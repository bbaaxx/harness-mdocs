import {
  ContractEnvelope,
  computeContractDigest,
  executionBlueprintPayloadSchema,
  ExecutionBlueprintPayload,
  parseContract,
  sealContract,
  verifyContractEnvelope
} from '../contracts';
import { ProjectReadContext } from '../project-context';
import { ProjectCapabilityObservation, SurfaceFidelity } from '../schema';
import {
  buildProjectCapabilityInventory,
  computeProjectCapabilityInventoryDigest
} from './inventory';
import {
  deepFreeze,
  parseCapabilityRouteDefinitions,
  parseProjectRuntimeCapabilityEvidence,
  parseRouteRequest
} from './schema';

export interface RouteProjectRequestInput {
  readonly context: ProjectReadContext;
  readonly definitions: readonly unknown[];
  readonly request: unknown;
  readonly runtimeEvidence?: readonly unknown[];
}

const AVAILABILITY_AXES = Object.freeze([
  'installed',
  'configured',
  'exposed',
  'permitted',
  'taskSuitability'
] as const);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejectionReasons(
  observation: ProjectCapabilityObservation,
  requested: ReadonlySet<string>
): string[] {
  const reasons: string[] = [];
  if (!requested.has(observation.capabilityId)) reasons.push('capability was not requested');
  for (const axis of AVAILABILITY_AXES) {
    const state = observation.availability[axis];
    if (axis === 'taskSuitability') {
      if (state !== 'suitable') reasons.push(`taskSuitability is ${state}`);
    } else if (state !== 'confirmed') {
      reasons.push(`${axis} is ${state}`);
    }
  }
  return [...new Set(reasons)].sort(compareText);
}

function requestedAndEligible(
  observation: ProjectCapabilityObservation,
  requested: ReadonlySet<string>
): boolean {
  return requested.has(observation.capabilityId) &&
    observation.availability.installed === 'confirmed' &&
    observation.availability.configured === 'confirmed' &&
    observation.availability.exposed === 'confirmed' &&
    observation.availability.permitted === 'confirmed' &&
    observation.availability.taskSuitability === 'suitable';
}

function isSafetyDiagnostic(diagnostic: string): boolean {
  return diagnostic === 'concurrent project mutation while collecting capability inventory' ||
    diagnostic.startsWith('project-context-') ||
    diagnostic.startsWith('unstable-project-read:');
}

function fallbackForReason(
  capabilityId: string,
  reason: string,
  definitionKnown: boolean,
  wasRequested: boolean
): string {
  if (!definitionKnown) {
    return `Capability "${capabilityId}" is requested but unknown; inject a route definition`;
  }
  const axis = /^(installed|configured|exposed|permitted) is (absent|unknown)$/.exec(reason);
  if (axis !== null) {
    const action = axis[2] === 'absent'
      ? `provide matching project-scoped evidence for ${axis[1]}`
      : `resolve unknown project-scoped evidence for ${axis[1]}`;
    return `Capability "${capabilityId}" rejected because ${reason}; ${action}`;
  }
  if (reason === 'taskSuitability is unsuitable') {
    if (!wasRequested) {
      return `Capability "${capabilityId}" task suitability was not evaluated because it was not requested; request it explicitly if intended`;
    }
    return `Capability "${capabilityId}" rejected because ${reason}; revise objective or task keywords`;
  }
  if (reason === 'taskSuitability is unknown') {
    return `Capability "${capabilityId}" rejected because ${reason}; provide a route definition with task rules`;
  }
  if (reason === 'capability was not requested') {
    return `Capability "${capabilityId}" rejected because ${reason}; request it explicitly if intended`;
  }
  return `Capability "${capabilityId}" rejected because ${reason}; resolve this route preflight`;
}

function renderPayload(
  base: Omit<ExecutionBlueprintPayload, 'fidelityResult' | 'unresolvedPreflightChecks'>,
  unresolved: readonly string[],
  fidelityResult: SurfaceFidelity
): ExecutionBlueprintPayload {
  return executionBlueprintPayloadSchema.parse({
    ...base,
    fidelityResult,
    unresolvedPreflightChecks: [...unresolved]
  });
}

export function routeProjectRequest(input: RouteProjectRequestInput): Readonly<ContractEnvelope> {
  const definitions = parseCapabilityRouteDefinitions(input.definitions);
  const request = parseRouteRequest(input.request);
  const runtimeEvidence = parseProjectRuntimeCapabilityEvidence(input.runtimeEvidence ?? []);
  const { inventory, diagnostics } = buildProjectCapabilityInventory(
    input.context,
    definitions,
    request,
    runtimeEvidence
  );
  const requested = new Set(request.requestedCapabilityIds ?? []);
  const selectedRoutes: ExecutionBlueprintPayload['selectedRoutes'] = [];
  const rejectedRoutes: ExecutionBlueprintPayload['rejectedRoutes'] = [];

  for (const observation of inventory.observations) {
    if (requestedAndEligible(observation, requested)) {
      selectedRoutes.push({
        id: observation.capabilityId,
        reasons: ['requested capability has confirmed project evidence on every axis and is suitable']
      });
    } else {
      rejectedRoutes.push({
        id: observation.capabilityId,
        reasons: rejectionReasons(observation, requested)
      });
    }
  }
  selectedRoutes.sort((left, right) => compareText(left.id, right.id));
  rejectedRoutes.sort((left, right) => compareText(left.id, right.id));

  const selectedIds = new Set(selectedRoutes.map(route => route.id));
  const knownDefinitionIds = new Set(definitions.map(definition => definition.capabilityId));
  const requestedRejected = rejectedRoutes.filter(route => requested.has(route.id));
  const routePreflight = requestedRejected.flatMap(route => route.reasons.map(reason =>
    `route-preflight-unresolved: capability "${route.id}": ${reason}`
  ));
  const evidencePreflight = diagnostics.filter(diagnostic =>
    isSafetyDiagnostic(diagnostic) ||
    [...requested].some(capabilityId => diagnostic.includes(`capability "${capabilityId}"`)) ||
    diagnostic.startsWith('unknown-requested-capability:')
  );
  const emptyRequestPreflight = requested.size === 0
    ? ['route-preflight-unresolved: no requested capabilities; analysis-only Route is plan-only']
    : [];
  const unresolved = [...new Set([
    ...routePreflight,
    ...evidencePreflight,
    ...emptyRequestPreflight
  ])].sort(compareText);
  const fallbacks = [...new Set([
    ...rejectedRoutes.flatMap(route => route.reasons.map(reason =>
      fallbackForReason(
        route.id,
        reason,
        knownDefinitionIds.has(route.id),
        requested.has(route.id)
      )
    )),
    ...evidencePreflight.map(diagnostic =>
      `Resolve preflight diagnostic before selection: ${diagnostic}`
    ),
    ...(requested.size === 0
      ? ['Request at least one capability; empty analysis-only Route remains plan-only']
      : [])
  ])].sort(compareText);
  const normalizedRequest = {
    id: request.id,
    objective: request.objective,
    requestedCapabilityIds: request.requestedCapabilityIds ?? [],
    fidelityRequirements: request.fidelityRequirements ?? []
  };
  const base: Omit<ExecutionBlueprintPayload, 'fidelityResult' | 'unresolvedPreflightChecks'> = {
    requestDigest: computeContractDigest(
      'execution-blueprint/v1',
      1,
      'route-request',
      normalizedRequest
    ),
    projectIdentity: computeContractDigest(
      'execution-blueprint/v1',
      1,
      'route-project-identity',
      { projectRoot: inventory.projectRoot }
    ),
    projectRoot: inventory.projectRoot,
    inventoryDigest: computeProjectCapabilityInventoryDigest(inventory),
    capabilityObservations: inventory.observations,
    selectedRoutes,
    rejectedRoutes,
    topology: [],
    fidelityRequirements: request.fidelityRequirements ?? [],
    sideEffects: ['none: Route is read-only'],
    approvalForecast: {
      requiresApproval: false,
      notes: ['Blueprint carries no authority and cannot approve or execute Run']
    },
    verification: [
      'Project capability inventory validated against strict schema',
      'Inventory digest computed from normalized project capability inventory',
      'Execution blueprint payload validated against strict schema',
      'Contract envelope digest verified and parsed through contract registry'
    ].sort(compareText),
    fallbacks
  };

  const everyRequestedCapabilitySelected = requested.size > 0 &&
    [...requested].every(capabilityId => selectedIds.has(capabilityId));
  let payload = renderPayload(
    base,
    unresolved,
    everyRequestedCapabilitySelected && unresolved.length === 0 ? 'exact' : 'plan-only'
  );
  let envelope = sealContract('execution-blueprint/v1', `route:${request.id}`, payload);
  let parsed = parseContract(envelope);
  let verified = verifyContractEnvelope(envelope);
  if (!parsed.ok || !verified.ok) {
    const failures = [
      ...(parsed.ok ? [] : parsed.issues.map(issue => `blueprint-validation-failed: ${issue}`)),
      ...(verified.ok ? [] : [`blueprint-digest-verification-failed: ${verified.reason}`])
    ].sort(compareText);
    payload = renderPayload(base, [...unresolved, ...failures].sort(compareText), 'unsupported');
    envelope = sealContract('execution-blueprint/v1', `route:${request.id}`, payload);
    parsed = parseContract(envelope);
    verified = verifyContractEnvelope(envelope);
    if (!parsed.ok || !verified.ok) {
      throw new Error('Route could not render a valid execution-blueprint/v1 contract');
    }
  }

  return deepFreeze(envelope);
}
