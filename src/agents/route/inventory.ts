import { z } from 'zod';

import {
  AvailabilityState,
  ProjectCapabilityEvidence,
  ProjectCapabilityInventory,
  ProjectCapabilityObservation,
  projectCapabilityInventorySchema,
  TaskSuitability
} from '../schema';
import { computeContractDigest, parseCanonicalJson } from '../contracts';
import { ProjectContextError, ProjectReadContext } from '../project-context';
import {
  CapabilityAxis,
  CapabilityEvidenceProbe,
  CapabilityRouteDefinition,
  canonicalStringSchema,
  deepFreeze,
  isProjectRelativeReference,
  parseCapabilityRouteDefinitions,
  parseProjectRuntimeCapabilityEvidence,
  parseRouteRequest,
  ProjectRuntimeCapabilityEvidence,
  routeProjectRootSchema,
  RouteRequest
} from './schema';

const AXES: readonly CapabilityAxis[] = Object.freeze([
  'installed',
  'configured',
  'exposed',
  'permitted'
]);

interface ProbeResult {
  readonly state: AvailabilityState;
  readonly diagnostic?: string;
}

const projectSnapshotEntrySchema = z.object({
  reference: canonicalStringSchema.pipe(z.string().min(1)),
  kind: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.number().int().nonnegative().safe(),
  sha256: canonicalStringSchema.pipe(z.string().regex(/^[0-9a-f]{64}$/)).optional()
}).strict();

const projectSnapshotSchema = z.array(projectSnapshotEntrySchema);

export interface ProjectCapabilityInventoryResult {
  readonly inventory: ProjectCapabilityInventory;
  readonly diagnostics: readonly string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contextDiagnostic(
  capabilityId: string,
  reference: string,
  error: unknown
): string {
  if (error instanceof ProjectContextError) {
    return `project-context-${error.code}: capability "${capabilityId}" reference "${reference}"`;
  }
  const rawCode = (error as { code?: unknown })?.code;
  const code = typeof rawCode === 'string' && /^[A-Z0-9_-]+$/.test(rawCode)
    ? ` (${rawCode})`
    : '';
  return `project-context-read-error: capability "${capabilityId}" reference "${reference}"${code}`;
}

type PointerResult =
  | { readonly status: 'found'; readonly value: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'unsupported'; readonly reason: string };

function resolveJsonPointer(document: unknown, pointer: string): PointerResult {
  if (pointer === '') return { status: 'found', value: document };
  if (!pointer.startsWith('/')) {
    return { status: 'unsupported', reason: 'pointer must be empty or start with "/"' };
  }

  let current = document;
  for (const encoded of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(encoded)) {
      return { status: 'unsupported', reason: 'pointer contains an invalid RFC 6901 escape' };
    }
    const token = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) {
        return { status: 'unsupported', reason: 'array pointer token must be a canonical index' };
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index)) {
        return { status: 'unsupported', reason: 'array pointer index is outside the safe range' };
      }
      if (index >= current.length) return { status: 'missing' };
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return { status: 'missing' };
      current = (current as Record<string, unknown>)[token];
      continue;
    }
    return { status: 'unsupported', reason: 'pointer cannot traverse a non-container value' };
  }
  return { status: 'found', value: current };
}

function evaluateExpectation(
  value: unknown,
  check: Extract<CapabilityEvidenceProbe['check'], { type: 'json-pointer' }>
): ProbeResult {
  if (check.expectation.type === 'equals') {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      return { state: 'unknown', diagnostic: 'unsupported-json-pointer-value' };
    }
    return { state: Object.is(value, check.expectation.value) ? 'confirmed' : 'absent' };
  }
  if (typeof value === 'string') {
    return { state: value.includes(check.expectation.value) ? 'confirmed' : 'absent' };
  }
  if (Array.isArray(value)) {
    return {
      state: value.some(item => typeof item === 'string' && item === check.expectation.value)
        ? 'confirmed'
        : 'absent'
    };
  }
  return { state: 'unknown', diagnostic: 'unsupported-json-pointer-value' };
}

function evaluateProbe(context: ProjectReadContext, probe: CapabilityEvidenceProbe): ProbeResult {
  if (!isProjectRelativeReference(probe.reference)) {
    return {
      state: 'unknown',
      diagnostic:
        `invalid-probe-reference: capability "${probe.capabilityId}" rejected ` +
        `non-project reference "${probe.reference}" before read`
    };
  }

  try {
    if (probe.check.type === 'exists') {
      return { state: context.exists(probe.reference) ? 'confirmed' : 'absent' };
    }

    if (!context.exists(probe.reference)) return { state: 'absent' };
    const text = context.readText(probe.reference);
    if (text === null) {
      return {
        state: 'unknown',
        diagnostic:
          `unstable-project-read: capability "${probe.capabilityId}" reference ` +
          `"${probe.reference}" disappeared during read`
      };
    }

    let document: unknown;
    try {
      document = parseCanonicalJson(text);
    } catch {
      return {
        state: 'unknown',
        diagnostic:
          `malformed-project-json: capability "${probe.capabilityId}" reference ` +
          `"${probe.reference}"`
      };
    }

    const resolved = resolveJsonPointer(document, probe.check.pointer);
    if (resolved.status === 'missing') return { state: 'absent' };
    if (resolved.status === 'unsupported') {
      return {
        state: 'unknown',
        diagnostic:
          `invalid-json-pointer: capability "${probe.capabilityId}" reference ` +
          `"${probe.reference}" pointer "${probe.check.pointer}": ${resolved.reason}`
      };
    }
    const result = evaluateExpectation(resolved.value, probe.check);
    return result.diagnostic === undefined ? result : {
      state: result.state,
      diagnostic:
        `${result.diagnostic}: capability "${probe.capabilityId}" reference ` +
        `"${probe.reference}" pointer "${probe.check.pointer}"`
    };
  } catch (error) {
    return {
      state: 'unknown',
      diagnostic: contextDiagnostic(probe.capabilityId, probe.reference, error)
    };
  }
}

function aggregateAxis(
  capabilityId: string,
  axis: CapabilityAxis,
  states: readonly AvailabilityState[],
  diagnostics: string[]
): AvailabilityState {
  if (states.length === 0) {
    diagnostics.push(`no-project-evidence: capability "${capabilityId}" axis "${axis}"`);
    return 'unknown';
  }
  if (states.includes('unknown')) return 'unknown';
  if (states.includes('confirmed') && states.includes('absent')) {
    diagnostics.push(`conflicting-evidence: capability "${capabilityId}" axis "${axis}"`);
    return 'unknown';
  }
  if (states.includes('confirmed')) return 'confirmed';
  return 'absent';
}

function taskSuitability(
  definition: CapabilityRouteDefinition,
  request: Readonly<RouteRequest>,
  requested: ReadonlySet<string>,
  diagnostics: string[]
): TaskSuitability {
  if (!requested.has(definition.capabilityId)) {
    diagnostics.push(`unrequested-capability: capability "${definition.capabilityId}"`);
    return 'unsuitable';
  }
  if (definition.task.type === 'always') return 'suitable';
  const objective = request.objective.toLowerCase();
  return definition.task.any.some(keyword => objective.includes(keyword))
    ? 'suitable'
    : 'unsuitable';
}

function evidenceKey(evidence: ProjectCapabilityEvidence): string {
  return `${evidence.source}\u0000${evidence.reference}`;
}

function addSyntheticProjectEvidence(
  evidence: ProjectCapabilityEvidence[]
): void {
  evidence.push({ source: 'project-manifest', reference: 'package.json' });
}

function sortedUniqueEvidence(
  evidence: readonly ProjectCapabilityEvidence[]
): ProjectCapabilityEvidence[] {
  return [...new Map(evidence.map(item => [evidenceKey(item), item])).values()]
    .sort((left, right) => compareText(evidenceKey(left), evidenceKey(right)));
}

function buildObservation(
  context: ProjectReadContext,
  definition: CapabilityRouteDefinition,
  request: Readonly<RouteRequest>,
  requested: ReadonlySet<string>,
  runtimeEvidence: readonly ProjectRuntimeCapabilityEvidence[],
  diagnostics: string[]
): ProjectCapabilityObservation {
  const states = new Map<CapabilityAxis, AvailabilityState[]>(AXES.map(axis => [axis, []]));
  const evidence: ProjectCapabilityEvidence[] = [];

  for (const probe of definition.probes) {
    const result = evaluateProbe(context, probe);
    states.get(probe.axis)!.push(result.state);
    if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
    if (isProjectRelativeReference(probe.reference)) {
      evidence.push({ source: probe.source, reference: probe.reference });
    }
  }

  for (const runtime of runtimeEvidence.filter(item => item.capabilityId === definition.capabilityId)) {
    if (runtime.projectRoot !== context.projectRoot) {
      diagnostics.push(
        `runtime-project-root-mismatch: capability "${runtime.capabilityId}" reference ` +
        `"${runtime.reference}" ignored because root does not match current project`
      );
      continue;
    }
    evidence.push({ source: 'active-project-runtime', reference: runtime.reference });
    for (const axis of AXES) {
      const state = runtime.availability[axis];
      if (state !== undefined) {
        states.get(axis)!.push(state);
        if (state === 'unknown') {
          diagnostics.push(
            `runtime-evidence-unknown: capability "${runtime.capabilityId}" axis "${axis}" ` +
            `reference "${runtime.reference}"`
          );
        }
      }
    }
  }

  const availability = {
    installed: aggregateAxis(definition.capabilityId, 'installed', states.get('installed')!, diagnostics),
    configured: aggregateAxis(definition.capabilityId, 'configured', states.get('configured')!, diagnostics),
    exposed: aggregateAxis(definition.capabilityId, 'exposed', states.get('exposed')!, diagnostics),
    permitted: aggregateAxis(definition.capabilityId, 'permitted', states.get('permitted')!, diagnostics),
    taskSuitability: taskSuitability(definition, request, requested, diagnostics)
  };

  const uniqueEvidence = sortedUniqueEvidence(evidence);
  if (uniqueEvidence.length === 0) {
    addSyntheticProjectEvidence(uniqueEvidence);
  }
  return { capabilityId: definition.capabilityId, evidence: uniqueEvidence, availability };
}

interface InventoryCollection {
  readonly observations: ProjectCapabilityObservation[];
  readonly diagnostics: string[];
}

function addUnknownRequestedObservations(
  definitions: readonly CapabilityRouteDefinition[],
  requested: ReadonlySet<string>,
  observations: ProjectCapabilityObservation[],
  diagnostics: string[]
): void {
  const known = new Set(definitions.map(definition => definition.capabilityId));
  for (const capabilityId of [...requested].filter(id => !known.has(id)).sort(compareText)) {
    diagnostics.push(`unknown-requested-capability: no route definition for "${capabilityId}"`);
    const evidence: ProjectCapabilityEvidence[] = [];
    addSyntheticProjectEvidence(evidence);
    observations.push({
      capabilityId,
      evidence,
      availability: {
        installed: 'unknown',
        configured: 'unknown',
        exposed: 'unknown',
        permitted: 'unknown',
        taskSuitability: 'unknown'
      }
    });
  }
}

function collectInventory(
  context: ProjectReadContext,
  definitions: readonly CapabilityRouteDefinition[],
  request: Readonly<RouteRequest>,
  requested: ReadonlySet<string>,
  runtimeEvidence: readonly ProjectRuntimeCapabilityEvidence[]
): InventoryCollection {
  const diagnostics: string[] = [];
  const observations = definitions.map(definition => buildObservation(
    context,
    definition,
    request,
    requested,
    runtimeEvidence,
    diagnostics
  ));
  addUnknownRequestedObservations(definitions, requested, observations, diagnostics);
  observations.sort((left, right) => compareText(left.capabilityId, right.capabilityId));
  return { observations, diagnostics };
}

function failClosedInventory(
  projectRoot: string,
  definitions: readonly CapabilityRouteDefinition[],
  request: Readonly<RouteRequest>,
  requested: ReadonlySet<string>,
  runtimeEvidence: readonly ProjectRuntimeCapabilityEvidence[],
  diagnostic: string
): InventoryCollection {
  const diagnostics = [diagnostic];
  const observations = definitions.map(definition => {
    const evidence: ProjectCapabilityEvidence[] = definition.probes
      .filter(probe => isProjectRelativeReference(probe.reference))
      .map(probe => ({ source: probe.source, reference: probe.reference }));
    for (const runtime of runtimeEvidence) {
      if (
        runtime.capabilityId === definition.capabilityId &&
        runtime.projectRoot === projectRoot
      ) {
        evidence.push({ source: 'active-project-runtime', reference: runtime.reference });
      }
    }
    if (evidence.length === 0) {
      evidence.push({ source: 'project-manifest', reference: 'package.json' });
    }
    return {
      capabilityId: definition.capabilityId,
      evidence: sortedUniqueEvidence(evidence),
      availability: {
        installed: 'unknown' as const,
        configured: 'unknown' as const,
        exposed: 'unknown' as const,
        permitted: 'unknown' as const,
        taskSuitability: taskSuitability(definition, request, requested, diagnostics)
      }
    };
  });
  addUnknownRequestedObservations(definitions, requested, observations, diagnostics);
  observations.sort((left, right) => compareText(left.capabilityId, right.capabilityId));
  return { observations, diagnostics };
}

function snapshotDigest(context: ProjectReadContext, reference: string): string {
  const snapshot = projectSnapshotSchema.parse(context.snapshot(reference));
  const key = (entry: (typeof snapshot)[number]): string =>
    `${entry.reference}\u0000${entry.kind}\u0000${entry.size}\u0000${entry.sha256 ?? ''}`;
  const normalized = [...new Map(snapshot.map(entry => [key(entry), entry])).values()]
    .sort((left, right) => compareText(key(left), key(right)));
  return computeContractDigest(
    'execution-blueprint/v1',
    1,
    'project-capability-inventory-snapshot',
    { reference, snapshot: normalized }
  );
}

function filesystemEvidenceReferences(
  definitions: readonly CapabilityRouteDefinition[]
): readonly string[] {
  return [...new Set(definitions.flatMap(definition => definition.probes
    .map(probe => probe.reference)
    .filter(isProjectRelativeReference)))].sort(compareText);
}

function snapshotEvidenceReferences(
  context: ProjectReadContext,
  references: readonly string[]
): ReadonlyMap<string, string> {
  return new Map(references.map(reference => [reference, snapshotDigest(context, reference)]));
}

function snapshotsMatch(
  references: readonly string[],
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): boolean {
  return references.every(reference => before.get(reference) === after.get(reference));
}

function isConcurrentMutation(error: unknown): boolean {
  return error instanceof ProjectContextError && error.code === 'concurrent-mutation';
}

function finalizeInventory(
  projectRoot: string,
  collection: InventoryCollection
): Readonly<ProjectCapabilityInventoryResult> {
  const inventory = projectCapabilityInventorySchema.parse({
    schemaVersion: 1,
    projectRoot,
    observations: collection.observations
  });
  return deepFreeze({
    inventory,
    diagnostics: [...new Set(collection.diagnostics)].sort(compareText)
  });
}

export function buildProjectCapabilityInventory(
  context: ProjectReadContext,
  definitionsInput: readonly unknown[],
  requestInput: unknown,
  runtimeEvidenceInput: readonly unknown[] = []
): Readonly<ProjectCapabilityInventoryResult> {
  const definitions = parseCapabilityRouteDefinitions(definitionsInput);
  const request = parseRouteRequest(requestInput);
  const runtimeEvidence = parseProjectRuntimeCapabilityEvidence(runtimeEvidenceInput);
  const requested = new Set(request.requestedCapabilityIds ?? []);
  const projectRoot = routeProjectRootSchema.parse(context.projectRoot);
  const references = filesystemEvidenceReferences(definitions);

  if (references.length === 0) {
    return finalizeInventory(
      projectRoot,
      collectInventory(context, definitions, request, requested, runtimeEvidence)
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before: ReadonlyMap<string, string>;
    try {
      before = snapshotEvidenceReferences(context, references);
    } catch (error) {
      if (attempt === 0 && isConcurrentMutation(error)) continue;
      const diagnostic = isConcurrentMutation(error)
        ? 'concurrent project mutation while collecting capability inventory'
        : contextDiagnostic('inventory', '.', error);
      return finalizeInventory(projectRoot, failClosedInventory(
        projectRoot,
        definitions,
        request,
        requested,
        runtimeEvidence,
        diagnostic
      ));
    }

    const collection = collectInventory(context, definitions, request, requested, runtimeEvidence);
    let after: ReadonlyMap<string, string>;
    try {
      after = snapshotEvidenceReferences(context, references);
    } catch (error) {
      if (attempt === 0 && isConcurrentMutation(error)) continue;
      const diagnostic = isConcurrentMutation(error)
        ? 'concurrent project mutation while collecting capability inventory'
        : contextDiagnostic('inventory', '.', error);
      return finalizeInventory(projectRoot, failClosedInventory(
        projectRoot,
        definitions,
        request,
        requested,
        runtimeEvidence,
        diagnostic
      ));
    }

    if (snapshotsMatch(references, before, after)) {
      return finalizeInventory(projectRoot, collection);
    }
    if (attempt === 0) continue;
  }

  return finalizeInventory(projectRoot, failClosedInventory(
    projectRoot,
    definitions,
    request,
    requested,
    runtimeEvidence,
    'concurrent project mutation while collecting capability inventory'
  ));
}

export function computeProjectCapabilityInventoryDigest(
  inventory: ProjectCapabilityInventory
): string {
  const parsed = projectCapabilityInventorySchema.parse(inventory);
  const normalized = projectCapabilityInventorySchema.parse({
    schemaVersion: parsed.schemaVersion,
    projectRoot: routeProjectRootSchema.parse(parsed.projectRoot),
    observations: parsed.observations.map(observation => ({
      ...observation,
      evidence: sortedUniqueEvidence(observation.evidence.map(evidence => ({
        ...evidence,
        reference: canonicalStringSchema.parse(evidence.reference)
      })))
    })).sort((left, right) => compareText(left.capabilityId, right.capabilityId))
  });
  return computeContractDigest(
    'execution-blueprint/v1',
    1,
    'project-capability-inventory',
    normalized
  );
}
