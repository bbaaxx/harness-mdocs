import * as crypto from 'crypto';

import { z } from 'zod';

import { kebabIdSchema, semanticRoleSchema } from '../../contracts';
import {
  HostIdentitySnapshot,
  hostIdentitySnapshotSchema,
  strictRfc3339UtcSchema,
  ticketLeasePlaceholderSchema,
  TicketLeasePlaceholder
} from './schema';
import {
  canonicalAuthoritySnapshot,
  snapshotAuthorityData,
  TicketAuthorityError,
  TicketAuthorityErrorCode
} from './state';

export const DEFAULT_LEASE_TTL_MS = 60_000 as const;
export const DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS = 15_000 as const;

const boundedString = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= 16 * 1024,
  'String exceeds 16384 UTF-8 bytes'
);
const safeNonNegativeInteger = z.number().int().nonnegative().safe();
const safePositiveInteger = z.number().int().positive().safe();
const controllerLeaseRefSchema = boundedString.regex(
  /^opaque-lease:controller:[A-Za-z0-9._~-]{16,1024}$/,
  'Expected opaque controller lease ref'
);
const workstreamLeaseRefSchema = boundedString.regex(
  /^opaque-lease:workstream:[A-Za-z0-9._~-]{16,1024}$/,
  'Expected opaque workstream lease ref'
);
const DEFAULT_CLOCK_DOMAIN_ID = `clock-domain:${crypto.randomBytes(32).toString('base64url')}`;

const leaseBindingFields = {
  runId: boundedString,
  projectId: boundedString,
  graphEpoch: safeNonNegativeInteger,
  cancellationGeneration: safeNonNegativeInteger
} as const;

const leaseRecordFields = {
  leaseRef: boundedString,
  generation: safePositiveInteger,
  fence: safePositiveInteger,
  holder: hostIdentitySnapshotSchema,
  ...leaseBindingFields,
  acquiredAt: strictRfc3339UtcSchema,
  heartbeatAt: strictRfc3339UtcSchema,
  expiresAt: strictRfc3339UtcSchema,
  authorityDeadlineAt: strictRfc3339UtcSchema,
  clockDomainId: boundedString,
  releasedAt: strictRfc3339UtcSchema.nullable(),
  lifecycle: z.enum(['active', 'released', 'invalidated']),
  acquiredMonotonicMs: safeNonNegativeInteger,
  heartbeatMonotonicMs: safeNonNegativeInteger
} as const;

export const controllerLeaseRecordSchema = z.object({
  kind: z.literal('controller'),
  holderRole: semanticRoleSchema.pipe(z.literal('PLAN_ROOT')),
  ...leaseRecordFields,
  leaseRef: controllerLeaseRefSchema
}).strict();

export const workstreamLeaseRecordSchema = z.object({
  kind: z.literal('workstream'),
  holderRole: semanticRoleSchema.pipe(z.literal('EXECUTION')),
  nodeId: kebabIdSchema,
  ticketHandleId: boundedString,
  ...leaseRecordFields,
  leaseRef: workstreamLeaseRefSchema,
  controllerLeaseRef: controllerLeaseRefSchema,
  controllerFence: safePositiveInteger
}).strict();

export const workstreamLeaseHighWaterSchema = z.object({
  nodeId: kebabIdSchema,
  generation: safePositiveInteger,
  fence: safePositiveInteger
}).strict();

export const clockDomainHighWaterSchema = z.object({
  domainId: boundedString,
  highWaterMs: safeNonNegativeInteger
}).strict();

export const leaseAuthorityStateSchema = z.object({
  format: z.literal('harness-mdocs/lease-authority'),
  schemaVersion: z.literal(1),
  ...leaseBindingFields,
  ttlMs: safePositiveInteger,
  heartbeatIntervalMs: safePositiveInteger,
  runStartedAt: strictRfc3339UtcSchema,
  runDeadlineAt: strictRfc3339UtcSchema,
  wallClockHighWater: strictRfc3339UtcSchema.nullable(),
  monotonicHighWaters: z.array(clockDomainHighWaterSchema).max(1024),
  controllerGenerationHighWater: safeNonNegativeInteger,
  controllerFenceHighWater: safeNonNegativeInteger,
  controllerLease: controllerLeaseRecordSchema.nullable(),
  workstreamHighWaters: z.array(workstreamLeaseHighWaterSchema).max(4096),
  workstreamLeases: z.array(workstreamLeaseRecordSchema).max(4096)
}).strict();

const createLeaseStateInputSchema = z.object({
  ...leaseBindingFields,
  ttlMs: safePositiveInteger.optional(),
  heartbeatIntervalMs: safePositiveInteger.optional(),
  runStartedAt: strictRfc3339UtcSchema,
  runDeadlineAt: strictRfc3339UtcSchema
}).strict();

const leaseProofFields = {
  generation: safePositiveInteger,
  fence: safePositiveInteger
} as const;

export const controllerLeaseProofSchema = z.object({
  kind: z.literal('controller'),
  ...leaseProofFields,
  leaseRef: controllerLeaseRefSchema
}).strict();

export const workstreamLeaseProofSchema = z.object({
  kind: z.literal('workstream'),
  nodeId: kebabIdSchema,
  ...leaseProofFields,
  leaseRef: workstreamLeaseRefSchema
}).strict();

const acquireControllerInputSchema = z.object({
  ...leaseBindingFields,
  holder: hostIdentitySnapshotSchema
}).strict();

const controllerOperationInputSchema = acquireControllerInputSchema.extend({
  proof: controllerLeaseProofSchema
}).strict();

export const executionTicketLeaseClaimSchema = z.object({
  runId: boundedString,
  projectId: boundedString,
  graphEpoch: safeNonNegativeInteger,
  cancellationGeneration: safeNonNegativeInteger,
  holder: hostIdentitySnapshotSchema,
  lease: ticketLeasePlaceholderSchema,
  ticketHandleId: boundedString,
  nodeId: kebabIdSchema,
  recipientRole: semanticRoleSchema.pipe(z.literal('EXECUTION')),
  expiresAt: strictRfc3339UtcSchema
}).strict();

const acquireWorkstreamInputSchema = z.object({
  ...leaseBindingFields,
  nodeId: kebabIdSchema,
  holder: hostIdentitySnapshotSchema,
  controllerHolder: hostIdentitySnapshotSchema,
  controllerProof: controllerLeaseProofSchema,
  ticket: executionTicketLeaseClaimSchema
}).strict();

const workstreamOperationInputSchema = z.object({
  ...leaseBindingFields,
  nodeId: kebabIdSchema,
  holder: hostIdentitySnapshotSchema,
  proof: workstreamLeaseProofSchema
}).strict();

export type ControllerLeaseRecord = z.infer<typeof controllerLeaseRecordSchema>;
export type WorkstreamLeaseRecord = z.infer<typeof workstreamLeaseRecordSchema>;
export type LeaseAuthorityState = z.infer<typeof leaseAuthorityStateSchema>;
export type ControllerLeaseProof = z.infer<typeof controllerLeaseProofSchema>;
export type WorkstreamLeaseProof = z.infer<typeof workstreamLeaseProofSchema>;
export type ExecutionTicketLeaseClaim = z.infer<typeof executionTicketLeaseClaimSchema>;

export interface LeaseSources {
  wallClock?: () => Date;
  monotonicClock?: () => number;
  clockDomainId?: () => string;
  /** Test-only deterministic entropy. Production callers must omit. */
  testOnlyRandomBytes?: () => Buffer;
}

export interface LeaseTransition<T> {
  readonly state: Readonly<LeaseAuthorityState>;
  readonly lease: Readonly<T>;
}

export type ControllerLeaseTransition = LeaseTransition<ControllerLeaseRecord>;
export type WorkstreamLeaseTransition = LeaseTransition<WorkstreamLeaseRecord>;

interface ClockReading {
  wallMs: number;
  wallAt: string;
  monotonicMs: number;
  clockDomainId: string;
}

function leaseError(code: TicketAuthorityErrorCode, message: string): never {
  throw new TicketAuthorityError(code, message);
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, description: string): T {
  const snapshot = snapshotAuthorityData(value);
  const result = schema.safeParse(snapshot);
  if (!result.success) {
    leaseError(
      'invalid-input',
      `Invalid ${description}: ${result.error.issues
        .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`)
        .sort()
        .join('; ')}`
    );
  }
  return result.data;
}

function sameIdentity(left: HostIdentitySnapshot, right: HostIdentitySnapshot): boolean {
  return left.providerId === right.providerId &&
    left.sessionRef === right.sessionRef &&
    left.principalRef === right.principalRef;
}

function sameBinding(
  state: LeaseAuthorityState,
  input: { runId: string; projectId: string; graphEpoch: number; cancellationGeneration: number }
): void {
  if (input.runId !== state.runId) leaseError('run-mismatch', 'Lease run binding mismatch');
  if (input.projectId !== state.projectId) leaseError('project-mismatch', 'Lease project binding mismatch');
  if (input.graphEpoch !== state.graphEpoch) leaseError('graph-epoch-mismatch', 'Lease graph epoch mismatch');
  if (input.cancellationGeneration !== state.cancellationGeneration) {
    leaseError('cancellation-generation-mismatch', 'Lease cancellation generation mismatch');
  }
}

function canonicalHighWaters(
  values: readonly z.infer<typeof workstreamLeaseHighWaterSchema>[]
): z.infer<typeof workstreamLeaseHighWaterSchema>[] {
  return [...values].sort((left, right) => left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0);
}

function canonicalWorkstreams(values: readonly WorkstreamLeaseRecord[]): WorkstreamLeaseRecord[] {
  return [...values].sort((left, right) => left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0);
}

function validateRecord(
  record: ControllerLeaseRecord | WorkstreamLeaseRecord,
  ttlMs: number,
  runDeadlineAt: string
): void {
  const acquired = Date.parse(record.acquiredAt);
  const heartbeat = Date.parse(record.heartbeatAt);
  const expires = Date.parse(record.expiresAt);
  if (acquired > heartbeat || heartbeat >= expires) {
    leaseError('invalid-state', 'Lease timestamp order is invalid');
  }
  if (expires !== Math.min(heartbeat + ttlMs, Date.parse(record.authorityDeadlineAt)) ||
      Date.parse(record.authorityDeadlineAt) > Date.parse(runDeadlineAt)) {
    leaseError('invalid-state', 'Lease expiry is not capped by TTL and authority deadline');
  }
  if (record.acquiredMonotonicMs > record.heartbeatMonotonicMs) {
    leaseError('invalid-state', 'Lease monotonic timestamp order is invalid');
  }
  if (record.lifecycle === 'active' && record.releasedAt !== null) {
    leaseError('invalid-state', 'Active lease cannot have releasedAt');
  }
  if (record.lifecycle === 'released') {
    if (record.releasedAt === null || Date.parse(record.releasedAt) < heartbeat ||
        Date.parse(record.releasedAt) >= expires) {
      leaseError('invalid-state', 'Released lease must have ordered releasedAt');
    }
  }
  if (record.lifecycle === 'invalidated' &&
      (record.releasedAt === null || Date.parse(record.releasedAt) < heartbeat)) {
    leaseError('invalid-state', 'Invalidated lease requires ordered invalidation timestamp');
  }
}

export function parseLeaseAuthorityState(value: unknown): Readonly<LeaseAuthorityState> {
  let snapshot: unknown;
  try {
    snapshot = snapshotAuthorityData(value);
  } catch (error) {
    leaseError('invalid-state', error instanceof Error ? error.message : String(error));
  }
  const result = leaseAuthorityStateSchema.safeParse(snapshot);
  if (!result.success) {
    leaseError(
      'invalid-state',
      `Invalid lease authority state: ${result.error.issues
        .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`)
        .sort()
        .join('; ')}`
    );
  }
  const state = result.data;
  if (state.heartbeatIntervalMs >= state.ttlMs) {
    leaseError('invalid-state', 'Heartbeat interval must be less than lease TTL');
  }
  if (Date.parse(state.runStartedAt) >= Date.parse(state.runDeadlineAt)) {
    leaseError('invalid-state', 'Run authority deadline must follow start');
  }
  if (new Set(state.monotonicHighWaters.map(record => record.domainId)).size !==
      state.monotonicHighWaters.length) {
    leaseError('invalid-state', 'Clock domain high-waters must be unique');
  }
  if (state.monotonicHighWaters.some((record, index) => index > 0 &&
      record.domainId <= state.monotonicHighWaters[index - 1].domainId)) {
    leaseError('invalid-state', 'Clock domain high-waters are not in canonical order');
  }
  if ((state.controllerLease === null) !== (state.controllerGenerationHighWater === 0)) {
    leaseError('invalid-state', 'Controller lease and generation high-water are inconsistent');
  }
  if ((state.controllerLease === null) !== (state.controllerFenceHighWater === 0)) {
    leaseError('invalid-state', 'Controller lease and fence high-water are inconsistent');
  }
  if (state.controllerLease) {
    validateRecord(state.controllerLease, state.ttlMs, state.runDeadlineAt);
    sameBinding(state, state.controllerLease);
    if (state.controllerLease.generation !== state.controllerGenerationHighWater ||
        state.controllerLease.fence !== state.controllerFenceHighWater) {
      leaseError('invalid-state', 'Controller lease generation/fence rolled back');
    }
  }
  if (new Set(state.workstreamLeases.map(record => record.nodeId)).size !== state.workstreamLeases.length ||
      new Set(state.workstreamHighWaters.map(record => record.nodeId)).size !== state.workstreamHighWaters.length) {
    leaseError('invalid-state', 'Workstream lease nodes must be unique');
  }
  if (state.workstreamLeases.length !== state.workstreamHighWaters.length) {
    leaseError('invalid-state', 'Workstream leases and high-waters are inconsistent');
  }
  const highWaters = new Map(state.workstreamHighWaters.map(record => [record.nodeId, record]));
  for (const record of state.workstreamLeases) {
    validateRecord(record, state.ttlMs, state.runDeadlineAt);
    sameBinding(state, record);
    const highWater = highWaters.get(record.nodeId);
    if (!highWater || highWater.generation !== record.generation || highWater.fence !== record.fence) {
      leaseError('invalid-state', `Workstream lease "${record.nodeId}" generation/fence rolled back`);
    }
    if (!state.controllerLease || record.controllerLeaseRef !== state.controllerLease.leaseRef ||
        record.controllerFence !== state.controllerLease.fence) {
      if (record.lifecycle === 'active') {
        leaseError('invalid-state', `Active workstream lease "${record.nodeId}" has stale controller lineage`);
      }
    }
  }
  const canonicalLeaseIds = canonicalWorkstreams(state.workstreamLeases).map(record => record.nodeId);
  const canonicalHighWaterIds = canonicalHighWaters(state.workstreamHighWaters).map(record => record.nodeId);
  if (state.workstreamLeases.some((record, index) => record.nodeId !== canonicalLeaseIds[index]) ||
      state.workstreamHighWaters.some((record, index) => record.nodeId !== canonicalHighWaterIds[index])) {
    leaseError('invalid-state', 'Workstream lease state is not in canonical node order');
  }
  const refs = [state.controllerLease?.leaseRef, ...state.workstreamLeases.map(record => record.leaseRef)]
    .filter((ref): ref is string => ref !== undefined);
  if (new Set(refs).size !== refs.length) leaseError('invalid-state', 'Lease refs must be unique');

  const latestWall = Math.max(
    0,
    ...[state.controllerLease, ...state.workstreamLeases]
      .filter((record): record is ControllerLeaseRecord | WorkstreamLeaseRecord => record !== null)
      .flatMap(record => [record.acquiredAt, record.heartbeatAt, record.releasedAt]
        .filter((timestamp): timestamp is string => timestamp !== null)
        .map(Date.parse))
  );
  if (latestWall > 0 && (state.wallClockHighWater === null || Date.parse(state.wallClockHighWater) < latestWall)) {
    leaseError('invalid-state', 'Wall clock high-water is behind lease records');
  }
  const domainRecords = [state.controllerLease, ...state.workstreamLeases]
    .filter((record): record is ControllerLeaseRecord | WorkstreamLeaseRecord => record !== null);
  for (const record of domainRecords) {
    const highWater = state.monotonicHighWaters.find(item => item.domainId === record.clockDomainId);
    if (!highWater || highWater.highWaterMs < record.heartbeatMonotonicMs) {
      leaseError('invalid-state', 'Monotonic clock high-water is behind lease records');
    }
  }
  if ((state.controllerLease !== null || state.workstreamLeases.length > 0) &&
      (state.wallClockHighWater === null || state.monotonicHighWaters.length === 0)) {
    leaseError('invalid-state', 'Lease records require wall and monotonic clock high-waters');
  }
  return canonicalAuthoritySnapshot(state);
}

export function createLeaseAuthorityState(input: unknown): Readonly<LeaseAuthorityState> {
  const parsed = parseInput(createLeaseStateInputSchema, input, 'lease state binding');
  const ttlMs = parsed.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const heartbeatIntervalMs = parsed.heartbeatIntervalMs ?? DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS;
  return parseLeaseAuthorityState({
    format: 'harness-mdocs/lease-authority',
    schemaVersion: 1,
    runId: parsed.runId,
    projectId: parsed.projectId,
    graphEpoch: parsed.graphEpoch,
    cancellationGeneration: parsed.cancellationGeneration,
    ttlMs,
    heartbeatIntervalMs,
    runStartedAt: parsed.runStartedAt,
    runDeadlineAt: parsed.runDeadlineAt,
    wallClockHighWater: null,
    monotonicHighWaters: [],
    controllerGenerationHighWater: 0,
    controllerFenceHighWater: 0,
    controllerLease: null,
    workstreamHighWaters: [],
    workstreamLeases: []
  });
}

function readClocks(state: LeaseAuthorityState, sources: LeaseSources): ClockReading {
  let wall: Date;
  let monotonicMs: number;
  let clockDomainId: string;
  try {
    wall = (sources.wallClock ?? (() => new Date()))();
    monotonicMs = (sources.monotonicClock ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))();
    clockDomainId = (sources.clockDomainId ?? (() => DEFAULT_CLOCK_DOMAIN_ID))();
  } catch {
    leaseError('clock-invalid', 'Lease clock source failed');
  }
  let wallMs: number;
  try {
    wallMs = Date.prototype.getTime.call(wall);
  } catch {
    leaseError('clock-invalid', 'Lease wall clock is invalid');
  }
  if (!(wall instanceof Date) || !Number.isSafeInteger(wallMs)) leaseError('clock-invalid', 'Lease wall clock is invalid');
  if (!Number.isSafeInteger(monotonicMs) || monotonicMs < 0 || Object.is(monotonicMs, -0)) {
    leaseError('clock-invalid', 'Lease monotonic clock must be a safe non-negative integer');
  }
  if (typeof clockDomainId !== 'string' || clockDomainId.length === 0 || clockDomainId.length > 16 * 1024) {
    leaseError('clock-invalid', 'Lease clock domain ID must be a non-empty bounded string');
  }
  if (state.wallClockHighWater !== null && wallMs < Date.parse(state.wallClockHighWater)) {
    leaseError('clock-regression', 'Lease wall clock regressed');
  }
  const domainHighWater = state.monotonicHighWaters.find(record => record.domainId === clockDomainId);
  if (domainHighWater && monotonicMs < domainHighWater.highWaterMs) {
    leaseError('clock-regression', 'Lease monotonic clock regressed');
  }
  return { wallMs, wallAt: new Date(wallMs).toISOString(), monotonicMs, clockDomainId };
}

function nextNumber(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    leaseError('generation-exhausted', `${name} exhausted`);
  }
  return value + 1;
}

function expiresAt(wallMs: number, ttlMs: number, deadlineAt: string): string {
  const expires = Math.min(wallMs + ttlMs, Date.parse(deadlineAt));
  if (!Number.isSafeInteger(expires)) leaseError('clock-invalid', 'Lease expiry is outside safe range');
  try {
    return new Date(expires).toISOString();
  } catch {
    leaseError('clock-invalid', 'Lease expiry cannot be represented as RFC3339');
  }
}

function nextRef(state: LeaseAuthorityState, kind: 'controller' | 'workstream', sources: LeaseSources): string {
  const existing = new Set([
    state.controllerLease?.leaseRef,
    ...state.workstreamLeases.map(record => record.leaseRef)
  ].filter((ref): ref is string => ref !== undefined));
  const source = sources.testOnlyRandomBytes ?? (() => crypto.randomBytes(32));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let bytes: Buffer;
    try {
      bytes = source();
    } catch {
      leaseError('random-source-invalid', 'Lease ref source failed');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > 128) {
      leaseError('random-source-invalid', 'Lease entropy source must return 32..128 bytes');
    }
    const random = bytes.toString('base64url');
    const ref = `opaque-lease:${kind}:${random}`;
    if (!existing.has(ref)) return ref;
  }
  leaseError('random-source-invalid', 'Lease ref source repeated an existing ref');
}

function withClockHighWater(state: LeaseAuthorityState, reading: ClockReading): LeaseAuthorityState {
  const existing = state.monotonicHighWaters.find(record => record.domainId === reading.clockDomainId);
  const monotonicHighWaters = [
    ...state.monotonicHighWaters.filter(record => record.domainId !== reading.clockDomainId),
    {
      domainId: reading.clockDomainId,
      highWaterMs: Math.max(existing?.highWaterMs ?? 0, reading.monotonicMs)
    }
  ].sort((left, right) => left.domainId < right.domainId ? -1
    : left.domainId > right.domainId ? 1 : 0);
  return {
    ...state,
    wallClockHighWater: reading.wallAt,
    monotonicHighWaters
  };
}

function invalidateWorkstreams(
  state: LeaseAuthorityState,
  at: string
): WorkstreamLeaseRecord[] {
  return canonicalWorkstreams(state.workstreamLeases.map(record => record.lifecycle === 'active'
    ? { ...record, lifecycle: 'invalidated' as const, releasedAt: at }
    : record));
}

function proofFor(record: ControllerLeaseRecord): ControllerLeaseProof;
function proofFor(record: WorkstreamLeaseRecord): WorkstreamLeaseProof;
function proofFor(record: ControllerLeaseRecord | WorkstreamLeaseRecord): ControllerLeaseProof | WorkstreamLeaseProof {
  return record.kind === 'controller'
    ? { kind: 'controller', leaseRef: record.leaseRef, generation: record.generation, fence: record.fence }
    : {
        kind: 'workstream',
        nodeId: record.nodeId,
        leaseRef: record.leaseRef,
        generation: record.generation,
        fence: record.fence
      };
}

function exactProof(
  record: ControllerLeaseRecord | WorkstreamLeaseRecord,
  proof: ControllerLeaseProof | WorkstreamLeaseProof
): void {
  if (record.kind !== proof.kind || record.leaseRef !== proof.leaseRef ||
      record.generation !== proof.generation || record.fence !== proof.fence ||
      (record.kind === 'workstream' &&
        (proof.kind !== 'workstream' || record.nodeId !== proof.nodeId))) {
    leaseError('stale-lease', 'Lease ref, generation, or fence is stale');
  }
}

function assertLive(
  state: LeaseAuthorityState,
  record: ControllerLeaseRecord | WorkstreamLeaseRecord,
  proof: ControllerLeaseProof | WorkstreamLeaseProof,
  holder: HostIdentitySnapshot,
  reading: ClockReading
): void {
  exactProof(record, proof);
  if (record.clockDomainId !== reading.clockDomainId) {
    leaseError('clock-regression', 'Lease proof crossed monotonic clock domains');
  }
  if (!sameIdentity(record.holder, holder)) leaseError('holder-mismatch', 'Lease holder identity mismatch');
  if (record.lifecycle !== 'active') leaseError('inactive-lease', 'Lease is released');
  if (reading.wallMs >= Date.parse(record.expiresAt)) leaseError('expired-lease', 'Lease is expired');
  sameBinding(state, record);
}

export function controllerLeasePlaceholder(record: ControllerLeaseRecord): TicketLeasePlaceholder {
  return canonicalAuthoritySnapshot({
    ref: record.leaseRef,
    generation: record.generation,
    fence: record.fence
  });
}

export function workstreamLeasePlaceholder(record: WorkstreamLeaseRecord): TicketLeasePlaceholder {
  return canonicalAuthoritySnapshot({
    ref: record.leaseRef,
    generation: record.generation,
    fence: record.fence
  });
}

export function acquireControllerLease(
  rawState: unknown,
  rawInput: unknown,
  sources: LeaseSources = {}
): ControllerLeaseTransition {
  const state = parseLeaseAuthorityState(rawState);
  const input = parseInput(acquireControllerInputSchema, rawInput, 'controller lease acquisition');
  sameBinding(state, input);
  const reading = readClocks(state, sources);
  if (reading.wallMs >= Date.parse(state.runDeadlineAt)) {
    leaseError('expired-lease', 'Run authority deadline has elapsed');
  }
  if (state.controllerLease?.lifecycle === 'active' &&
      reading.wallMs < Date.parse(state.controllerLease.expiresAt)) {
    leaseError('lease-held', 'Controller lease is active and unexpired');
  }
  const generation = nextNumber(state.controllerGenerationHighWater, 'Controller lease generation');
  const fence = nextNumber(state.controllerFenceHighWater, 'Controller lease fence');
  const lease: ControllerLeaseRecord = {
    kind: 'controller',
    holderRole: 'PLAN_ROOT',
    leaseRef: nextRef(state, 'controller', sources),
    generation,
    fence,
    holder: input.holder,
    runId: state.runId,
    projectId: state.projectId,
    graphEpoch: state.graphEpoch,
    cancellationGeneration: state.cancellationGeneration,
    acquiredAt: reading.wallAt,
    heartbeatAt: reading.wallAt,
    expiresAt: expiresAt(reading.wallMs, state.ttlMs, state.runDeadlineAt),
    authorityDeadlineAt: state.runDeadlineAt,
    clockDomainId: reading.clockDomainId,
    releasedAt: null,
    lifecycle: 'active',
    acquiredMonotonicMs: reading.monotonicMs,
    heartbeatMonotonicMs: reading.monotonicMs
  };
  const next = parseLeaseAuthorityState({
    ...withClockHighWater(state, reading),
    controllerGenerationHighWater: generation,
    controllerFenceHighWater: fence,
    controllerLease: lease,
    workstreamLeases: invalidateWorkstreams(state, reading.wallAt)
  });
  return canonicalAuthoritySnapshot({ state: next, lease });
}

export function validateControllerLease(
  rawState: unknown,
  rawInput: unknown,
  sources: LeaseSources = {}
): Readonly<ControllerLeaseRecord> {
  const state = parseLeaseAuthorityState(rawState);
  const input = parseInput(controllerOperationInputSchema, rawInput, 'controller lease validation');
  sameBinding(state, input);
  const reading = readClocks(state, sources);
  if (!state.controllerLease) leaseError('lease-required', 'Controller lease is absent');
  if (state.controllerLease.clockDomainId !== reading.clockDomainId) {
    leaseError('clock-regression', 'Controller heartbeat crossed monotonic clock domains');
  }
  assertLive(state, state.controllerLease, input.proof, input.holder, reading);
  return canonicalAuthoritySnapshot(state.controllerLease);
}

export function heartbeatControllerLease(
  rawState: unknown,
  rawInput: unknown,
  sources: LeaseSources = {}
): ControllerLeaseTransition {
  const state = parseLeaseAuthorityState(rawState);
  const input = parseInput(controllerOperationInputSchema, rawInput, 'controller lease heartbeat');
  sameBinding(state, input);
  const reading = readClocks(state, sources);
  if (!state.controllerLease) leaseError('lease-required', 'Controller lease is absent');
  if (state.controllerLease.clockDomainId !== reading.clockDomainId) {
    leaseError('clock-regression', 'Controller heartbeat crossed monotonic clock domains');
  }
  assertLive(state, state.controllerLease, input.proof, input.holder, reading);
  if (reading.monotonicMs - state.controllerLease.heartbeatMonotonicMs < state.heartbeatIntervalMs) {
    leaseError('heartbeat-too-early', 'Controller heartbeat is before configured cadence');
  }
  const lease: ControllerLeaseRecord = {
    ...state.controllerLease,
    heartbeatAt: reading.wallAt,
    expiresAt: expiresAt(reading.wallMs, state.ttlMs, state.controllerLease.authorityDeadlineAt),
    heartbeatMonotonicMs: reading.monotonicMs
  };
  const next = parseLeaseAuthorityState({
    ...withClockHighWater(state, reading),
    controllerLease: lease
  });
  return canonicalAuthoritySnapshot({ state: next, lease });
}

export function releaseControllerLease(
  rawState: unknown,
  rawInput: unknown,
  sources: LeaseSources = {}
): ControllerLeaseTransition {
  const state = parseLeaseAuthorityState(rawState);
  const input = parseInput(controllerOperationInputSchema, rawInput, 'controller lease release');
  sameBinding(state, input);
  const reading = readClocks(state, sources);
  if (!state.controllerLease) leaseError('lease-required', 'Controller lease is absent');
  exactProof(state.controllerLease, input.proof);
  if (!sameIdentity(state.controllerLease.holder, input.holder)) {
    leaseError('holder-mismatch', 'Lease holder identity mismatch');
  }
  if (state.controllerLease.lifecycle === 'released') {
    return canonicalAuthoritySnapshot({ state, lease: state.controllerLease });
  }
  if (state.controllerLease.clockDomainId !== reading.clockDomainId) {
    leaseError('clock-regression', 'Controller release crossed monotonic clock domains');
  }
  if (reading.wallMs >= Date.parse(state.controllerLease.expiresAt)) {
    leaseError('expired-lease', 'Lease is expired');
  }
  const lease: ControllerLeaseRecord = {
    ...state.controllerLease,
    lifecycle: 'released',
    releasedAt: reading.wallAt
  };
  const next = parseLeaseAuthorityState({
    ...withClockHighWater(state, reading),
    controllerLease: lease,
    workstreamLeases: invalidateWorkstreams(state, reading.wallAt)
  });
  return canonicalAuthoritySnapshot({ state: next, lease });
}

function assertExecutionTicket(
  state: LeaseAuthorityState,
  input: z.infer<typeof acquireWorkstreamInputSchema>,
  reading: ClockReading
): void {
  const ticket = input.ticket;
  sameBinding(state, ticket);
  if (ticket.nodeId !== input.nodeId || ticket.recipientRole !== 'EXECUTION') {
    leaseError('wrong-role', 'Workstream lease requires matching EXECUTION ticket');
  }
  if (!sameIdentity(ticket.holder, input.holder)) {
    leaseError('holder-mismatch', 'Workstream holder does not match ticket host identity');
  }
  if (reading.wallMs >= Date.parse(ticket.expiresAt)) {
    leaseError('expired-ticket', 'Execution ticket is expired');
  }
  if (ticket.lease.ref !== input.controllerProof.leaseRef ||
      ticket.lease.generation !== input.controllerProof.generation ||
      ticket.lease.fence !== input.controllerProof.fence) {
    leaseError('stale-lease', 'Execution ticket is not bound to current controller lease');
  }
}

export function acquireWorkstreamLease(
  rawState: unknown,
  rawInput: unknown,
  sources: LeaseSources = {}
): WorkstreamLeaseTransition {
  const state = parseLeaseAuthorityState(rawState);
  const input = parseInput(acquireWorkstreamInputSchema, rawInput, 'workstream lease acquisition');
  sameBinding(state, input);
  const reading = readClocks(state, sources);
  assertExecutionTicket(state, input, reading);
  if (!state.controllerLease) leaseError('lease-required', 'Controller lease is absent');
  assertLive(state, state.controllerLease, input.controllerProof, input.controllerHolder, reading);
  const authorityDeadlineMs = Math.min(
    Date.parse(state.runDeadlineAt), Date.parse(input.ticket.expiresAt)
  );
  if (reading.wallMs >= authorityDeadlineMs) {
    leaseError('expired-ticket', 'Workstream authority deadline has elapsed');
  }
  const current = state.workstreamLeases.find(record => record.nodeId === input.nodeId);
  if (current?.lifecycle === 'active' && reading.wallMs < Date.parse(current.expiresAt)) {
    leaseError('lease-held', `Workstream lease "${input.nodeId}" is active and unexpired`);
  }
  const highWater = state.workstreamHighWaters.find(record => record.nodeId === input.nodeId);
  const generation = nextNumber(highWater?.generation ?? 0, 'Workstream lease generation');
  const fence = nextNumber(highWater?.fence ?? 0, 'Workstream lease fence');
  const lease: WorkstreamLeaseRecord = {
    kind: 'workstream',
    holderRole: 'EXECUTION',
    nodeId: input.nodeId,
    ticketHandleId: input.ticket.ticketHandleId,
    leaseRef: nextRef(state, 'workstream', sources),
    generation,
    fence,
    holder: input.holder,
    runId: state.runId,
    projectId: state.projectId,
    graphEpoch: state.graphEpoch,
    cancellationGeneration: state.cancellationGeneration,
    acquiredAt: reading.wallAt,
    heartbeatAt: reading.wallAt,
    authorityDeadlineAt: new Date(authorityDeadlineMs).toISOString(),
    expiresAt: expiresAt(
      reading.wallMs, state.ttlMs, new Date(authorityDeadlineMs).toISOString()
    ),
    clockDomainId: reading.clockDomainId,
    controllerLeaseRef: state.controllerLease.leaseRef,
    controllerFence: state.controllerLease.fence,
    releasedAt: null,
    lifecycle: 'active',
    acquiredMonotonicMs: reading.monotonicMs,
    heartbeatMonotonicMs: reading.monotonicMs
  };
  const workstreamLeases = canonicalWorkstreams([
    ...state.workstreamLeases.filter(record => record.nodeId !== input.nodeId),
    lease
  ]);
  const workstreamHighWaters = canonicalHighWaters([
    ...state.workstreamHighWaters.filter(record => record.nodeId !== input.nodeId),
    { nodeId: input.nodeId, generation, fence }
  ]);
  const next = parseLeaseAuthorityState({
    ...withClockHighWater(state, reading),
    workstreamLeases,
    workstreamHighWaters
  });
  return canonicalAuthoritySnapshot({ state: next, lease });
}

export function validateWorkstreamLease(
  rawState: unknown,
  rawInput: unknown,
  sources: LeaseSources = {}
): Readonly<WorkstreamLeaseRecord> {
  const state = parseLeaseAuthorityState(rawState);
  const input = parseInput(workstreamOperationInputSchema, rawInput, 'workstream lease validation');
  sameBinding(state, input);
  const reading = readClocks(state, sources);
  const record = state.workstreamLeases.find(candidate => candidate.nodeId === input.nodeId);
  if (!record) leaseError('lease-required', `Workstream lease "${input.nodeId}" is absent`);
  if (!state.controllerLease || state.controllerLease.lifecycle !== 'active' ||
      reading.wallMs >= Date.parse(state.controllerLease.expiresAt) ||
      record.controllerLeaseRef !== state.controllerLease.leaseRef ||
      record.controllerFence !== state.controllerLease.fence) {
    leaseError('stale-lease', 'Workstream controller lineage is no longer active');
  }
  assertLive(state, record, input.proof, input.holder, reading);
  return canonicalAuthoritySnapshot(record);
}

export function heartbeatWorkstreamLease(
  rawState: unknown,
  rawInput: unknown,
  sources: LeaseSources = {}
): WorkstreamLeaseTransition {
  const state = parseLeaseAuthorityState(rawState);
  const input = parseInput(workstreamOperationInputSchema, rawInput, 'workstream lease heartbeat');
  sameBinding(state, input);
  const reading = readClocks(state, sources);
  const current = state.workstreamLeases.find(record => record.nodeId === input.nodeId);
  if (!current) leaseError('lease-required', `Workstream lease "${input.nodeId}" is absent`);
  if (current.clockDomainId !== reading.clockDomainId) {
    leaseError('clock-regression', 'Workstream heartbeat crossed monotonic clock domains');
  }
  if (!state.controllerLease || state.controllerLease.lifecycle !== 'active' ||
      current.controllerLeaseRef !== state.controllerLease.leaseRef ||
      current.controllerFence !== state.controllerLease.fence) {
    leaseError('stale-lease', 'Workstream controller lineage is no longer active');
  }
  assertLive(state, current, input.proof, input.holder, reading);
  if (reading.monotonicMs - current.heartbeatMonotonicMs < state.heartbeatIntervalMs) {
    leaseError('heartbeat-too-early', 'Workstream heartbeat is before configured cadence');
  }
  const lease: WorkstreamLeaseRecord = {
    ...current,
    heartbeatAt: reading.wallAt,
    expiresAt: expiresAt(reading.wallMs, state.ttlMs, current.authorityDeadlineAt),
    heartbeatMonotonicMs: reading.monotonicMs
  };
  const next = parseLeaseAuthorityState({
    ...withClockHighWater(state, reading),
    workstreamLeases: canonicalWorkstreams([
      ...state.workstreamLeases.filter(record => record.nodeId !== input.nodeId),
      lease
    ])
  });
  return canonicalAuthoritySnapshot({ state: next, lease });
}

export function releaseWorkstreamLease(
  rawState: unknown,
  rawInput: unknown,
  sources: LeaseSources = {}
): WorkstreamLeaseTransition {
  const state = parseLeaseAuthorityState(rawState);
  const input = parseInput(workstreamOperationInputSchema, rawInput, 'workstream lease release');
  sameBinding(state, input);
  const reading = readClocks(state, sources);
  const current = state.workstreamLeases.find(record => record.nodeId === input.nodeId);
  if (!current) leaseError('lease-required', `Workstream lease "${input.nodeId}" is absent`);
  exactProof(current, input.proof);
  if (!sameIdentity(current.holder, input.holder)) leaseError('holder-mismatch', 'Lease holder identity mismatch');
  if (current.lifecycle === 'released') return canonicalAuthoritySnapshot({ state, lease: current });
  if (current.clockDomainId !== reading.clockDomainId) {
    leaseError('clock-regression', 'Workstream release crossed monotonic clock domains');
  }
  if (reading.wallMs >= Date.parse(current.expiresAt)) leaseError('expired-lease', 'Lease is expired');
  const lease: WorkstreamLeaseRecord = {
    ...current,
    lifecycle: 'released',
    releasedAt: reading.wallAt
  };
  const next = parseLeaseAuthorityState({
    ...withClockHighWater(state, reading),
    workstreamLeases: canonicalWorkstreams([
      ...state.workstreamLeases.filter(record => record.nodeId !== input.nodeId),
      lease
    ])
  });
  return canonicalAuthoritySnapshot({ state: next, lease });
}

export function controllerProof(record: ControllerLeaseRecord): Readonly<ControllerLeaseProof> {
  return canonicalAuthoritySnapshot(proofFor(record));
}

export function workstreamProof(record: WorkstreamLeaseRecord): Readonly<WorkstreamLeaseProof> {
  return canonicalAuthoritySnapshot(proofFor(record));
}

export function invalidateWorkstreamLeases(
  rawState: unknown,
  nodeIds: readonly string[],
  sources: LeaseSources = {}
): Readonly<LeaseAuthorityState> {
  const state = parseLeaseAuthorityState(rawState);
  const targets = new Set(nodeIds);
  if (targets.size === 0) return state;
  const reading = readClocks(state, sources);
  return parseLeaseAuthorityState({
    ...withClockHighWater(state, reading),
    workstreamLeases: canonicalWorkstreams(state.workstreamLeases.map(record =>
      targets.has(record.nodeId) && record.lifecycle === 'active'
        ? { ...record, lifecycle: 'invalidated' as const, releasedAt: reading.wallAt }
        : record))
  });
}

export function invalidateWorkstreamLeasesByTicketHandles(
  rawState: unknown,
  ticketHandleIds: readonly string[],
  sources: LeaseSources = {}
): Readonly<LeaseAuthorityState> {
  const state = parseLeaseAuthorityState(rawState);
  const targets = new Set(ticketHandleIds);
  if (targets.size === 0) return state;
  const reading = readClocks(state, sources);
  return parseLeaseAuthorityState({
    ...withClockHighWater(state, reading),
    workstreamLeases: canonicalWorkstreams(state.workstreamLeases.map(record =>
      targets.has(record.ticketHandleId) && record.lifecycle === 'active'
        ? { ...record, lifecycle: 'invalidated' as const, releasedAt: reading.wallAt }
        : record))
  });
}

export function invalidateAllLeases(
  rawState: unknown,
  sources: LeaseSources = {}
): Readonly<LeaseAuthorityState> {
  const state = parseLeaseAuthorityState(rawState);
  const reading = readClocks(state, sources);
  const controllerLease = state.controllerLease?.lifecycle === 'active'
    ? { ...state.controllerLease, lifecycle: 'invalidated' as const, releasedAt: reading.wallAt }
    : state.controllerLease;
  return parseLeaseAuthorityState({
    ...withClockHighWater(state, reading),
    controllerLease,
    workstreamLeases: invalidateWorkstreams(state, reading.wallAt)
  });
}
