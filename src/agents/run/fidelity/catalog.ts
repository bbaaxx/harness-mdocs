export const ROUTE_FIDELITY_PROBE_IDS = Object.freeze([
  'route.contracts',
  'route.purity'
] as const);

export const UNCONDITIONAL_RUN_FIDELITY_PROBE_IDS = Object.freeze([
  'run.trusted-attestation',
  'run.host-identity',
  'run.protected-store',
  'run.action-mediation',
  'run.receipt-integrity',
  'run.depth-topology',
  'run.cancellation'
] as const);

export const METERING_FIDELITY_PROBE_IDS = Object.freeze([
  'run.metering.tokens',
  'run.metering.cost'
] as const);

export const FIDELITY_PROBE_IDS = Object.freeze([
  ...ROUTE_FIDELITY_PROBE_IDS,
  ...UNCONDITIONAL_RUN_FIDELITY_PROBE_IDS,
  ...METERING_FIDELITY_PROBE_IDS
] as const);

export type FidelityProbeId = typeof FIDELITY_PROBE_IDS[number];

const assertions = <const Values extends readonly string[]>(...values: Values): Readonly<Values> =>
  Object.freeze(values);

/** Canonical, exhaustive evidence assertions for each measured probe. */
export const FIDELITY_ASSERTION_CATALOG = Object.freeze({
  'route.contracts': assertions(
    'blueprint-round-trip',
    'malformed-rejected',
    'unknown-major-rejected'
  ),
  'route.purity': assertions(
    'absent-mdocs-unchanged',
    'readonly-success',
    'no-writes',
    'tree-stable'
  ),
  'run.trusted-attestation': assertions(
    'separate-gestures',
    'digest-binding',
    'revision-binding',
    'principal-binding',
    'project-binding',
    'session-binding',
    'forged-rejected',
    'replay-rejected',
    'expiry-rejected',
    'revocation-rejected'
  ),
  'run.host-identity': assertions(
    'issued-binding',
    'forged-metadata-denied',
    'unbound-handles-denied'
  ),
  'run.protected-store': assertions(
    'atomic-cas',
    'checksum-validation',
    'fencing',
    'recovery',
    'tamper-quarantine',
    'worker-inaccessible',
    'mirror-inert'
  ),
  'run.action-mediation': assertions(
    'every-effect-path-gated',
    'every-spawn-path-gated',
    'bypass-corpus-denied',
    'intent-before-effect',
    // Production adapters attest guard placement immediately before protected primitive.
    'effect-boundary-guard'
  ),
  'run.receipt-integrity': assertions(
    'schema-validation',
    'lineage-validation',
    'idempotency-validation',
    'operation-validation',
    'fingerprint-validation',
    'tamper-rejected',
    'replay-rejected',
    'redaction-validation'
  ),
  'run.depth-topology': assertions(
    'root-to-leaf-denied',
    'eo-to-eo-denied',
    'leaf-delegation-denied',
    'depth-overflow-denied'
  ),
  'run.cancellation': assertions(
    'generation-committed-before-authorize',
    'pending-effects-denied',
    'descendants-signalled',
    'bounded-drain',
    'no-post-cancel-effect'
  ),
  'run.metering.tokens': assertions(
    'authoritative-bounded-reservation',
    'monotonic-sample',
    'final-reconciliation'
  ),
  'run.metering.cost': assertions(
    'authoritative-bounded-reservation',
    'monotonic-sample',
    'final-reconciliation',
    'price-table-binding'
  )
} satisfies Record<FidelityProbeId, readonly string[]>);

export type FidelityAssertionId<Id extends FidelityProbeId = FidelityProbeId> =
  typeof FIDELITY_ASSERTION_CATALOG[Id][number];

export const FIDELITY_REASON_BASE = Object.freeze({
  'route.contracts': 'ROUTE_CONTRACTS',
  'route.purity': 'ROUTE_PURITY',
  'run.trusted-attestation': 'RUN_ATTESTATION',
  'run.host-identity': 'RUN_HOST_IDENTITY',
  'run.protected-store': 'RUN_PROTECTED_STORE',
  'run.action-mediation': 'RUN_ACTION_MEDIATION',
  'run.receipt-integrity': 'RUN_RECEIPT_INTEGRITY',
  'run.depth-topology': 'RUN_DEPTH_TOPOLOGY',
  'run.cancellation': 'RUN_CANCELLATION',
  'run.metering.tokens': 'RUN_METERING_TOKENS',
  'run.metering.cost': 'RUN_METERING_COST'
} as const satisfies Record<FidelityProbeId, string>);

export const FIDELITY_AUTHENTICITY_REASON_CODES = Object.freeze([
  'ROUTE_MEASUREMENT_NOT_MEASURED',
  'RUN_MEASUREMENT_NOT_MEASURED',
  'ROUTE_MEASUREMENT_UNTRUSTED',
  'RUN_MEASUREMENT_UNTRUSTED'
] as const);

export const FIDELITY_POLICY_REASON_CODES = Object.freeze([
  'RUN_HUMAN_CHECKPOINT_REQUIRED'
] as const);

export const FIDELITY_RUNTIME_REASON_CODES = Object.freeze([
  'ROUTE_ISOLATION_NOT_KILLABLE',
  'RUN_ISOLATION_NOT_KILLABLE',
  'RUNNER_POISONED',
  'RUN_REQUIREMENTS_INVALID'
] as const);

export type FidelityProbeReasonCode =
  `${typeof FIDELITY_REASON_BASE[FidelityProbeId]}_${'NOT_MEASURED' | 'FAILED' | 'INCONCLUSIVE'}`;
export type FidelityAuthenticityReasonCode = typeof FIDELITY_AUTHENTICITY_REASON_CODES[number];
export type FidelityPolicyReasonCode = typeof FIDELITY_POLICY_REASON_CODES[number];
export type FidelityRuntimeReasonCode = typeof FIDELITY_RUNTIME_REASON_CODES[number];
export type FidelityReasonCode = FidelityProbeReasonCode |
  FidelityAuthenticityReasonCode |
  FidelityPolicyReasonCode |
  FidelityRuntimeReasonCode;
