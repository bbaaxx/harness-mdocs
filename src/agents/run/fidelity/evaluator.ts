import { z } from 'zod';
import { isProxy } from 'util/types';

import { SurfaceFidelity } from '../../schema';
import { ExecutionPlanBudgetInput, ExecutionPlanBudgets } from '../compiler/schema';
import {
  FIDELITY_PROBE_IDS,
  FIDELITY_REASON_BASE,
  FidelityProbeId,
  FidelityReasonCode,
  METERING_FIDELITY_PROBE_IDS,
  ROUTE_FIDELITY_PROBE_IDS,
  UNCONDITIONAL_RUN_FIDELITY_PROBE_IDS
} from './catalog';
import {
  FidelityRunnerDiagnosticsSnapshot,
  resolveTrustedFidelityMeasurement,
  TrustedFidelitySnapshot
} from './internal';
import { FidelityProbeResult, FidelitySubject, unknownProbeResult } from './schema';

export type HardBudgetDimension = 'tokens' | 'cost';

const HARD_BUDGET_DIMENSIONS = Object.freeze(['tokens', 'cost'] as const);
const MAX_HARD_BUDGET_DIMENSIONS = 16;
const INVALID_REQUIREMENTS = Object.freeze({});

export interface SurfaceFidelityRequirements {
  continuation: 'autonomous' | 'human-checkpoint';
  hardBudgetDimensions: readonly HardBudgetDimension[];
}

function boundedRequirementsInput(value: unknown): unknown {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      return INVALID_REQUIREMENTS;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return INVALID_REQUIREMENTS;

    let enumerableKeys = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || ++enumerableKeys > 2) {
        return INVALID_REQUIREMENTS;
      }
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 ||
        !keys.includes('continuation') ||
        !keys.includes('hardBudgetDimensions') ||
        keys.some(key => key !== 'continuation' && key !== 'hardBudgetDimensions')) {
      return INVALID_REQUIREMENTS;
    }
    const continuationDescriptor = Object.getOwnPropertyDescriptor(value, 'continuation');
    if (continuationDescriptor === undefined || !('value' in continuationDescriptor)) {
      return INVALID_REQUIREMENTS;
    }
    const dimensionsDescriptor = Object.getOwnPropertyDescriptor(value, 'hardBudgetDimensions');
    if (dimensionsDescriptor === undefined || !('value' in dimensionsDescriptor)) {
      return INVALID_REQUIREMENTS;
    }
    const dimensions = dimensionsDescriptor.value;
    if (typeof dimensions !== 'object' || dimensions === null || isProxy(dimensions) ||
        !Array.isArray(dimensions) ||
        Object.getPrototypeOf(dimensions) !== Array.prototype) {
      return INVALID_REQUIREMENTS;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(dimensions, 'length');
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_HARD_BUDGET_DIMENSIONS) {
      return INVALID_REQUIREMENTS;
    }
    const length = lengthDescriptor.value;

    let enumerableDimensions = 0;
    for (const key in dimensions) {
      if (!Object.prototype.hasOwnProperty.call(dimensions, key) || ++enumerableDimensions > length) {
        return INVALID_REQUIREMENTS;
      }
    }
    const dimensionKeys = Reflect.ownKeys(dimensions);
    if (dimensionKeys.length !== length + 1 || dimensionKeys.some(key =>
      key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= length)
    )) return INVALID_REQUIREMENTS;

    const bounded: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(dimensions, String(index));
      if (descriptor === undefined || !('value' in descriptor)) return INVALID_REQUIREMENTS;
      bounded.push(descriptor.value);
    }
    return { continuation: continuationDescriptor.value, hardBudgetDimensions: bounded };
  } catch {
    return INVALID_REQUIREMENTS;
  }
}

/** Strict runtime boundary; dimensions normalize into fixed catalog order. */
export const surfaceFidelityRequirementsSchema = z.preprocess(
  boundedRequirementsInput,
  z.object({
    continuation: z.enum(['autonomous', 'human-checkpoint']),
    hardBudgetDimensions: z.array(z.enum(HARD_BUDGET_DIMENSIONS)).max(MAX_HARD_BUDGET_DIMENSIONS)
  }).strict()
).transform(value => ({
  continuation: value.continuation,
  hardBudgetDimensions: Object.freeze(HARD_BUDGET_DIMENSIONS.filter(dimension =>
    value.hardBudgetDimensions.includes(dimension)
  ))
} satisfies SurfaceFidelityRequirements));

export interface SurfaceFidelityAssessment {
  fidelity: SurfaceFidelity;
  reasons: readonly FidelityReasonCode[];
}

export interface SurfaceFidelityReport {
  schemaVersion: 1;
  subject: FidelitySubject;
  route: SurfaceFidelityAssessment;
  run: SurfaceFidelityAssessment;
  probes: readonly FidelityProbeResult[];
  diagnostics: FidelityRunnerDiagnosticsSnapshot;
}

/** Opaque by authenticity, not secrecy. Only internal host runner can mint one. */
export interface TrustedFidelityMeasurementSet {
  readonly schemaVersion: 1;
  readonly subject: FidelitySubject;
  readonly probes: readonly FidelityProbeResult[];
  readonly diagnostics: FidelityRunnerDiagnosticsSnapshot;
}

const UNTRUSTED_SUBJECT: FidelitySubject = Object.freeze({
  surfaceId: 'untrusted-measurement',
  adapterId: 'untrusted-measurement',
  adapterVersion: '0',
  implementationDigest: `sha256:${'0'.repeat(64)}`
});

const EMPTY_DIAGNOSTICS: FidelityRunnerDiagnosticsSnapshot = Object.freeze({
  poisoned: false,
  isolation: 'in-process',
  quarantines: Object.freeze([])
});

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

/** Token and cost probes follow defined plan values, never mere key presence. */
export function deriveHardBudgetDimensions(
  executionPlanBudgets: Readonly<Partial<ExecutionPlanBudgets> | ExecutionPlanBudgetInput>
): readonly HardBudgetDimension[] {
  const entries = Object.entries(executionPlanBudgets);
  return Object.freeze([
    ...(entries.some(([key, value]) => key.startsWith('tokens') && value !== undefined)
      ? ['tokens' as const] : []),
    ...(entries.some(([key, value]) => key.startsWith('costUsd') && value !== undefined)
      ? ['cost' as const] : [])
  ]);
}

function reasonFor(
  probeId: FidelityProbeId,
  probe: FidelityProbeResult | undefined
): FidelityReasonCode | undefined {
  if (probe?.status === 'pass') return undefined;
  const suffix = probe === undefined
    ? 'NOT_MEASURED'
    : probe.status === 'fail'
      ? 'FAILED'
      : 'INCONCLUSIVE';
  return `${FIDELITY_REASON_BASE[probeId]}_${suffix}` as FidelityReasonCode;
}

function orderedProbes(snapshot: TrustedFidelitySnapshot): readonly FidelityProbeResult[] {
  const byId = new Map<FidelityProbeId, FidelityProbeResult[]>();
  for (const probe of snapshot.probes) {
    const matches = byId.get(probe.probeId) ?? [];
    matches.push(probe);
    byId.set(probe.probeId, matches);
  }
  return FIDELITY_PROBE_IDS.flatMap(probeId => {
    const matches = byId.get(probeId) ?? [];
    if (matches.length === 0) return [];
    if (matches.length === 1) return matches;
    return [unknownProbeResult(
      probeId,
      snapshot.subject,
      matches[0].challengeId,
      matches[0].measuredAt,
      'PROBE_DUPLICATE'
    )];
  });
}

function assessment(
  fidelity: SurfaceFidelity,
  reasons: readonly FidelityReasonCode[]
): SurfaceFidelityAssessment {
  return { fidelity, reasons };
}

function unauthenticatedReport(notMeasured: boolean): SurfaceFidelityReport {
  const routeReason = notMeasured
    ? 'ROUTE_MEASUREMENT_NOT_MEASURED'
    : 'ROUTE_MEASUREMENT_UNTRUSTED';
  const runReason = notMeasured
    ? 'RUN_MEASUREMENT_NOT_MEASURED'
    : 'RUN_MEASUREMENT_UNTRUSTED';
  return deepFreeze({
    schemaVersion: 1,
    subject: UNTRUSTED_SUBJECT,
    route: assessment('unsupported', [routeReason]),
    run: assessment('unsupported', [runReason]),
    probes: [],
    diagnostics: EMPTY_DIAGNOSTICS
  });
}

/** Classifies only internal-runner measurements; arbitrary objects always fail closed. */
export function evaluateSurfaceFidelity(
  measurement: unknown,
  requirements: unknown
): SurfaceFidelityReport {
  if (typeof measurement !== 'object' || measurement === null) {
    return unauthenticatedReport(measurement === undefined || measurement === null);
  }
  const snapshot = resolveTrustedFidelityMeasurement(measurement);
  if (snapshot === undefined) return unauthenticatedReport(false);

  const probes = orderedProbes(snapshot);
  const byId = new Map(probes.map(probe => [probe.probeId, probe]));
  const contractsReason = reasonFor('route.contracts', byId.get('route.contracts'));
  const purityReason = reasonFor('route.purity', byId.get('route.purity'));
  const measuredRoute = contractsReason !== undefined
    ? assessment('unsupported', [contractsReason])
    : purityReason !== undefined
      ? assessment('plan-only', [purityReason])
      : assessment('exact', []);
  const route = snapshot.diagnostics.isolation !== 'killable' && measuredRoute.fidelity === 'exact'
    ? assessment('plan-only', ['ROUTE_ISOLATION_NOT_KILLABLE'])
    : measuredRoute;
  const runnerPoisoned = snapshot.diagnostics.poisoned ||
    snapshot.diagnostics.quarantines.length > 0;

  let parsedRequirements: SurfaceFidelityRequirements | undefined;
  try {
    const parsed = surfaceFidelityRequirementsSchema.safeParse(requirements);
    if (parsed.success) parsedRequirements = parsed.data;
  } catch {
    parsedRequirements = undefined;
  }
  if (parsedRequirements === undefined) {
    return deepFreeze({
      schemaVersion: 1,
      subject: snapshot.subject,
      route,
      run: assessment('plan-only', [
        ...(runnerPoisoned ? ['RUNNER_POISONED' as const] : []),
        'RUN_REQUIREMENTS_INVALID'
      ]),
      probes,
      diagnostics: snapshot.diagnostics
    });
  }

  const hardBudgetDimensions = parsedRequirements.hardBudgetDimensions;
  const requiredRunIds: FidelityProbeId[] = [...UNCONDITIONAL_RUN_FIDELITY_PROBE_IDS];
  if (hardBudgetDimensions.includes('tokens')) requiredRunIds.push(METERING_FIDELITY_PROBE_IDS[0]);
  if (hardBudgetDimensions.includes('cost')) requiredRunIds.push(METERING_FIDELITY_PROBE_IDS[1]);
  const runReasons: FidelityReasonCode[] = [
    ...(runnerPoisoned ? ['RUNNER_POISONED' as const] : []),
    ...(snapshot.diagnostics.isolation !== 'killable'
      ? ['RUN_ISOLATION_NOT_KILLABLE' as const]
      : []),
    ...requiredRunIds.flatMap(probeId => {
      const reason = reasonFor(probeId, byId.get(probeId));
      return reason === undefined ? [] : [reason];
    })
  ];
  const run = runReasons.length > 0
    ? assessment('plan-only', runReasons)
    : parsedRequirements.continuation === 'autonomous'
      ? assessment('exact', [])
      : assessment('supervised', ['RUN_HUMAN_CHECKPOINT_REQUIRED']);

  return deepFreeze({
    schemaVersion: 1,
    subject: snapshot.subject,
    route,
    run,
    probes,
    diagnostics: snapshot.diagnostics
  });
}

export { ROUTE_FIDELITY_PROBE_IDS };
