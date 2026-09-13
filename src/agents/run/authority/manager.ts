import * as crypto from 'crypto';
import { isProxy } from 'util/types';

import { z } from 'zod';

import { canonicalizeJson } from '../../contracts';
import {
  CompiledPlanGraph,
  ExecutionPlanBudgets,
  validateCompiledPlanGraph
} from '../compiler';
import { ProtectedControllerStoreReader, ProtectedControllerStoreWriter } from '../store';
import {
  ExecutionModeSelectionEvent,
  HostIdentity,
  HostIdentityProvider,
  PlanApprovalEvent,
  UsageSample
} from '../trust';
import {
  assertRoleBudgetAmounts,
  BudgetLedger,
  budgetLedgerSchema,
  createBudgetLedger,
  parseBudgetLedger,
  reconcileBudget,
  recordBudgetOperation,
  releaseBudget,
  reserveBudget
} from './budgets';
import {
  acquireControllerLease,
  acquireWorkstreamLease,
  ControllerLeaseProof,
  controllerLeaseProofSchema,
  ControllerLeaseRecord,
  controllerLeasePlaceholder,
  heartbeatControllerLease,
  heartbeatWorkstreamLease,
  invalidateAllLeases,
  invalidateWorkstreamLeasesByTicketHandles,
  LeaseAuthorityState,
  LeaseSources,
  parseLeaseAuthorityState,
  releaseControllerLease,
  releaseWorkstreamLease,
  validateControllerLease,
  validateWorkstreamLease,
  WorkstreamLeaseProof,
  workstreamProof,
  workstreamLeaseProofSchema,
  WorkstreamLeaseRecord,
  workstreamLeasePlaceholder
} from './leases';
import {
  AuthorityRepositorySnapshot,
  createProtectedAuthorityRepository,
  ProtectedAuthorityRepository
} from './protected-repository';
import {
  DelegateTicketInput,
  HostIdentitySnapshot,
  hostIdentitySnapshotSchema,
  IssueRootTicketInput,
  issueRootTicketInputSchema,
  strictRfc3339UtcSchema,
  TicketAuthorityState,
  ticketAuthorityStateSchema
} from './schema';
import { delegateTicketInputSchema } from './schema';
import {
  canonicalAuthoritySnapshot,
  snapshotAuthorityData,
  TicketAuthorityError,
  TicketAuthorityErrorCode
} from './state';
import { createTicketAuthorityBroker, IssuedTicketHandle } from './tickets';
import {
  AuthorityAttestationResult,
  AuthorityUsageMeter,
  AuthorityUsageReservationRequest,
  RecoverableAuthorityAttestationProvider
} from './providers';

const boundedString = z.string().min(1).max(16 * 1024);
const safeNonNegative = z.number().int().nonnegative().safe();
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const fanoutCounterSchema = z.object({
  parentTicketHandleId: boundedString,
  issuedChildren: safeNonNegative
}).strict();
const ticketDeadlineSchema = z.object({
  ticketHandleId: boundedString,
  role: z.enum(['EXECUTION', 'LEAF']),
  startedAt: strictRfc3339UtcSchema,
  hardDeadlineAt: strictRfc3339UtcSchema
}).strict();
const issuanceMappingSchema = z.object({
  operationId: boundedString,
  kind: z.enum(['execution', 'leaf']),
  requestDigest: digestSchema,
  request: z.unknown(),
  ticketHandleId: boundedString,
  reservationId: boundedString
}).strict();
const usageBindingSchema = z.object({
  source: boundedString,
  provider: boundedString,
  model: boundedString,
  priceTableVersion: boundedString,
  currency: boundedString
}).strict();
const attestationResultSchema = z.object({
  ok: z.literal(true),
  reservationId: boundedString,
  approvalEventId: boundedString,
  modeSelectionEventId: boundedString,
  approvalRef: boundedString,
  modeSelectionRef: boundedString,
  mode: z.enum(['milestone', 'autonomous']),
  initializationRequestDigest: digestSchema,
  projectId: boundedString,
  hostSessionRef: boundedString,
  principalRef: boundedString,
  planDigest: digestSchema,
  graphDigest: digestSchema,
  planRevision: safeNonNegative
}).strict();
const authorityAttestationReservationSchema = z.object({
  reservationId: boundedString,
  idempotencyKey: boundedString,
  expiresAt: strictRfc3339UtcSchema
}).strict();
const authorityUsageScopeSchema = z.object({
  opaqueScope: boundedString,
  runId: boundedString,
  projectId: boundedString,
  operationId: boundedString,
  ticketRequestDigest: digestSchema,
  reservationId: boundedString,
  nodeId: boundedString
}).strict();
const authorityUsageRequestSchema = z.object({
  idempotencyKey: boundedString,
  scope: authorityUsageScopeSchema,
  estimate: z.object({
    tokens: safeNonNegative.optional(),
    cost: z.object({ currency: boundedString, value: z.number().finite().nonnegative() }).strict().optional(),
    actions: safeNonNegative.optional()
  }).strict()
}).strict();
const authorityUsageReservationSchema = z.object({
  providerReservationId: boundedString,
  idempotencyKey: boundedString,
  opaqueScope: boundedString
}).strict();
const pendingIssuanceSchema = z.object({
  kind: z.enum(['execution', 'leaf']),
  operationId: boundedString,
  requestDigest: digestSchema,
  request: z.unknown(),
  usageRequest: authorityUsageRequestSchema,
    providerReservation: authorityUsageReservationSchema.nullable(),
    status: z.enum(['intent', 'provider-reserved', 'release-pending', 'release-pending-unbound']),
  createdAt: strictRfc3339UtcSchema
}).strict();
const providerUsageRecordSchema = z.object({
  reservationId: boundedString,
  ticketHandleId: boundedString,
  operationId: boundedString,
  providerReservationId: boundedString,
  opaqueScope: boundedString,
  status: z.enum(['reserved', 'commit-pending', 'committed', 'release-pending', 'released']),
  sampleDigest: digestSchema.nullable()
}).strict();
const issueExecutionSchema = z.object({
  operationId: boundedString,
  controllerProof: controllerLeaseProofSchema,
  ticket: issueRootTicketInputSchema.omit({ lease: true })
}).strict();
const issueLeafSchema = z.object({
  operationId: boundedString,
  workstreamProof: workstreamLeaseProofSchema,
  ticket: delegateTicketInputSchema.omit({ lease: true })
}).strict();
const budgetOperationSchema = z.object({
  operationId: boundedString,
  nodeId: boundedString,
  leaseProof: z.union([controllerLeaseProofSchema, workstreamLeaseProofSchema])
}).strict();
const claimExecutionSchema = z.object({
  handle: boundedString,
  controllerProof: controllerLeaseProofSchema
}).strict();
const authorityPolicySchema = z.object({
  operationClasses: z.array(boundedString).max(1024).optional(),
  toolClasses: z.array(boundedString).max(1024).optional(),
  credentialClasses: z.array(boundedString).max(1024).optional(),
  approvalGrants: z.array(boundedString).max(1024).optional()
}).strict();

const pendingInitializationSchema = z.object({
  format: z.literal('harness-mdocs/run-authority'),
  schemaVersion: z.literal(2),
  stateKind: z.literal('initialization-pending'),
  runId: boundedString,
  projectId: boundedString,
  idempotencyKey: boundedString,
  initializationRequestDigest: digestSchema,
  attestationReservationId: boundedString,
  hostIdentity: hostIdentitySnapshotSchema,
  graphEpoch: safeNonNegative,
  cancellationGeneration: safeNonNegative,
    leaseTtlMs: z.number().int().positive().safe(),
    heartbeatIntervalMs: z.number().int().positive().safe(),
    createdAt: strictRfc3339UtcSchema
}).strict();

const activeRunAuthoritySchema = z.object({
  format: z.literal('harness-mdocs/run-authority'),
  schemaVersion: z.literal(2),
  stateKind: z.literal('initialized'),
  runId: boundedString,
  projectId: boundedString,
  lifecycle: z.enum(['active', 'cancelled']),
  idempotencyKey: boundedString,
  initializationRequestDigest: digestSchema,
  approvalEventId: boundedString,
  modeSelectionEventId: boundedString,
  approvedPlanDigest: digestSchema,
  approvedGraphDigest: digestSchema,
  graphId: boundedString,
  graphRevision: z.number().int().positive().safe(),
  graphEpoch: safeNonNegative,
  cancellationGeneration: safeNonNegative,
  approvalRef: boundedString,
  modeSelectionRef: boundedString,
  mode: z.enum(['milestone', 'autonomous']),
  hostIdentity: hostIdentitySnapshotSchema,
  runStartedAt: strictRfc3339UtcSchema,
  runDeadlineAt: strictRfc3339UtcSchema,
  wallClockHighWater: strictRfc3339UtcSchema,
  usageBinding: usageBindingSchema,
  compiled: z.unknown(),
  ticketState: ticketAuthorityStateSchema,
  leaseState: z.unknown(),
  budgets: budgetLedgerSchema,
  fanoutCounters: z.array(fanoutCounterSchema).max(4096),
  ticketDeadlines: z.array(ticketDeadlineSchema).max(4096),
  issuanceMappings: z.array(issuanceMappingSchema).max(4096),
  pendingIssuance: pendingIssuanceSchema.nullable(),
  providerUsage: z.array(providerUsageRecordSchema).max(4096),
  liveDescendants: safeNonNegative,
  totalDescendants: safeNonNegative,
  operationSequence: safeNonNegative
}).strict();

const runAuthorityStateSchema = z.discriminatedUnion('stateKind', [
  pendingInitializationSchema,
  activeRunAuthoritySchema
]);

export type PendingRunAuthorityState = z.infer<typeof pendingInitializationSchema>;
export type InitializedRunAuthorityState = z.infer<typeof activeRunAuthoritySchema> & {
  compiled: CompiledPlanGraph;
  leaseState: LeaseAuthorityState;
  ticketState: TicketAuthorityState;
  budgets: BudgetLedger;
};
export type RunAuthorityState = PendingRunAuthorityState | InitializedRunAuthorityState;

export interface InitializeRunAuthorityInput {
  idempotencyKey: string;
  approval: PlanApprovalEvent;
  modeSelection: ExecutionModeSelectionEvent;
  graphEpoch?: number;
  cancellationGeneration?: number;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
}

export interface TicketGrantRequest extends Omit<IssueRootTicketInput, 'lease'> {}
export interface LeafTicketGrantRequest extends Omit<DelegateTicketInput, 'lease'> {}

export interface IssueExecutionTicketInput {
  operationId: string;
  controllerProof: ControllerLeaseProof;
  ticket: TicketGrantRequest;
}

export interface IssueLeafTicketInput {
  operationId: string;
  workstreamProof: WorkstreamLeaseProof;
  ticket: LeafTicketGrantRequest;
}

export interface ClaimExecutionAndAcquireWorkstreamInput {
  handle: string;
  controllerProof: ControllerLeaseProof;
}

export interface BudgetOperationInput {
  operationId: string;
  nodeId: string;
  leaseProof: ControllerLeaseProof | WorkstreamLeaseProof;
}

export interface UsageAuthorityBinding {
  source: string;
  provider: string;
  model: string;
  priceTableVersion: string;
  currency: string;
}

export interface RunAuthorityManagerOptions {
  runId: string;
  projectId: string;
  compiled: CompiledPlanGraph;
  reader: ProtectedControllerStoreReader;
  writer: ProtectedControllerStoreWriter;
  attestationProvider: RecoverableAuthorityAttestationProvider;
  hostIdentityProvider: HostIdentityProvider;
  usageMeter: AuthorityUsageMeter;
  usageBinding: UsageAuthorityBinding;
  /** Bounded wait for trusted usage finalization during cancellation settlement. */
  usageSettlementTimeoutMs?: number;
  maxCasRetries?: number;
}

export interface RunAuthorityTestSources {
  now?: () => Date;
  monotonicClock?: () => number;
  clockDomainId?: () => string;
  randomBytes?: () => Buffer;
}

export type UsageSettlementIssue =
  | {
      readonly reservationId: string;
      readonly reason:
        | 'provider-release-pending'
        | 'provider-commit-pending'
        | 'cancelled-without-trusted-final';
    }
  | {
      readonly pendingOperationId: string;
      readonly idempotencyKey: string;
      readonly reason: 'pending-issuance-unresolved';
      readonly recovery: 'abortPendingIssuance';
    };

export interface RunAuthorityPublicSnapshot {
  readonly generation: number;
  readonly runId: string;
  readonly projectId: string;
  readonly lifecycle: 'active' | 'cancelled';
  readonly graphEpoch: number;
  readonly cancellationGeneration: number;
  readonly mode: 'milestone' | 'autonomous';
  readonly ticketCount: number;
  readonly liveDescendants: number;
  readonly totalDescendants: number;
  readonly reservationCount: number;
  readonly operationSequence: number;
  readonly budgetTotals: Readonly<BudgetLedger['totals']>;
  readonly cumulative: Readonly<BudgetLedger['cumulative']>;
  readonly nodeCounters: Readonly<BudgetLedger['nodeCounters']>;
  /** Unsettled usage sagas; non-empty means cancellation/recovery left work for operators. */
  readonly unsettledUsage: readonly UsageSettlementIssue[];
}

export interface PublicTicketInspection {
  readonly authority: false;
  readonly ticketHandleId: string;
  readonly role: 'EXECUTION' | 'LEAF';
  readonly expiresAt: string;
}

export interface RunAuthorityManager {
  initialize(input: InitializeRunAuthorityInput): Promise<RunAuthorityPublicSnapshot>;
  read(): Promise<RunAuthorityPublicSnapshot>;
  acquireControllerLease(): Promise<Readonly<ControllerLeaseRecord>>;
  heartbeatControllerLease(proof: ControllerLeaseProof): Promise<Readonly<ControllerLeaseRecord>>;
  releaseControllerLease(proof: ControllerLeaseProof): Promise<Readonly<ControllerLeaseRecord>>;
  issueExecutionTicket(input: IssueExecutionTicketInput): Promise<IssuedTicketHandle>;
  claimExecutionAndAcquireWorkstream(
    input: ClaimExecutionAndAcquireWorkstreamInput
  ): Promise<Readonly<WorkstreamLeaseRecord>>;
  heartbeatWorkstreamLease(input: { nodeId: string; proof: WorkstreamLeaseProof }):
    Promise<Readonly<WorkstreamLeaseRecord>>;
  releaseWorkstreamLease(input: { nodeId: string; proof: WorkstreamLeaseProof }):
    Promise<Readonly<WorkstreamLeaseRecord>>;
  issueLeafTicket(input: IssueLeafTicketInput): Promise<IssuedTicketHandle>;
  recoverPendingIssuance(): Promise<IssuedTicketHandle | null>;
  abortPendingIssuance(): Promise<boolean>;
  inspectTicket(handle: string): Promise<PublicTicketInspection>;
  revokeTicket(handle: string): Promise<boolean>;
  reconcileUsage(reservationId: string): Promise<Readonly<BudgetLedger>>;
  releaseReservation(reservationId: string): Promise<Readonly<BudgetLedger>>;
  recordRetry(input: BudgetOperationInput): Promise<Readonly<BudgetLedger>>;
  recordLocalFix(input: BudgetOperationInput): Promise<Readonly<BudgetLedger>>;
  recordReplacement(input: BudgetOperationInput): Promise<Readonly<BudgetLedger>>;
  recordResume(input: BudgetOperationInput): Promise<Readonly<BudgetLedger>>;
  cancel(): Promise<RunAuthorityPublicSnapshot>;
}

function fail(code: TicketAuthorityErrorCode, message: string): never {
  throw new TicketAuthorityError(code, message);
}

function hash(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalizeJson(value)).digest('hex')}`;
}

function derivedDeadline(startMs: number, minutes: number, description: string): string {
  const durationMs = minutes * 60_000;
  const deadlineMs = startMs + durationMs;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(durationMs) ||
      !Number.isSafeInteger(deadlineMs) || Math.abs(deadlineMs) > 8_640_000_000_000_000) {
    fail('invalid-input', `${description} is not Date-representable`);
  }
  try { return new Date(deadlineMs).toISOString(); } catch {
    fail('invalid-input', `${description} is not Date-representable`);
  }
}

function ownDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('invalid-input', `${description} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('invalid-input', `${description} must be plain`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key === 'symbol')) fail('invalid-input', `${description} contains symbol keys`);
  const expected = new Set([...required, ...optional]);
  const names = keys as string[];
  if (required.some(key => !names.includes(key)) || names.some(key => !expected.has(key))) {
    fail('invalid-input', `${description} has missing or unrecognized fields`);
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || !('value' in descriptor)) {
      fail('invalid-input', `${description}.${name} must be an enumerable data property`);
    }
    output[name] = descriptor.value;
  }
  return output;
}

function sameIdentity(left: HostIdentitySnapshot, right: HostIdentitySnapshot): boolean {
  return left.providerId === right.providerId && left.sessionRef === right.sessionRef &&
    left.principalRef === right.principalRef;
}

function compiledAuthorityPolicy(compiled: CompiledPlanGraph) {
  const policy = compiled.plan.payload.policy as Record<string, unknown>;
  const parsed = authorityPolicySchema.safeParse(policy.authority ?? {});
  if (!parsed.success) fail('invalid-graph', parsed.error.issues
    .map(issue => `policy.authority.${issue.path.join('.') || '$'}: ${issue.message}`).sort().join('; '));
  const canonical = (values: readonly string[] | undefined) => [...new Set(values ?? [])].sort();
  return canonicalAuthoritySnapshot({
    operationClasses: canonical(parsed.data.operationClasses),
    toolClasses: canonical(parsed.data.toolClasses),
    credentialClasses: canonical(parsed.data.credentialClasses),
    approvalGrants: canonical(parsed.data.approvalGrants)
  });
}

function identitySnapshot(identity: HostIdentity | null): Readonly<HostIdentitySnapshot> {
  const result = hostIdentitySnapshotSchema.safeParse(snapshotAuthorityData(identity));
  if (!result.success) fail('host-identity-mismatch', 'Trusted host identity is absent or malformed');
  return canonicalAuthoritySnapshot(result.data);
}

function sortedFanout(ticketState: TicketAuthorityState) {
  const counts = new Map<string, number>();
  for (const ticket of ticketState.tickets) {
    if (ticket.parentTicketHandleId) {
      counts.set(ticket.parentTicketHandleId, (counts.get(ticket.parentTicketHandleId) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([parentTicketHandleId, issuedChildren]) => ({
    parentTicketHandleId, issuedChildren
  })).sort((left, right) => left.parentTicketHandleId < right.parentTicketHandleId ? -1
    : left.parentTicketHandleId > right.parentTicketHandleId ? 1 : 0);
}

function expectedUsageEstimate(
  amounts: Record<string, number>,
  role: 'EXECUTION' | 'LEAF',
  currency: string
) {
  const minimum = (keys: string[]) => Math.min(...keys.map(key => amounts[key]));
  return {
    tokens: minimum(role === 'LEAF'
      ? ['tokensGlobal', 'tokensEo', 'tokensLeaf'] : ['tokensGlobal', 'tokensEo']),
    actions: minimum(role === 'LEAF'
      ? ['toolActionsGlobal', 'toolActionsEo', 'toolActionsLeaf'] : ['toolActionsGlobal', 'toolActionsEo']),
    cost: { currency, value: minimum(['costUsdGlobal', 'costUsdEo']) }
  };
}

function parseRunAuthorityState(
  value: unknown,
  expectedCompiled?: CompiledPlanGraph,
  expectedBinding?: { runId: string; projectId: string; usageBinding?: UsageAuthorityBinding }
): Readonly<RunAuthorityState> {
  let snapshot: unknown;
  try { snapshot = snapshotAuthorityData(value); } catch (error) {
    fail('invalid-state', error instanceof Error ? error.message : String(error));
  }
  const parsed = runAuthorityStateSchema.safeParse(snapshot);
  if (!parsed.success) fail('invalid-state', parsed.error.issues
    .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`).sort().join('; '));
  const state = parsed.data;
  if (expectedBinding && (state.runId !== expectedBinding.runId || state.projectId !== expectedBinding.projectId)) {
    fail('binding-mismatch', 'Persisted aggregate has different run/project binding');
  }
  if (state.stateKind === 'initialization-pending') return canonicalAuthoritySnapshot(state);

  const validation = validateCompiledPlanGraph(state.compiled);
  if (!validation.ok) fail('invalid-state', `Persisted compiled graph invalid: ${validation.reasons.join('; ')}`);
  const compiled = state.compiled as CompiledPlanGraph;
  if (expectedCompiled && canonicalizeJson(compiled) !== canonicalizeJson(expectedCompiled)) {
    fail('binding-mismatch', 'Persisted compiled graph differs from configured graph');
  }
  const leaseState = parseLeaseAuthorityState(state.leaseState);
  const budgets = parseBudgetLedger(state.budgets);
  const ticketState = state.ticketState;
  createTicketAuthorityBroker({
    compiled, runId: state.runId, projectId: state.projectId,
    graphEpoch: state.graphEpoch, cancellationGeneration: ticketState.cancellationGeneration,
    hostIdentityProvider: { currentHostIdentity: async () => null, bindHandle: () => {}, identityForHandle: () => null },
    state: ticketState, leaseState: () => leaseState
  });
  const exactBindings: [unknown, unknown, string][] = [
    [state.approvedPlanDigest, compiled.plan.digest, 'plan digest'],
    [state.approvedGraphDigest, compiled.graph.digest, 'graph digest'],
    [state.graphId, compiled.graph.id, 'graph ID'],
    [state.graphRevision, compiled.planRevision, 'graph revision'],
    [ticketState.runId, state.runId, 'ticket run'], [ticketState.projectId, state.projectId, 'ticket project'],
    [ticketState.graphEpoch, state.graphEpoch, 'ticket epoch'],
    [leaseState.runId, state.runId, 'lease run'], [leaseState.projectId, state.projectId, 'lease project'],
    [leaseState.graphEpoch, state.graphEpoch, 'lease epoch'],
    [leaseState.runStartedAt, state.runStartedAt, 'lease run start'],
    [leaseState.runDeadlineAt, state.runDeadlineAt, 'lease run deadline']
  ];
  for (const [actual, expected, name] of exactBindings) {
    if (actual !== expected) fail('invalid-state', `Persisted ${name} mismatch`);
  }
  const nestedCancellation = state.lifecycle === 'active'
    ? state.cancellationGeneration : state.cancellationGeneration - 1;
  if (ticketState.cancellationGeneration !== nestedCancellation ||
      leaseState.cancellationGeneration !== nestedCancellation) {
    fail('invalid-state', 'Nested cancellation generation mismatch');
  }
  if (Date.parse(state.runStartedAt) >= Date.parse(state.runDeadlineAt) ||
      Date.parse(state.wallClockHighWater) < Date.parse(state.runStartedAt) ||
      (leaseState.wallClockHighWater !== null &&
        Date.parse(state.wallClockHighWater) < Date.parse(leaseState.wallClockHighWater))) {
    fail('invalid-state', 'Run wall-time authority is inconsistent');
  }
  if (expectedBinding?.usageBinding &&
      canonicalizeJson(state.usageBinding) !== canonicalizeJson(expectedBinding.usageBinding)) {
    fail('binding-mismatch', 'Persisted usage-meter binding differs from configured binding');
  }
  const expectedApprovalRefs = [state.approvalRef, state.modeSelectionRef].sort();
  if (canonicalizeJson(ticketState.rootAuthority.approvalRefs) !== canonicalizeJson(expectedApprovalRefs)) {
    fail('invalid-state', 'Root authority approval refs differ from verified pair');
  }
  const policyAuthority = compiledAuthorityPolicy(compiled);
  const expectedRootAuthority = {
    roots: compiled.plan.payload.scope,
    operationClasses: policyAuthority.operationClasses,
    toolClasses: policyAuthority.toolClasses,
    credentialClasses: policyAuthority.credentialClasses,
    approvalRefs: expectedApprovalRefs,
    budgets: compiled.plan.payload.budgets,
    expiresAt: state.runDeadlineAt,
    maxChildDepth: 2,
    maxFanout: (compiled.plan.payload.budgets as ExecutionPlanBudgets).maxActiveExecutionOrchestrators
  };
  if (canonicalizeJson(ticketState.rootAuthority) !== canonicalizeJson(expectedRootAuthority)) {
    fail('invalid-state', 'Root authority does not reconstruct from compiled policy and verified approval');
  }
  for (const dimension of Object.keys(compiled.plan.payload.budgets)) {
    if (budgets.totals[dimension as keyof typeof budgets.totals]?.limit !==
        compiled.plan.payload.budgets[dimension as keyof typeof compiled.plan.payload.budgets]) {
      fail('invalid-state', `Approved budget ${dimension} mismatch`);
    }
  }
  const reservations = new Map(budgets.reservations.map(item => [item.ticketHandleId, item]));
  const deadlines = new Map(state.ticketDeadlines.map(item => [item.ticketHandleId, item]));
  const mappings = new Map(state.issuanceMappings.map(item => [item.ticketHandleId, item]));
  const providerUsage = new Map(state.providerUsage.map(item => [item.ticketHandleId, item]));
  if (reservations.size !== ticketState.tickets.length || deadlines.size !== ticketState.tickets.length ||
      state.ticketDeadlines.length !== deadlines.size || mappings.size !== ticketState.tickets.length ||
      state.issuanceMappings.length !== mappings.size ||
      providerUsage.size !== ticketState.tickets.length || state.providerUsage.length !== providerUsage.size ||
      new Set(state.issuanceMappings.map(item => item.operationId)).size !== state.issuanceMappings.length) {
    fail('invalid-state', 'Tickets, reservations, deadlines, usage, and issuance mappings are not one-to-one');
  }
  if (new Set(state.providerUsage.map(item => item.providerReservationId)).size !== state.providerUsage.length ||
      new Set(state.providerUsage.map(item => item.opaqueScope)).size !== state.providerUsage.length) {
    fail('invalid-state', 'Provider usage reservation IDs and scopes must be unique');
  }
  for (const record of ticketState.tickets) {
    const handle = record.ticket.ticketHandleId;
    const reservation = reservations.get(handle);
    const deadline = deadlines.get(handle);
    const mapping = mappings.get(handle);
    const providerRecord = providerUsage.get(handle);
    const request = mapping?.request as Record<string, any> | undefined;
    const requestTicket = request?.ticket as Record<string, any> | undefined;
    const requestedExpiryMs = Date.parse(requestTicket?.expiresAt ?? '');
    if (!Number.isFinite(requestedExpiryMs)) {
      fail('invalid-state', 'Persisted issuance request expiry is invalid');
    }
    const parentDeadline = record.parentTicketHandleId
      ? deadlines.get(record.parentTicketHandleId)?.hardDeadlineAt
      : undefined;
    const roleMinutes = record.ticket.recipientRole === 'EXECUTION'
      ? (compiled.plan.payload.budgets as ExecutionPlanBudgets).wallTimeMinutesEo
      : (compiled.plan.payload.budgets as ExecutionPlanBudgets).wallTimeMinutesLeaf;
    const expectedHardDeadline = new Date(Math.min(
      Date.parse(state.runDeadlineAt), Date.parse(deadline?.startedAt ?? state.runStartedAt) + roleMinutes * 60_000,
      parentDeadline ? Date.parse(parentDeadline) : Number.MAX_SAFE_INTEGER
    )).toISOString();
    if (!reservation || !deadline || !mapping || !providerRecord ||
        providerRecord.reservationId !== reservation.reservationId ||
        providerRecord.operationId !== mapping.operationId ||
        (providerRecord.status === 'reserved' && reservation.status !== 'pending') ||
        (['release-pending', 'released'].includes(providerRecord.status) &&
          reservation.status !== 'released') ||
        (['reserved', 'release-pending', 'released'].includes(providerRecord.status) &&
          providerRecord.sampleDigest !== null) ||
        (['commit-pending', 'committed'].includes(providerRecord.status) &&
          (reservation.status !== 'committed' || providerRecord.sampleDigest !== reservation.sampleDigest)) ||
        reservation.parentTicketHandleId !== record.parentTicketHandleId ||
        reservation.scope !== record.ticket.scope || reservation.role !== record.ticket.recipientRole ||
        canonicalizeJson(reservation.amounts) !== canonicalizeJson(record.ticket.budgets) ||
        deadline.role !== record.ticket.recipientRole ||
        Date.parse(record.ticket.expiresAt) > Date.parse(deadline.hardDeadlineAt) ||
        reservation.startedAt !== deadline.startedAt || reservation.deadlineAt !== record.ticket.expiresAt ||
        deadline.hardDeadlineAt !== expectedHardDeadline ||
        mapping.reservationId !== reservation.reservationId || mapping.operationId !== request?.operationId ||
        mapping.kind !== (record.ticket.recipientRole === 'EXECUTION' ? 'execution' : 'leaf') ||
        requestTicket?.nodeId !== record.ticket.nodeId || requestTicket?.scope !== record.ticket.scope ||
        (record.parentTicketHandleId !== null && requestTicket?.parentHandle !== record.parentTicketHandleId) ||
        canonicalizeJson(requestTicket?.budgets ?? {}) !== canonicalizeJson(record.ticket.budgets) ||
        record.ticket.expiresAt !== new Date(Math.min(
          requestedExpiryMs, Date.parse(deadline.hardDeadlineAt)
        )).toISOString() ||
        hash(mapping.request) !== mapping.requestDigest || mapping.request === null ||
        typeof mapping.request !== 'object') {
      fail('invalid-state', `Ticket "${handle}" aggregate linkage is inconsistent`);
    }
    assertRoleBudgetAmounts(record.ticket.recipientRole as 'EXECUTION' | 'LEAF', reservation.amounts);
  }
  if (canonicalizeJson(sortedFanout(ticketState)) !== canonicalizeJson(state.fanoutCounters)) {
    fail('invalid-state', 'Fanout counters do not reconstruct from ticket records');
  }
  const live = ticketState.tickets.filter(ticket => ticket.lifecycle === 'active').length;
  if (state.totalDescendants !== ticketState.tickets.length || state.liveDescendants !== live ||
      budgets.operationEvents.filter(event => event.kind === 'spawn').length !== ticketState.tickets.length) {
    fail('invalid-state', 'Descendant/spawn counters do not reconstruct from tickets');
  }
  const limits = compiled.plan.payload.budgets as ExecutionPlanBudgets;
  if (state.totalDescendants > limits.maxGlobalDescendants ||
      state.liveDescendants > limits.maxGlobalDescendants ||
      budgets.cumulative.spawns > limits.maxCumulativeSpawns) {
    fail('invalid-state', 'Persisted descendant/spawn count exceeds approved limits');
  }
  for (const mapping of state.issuanceMappings) {
    const event = budgets.operationEvents.find(item => item.eventId === mapping.operationId && item.kind === 'spawn');
    const ticket = ticketState.tickets.find(item => item.ticket.ticketHandleId === mapping.ticketHandleId);
    if (!event || !ticket || event.nodeId !== ticket.ticket.nodeId) {
      fail('invalid-state', 'Spawn events do not match issuance mappings');
    }
  }
  if (state.pendingIssuance) {
    const pending = state.pendingIssuance;
    const scope = pending.usageRequest.scope;
    const request = pending.request as Record<string, unknown>;
    const ticket = request?.ticket as Record<string, unknown> | undefined;
    const role = pending.kind === 'execution' ? 'EXECUTION' : 'LEAF';
    const estimate = ticket && typeof ticket.budgets === 'object' && ticket.budgets !== null
      ? expectedUsageEstimate(
          ticket.budgets as Record<string, number>, role, state.usageBinding.currency
        )
      : null;
    const provider = pending.providerReservation;
    const expectedScope = `opaque-usage-scope:${hash({
      projectId: state.projectId, runId: state.runId,
      operationId: pending.operationId, requestDigest: pending.requestDigest
    }).slice(7)}`;
    if (hash(pending.request) !== pending.requestDigest || request?.operationId !== pending.operationId ||
        state.issuanceMappings.some(item => item.operationId === pending.operationId) ||
        pending.usageRequest.idempotencyKey !==
          `ticket-usage:${state.projectId}:${state.runId}:${pending.operationId}:${pending.requestDigest}` ||
        scope.opaqueScope !== expectedScope ||
        scope.runId !== state.runId || scope.projectId !== state.projectId ||
        scope.operationId !== pending.operationId || scope.ticketRequestDigest !== pending.requestDigest ||
        scope.reservationId !== `reservation:${hash({
          projectId: state.projectId, runId: state.runId, operationId: pending.operationId
        }).slice(7)}` || scope.nodeId !== ticket?.nodeId ||
        canonicalizeJson(pending.usageRequest.estimate) !== canonicalizeJson(estimate) ||
        ((pending.status === 'intent') !== (provider === null)) ||
        (provider !== null && (provider.idempotencyKey !== pending.usageRequest.idempotencyKey ||
          provider.opaqueScope !== scope.opaqueScope))) {
      fail('invalid-state', 'Pending provider usage intent binding is inconsistent');
    }
  }
  const graphNodes = new Set(compiled.graph.payload.nodes.map(node => node.nodeId));
  for (const counter of budgets.nodeCounters) {
    if (!graphNodes.has(counter.nodeId)) fail('invalid-state', 'Budget counter references unknown graph node');
  }
  for (const workstream of leaseState.workstreamLeases) {
    const node = compiled.graph.payload.nodes.find(item => item.nodeId === workstream.nodeId);
    if (!node || node.ownerRole !== 'EXECUTION') fail('invalid-state', 'Lease references non-EO graph node');
    const eoTicket = ticketState.tickets.find(item =>
      item.ticket.ticketHandleId === workstream.ticketHandleId);
    if (!eoTicket || eoTicket.nonceStatus !== 'claimed' ||
        eoTicket.ticket.nodeId !== workstream.nodeId || eoTicket.ticket.recipientRole !== 'EXECUTION' ||
        workstream.authorityDeadlineAt !== eoTicket.ticket.expiresAt ||
        !sameIdentity(workstream.holder, eoTicket.hostIdentity)) {
      fail('invalid-state', 'Workstream lease deadline/ticket lineage mismatch');
    }
    const controller = leaseState.controllerLease;
    if (!controller || workstream.controllerLeaseRef !== controller.leaseRef ||
        workstream.controllerFence !== controller.fence) {
      if (workstream.lifecycle === 'active') {
        fail('invalid-state', 'Active workstream controller lineage mismatch');
      }
    }
  }
  for (const record of ticketState.tickets.filter(item =>
    item.ticket.recipientRole === 'LEAF' && item.lifecycle === 'active')) {
    const parent = ticketState.tickets.find(item =>
      item.ticket.ticketHandleId === record.parentTicketHandleId);
    const workstream = parent && leaseState.workstreamLeases.find(item =>
      item.ticketHandleId === parent.ticket.ticketHandleId);
    if (!parent || !workstream || workstream.nodeId !== parent.ticket.nodeId ||
        record.lease.ref !== workstream.leaseRef ||
        record.lease.generation !== workstream.generation || record.lease.fence !== workstream.fence) {
      fail('invalid-state', 'Leaf ticket workstream lineage mismatch');
    }
  }
  if (leaseState.controllerLease && leaseState.controllerLease.authorityDeadlineAt !== state.runDeadlineAt) {
    fail('invalid-state', 'Controller lease deadline differs from run deadline');
  }
  return canonicalAuthoritySnapshot({ ...state, compiled, leaseState, budgets }) as Readonly<RunAuthorityState>;
}

function initialized(
  state: Readonly<RunAuthorityState>,
  _allowPendingIssuance = false
): Readonly<InitializedRunAuthorityState> {
  if (state.stateKind !== 'initialized') {
    fail('initialization-recovery-required', 'Run initialization is pending reconciliation');
  }
  if (state.lifecycle !== 'active') fail('cancelled', 'Run authority is cancelled');
  return state;
}

function initializedForAccounting(
  state: Readonly<RunAuthorityState>
): Readonly<InitializedRunAuthorityState> {
  if (state.stateKind !== 'initialized') {
    fail('initialization-recovery-required', 'Run initialization is pending reconciliation');
  }
  return state;
}

function publicSnapshot(snapshot: AuthorityRepositorySnapshot<RunAuthorityState>): RunAuthorityPublicSnapshot {
  if (snapshot.state.stateKind !== 'initialized') {
    fail('initialization-recovery-required', 'Run initialization is pending reconciliation');
  }
  const state = snapshot.state;
  const unsettledUsage: UsageSettlementIssue[] = [];
  if (state.pendingIssuance) {
    unsettledUsage.push({
      pendingOperationId: state.pendingIssuance.operationId,
      idempotencyKey: state.pendingIssuance.usageRequest.idempotencyKey,
      reason: 'pending-issuance-unresolved',
      recovery: 'abortPendingIssuance'
    });
  }
  for (const usage of state.providerUsage) {
    if (usage.status === 'release-pending') {
      unsettledUsage.push({ reservationId: usage.reservationId, reason: 'provider-release-pending' });
    } else if (usage.status === 'commit-pending') {
      unsettledUsage.push({ reservationId: usage.reservationId, reason: 'provider-commit-pending' });
    } else if (usage.status === 'reserved' && state.lifecycle === 'cancelled') {
      unsettledUsage.push({ reservationId: usage.reservationId, reason: 'cancelled-without-trusted-final' });
    }
  }
  const issueSortKey = (issue: UsageSettlementIssue): string =>
    'reservationId' in issue ? issue.reservationId : `pending:${issue.pendingOperationId}`;
  unsettledUsage.sort((left, right) => {
    const leftKey = issueSortKey(left);
    const rightKey = issueSortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return canonicalAuthoritySnapshot({
    generation: snapshot.generation, runId: state.runId, projectId: state.projectId,
    lifecycle: state.lifecycle, graphEpoch: state.graphEpoch,
    cancellationGeneration: state.cancellationGeneration, mode: state.mode,
    ticketCount: state.ticketState.tickets.length,
    liveDescendants: state.liveDescendants, totalDescendants: state.totalDescendants,
    reservationCount: state.budgets.reservations.length, operationSequence: state.operationSequence,
    budgetTotals: state.budgets.totals, cumulative: state.budgets.cumulative,
    nodeCounters: state.budgets.nodeCounters, unsettledUsage
  });
}

function createManager(
  options: RunAuthorityManagerOptions,
  testSources: RunAuthorityTestSources = {}
): RunAuthorityManager {
  const graphValidation = validateCompiledPlanGraph(options.compiled);
  if (!graphValidation.ok) fail('invalid-graph', graphValidation.reasons.join('; '));
  const compiled = snapshotAuthorityData(options.compiled) as CompiledPlanGraph;
  const approved = compiled.plan.payload.budgets as ExecutionPlanBudgets;
  const authorityPolicy = compiledAuthorityPolicy(compiled);
  const usageBinding = usageBindingSchema.parse(snapshotAuthorityData(options.usageBinding));
  const runId = options.runId;
  const projectId = options.projectId;
  const attestationProvider = options.attestationProvider;
  const hostIdentityProvider = options.hostIdentityProvider;
  const usageMeter = options.usageMeter;
  if (!attestationProvider || typeof attestationProvider.reservePair !== 'function' ||
      typeof attestationProvider.verifyReservedPair !== 'function' ||
      typeof attestationProvider.reconcileReservedPair !== 'function') {
    fail('invalid-input', 'Recoverable trusted attestation provider is required');
  }
  if (!usageMeter || typeof usageMeter.reserve !== 'function' ||
      typeof usageMeter.finalize !== 'function' || typeof usageMeter.commit !== 'function' ||
      typeof usageMeter.release !== 'function') {
    fail('invalid-input', 'Reservation-capable trusted usage meter is required');
  }
  const usageSettlementTimeoutMs = options.usageSettlementTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(usageSettlementTimeoutMs) || usageSettlementTimeoutMs <= 0) {
    fail('invalid-input', 'Usage settlement timeout must be a positive safe integer');
  }
  const expectedBinding = { runId, projectId, usageBinding };
  const bootClockDomainId = `clock-domain:${crypto.randomBytes(32).toString('base64url')}`;
  const nowSource = testSources.now ?? (() => new Date());
  const entropy = (): Buffer => {
    const bytes = testSources.randomBytes ? testSources.randomBytes() : crypto.randomBytes(32);
    if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > 128) {
      fail('random-source-invalid', 'Authority entropy source must return 32..128 bytes');
    }
    return Buffer.from(bytes);
  };
  const leaseSources: LeaseSources = {
    wallClock: nowSource,
    monotonicClock: testSources.monotonicClock,
    clockDomainId: testSources.clockDomainId ?? (() => bootClockDomainId),
    testOnlyRandomBytes: testSources.randomBytes ? entropy : undefined
  };
  const repository: ProtectedAuthorityRepository<RunAuthorityState> = createProtectedAuthorityRepository({
    runId, projectId,
    reader: options.reader, writer: options.writer,
    parseState: value => parseRunAuthorityState(value, compiled, expectedBinding),
    maxCasRetries: options.maxCasRetries
  });

  function now(state?: InitializedRunAuthorityState): { at: string; ms: number } {
    let date: Date;
    try { date = nowSource(); } catch { fail('clock-invalid', 'Trusted wall clock failed'); }
    let ms: number;
    try { ms = Date.prototype.getTime.call(date!); } catch { fail('clock-invalid', 'Trusted wall clock invalid'); }
    if (!(date! instanceof Date) || !Number.isSafeInteger(ms!)) fail('clock-invalid', 'Trusted wall clock invalid');
    if (state && ms! < Date.parse(state.wallClockHighWater)) fail('clock-regression', 'Run wall clock regressed');
    return { at: new Date(ms!).toISOString(), ms: ms! };
  }

  async function currentIdentity(
    state?: InitializedRunAuthorityState,
    enforceDeadline = true
  ): Promise<Readonly<HostIdentitySnapshot>> {
    let identity: HostIdentity | null;
    try { identity = await hostIdentityProvider.currentHostIdentity(); } catch {
      fail('host-identity-mismatch', 'Trusted host identity provider failed');
    }
    const snapshot = identitySnapshot(identity!);
    if (state && !sameIdentity(snapshot, state.hostIdentity)) {
      fail('host-identity-mismatch', 'Current trusted host identity differs from run owner');
    }
    if (state && enforceDeadline && now(state).ms >= Date.parse(state.runDeadlineAt)) {
      fail('expired-ticket', 'Run wall-time deadline elapsed');
    }
    return snapshot;
  }

  function broker(state: InitializedRunAuthorityState) {
    return createTicketAuthorityBroker({
      compiled, runId: state.runId, projectId: state.projectId,
      graphEpoch: state.graphEpoch, cancellationGeneration: state.ticketState.cancellationGeneration,
      hostIdentityProvider, state: state.ticketState,
      now: nowSource,
      leaseState: () => state.leaseState, leaseSources
    });
  }

  function binding(state: InitializedRunAuthorityState, holder: HostIdentitySnapshot) {
    return {
      runId: state.runId, projectId: state.projectId, graphEpoch: state.graphEpoch,
      cancellationGeneration: state.ticketState.cancellationGeneration, holder
    };
  }

  function nextSequence(state: InitializedRunAuthorityState): number {
    if (state.operationSequence >= Number.MAX_SAFE_INTEGER) fail('invalid-state', 'Operation sequence exhausted');
    return state.operationSequence + 1;
  }

  async function withTimeout<T>(promise: Promise<T>, ms: number, description: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out`)), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function checkedState(state: InitializedRunAuthorityState, change: Record<string, unknown>) {
    return parseRunAuthorityState({ ...state, ...change }, compiled, expectedBinding) as InitializedRunAuthorityState;
  }

  function trustedAttestationResult(value: AuthorityAttestationResult, reservationId: string) {
    const snapshot = snapshotAuthorityData(value);
    if (!snapshot || typeof snapshot !== 'object' || !('ok' in snapshot) || snapshot.ok !== true) {
      const reason = snapshot && typeof snapshot === 'object' && 'reason' in snapshot
        ? String(snapshot.reason) : 'trusted attestation did not verify';
      fail('initialization-recovery-required', reason);
    }
    const parsed = attestationResultSchema.safeParse(snapshot);
    if (!parsed.success || parsed.data.reservationId !== reservationId ||
        parsed.data.approvalEventId === parsed.data.modeSelectionEventId ||
        parsed.data.approvalRef === parsed.data.modeSelectionRef) {
      fail('initialization-recovery-required', 'Trusted attestation reconciliation result is malformed');
    }
    return parsed.data;
  }

  async function finalizeInitialization(
    pending: PendingRunAuthorityState,
    resultValue: AuthorityAttestationResult
  ): Promise<RunAuthorityPublicSnapshot> {
    const result = trustedAttestationResult(resultValue, pending.attestationReservationId);
    if (result.initializationRequestDigest !== pending.initializationRequestDigest ||
        result.projectId !== projectId || result.hostSessionRef !== pending.hostIdentity.sessionRef ||
        result.principalRef !== pending.hostIdentity.principalRef ||
        result.planDigest !== compiled.plan.digest || result.graphDigest !== compiled.graph.digest ||
        result.planRevision !== compiled.planRevision) {
      fail('initialization-recovery-required', 'Trusted attestation result binding mismatch');
    }
    const createdMs = Date.parse(pending.createdAt);
    const runDeadlineAt = derivedDeadline(createdMs, approved.wallTimeMinutesRun, 'Run wall deadline');
    const exactRefs = [result.approvalRef, result.modeSelectionRef].sort();
    const rootAuthority = {
      roots: compiled.plan.payload.scope,
      operationClasses: authorityPolicy.operationClasses,
      toolClasses: authorityPolicy.toolClasses,
      credentialClasses: authorityPolicy.credentialClasses,
      approvalRefs: exactRefs,
      budgets: approved,
      expiresAt: runDeadlineAt,
      maxChildDepth: 2,
      maxFanout: approved.maxActiveExecutionOrchestrators
    };
    const leaseState = parseLeaseAuthorityState({
      format: 'harness-mdocs/lease-authority', schemaVersion: 1,
      runId, projectId, graphEpoch: pending.graphEpoch,
      cancellationGeneration: pending.cancellationGeneration,
      ttlMs: pending.leaseTtlMs, heartbeatIntervalMs: pending.heartbeatIntervalMs,
      runStartedAt: pending.createdAt, runDeadlineAt,
      wallClockHighWater: null, monotonicHighWaters: [],
      controllerGenerationHighWater: 0, controllerFenceHighWater: 0,
      controllerLease: null, workstreamHighWaters: [], workstreamLeases: []
    });
    const ticketBroker = createTicketAuthorityBroker({
      compiled, runId, projectId, graphEpoch: pending.graphEpoch,
      cancellationGeneration: pending.cancellationGeneration,
      hostIdentityProvider, rootAuthority,
      now: nowSource,
      leaseState: () => leaseState, leaseSources
    });
    const finalState = parseRunAuthorityState({
      format: 'harness-mdocs/run-authority', schemaVersion: 2, stateKind: 'initialized',
      runId, projectId, lifecycle: 'active',
      idempotencyKey: pending.idempotencyKey,
      initializationRequestDigest: pending.initializationRequestDigest,
      approvalEventId: result.approvalEventId, modeSelectionEventId: result.modeSelectionEventId,
      approvedPlanDigest: compiled.plan.digest, approvedGraphDigest: compiled.graph.digest,
      graphId: compiled.graph.id, graphRevision: compiled.planRevision,
      graphEpoch: pending.graphEpoch, cancellationGeneration: pending.cancellationGeneration,
      approvalRef: result.approvalRef, modeSelectionRef: result.modeSelectionRef,
      mode: result.mode, hostIdentity: pending.hostIdentity,
      runStartedAt: pending.createdAt, runDeadlineAt, wallClockHighWater: pending.createdAt,
      usageBinding, compiled, ticketState: ticketBroker.snapshot(), leaseState,
      budgets: createBudgetLedger(approved, usageBinding.currency), fanoutCounters: [],
      ticketDeadlines: [], issuanceMappings: [], pendingIssuance: null, providerUsage: [],
      liveDescendants: 0, totalDescendants: 0, operationSequence: 0
    }, compiled, expectedBinding);
    try {
      const finalized = await repository.transact({
        digest: pending.initializationRequestDigest,
        reservationId: pending.attestationReservationId
      }, state => {
        if (state.stateKind === 'initialized' &&
            state.initializationRequestDigest === pending.initializationRequestDigest) {
          return { state: state as RunAuthorityState, result: true };
        }
        if (state.stateKind !== 'initialization-pending' ||
            state.initializationRequestDigest !== pending.initializationRequestDigest ||
            state.attestationReservationId !== pending.attestationReservationId ||
            !sameIdentity(state.hostIdentity, pending.hostIdentity)) {
          fail('initialization-recovery-required', 'Pending initialization binding changed');
        }
        return { state: finalState as RunAuthorityState, result: true };
      });
      return publicSnapshot(finalized);
    } catch (error) {
      const recovered = await repository.read();
      if (recovered?.state.stateKind === 'initialized' &&
          recovered.state.initializationRequestDigest === pending.initializationRequestDigest) {
        return publicSnapshot(recovered);
      }
      fail('initialization-recovery-required',
        `Trusted attestation verified but initialization finalize is unresolved: ${
          error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function reconcilePendingInitialization(
    pending: PendingRunAuthorityState
  ): Promise<RunAuthorityPublicSnapshot> {
    const host = await currentIdentity();
    if (!sameIdentity(host, pending.hostIdentity)) {
      fail('initialization-recovery-required', 'Pending initialization belongs to another host identity');
    }
    let result: AuthorityAttestationResult | null;
    try {
      result = await attestationProvider.reconcileReservedPair(pending.attestationReservationId);
      if (!result) result = await attestationProvider.verifyReservedPair(pending.attestationReservationId);
    } catch (error) {
      fail('initialization-recovery-required',
        `Trusted attestation reservation cannot reconcile: ${error instanceof Error ? error.message : String(error)}`);
    }
    return finalizeInitialization(pending, result!);
  }

  function assertAncestorsActive(state: InitializedRunAuthorityState, handle: string): void {
    let record = state.ticketState.tickets.find(item => item.ticket.ticketHandleId === handle);
    if (!record) fail('unknown-handle', 'Unknown opaque ticket handle');
    const seen = new Set<string>();
    while (record) {
      const currentHandle = record.ticket.ticketHandleId;
      if (seen.has(currentHandle)) fail('invalid-state', 'Ticket parent cycle');
      seen.add(currentHandle);
      if (record.lifecycle !== 'active') fail('inactive-ticket', 'Ticket or ancestor is revoked');
      record = record.parentTicketHandleId
        ? state.ticketState.tickets.find(item => item.ticket.ticketHandleId === record!.parentTicketHandleId)
        : undefined;
      if (record === undefined && [...seen].length > 1) {
        const child = state.ticketState.tickets.find(item => item.ticket.ticketHandleId === currentHandle)!;
        if (child.parentTicketHandleId) fail('invalid-state', 'Ticket ancestor is absent');
      }
    }
  }

  function reservationId(operationId: string): string {
    return `reservation:${hash({ projectId, runId, operationId }).slice(7)}`;
  }

  function hardDeadline(
    state: InitializedRunAuthorityState,
    role: 'EXECUTION' | 'LEAF',
    startedMs: number,
    parentDeadline?: string
  ): string {
    const minutes = role === 'EXECUTION' ? approved.wallTimeMinutesEo : approved.wallTimeMinutesLeaf;
    const roleDeadline = derivedDeadline(startedMs, minutes, `${role} wall deadline`);
    const candidates = [Date.parse(state.runDeadlineAt), Date.parse(roleDeadline)];
    if (parentDeadline) candidates.push(Date.parse(parentDeadline));
    return new Date(Math.min(...candidates)).toISOString();
  }

  function mappingForOperation(state: InitializedRunAuthorityState, operationId: string, request: unknown) {
    const existing = state.issuanceMappings.find(item => item.operationId === operationId);
    if (!existing) return undefined;
    if (existing.requestDigest !== hash(request)) fail('reservation-conflict', 'Issuance operation payload changed');
    return canonicalAuthoritySnapshot({ handle: existing.ticketHandleId }) as IssuedTicketHandle;
  }

  async function prepareIssuedState(
    state: InitializedRunAuthorityState,
    detached: IssueExecutionTicketInput | IssueLeafTicketInput,
    kind: 'execution' | 'leaf',
    request: unknown,
    providerReservation?: { providerReservationId: string; opaqueScope: string }
  ) {
    const identity = await currentIdentity(state);
    const reading = now(state);
    if (state.totalDescendants >= approved.maxGlobalDescendants ||
        state.liveDescendants >= approved.maxGlobalDescendants ||
        state.budgets.cumulative.spawns >= approved.maxCumulativeSpawns) {
      fail('budget-exceeded', 'Global descendant or cumulative spawn budget exhausted');
    }
    const localBroker = broker(state);
    let issued: IssuedTicketHandle;
    let parentHandle: string | null;
    let role: 'EXECUTION' | 'LEAF';
    let deadline: string;
    let ticketInput: IssueRootTicketInput | DelegateTicketInput;
    if (kind === 'execution') {
      const value = detached as IssueExecutionTicketInput;
      validateControllerLease(state.leaseState, {
        ...binding(state, identity), proof: value.controllerProof
      }, leaseSources);
      if (state.ticketState.tickets.filter(item =>
        item.parentTicketHandleId === null && item.lifecycle === 'active').length >=
        approved.maxActiveExecutionOrchestrators) {
        fail('budget-exceeded', 'Active execution-orchestrator budget exhausted');
      }
      role = 'EXECUTION'; parentHandle = null;
      deadline = hardDeadline(state, role, reading.ms);
      const charged = assertRoleBudgetAmounts(role, value.ticket.budgets ?? {});
      ticketInput = {
        ...value.ticket,
        budgets: charged,
        expiresAt: new Date(Math.min(Date.parse(value.ticket.expiresAt), Date.parse(deadline))).toISOString(),
        lease: controllerLeasePlaceholder(state.leaseState.controllerLease!)
      };
      issued = await localBroker.issueRoot(ticketInput);
    } else {
      const value = detached as IssueLeafTicketInput;
      parentHandle = value.ticket.parentHandle;
      assertAncestorsActive(state, parentHandle);
      const parent = state.ticketState.tickets.find(item => item.ticket.ticketHandleId === parentHandle)!;
      const parentDeadline = state.ticketDeadlines.find(item => item.ticketHandleId === parentHandle)!;
      validateWorkstreamLease(state.leaseState, {
        ...binding(state, identity), nodeId: parent.ticket.nodeId, proof: value.workstreamProof
      }, leaseSources);
      const children = state.ticketState.tickets.filter(item => item.parentTicketHandleId === parentHandle).length;
      if (children >= parent.ticket.maxFanout || children >= approved.maxLeavesPerEO) {
        fail('attenuation-denied', 'Parent ticket fanout exhausted');
      }
      role = 'LEAF';
      deadline = hardDeadline(state, role, reading.ms, parentDeadline.hardDeadlineAt);
      const charged = assertRoleBudgetAmounts(role, value.ticket.budgets ?? {});
      ticketInput = {
        ...value.ticket,
        budgets: charged,
        expiresAt: new Date(Math.min(Date.parse(value.ticket.expiresAt), Date.parse(deadline))).toISOString(),
        lease: workstreamLeasePlaceholder(state.leaseState.workstreamLeases.find(
          item => item.nodeId === parent.ticket.nodeId)!)
      };
      issued = await localBroker.delegate(ticketInput as DelegateTicketInput);
    }
    const normalizedTicket = localBroker.snapshot().tickets.find(
      item => item.ticket.ticketHandleId === issued.handle)!.ticket;
    const id = reservationId(detached.operationId);
    let budgets = reserveBudget(state.budgets, {
      reservationId: id, ticketHandleId: issued.handle, parentTicketHandleId: parentHandle,
      amounts: normalizedTicket.budgets, scope: normalizedTicket.scope, role,
      startedAt: reading.at, deadlineAt: normalizedTicket.expiresAt
    });
    budgets = recordBudgetOperation(budgets, {
      eventId: detached.operationId, nodeId: normalizedTicket.nodeId,
      operation: kind === 'execution' ? 'issue-execution' : 'issue-leaf', kind: 'spawn'
    });
    const mapping = {
      operationId: detached.operationId, kind, requestDigest: hash(request), request,
      ticketHandleId: issued.handle, reservationId: id
    };
    const ticketState = localBroker.snapshot();
    const providerUsage = providerReservation ? [...state.providerUsage, {
      reservationId: id, ticketHandleId: issued.handle, operationId: detached.operationId,
      providerReservationId: providerReservation.providerReservationId,
      opaqueScope: providerReservation.opaqueScope,
      status: 'reserved' as const, sampleDigest: null
    }] : state.providerUsage;
    const next = checkedState(state, {
      ticketState, budgets, providerUsage, pendingIssuance: null,
      issuanceMappings: [...state.issuanceMappings, mapping],
      ticketDeadlines: [...state.ticketDeadlines, {
        ticketHandleId: issued.handle, role, startedAt: reading.at, hardDeadlineAt: deadline
      }],
      fanoutCounters: sortedFanout(ticketState),
      liveDescendants: state.liveDescendants + 1,
      totalDescendants: state.totalDescendants + 1,
      operationSequence: nextSequence(state), wallClockHighWater: reading.at
    });
    return { state: next, issued, reservationId: id, normalizedTicket };
  }

  function samePending(
    left: z.infer<typeof pendingIssuanceSchema>,
    right: z.infer<typeof pendingIssuanceSchema>
  ): boolean {
    return left.operationId === right.operationId && left.requestDigest === right.requestDigest;
  }

  interface OrphanReleaseOutcome {
    /** True when this flow issued the provider release call. */
    readonly released: boolean;
    /** True when the saga finalized elsewhere; live ticket usage is never released. */
    readonly finalized: boolean;
    /** True when a same-provider bind is in flight; typed retryable, never stolen. */
    readonly inFlight: boolean;
  }

  type BindOutcome =
    | { readonly kind: 'bound'; readonly pending: z.infer<typeof pendingIssuanceSchema> }
    | { readonly kind: 'already-finalized'; readonly handle: IssuedTicketHandle };

  async function bindPendingProvider(
    pending: z.infer<typeof pendingIssuanceSchema>,
    accountingOnly = false
  ): Promise<BindOutcome> {
    if (pending.providerReservation) return { kind: 'bound', pending };
    let providerValue: unknown;
    try { providerValue = await usageMeter.reserve(pending.usageRequest); } catch (error) {
      fail('reservation-unresolved',
        `Trusted usage reservation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const provider = authorityUsageReservationSchema.safeParse(snapshotAuthorityData(providerValue));
    if (!provider.success || provider.data.idempotencyKey !== pending.usageRequest.idempotencyKey ||
        provider.data.opaqueScope !== pending.usageRequest.scope.opaqueScope) {
      fail('reservation-unresolved', 'Trusted usage reservation binding mismatch');
    }
    try {
      const bound = await repository.transact({ pending, provider: provider.data }, async rawState => {
        const state = accountingOnly ? initializedForAccounting(rawState) : initialized(rawState, true);
        if (!accountingOnly) await currentIdentity(state, false);
        if (!state.pendingIssuance || !samePending(state.pendingIssuance, pending)) {
          fail('reservation-conflict', 'Pending usage intent changed before provider binding');
        }
        if (state.pendingIssuance.providerReservation) {
          if (canonicalizeJson(state.pendingIssuance.providerReservation) !== canonicalizeJson(provider.data)) {
            fail('reservation-conflict', 'Pending usage provider binding changed');
          }
          return { state: state as RunAuthorityState, result: state.pendingIssuance };
        }
        const reading = now(state);
        const nextPending = pendingIssuanceSchema.parse({
          ...state.pendingIssuance, providerReservation: provider.data, status: 'provider-reserved'
        });
        return {
          state: checkedState(state, {
            pendingIssuance: nextPending, operationSequence: nextSequence(state),
            wallClockHighWater: reading.at
          }),
          result: nextPending
        };
      });
      return { kind: 'bound', pending: bound.result };
    } catch (error) {
      if (!(error instanceof TicketAuthorityError) ||
          !['reservation-conflict', 'commit-unknown'].includes(error.code)) throw error;
      if (error.code === 'commit-unknown') {
        const recovered = await repository.read();
        if (recovered?.state.stateKind === 'initialized' && recovered.state.pendingIssuance &&
            samePending(recovered.state.pendingIssuance, pending) &&
            recovered.state.pendingIssuance.providerReservation) {
          return { kind: 'bound', pending: recovered.state.pendingIssuance };
        }
      }
      const outcome = await releaseOrphanedProviderReservation(pending, provider.data);
      if (outcome.finalized) {
        const mapped = await mappingAfterRecovery(pending);
        if (mapped) return { kind: 'already-finalized', handle: mapped };
      }
      throw error;
    }
  }

  /**
   * A provider reservation that could not be bound must never leak, and recovery
   * must never need reserve-after-release: stage the saga with the provider
   * identity first (`release-pending-unbound` when the binding never landed),
   * release the provider reservation idempotently, then clear. Conflicting
   * sagas are left untouched; a marked saga remains for abortPendingIssuance.
   * A reservation referenced by an issued ticket's providerUsage is live and is
   * never released here; a finalized mapping yields a typed no-op outcome.
   */
  async function releaseOrphanedProviderReservation(
    pending: z.infer<typeof pendingIssuanceSchema>,
    provider: z.infer<typeof authorityUsageReservationSchema>
  ): Promise<OrphanReleaseOutcome> {
    const referencesProvider = (current: InitializedRunAuthorityState): boolean =>
      current.providerUsage.some(item => item.providerReservationId === provider.providerReservationId);
    const hasFinalizedMapping = (current: InitializedRunAuthorityState): boolean =>
      current.issuanceMappings.some(item => item.operationId === pending.operationId);
    const ownsProvider = (current: InitializedRunAuthorityState): boolean =>
      !!current.pendingIssuance && samePending(current.pendingIssuance, pending) &&
      current.pendingIssuance.providerReservation !== null &&
      canonicalizeJson(current.pendingIssuance.providerReservation) === canonicalizeJson(provider);
    const tolerableRace = (error: unknown): boolean =>
      error instanceof TicketAuthorityError &&
      ['reservation-conflict', 'commit-unknown'].includes(error.code);

    const initial = await repository.read();
    if (!initial || initial.state.stateKind !== 'initialized') {
      fail('invalid-state', 'Run authority is not initialized');
    }
    if (referencesProvider(initial.state)) return { released: false, finalized: true, inFlight: false };
    let finalized = hasFinalizedMapping(initial.state);

    const stageOnce = async (): Promise<'staged' | 'foreign' | 'finalized' | 'in-flight'> => {
      try {
        const staged = await repository.transact({ pending, provider }, async rawState => {
          const current = initializedForAccounting(rawState);
          if (referencesProvider(current)) {
            return { state: current as RunAuthorityState, result: 'finalized' as const };
          }
          const currentPending = current.pendingIssuance;
          if (!currentPending || !samePending(currentPending, pending)) {
            return { state: current as RunAuthorityState, result: 'foreign' as const };
          }
          const sameProviderBinding = currentPending.providerReservation !== null &&
            canonicalizeJson(currentPending.providerReservation) === canonicalizeJson(provider);
          if (['release-pending', 'release-pending-unbound'].includes(currentPending.status)) {
            return {
              state: current as RunAuthorityState,
              result: sameProviderBinding ? 'staged' as const : 'foreign' as const
            };
          }
          if (currentPending.providerReservation !== null) {
            // A same-provider bind is in flight and awaiting finalize; never
            // steal it into release. A different binding owns the saga.
            return {
              state: current as RunAuthorityState,
              result: sameProviderBinding ? 'in-flight' as const : 'foreign' as const
            };
          }
          const reading = now(current);
          const nextPending = pendingIssuanceSchema.parse({
            ...currentPending,
            providerReservation: provider,
            status: 'release-pending-unbound' as const
          });
          return {
            state: checkedState(current, {
              pendingIssuance: nextPending, operationSequence: nextSequence(current),
              wallClockHighWater: reading.at
            }), result: 'staged' as const
          };
        });
        return staged.result;
      } catch (error) {
        // A conflicting saga winning the CAS is tolerable; anything else surfaces.
        if (!tolerableRace(error)) throw error;
        return 'foreign';
      }
    };

    // Guard between staging and the provider call: re-read under bounded retry
    // so an in-flight same-provider bind or a finalized ticket is observed
    // before any release.
    let stable = false;
    let sawInFlight = false;
    for (let attempt = 0; attempt < 4 && !stable; attempt += 1) {
      const staged = await stageOnce();
      if (staged === 'finalized') return { released: false, finalized: true, inFlight: false };
      if (staged === 'in-flight') sawInFlight = true;
      const verify = await repository.read();
      if (!verify || verify.state.stateKind !== 'initialized') {
        fail('invalid-state', 'Run authority is not initialized');
      }
      if (referencesProvider(verify.state)) return { released: false, finalized: true, inFlight: false };
      finalized = finalized || hasFinalizedMapping(verify.state);
      const pendingNow = verify.state.pendingIssuance;
      if (!pendingNow || !samePending(pendingNow, pending)) {
        stable = true;
      } else if (
        ['release-pending', 'release-pending-unbound'].includes(pendingNow.status) &&
        pendingNow.providerReservation !== null &&
        canonicalizeJson(pendingNow.providerReservation) === canonicalizeJson(provider)
      ) {
        stable = true;
      } else if (pendingNow.providerReservation !== null &&
          canonicalizeJson(pendingNow.providerReservation) === canonicalizeJson(provider)) {
        // Bound and awaiting finalize; keep waiting within the bounded loop.
        sawInFlight = true;
      } else if (pendingNow.providerReservation !== null) {
        // A foreign binding owns the saga; our provider remains orphaned.
        stable = true;
      }
    }
    if (!stable) {
      if (sawInFlight) return { released: false, finalized, inFlight: true };
      fail('reservation-unresolved', 'Pending orphan release could not stabilize');
    }

    try {
      await usageMeter.release(
        provider.providerReservationId,
        providerReleaseKey(pending.usageRequest.scope.reservationId)
      );
    } catch {
      fail('reservation-unresolved', 'Trusted pending usage release failed');
    }
    try {
      await repository.transact({ pending }, async rawState => {
        const current = initializedForAccounting(rawState);
        if (!ownsProvider(current)) {
          return { state: current as RunAuthorityState, result: true };
        }
        const reading = now(current);
        return {
          state: checkedState(current, {
            pendingIssuance: null, operationSequence: nextSequence(current),
            wallClockHighWater: reading.at
          }), result: true
        };
      });
    } catch (error) {
      // A conflicting saga winning the CAS leaves recovery to abortPendingIssuance;
      // anything else surfaces.
      if (!tolerableRace(error)) throw error;
    }
    return { released: true, finalized, inFlight: false };
  }

  async function mappingAfterRecovery(
    pending: z.infer<typeof pendingIssuanceSchema>
  ): Promise<IssuedTicketHandle | null> {
    const recovered = await repository.read();
    if (recovered?.state.stateKind !== 'initialized') return null;
    return mappingForOperation(recovered.state, pending.operationId, pending.request) ?? null;
  }

  async function finalizePendingIssuance(
    pendingValue: z.infer<typeof pendingIssuanceSchema>
  ): Promise<IssuedTicketHandle> {
    const bound = await bindPendingProvider(pendingValue);
    if (bound.kind === 'already-finalized') return bound.handle;
    const pending = bound.pending;
    if (pending.status !== 'provider-reserved' || !pending.providerReservation) {
      fail('reservation-unresolved', 'Pending issuance is being aborted');
    }
    const providerReservation = pending.providerReservation;
    const parsedRequest = (pending.kind === 'execution' ? issueExecutionSchema : issueLeafSchema)
      .safeParse(pending.request);
    if (!parsedRequest.success) fail('invalid-state', 'Persisted pending issuance request is malformed');
    const request = parsedRequest.data as IssueExecutionTicketInput | IssueLeafTicketInput;
    try {
      const finalized = await repository.transact({ pending }, async rawState => {
        const state = initialized(rawState, true);
        const existing = mappingForOperation(state, pending.operationId, pending.request);
        if (existing) return { state: state as RunAuthorityState, result: existing };
        if (!state.pendingIssuance || !samePending(state.pendingIssuance, pending) ||
            state.pendingIssuance.status !== 'provider-reserved' ||
            canonicalizeJson(state.pendingIssuance.providerReservation) !==
              canonicalizeJson(pending.providerReservation)) {
          fail('reservation-conflict', 'Ticket usage reservation binding changed before finalize');
        }
        const prepared = await prepareIssuedState(
          state, request, pending.kind, pending.request, providerReservation
        );
        return { state: prepared.state as RunAuthorityState, result: prepared.issued };
      });
      return finalized.result;
    } catch (error) {
      if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
      const recovered = await repository.read();
      if (recovered?.state.stateKind === 'initialized') {
        const mapped = mappingForOperation(recovered.state, pending.operationId, pending.request);
        if (mapped) return mapped;
      }
      throw error;
    }
  }

  async function issue(
    inputValue: IssueExecutionTicketInput | IssueLeafTicketInput,
    kind: 'execution' | 'leaf'
  ): Promise<IssuedTicketHandle> {
    const parsedInput = (kind === 'execution' ? issueExecutionSchema : issueLeafSchema)
      .safeParse(snapshotAuthorityData(inputValue));
    if (!parsedInput.success) fail('invalid-input', parsedInput.error.issues
      .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`).sort().join('; '));
    const input = parsedInput.data as IssueExecutionTicketInput | IssueLeafTicketInput;
    const request = snapshotAuthorityData(input);
    const requestDigest = hash(request);
    let pending: z.infer<typeof pendingIssuanceSchema>;
    try {
      const staged = await repository.transact(input, async (rawState, detached) => {
        const state = initialized(rawState, true);
        const existing = mappingForOperation(state, detached.operationId, request);
        if (existing) return { state: state as RunAuthorityState, result: null };
        if (state.pendingIssuance) {
          if (state.pendingIssuance.operationId !== detached.operationId ||
              state.pendingIssuance.requestDigest !== requestDigest) {
            fail('reservation-conflict', 'Another ticket usage reservation saga is pending');
          }
          return { state: state as RunAuthorityState, result: state.pendingIssuance };
        }
        const opaqueScope = `opaque-usage-scope:${hash({
          projectId, runId, operationId: detached.operationId, requestDigest
        }).slice(7)}`;
        const prepared = await prepareIssuedState(state, detached, kind, request, {
          providerReservationId: `pending-provider:${hash({ requestDigest, opaqueScope }).slice(7)}`,
          opaqueScope
        });
        const role = prepared.normalizedTicket.recipientRole as 'EXECUTION' | 'LEAF';
        const usageRequest: AuthorityUsageReservationRequest = {
          idempotencyKey: `ticket-usage:${projectId}:${runId}:${detached.operationId}:${requestDigest}`,
          scope: {
            opaqueScope,
            runId, projectId, operationId: detached.operationId,
            ticketRequestDigest: requestDigest, reservationId: prepared.reservationId,
            nodeId: prepared.normalizedTicket.nodeId
          },
          estimate: expectedUsageEstimate(prepared.normalizedTicket.budgets, role, usageBinding.currency)
        };
        const intent = pendingIssuanceSchema.parse({
          kind, operationId: detached.operationId, requestDigest, request,
          usageRequest, providerReservation: null, status: 'intent', createdAt: now(state).at
        });
        return {
          state: checkedState(state, {
            pendingIssuance: intent, operationSequence: nextSequence(state),
            wallClockHighWater: intent.createdAt
          }),
          result: intent
        };
      });
      if (staged.result === null) return mappingForOperation(staged.state as InitializedRunAuthorityState,
        input.operationId, request)!;
      pending = staged.result;
    } catch (error) {
      if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
      const recovered = await repository.read();
      if (recovered?.state.stateKind !== 'initialized') throw error;
      const mapped = mappingForOperation(recovered.state, input.operationId, request);
      if (mapped) return mapped;
      if (!recovered.state.pendingIssuance ||
          recovered.state.pendingIssuance.operationId !== input.operationId ||
          recovered.state.pendingIssuance.requestDigest !== requestDigest) throw error;
      pending = recovered.state.pendingIssuance;
    }

    return finalizePendingIssuance(pending);
  }

  function providerReleaseKey(reservationIdValue: string): string {
    return `ticket-usage-release:${projectId}:${runId}:${reservationIdValue}`;
  }

  function markProviderReleases(
    state: InitializedRunAuthorityState,
    reservationIds: readonly string[]
  ) {
    const targets = new Set(reservationIds);
    return state.providerUsage.map(item => targets.has(item.reservationId) && item.status === 'reserved'
      ? { ...item, status: 'release-pending' as const }
      : item);
  }

  async function finishProviderReleases(reservationIds: readonly string[]): Promise<void> {
    for (const reservationIdValue of [...new Set(reservationIds)].sort()) {
      const snapshot = await repository.read();
      if (!snapshot) fail('invalid-state', 'Run authority is not initialized');
      const state = initializedForAccounting(snapshot.state);
      const usage = state.providerUsage.find(item => item.reservationId === reservationIdValue);
      if (!usage || usage.status === 'released') continue;
      if (usage.status !== 'release-pending') {
        fail('reservation-conflict', 'Provider usage reservation is not pending release');
      }
      try {
        await usageMeter.release(usage.providerReservationId, providerReleaseKey(reservationIdValue));
      } catch {
        fail('reservation-unresolved', 'Trusted usage release failed');
      }
      try {
        await repository.transact({
          reservationId: reservationIdValue,
          providerReservationId: usage.providerReservationId
        }, async rawState => {
          const current = initializedForAccounting(rawState);
          const currentUsage = current.providerUsage.find(item => item.reservationId === reservationIdValue);
          if (!currentUsage || currentUsage.providerReservationId !== usage.providerReservationId) {
            fail('reservation-conflict', 'Provider release binding changed');
          }
          if (currentUsage.status === 'released') {
            return { state: current as RunAuthorityState, result: true };
          }
          if (currentUsage.status !== 'release-pending') {
            fail('reservation-conflict', 'Provider release lifecycle changed');
          }
          const reading = now(current);
          const providerUsage = current.providerUsage.map(item => item.reservationId === reservationIdValue
            ? { ...item, status: 'released' as const }
            : item);
          return {
            state: checkedState(current, {
              providerUsage, operationSequence: nextSequence(current), wallClockHighWater: reading.at
            }), result: true
          };
        });
      } catch (error) {
        if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
        const recovered = await repository.read();
        if (recovered?.state.stateKind !== 'initialized' || !recovered.state.providerUsage.some(item =>
          item.reservationId === reservationIdValue && item.status === 'released')) throw error;
      }
    }
  }

  async function abortPending(): Promise<boolean> {
    const snapshot = await repository.read();
    if (!snapshot) fail('invalid-state', 'Run authority is not initialized');
    const state = initializedForAccounting(snapshot.state);
    if (!state.pendingIssuance) return false;
    const bound = await bindPendingProvider(state.pendingIssuance, true);
    if (bound.kind === 'already-finalized') return false;
    let pending = bound.pending;
    if (!pending.providerReservation) fail('reservation-unresolved', 'Pending provider reservation is absent');
    if (pending.status !== 'release-pending') {
      try {
        const marked = await repository.transact({ pending }, async rawState => {
          const current = initializedForAccounting(rawState);
          if (!current.pendingIssuance || !samePending(current.pendingIssuance, pending)) {
            fail('reservation-conflict', 'Pending issuance changed before abort');
          }
          const reading = now(current);
          const nextPending = pendingIssuanceSchema.parse({
            ...current.pendingIssuance, status: 'release-pending'
          });
          return {
            state: checkedState(current, {
              pendingIssuance: nextPending, operationSequence: nextSequence(current),
              wallClockHighWater: reading.at
            }), result: nextPending
          };
        });
        pending = marked.result;
      } catch (error) {
        if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
        const recovered = await repository.read();
        if (recovered?.state.stateKind !== 'initialized' ||
            recovered.state.pendingIssuance?.status !== 'release-pending') throw error;
        pending = recovered.state.pendingIssuance;
      }
    }
    const providerReservation = pending.providerReservation;
    if (!providerReservation) fail('invalid-state', 'Pending provider reservation disappeared');
    try {
      await usageMeter.release(
        providerReservation.providerReservationId,
        providerReleaseKey(pending.usageRequest.scope.reservationId)
      );
    } catch {
      fail('reservation-unresolved', 'Trusted pending usage release failed');
    }
    try {
      await repository.transact({ pending }, async rawState => {
        const current = initializedForAccounting(rawState);
        if (!current.pendingIssuance) return { state: current as RunAuthorityState, result: true };
        if (!samePending(current.pendingIssuance, pending) ||
            current.pendingIssuance.status !== 'release-pending') {
          fail('reservation-conflict', 'Pending issuance changed during abort');
        }
        const reading = now(current);
        return {
          state: checkedState(current, {
            pendingIssuance: null, operationSequence: nextSequence(current),
            wallClockHighWater: reading.at
          }), result: true
        };
      });
    } catch (error) {
      if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
      const recovered = await repository.read();
      if (recovered?.state.stateKind !== 'initialized' || recovered.state.pendingIssuance) throw error;
    }
    return true;
  }

  async function mutateLease<T>(
    inputValue: unknown,
    transition: (state: unknown, input: unknown, sources?: LeaseSources) =>
      { state: Readonly<LeaseAuthorityState>; lease: Readonly<T> },
    kind: 'controller' | 'workstream'
  ): Promise<Readonly<T>> {
    const detached = snapshotAuthorityData(inputValue) as Record<string, unknown> | null;
    if (kind === 'workstream' && (!detached || typeof detached !== 'object' || Array.isArray(detached))) {
      fail('invalid-input', 'Workstream lease mutation input must be an object');
    }
    const proofInput = kind === 'controller' ? detached : detached!.proof;
    const nodeId = kind === 'workstream' ? detached!.nodeId : undefined;
    let attemptedLease: Readonly<T> | undefined;
    try {
      const transaction = await repository.transact(
        kind === 'controller' ? { proofInput } : { proofInput, nodeId },
        async (rawState, input) => {
          const state = initialized(rawState);
          const identity = await currentIdentity(state);
          const operationInput = kind === 'controller'
            ? { ...binding(state, identity), proof: input.proofInput }
            : { ...binding(state, identity), nodeId: input.nodeId, proof: input.proofInput };
          const changed = transition(state.leaseState, operationInput, leaseSources);
          if (canonicalizeJson(changed.state) === canonicalizeJson(state.leaseState)) {
            return { state: state as RunAuthorityState, result: changed.lease };
          }
          attemptedLease = changed.lease;
          return {
            state: checkedState(state, {
              leaseState: changed.state, operationSequence: nextSequence(state),
              wallClockHighWater: changed.state.wallClockHighWater ?? state.wallClockHighWater
            }),
            result: changed.lease
          };
        });
      return transaction.result;
    } catch (error) {
      if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown' || !attemptedLease) {
        throw error;
      }
      const recovered = await repository.read();
      if (recovered?.state.stateKind === 'initialized') {
        const record = kind === 'controller'
          ? recovered.state.leaseState.controllerLease
          : recovered.state.leaseState.workstreamLeases.find(item => item.nodeId === nodeId);
        if (canonicalizeJson(record) === canonicalizeJson(attemptedLease)) {
          return canonicalAuthoritySnapshot(attemptedLease);
        }
      }
      throw error;
    }
  }

  async function recordOperation(inputValue: BudgetOperationInput, kind: 'retry' | 'local-fix' |
    'replacement' | 'resume'): Promise<Readonly<BudgetLedger>> {
    const parsed = budgetOperationSchema.safeParse(snapshotAuthorityData(inputValue));
    if (!parsed.success) fail('invalid-input', parsed.error.issues
      .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`).sort().join('; '));
    const transaction = await repository.transact(parsed.data, async (rawState, input) => {
      const state = initialized(rawState);
      const identity = await currentIdentity(state);
      const node = compiled.graph.payload.nodes.find(candidate => candidate.nodeId === input.nodeId);
      if (!node) {
        fail('topology-denied', 'Budget operation references unknown graph node');
      }
      if (node.ownerRole === 'EXECUTION') {
        if (input.leaseProof.kind !== 'controller') {
          fail('lease-required', 'Execution-node budget operation requires controller lease proof');
        }
        validateControllerLease(state.leaseState, {
          ...binding(state, identity), proof: input.leaseProof
        }, leaseSources);
      } else {
        const parentId = compiled.graph.payload.edges.find(edge => edge.toNodeId === node.nodeId)?.fromNodeId;
        if (!parentId || input.leaseProof.kind !== 'workstream' || input.leaseProof.nodeId !== parentId) {
          fail('lease-required', 'Leaf-node budget operation requires parent workstream lease proof');
        }
        validateWorkstreamLease(state.leaseState, {
          ...binding(state, identity), nodeId: parentId, proof: input.leaseProof
        }, leaseSources);
      }
      const budgets = recordBudgetOperation(state.budgets, {
        eventId: input.operationId, nodeId: input.nodeId, operation: kind, kind
      });
      if (canonicalizeJson(budgets) === canonicalizeJson(state.budgets)) {
        return { state: state as RunAuthorityState, result: budgets };
      }
      const reading = now(state);
      return {
        state: checkedState(state, {
          budgets, operationSequence: nextSequence(state), wallClockHighWater: reading.at
        }), result: budgets
      };
    });
    return transaction.result;
  }

  const lifecycleManager: Omit<RunAuthorityManager,
    'reconcileUsage' | 'releaseReservation' | 'recordRetry' | 'recordLocalFix' |
    'recordReplacement' | 'recordResume' | 'cancel'> = {
    async initialize(inputValue) {
      const input = ownDataRecord(inputValue,
        ['idempotencyKey', 'approval', 'modeSelection'],
        ['graphEpoch', 'cancellationGeneration', 'leaseTtlMs', 'heartbeatIntervalMs'],
        'authority initialization');
      const approval = input.approval as PlanApprovalEvent;
      const modeSelection = input.modeSelection as ExecutionModeSelectionEvent;
      const idempotencyKey = input.idempotencyKey;
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        fail('invalid-input', 'Initialization idempotency key is required');
      }
      const graphEpoch = (input.graphEpoch as number | undefined) ?? 0;
      const cancellationGeneration = (input.cancellationGeneration as number | undefined) ?? 0;
      const leaseTtlMs = (input.leaseTtlMs as number | undefined) ?? 30_000;
      const heartbeatIntervalMs = (input.heartbeatIntervalMs as number | undefined) ?? 10_000;
      if (!Number.isSafeInteger(graphEpoch) || graphEpoch < 0 ||
          !Number.isSafeInteger(cancellationGeneration) || cancellationGeneration < 0 ||
          !Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0 ||
          !Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 ||
          heartbeatIntervalMs >= leaseTtlMs) {
        fail('invalid-input', 'Initialization generations and lease cadence are invalid');
      }
      const initializationRequestDigest = hash({
        runId, projectId, idempotencyKey,
        planDigest: compiled.plan.digest, graphDigest: compiled.graph.digest,
        graphEpoch, cancellationGeneration, leaseTtlMs, heartbeatIntervalMs,
        approval, modeSelection
      });
      const existing = await repository.read();
      if (existing) {
        if (existing.state.stateKind === 'initialized' &&
            existing.state.idempotencyKey === idempotencyKey &&
            existing.state.initializationRequestDigest === initializationRequestDigest) {
          return publicSnapshot(existing);
        }
        if (existing.state.stateKind === 'initialization-pending' &&
            existing.state.initializationRequestDigest === initializationRequestDigest) {
          return reconcilePendingInitialization(existing.state);
        }
        fail('initialization-recovery-required', 'Existing run initialization requires explicit reconciliation');
      }
      const created = now();
      derivedDeadline(created.ms, approved.wallTimeMinutesRun, 'Run wall deadline');
      const host = await currentIdentity();
      const expectedAttestationBinding = {
        planDigest: compiled.plan.digest as `sha256:${string}`,
        graphDigest: compiled.graph.digest as `sha256:${string}`,
        planRevision: compiled.planRevision,
        principalRef: host.principalRef,
        projectId,
        hostSessionRef: host.sessionRef
      };
      const attestationIdempotencyKey = `run-init:${projectId}:${runId}:${initializationRequestDigest}`;
      let reservationValue: unknown;
      try {
        reservationValue = await attestationProvider.reservePair({
          idempotencyKey: attestationIdempotencyKey,
          initializationRequestDigest,
          approval,
          modeSelection,
          expected: expectedAttestationBinding
        });
      } catch (error) {
        fail('binding-mismatch',
          `Trusted attestation reservation denied: ${error instanceof Error ? error.message : String(error)}`);
      }
      const reservation = authorityAttestationReservationSchema.safeParse(snapshotAuthorityData(reservationValue));
      const afterReserve = now();
      if (!reservation.success || reservation.data.idempotencyKey !== attestationIdempotencyKey ||
          afterReserve.ms >= Date.parse(reservation.data.expiresAt)) {
        fail('binding-mismatch', 'Trusted attestation reservation is malformed or expired');
      }
      const pending: PendingRunAuthorityState = {
        format: 'harness-mdocs/run-authority', schemaVersion: 2,
        stateKind: 'initialization-pending', runId, projectId,
        idempotencyKey, initializationRequestDigest, attestationReservationId: reservation.data.reservationId,
        hostIdentity: host, graphEpoch, cancellationGeneration, leaseTtlMs, heartbeatIntervalMs,
        createdAt: created.at
      };
      try { await repository.initialize(pending); } catch (error) {
        if (!(error instanceof TicketAuthorityError) ||
            !['already-initialized', 'commit-unknown'].includes(error.code)) throw error;
        const raced = await repository.read();
        if (raced?.state.stateKind === 'initialized' &&
            raced.state.initializationRequestDigest === initializationRequestDigest) {
          return publicSnapshot(raced);
        }
        if (raced?.state.stateKind === 'initialization-pending' &&
            raced.state.initializationRequestDigest === initializationRequestDigest) {
          return reconcilePendingInitialization(raced.state);
        }
        fail('initialization-recovery-required', 'Concurrent initialization owns another approval reservation');
      }
      let result: AuthorityAttestationResult;
      try {
        result = await attestationProvider.verifyReservedPair(pending.attestationReservationId);
      } catch (error) {
        fail('initialization-recovery-required',
          `Trusted attestation verification is unresolved: ${
            error instanceof Error ? error.message : String(error)}`);
      }
      return finalizeInitialization(pending, result!);
    },

    async read() {
      const snapshot = await repository.read();
      if (!snapshot) fail('invalid-state', 'Run authority is not initialized');
      return publicSnapshot(snapshot);
    },

    async acquireControllerLease() {
      let attemptedLease: Readonly<ControllerLeaseRecord> | undefined;
      try {
        const transaction = await repository.transact({}, async rawState => {
          const state = initialized(rawState);
          const holder = await currentIdentity(state);
          const changed = acquireControllerLease(state.leaseState, binding(state, holder), leaseSources);
          attemptedLease = changed.lease;
          return {
            state: checkedState(state, {
              leaseState: changed.state, operationSequence: nextSequence(state),
              wallClockHighWater: changed.lease.heartbeatAt
            }), result: changed.lease
          };
        });
        return transaction.result;
      } catch (error) {
        if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown' || !attemptedLease) {
          throw error;
        }
        const recovered = await repository.read();
        if (recovered?.state.stateKind === 'initialized' &&
            canonicalizeJson(recovered.state.leaseState.controllerLease) === canonicalizeJson(attemptedLease)) {
          return canonicalAuthoritySnapshot(attemptedLease);
        }
        throw error;
      }
    },

    heartbeatControllerLease: proof => mutateLease(proof, heartbeatControllerLease, 'controller'),
    releaseControllerLease: proof => mutateLease(proof, releaseControllerLease, 'controller'),
    issueExecutionTicket: input => issue(input, 'execution'),

    async claimExecutionAndAcquireWorkstream(inputValue) {
      const parsedInput = claimExecutionSchema.safeParse(snapshotAuthorityData(inputValue));
      if (!parsedInput.success) fail('invalid-input', parsedInput.error.issues
        .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`).sort().join('; '));
      const input = parsedInput.data;
      try {
        const transaction = await repository.transact(input, async (rawState, detached) => {
          const state = initialized(rawState);
          const holder = await currentIdentity(state);
          assertAncestorsActive(state, detached.handle);
          const localBroker = broker(state);
          const record = state.ticketState.tickets.find(item => item.ticket.ticketHandleId === detached.handle)!;
          if (record.ticket.recipientRole !== 'EXECUTION') fail('wrong-role', 'Expected EXECUTION ticket');
          const resolved = await localBroker.claim({
            handle: detached.handle, runId: state.runId, projectId: state.projectId,
            approvedPlanDigest: state.approvedPlanDigest, approvedGraphDigest: state.approvedGraphDigest,
            graphId: state.graphId, graphRevision: state.graphRevision, graphEpoch: state.graphEpoch,
            cancellationGeneration: state.ticketState.cancellationGeneration
          });
          if (!resolved.ok) fail(resolved.code, resolved.reason);
          const changed = acquireWorkstreamLease(state.leaseState, {
            ...binding(state, holder), nodeId: resolved.claims.nodeId, ticket: resolved.claims,
            controllerProof: detached.controllerProof, controllerHolder: holder
          }, leaseSources);
          return {
            state: checkedState(state, {
              ticketState: localBroker.snapshot(), leaseState: changed.state,
              operationSequence: nextSequence(state), wallClockHighWater: changed.lease.heartbeatAt
            }), result: changed.lease
          };
        });
        return transaction.result;
      } catch (error) {
        if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
        const recovered = await repository.read();
        if (recovered?.state.stateKind === 'initialized') {
          const state = initialized(recovered.state);
          const holder = await currentIdentity(state);
          const ticket = state.ticketState.tickets.find(item =>
            item.ticket.ticketHandleId === input.handle);
          const workstream = ticket && state.leaseState.workstreamLeases.find(item =>
            item.nodeId === ticket.ticket.nodeId);
          const controller = state.leaseState.controllerLease;
          if (ticket?.lifecycle === 'active' && ticket.nonceStatus === 'claimed' && workstream && controller &&
              workstream.ticketHandleId === input.handle &&
              controller.leaseRef === input.controllerProof.leaseRef &&
              controller.generation === input.controllerProof.generation &&
              controller.fence === input.controllerProof.fence &&
              workstream.controllerLeaseRef === controller.leaseRef &&
              workstream.controllerFence === controller.fence && sameIdentity(workstream.holder, holder)) {
            validateWorkstreamLease(state.leaseState, {
              ...binding(state, holder), nodeId: workstream.nodeId, proof: workstreamProof(workstream)
            }, leaseSources);
            return canonicalAuthoritySnapshot(workstream);
          }
        }
        throw error;
      }
    },

    heartbeatWorkstreamLease: input => mutateLease(input, heartbeatWorkstreamLease, 'workstream'),
    releaseWorkstreamLease: input => mutateLease(input, releaseWorkstreamLease, 'workstream'),
    issueLeafTicket: input => issue(input, 'leaf'),

    async recoverPendingIssuance() {
      const snapshot = await repository.read();
      if (!snapshot) fail('invalid-state', 'Run authority is not initialized');
      const state = initialized(snapshot.state, true);
      await currentIdentity(state);
      return state.pendingIssuance ? finalizePendingIssuance(state.pendingIssuance) : null;
    },

    abortPendingIssuance: abortPending,

    async inspectTicket(handle) {
      const snapshot = await repository.read();
      if (!snapshot) fail('invalid-state', 'Run authority is not initialized');
      const state = initialized(snapshot.state);
      const holder = await currentIdentity(state);
      assertAncestorsActive(state, handle);
      const record = state.ticketState.tickets.find(item => item.ticket.ticketHandleId === handle)!;
      if (!sameIdentity(holder, record.hostIdentity)) fail('host-identity-mismatch', 'Ticket belongs to other host');
      const reading = now(state);
      if (reading.ms >= Date.parse(record.ticket.expiresAt)) fail('expired-ticket', 'Ticket expired');
      if (record.ticket.recipientRole === 'EXECUTION') {
        if (record.nonceStatus === 'claimed') {
          const lease = state.leaseState.workstreamLeases.find(item => item.nodeId === record.ticket.nodeId);
          if (!lease) fail('lease-required', 'Claimed EO has no workstream lease');
          validateWorkstreamLease(state.leaseState, {
            ...binding(state, holder), nodeId: record.ticket.nodeId,
            proof: { kind: 'workstream', nodeId: record.ticket.nodeId, leaseRef: lease.leaseRef,
              generation: lease.generation, fence: lease.fence }
          }, leaseSources);
        } else {
          const controller = state.leaseState.controllerLease;
          if (!controller) fail('lease-required', 'Controller lease absent');
          if (record.lease.ref !== controller.leaseRef || record.lease.fence !== controller.fence ||
              record.lease.generation !== controller.generation) {
            fail('stale-lease', 'Execution ticket controller fence is stale');
          }
          validateControllerLease(state.leaseState, {
            ...binding(state, holder), proof: { kind: 'controller', leaseRef: controller.leaseRef,
              generation: controller.generation, fence: controller.fence }
          }, leaseSources);
        }
      } else {
        const parent = state.ticketState.tickets.find(item =>
          item.ticket.ticketHandleId === record.parentTicketHandleId)!;
        const lease = state.leaseState.workstreamLeases.find(item => item.nodeId === parent.ticket.nodeId);
        if (!lease || record.lease.ref !== lease.leaseRef || record.lease.fence !== lease.fence) {
          fail('stale-lease', 'Leaf ticket workstream fence is stale');
        }
        validateWorkstreamLease(state.leaseState, {
          ...binding(state, holder), nodeId: parent.ticket.nodeId,
          proof: { kind: 'workstream', nodeId: parent.ticket.nodeId, leaseRef: lease.leaseRef,
            generation: lease.generation, fence: lease.fence }
        }, leaseSources);
      }
      return canonicalAuthoritySnapshot({
        authority: false as const, ticketHandleId: handle,
        role: record.ticket.recipientRole as 'EXECUTION' | 'LEAF', expiresAt: record.ticket.expiresAt
      });
    },

    async revokeTicket(handle) {
      let attemptedRevocation = false;
      let attemptedHandles: string[] = [];
      let result: { revoked: boolean; releases: string[] };
      try {
        const transaction = await repository.transact({ handle }, async (rawState, input) => {
          const state = initialized(rawState);
          await currentIdentity(state);
          const root = state.ticketState.tickets.find(item => item.ticket.ticketHandleId === input.handle);
          if (!root) return { state: state as RunAuthorityState, result: { revoked: false, releases: [] } };
          attemptedRevocation = root.lifecycle === 'active';
          const handles = new Set<string>([input.handle]);
          for (let changed = true; changed;) {
            changed = false;
            for (const ticket of state.ticketState.tickets) {
              if (ticket.parentTicketHandleId && handles.has(ticket.parentTicketHandleId) &&
                  !handles.has(ticket.ticket.ticketHandleId)) {
                handles.add(ticket.ticket.ticketHandleId); changed = true;
              }
            }
          }
          attemptedHandles = [...handles];
          const localBroker = broker(state);
          for (const ticket of [...state.ticketState.tickets].reverse()) {
            if (handles.has(ticket.ticket.ticketHandleId)) localBroker.revoke(ticket.ticket.ticketHandleId as never);
          }
          let budgets = state.budgets;
          const releases: string[] = [];
          for (const ticket of [...state.ticketState.tickets].reverse()) {
            if (!handles.has(ticket.ticket.ticketHandleId) || ticket.nonceStatus === 'claimed') continue;
            const reservation = budgets.reservations.find(item => item.ticketHandleId === ticket.ticket.ticketHandleId);
            if (reservation?.status === 'pending') {
              budgets = releaseBudget(budgets, reservation.reservationId);
              releases.push(reservation.reservationId);
            }
            const usage = state.providerUsage.find(item => item.reservationId === reservation?.reservationId);
            if (usage?.status === 'release-pending') releases.push(usage.reservationId);
          }
          const ticketState = localBroker.snapshot();
          const revokedWorkstreamHandles = state.ticketState.tickets.filter(ticket =>
            handles.has(ticket.ticket.ticketHandleId) && ticket.ticket.recipientRole === 'EXECUTION')
            .map(ticket => ticket.ticket.ticketHandleId);
          const leaseState = invalidateWorkstreamLeasesByTicketHandles(
            state.leaseState, revokedWorkstreamHandles, leaseSources
          );
          const wallClockHighWater = revokedWorkstreamHandles.length > 0
            ? leaseState.wallClockHighWater!
            : now(state).at;
          return {
            state: checkedState(state, {
              ticketState, budgets, leaseState,
              providerUsage: markProviderReleases(state, releases),
              liveDescendants: ticketState.tickets.filter(item =>
                item.lifecycle === 'active').length,
              operationSequence: nextSequence(state), wallClockHighWater
            }), result: { revoked: root.lifecycle === 'active', releases }
          };
        });
        result = transaction.result;
      } catch (error) {
        if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
        const recovered = await repository.read();
        const recoveredState = recovered?.state;
        if (recoveredState?.stateKind !== 'initialized' || attemptedHandles.length === 0 ||
            attemptedHandles.some(ticketHandleId => !recoveredState.ticketState.tickets.some(item =>
              item.ticket.ticketHandleId === ticketHandleId && item.lifecycle !== 'active'))) {
          throw error;
        }
        result = {
          revoked: attemptedRevocation,
          releases: recoveredState.providerUsage.filter(item =>
            attemptedHandles.includes(item.ticketHandleId) && item.status === 'release-pending')
            .map(item => item.reservationId)
        };
      }
      await finishProviderReleases(result.releases);
      return result.revoked;
    }
  };

  async function reconcileReservation(
    reservationIdValue: string,
    prefetchedSample?: UsageSample
  ): Promise<Readonly<BudgetLedger>> {
      const initial = await repository.read();
      if (!initial) fail('invalid-state', 'Run authority is not initialized');
      const initialState = initializedForAccounting(initial.state);
      const reservation = initialState.budgets.reservations.find(item =>
        item.reservationId === reservationIdValue);
      if (!reservation) fail('unknown-reservation', 'Usage reservation absent');
      let usage = initialState.providerUsage.find(item => item.reservationId === reservationIdValue);
      if (!usage) fail('invalid-state', 'Provider usage reservation absent');
      if (reservation.status === 'committed' && usage.status === 'committed') {
        return initialState.budgets;
      }
      if (reservation.status === 'released') {
        fail('reservation-conflict', 'Released reservation cannot reconcile');
      }
      if (usage.status === 'reserved') {
        let sample: UsageSample;
        if (prefetchedSample) {
          sample = prefetchedSample;
        } else {
          try { sample = await usageMeter.finalize(usage.providerReservationId); } catch {
            fail('reservation-unresolved', 'Trusted usage meter failed');
          }
        }
        const detachedSample = snapshotAuthorityData(sample!);
        if (detachedSample.source !== usageBinding.source || detachedSample.provider !== usageBinding.provider ||
            detachedSample.model !== usageBinding.model ||
            detachedSample.priceTableVersion !== usageBinding.priceTableVersion ||
            (detachedSample.cost && detachedSample.cost.currency !== usageBinding.currency)) {
          fail('reservation-unresolved', 'Trusted usage sample binding mismatch');
        }
        try {
          const reconciled = await repository.transact({
            reservationId: reservationIdValue,
            providerReservationId: usage.providerReservationId,
            opaqueScope: usage.opaqueScope,
            sample: detachedSample
          }, async (rawState, input) => {
            const state = initializedForAccounting(rawState);
            const current = state.budgets.reservations.find(item => item.reservationId === input.reservationId);
            const currentUsage = state.providerUsage.find(item => item.reservationId === input.reservationId);
            if (!current || !currentUsage || current.ticketHandleId !== reservation.ticketHandleId ||
                currentUsage.providerReservationId !== input.providerReservationId ||
                currentUsage.opaqueScope !== input.opaqueScope) {
              fail('reservation-conflict', 'Usage reservation changed during metering');
            }
            if (current.status === 'committed') {
              return { state: state as RunAuthorityState, result: state.budgets };
            }
            const budgets = reconcileBudget(state.budgets, input.reservationId, input.sample);
            const committed = budgets.reservations.find(item => item.reservationId === input.reservationId)!;
            const providerUsage = state.providerUsage.map(item => item.reservationId === input.reservationId
              ? { ...item, status: 'commit-pending' as const, sampleDigest: committed.sampleDigest }
              : item);
            const reading = now(state);
            return {
              state: checkedState(state, {
                budgets, providerUsage, operationSequence: nextSequence(state),
                wallClockHighWater: reading.at
              }), result: budgets
            };
          });
          usage = (reconciled.state as InitializedRunAuthorityState).providerUsage.find(
            item => item.reservationId === reservationIdValue)!;
        } catch (error) {
          if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
          const recovered = await repository.read();
          if (recovered?.state.stateKind !== 'initialized') throw error;
          usage = recovered.state.providerUsage.find(item => item.reservationId === reservationIdValue)!;
          if (!usage || usage.status === 'reserved') throw error;
        }
      }
      if (!usage.sampleDigest) fail('invalid-state', 'Provider commit lacks usage sample digest');
      try { await usageMeter.commit(usage.providerReservationId, usage.sampleDigest); } catch {
        fail('reservation-unresolved', 'Trusted usage commit failed');
      }
      try {
        const committed = await repository.transact({
          reservationId: reservationIdValue,
          providerReservationId: usage.providerReservationId,
          sampleDigest: usage.sampleDigest
        }, async (rawState, input) => {
          const state = initializedForAccounting(rawState);
          const currentUsage = state.providerUsage.find(item => item.reservationId === input.reservationId);
          if (!currentUsage || currentUsage.providerReservationId !== input.providerReservationId ||
              currentUsage.sampleDigest !== input.sampleDigest) {
            fail('reservation-conflict', 'Provider usage commit binding changed');
          }
          if (currentUsage.status === 'committed') {
            return { state: state as RunAuthorityState, result: state.budgets };
          }
          const reading = now(state);
          const providerUsage = state.providerUsage.map(item => item.reservationId === input.reservationId
            ? { ...item, status: 'committed' as const }
            : item);
          return {
            state: checkedState(state, {
              providerUsage, operationSequence: nextSequence(state), wallClockHighWater: reading.at
            }), result: state.budgets
          };
        });
        return committed.result;
      } catch (error) {
        if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
        const recovered = await repository.read();
        if (recovered?.state.stateKind === 'initialized' && recovered.state.providerUsage.some(item =>
          item.reservationId === reservationIdValue && item.status === 'committed')) {
          return recovered.state.budgets;
        }
        throw error;
      }
  }

  async function releaseReservationInternal(reservationIdValue: string): Promise<Readonly<BudgetLedger>> {
      try {
        await repository.transact({ reservationId: reservationIdValue }, async (rawState, input) => {
          const state = initializedForAccounting(rawState);
          const reservation = state.budgets.reservations.find(item => item.reservationId === input.reservationId);
          if (!reservation) fail('unknown-reservation', 'Reservation absent');
          const ticket = state.ticketState.tickets.find(item =>
            item.ticket.ticketHandleId === reservation.ticketHandleId)!;
          const existingUsage = state.providerUsage.find(item => item.reservationId === input.reservationId);
          if (reservation.status === 'released' && ticket.lifecycle !== 'active' &&
              existingUsage?.status === 'released') {
            return { state: state as RunAuthorityState, result: true };
          }
          if (ticket.nonceStatus !== 'issued' && state.lifecycle !== 'cancelled') {
            fail('reservation-conflict', 'Claimed ticket reservation cannot be released');
          }
          const hasDescendants = state.ticketState.tickets.some(item =>
            item.parentTicketHandleId === reservation.ticketHandleId && item.lifecycle === 'active');
          if (hasDescendants) fail('reservation-unresolved', 'Parent with active descendants cannot release');
          const budgets = reservation.status === 'released'
            ? state.budgets : releaseBudget(state.budgets, input.reservationId);
          const localBroker = broker(state);
          localBroker.revoke(ticket.ticket.ticketHandleId as never);
          const ticketState = localBroker.snapshot();
          const providerUsage = markProviderReleases(state, [input.reservationId]);
          if (providerUsage.find(item => item.reservationId === input.reservationId)?.status === 'committed') {
            fail('reservation-conflict', 'Committed provider usage cannot be released');
          }
          const reading = now(state);
          return {
            state: checkedState(state, {
              budgets, ticketState, providerUsage,
              liveDescendants: ticketState.tickets.filter(item => item.lifecycle === 'active').length,
              operationSequence: nextSequence(state), wallClockHighWater: reading.at
            }), result: true
          };
        });
      } catch (error) {
        if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
        const recovered = await repository.read();
        if (recovered?.state.stateKind !== 'initialized' || !recovered.state.providerUsage.some(item =>
          item.reservationId === reservationIdValue &&
          ['release-pending', 'released'].includes(item.status))) throw error;
      }
      await finishProviderReleases([reservationIdValue]);
      const released = await repository.read();
      if (!released || released.state.stateKind !== 'initialized') fail('invalid-state', 'Run authority is absent');
      return released.state.budgets;
  }

  /**
   * Bounded best-effort settlement for a claimed reservation after cancellation:
   * finalize trusted usage within the settlement deadline and commit it, or
   * release idempotently when no trusted final exists. Persistent pending
   * settlement remains recoverable via reconcileUsage/releaseReservation/cancel.
   */
  async function settleClaimedReservation(reservationIdValue: string): Promise<void> {
    const snapshot = await repository.read();
    if (!snapshot || snapshot.state.stateKind !== 'initialized') return;
    const usage = snapshot.state.providerUsage.find(item => item.reservationId === reservationIdValue);
    if (!usage) return;
    if (usage.status === 'commit-pending') {
      // Persisted saga already holds a trusted sample digest: finish the
      // idempotent provider commit, then complete accounting.
      await reconcileReservation(reservationIdValue);
      return;
    }
    if (usage.status !== 'reserved') return;
    let sample: UsageSample;
    try {
      sample = await withTimeout(
        usageMeter.finalize(usage.providerReservationId),
        usageSettlementTimeoutMs,
        'Trusted usage settlement'
      );
    } catch {
      await releaseReservationInternal(reservationIdValue);
      return;
    }
    await reconcileReservation(reservationIdValue, sample);
  }

  async function settleClaimedReservations(reservationIds: readonly string[]): Promise<void> {
    for (const reservationIdValue of [...new Set(reservationIds)].sort()) {
      try {
        await settleClaimedReservation(reservationIdValue);
      } catch {
        // Settlement stays persistent and recoverable; cancellation is already final.
      }
    }
  }

  function claimedPendingReservations(state: InitializedRunAuthorityState): string[] {
    return state.ticketState.tickets
      .filter(ticket => ticket.nonceStatus === 'claimed')
      .map(ticket => state.providerUsage.find(item =>
        item.ticketHandleId === ticket.ticket.ticketHandleId))
      .filter((usage): usage is NonNullable<typeof usage> =>
        usage?.status === 'reserved' || usage?.status === 'commit-pending')
      .map(usage => usage.reservationId);
  }

  const accountingManager: Pick<RunAuthorityManager,
    'reconcileUsage' | 'releaseReservation' | 'recordRetry' | 'recordLocalFix' |
    'recordReplacement' | 'recordResume' | 'cancel'> = {
    reconcileUsage: (reservationId: string) => reconcileReservation(reservationId),
    releaseReservation: (reservationId: string) => releaseReservationInternal(reservationId),
    recordRetry: input => recordOperation(input, 'retry'),
    recordLocalFix: input => recordOperation(input, 'local-fix'),
    recordReplacement: input => recordOperation(input, 'replacement'),
    recordResume: input => recordOperation(input, 'resume'),

    async cancel() {
      try {
        await abortPending();
      } catch (error) {
        if (!(error instanceof TicketAuthorityError) || error.code !== 'reservation-unresolved') throw error;
        // Provider release failed; pending saga remains for operator recovery
        // via abortPendingIssuance() after cancellation.
      }
      let outcome: { releases: readonly string[]; settlements: readonly string[] };
      try {
        const transaction = await repository.transact({}, async rawState => {
          if (rawState.stateKind !== 'initialized') {
            fail('initialization-recovery-required', 'Pending initialization cannot authorize cancellation');
          }
          if (rawState.lifecycle === 'cancelled') {
            return {
              state: rawState as RunAuthorityState,
              result: {
                releases: rawState.providerUsage.filter(item => item.status === 'release-pending')
                  .map(item => item.reservationId),
                settlements: claimedPendingReservations(rawState)
              }
            };
          }
          if (rawState.cancellationGeneration >= Number.MAX_SAFE_INTEGER) {
            fail('invalid-state', 'Cancellation exhausted');
          }
          const localBroker = broker(rawState);
          for (const ticket of rawState.ticketState.tickets) {
            localBroker.revoke(ticket.ticket.ticketHandleId as never);
          }
          let budgets = rawState.budgets;
          const releases: string[] = [];
          for (const ticket of [...rawState.ticketState.tickets].reverse()) {
            const reservation = budgets.reservations.find(item => item.ticketHandleId === ticket.ticket.ticketHandleId);
            if (reservation?.status === 'pending' && ticket.nonceStatus === 'issued') {
              budgets = releaseBudget(budgets, reservation.reservationId);
              releases.push(reservation.reservationId);
            }
          }
          const ticketState = localBroker.snapshot();
          const leaseState = invalidateAllLeases(rawState.leaseState, leaseSources);
          const next = checkedState(rawState, {
            lifecycle: 'cancelled', cancellationGeneration: rawState.cancellationGeneration + 1,
            ticketState, budgets, leaseState,
            providerUsage: markProviderReleases(rawState, releases),
            liveDescendants: 0, operationSequence: nextSequence(rawState),
            wallClockHighWater: leaseState.wallClockHighWater ?? rawState.wallClockHighWater
          });
          return {
            state: next as RunAuthorityState,
            result: { releases, settlements: claimedPendingReservations(rawState) }
          };
        });
        outcome = transaction.result;
      } catch (error) {
        if (!(error instanceof TicketAuthorityError) || error.code !== 'commit-unknown') throw error;
        const recovered = await repository.read();
        if (recovered?.state.stateKind !== 'initialized' || recovered.state.lifecycle !== 'cancelled') throw error;
        outcome = {
          releases: recovered.state.providerUsage.filter(item => item.status === 'release-pending')
            .map(item => item.reservationId),
          settlements: claimedPendingReservations(recovered.state)
        };
      }
      await finishProviderReleases(outcome.releases);
      await settleClaimedReservations(outcome.settlements);
      const completed = await repository.read();
      if (!completed) fail('invalid-state', 'Run authority is absent after cancellation');
      return publicSnapshot(completed);
    }
  };
  const manager: RunAuthorityManager = { ...lifecycleManager, ...accountingManager };
  return Object.freeze(manager);
}

export function createRunAuthorityManager(options: RunAuthorityManagerOptions): RunAuthorityManager {
  return createManager(options);
}

/** Internal test factory. Intentionally omitted from safe authority barrel. */
export function createRunAuthorityManagerForTest(
  options: RunAuthorityManagerOptions,
  sources: RunAuthorityTestSources
): RunAuthorityManager {
  return createManager(options, sources);
}

export { parseRunAuthorityState };
