import { canonicalizeJson } from '../../contracts';
import {
  computeRunControllerBindingDigest,
  computeRunControllerCommandId,
  computeRunControllerEventDigest,
  computeRunControllerModelDigest,
  computeRunControllerPayloadDigest,
  computeRunControllerQuiescenceDigest,
  Digest,
  ProtectedRunControllerCommandPayload,
  RunControllerCommand,
  RunControllerCommandCompletionProof,
  RunControllerCommandKind,
  RunControllerEvent,
  RunControllerState
} from './algebra';
import { projectRunController, RunControllerView } from './projection';
import {
  ProtectedRunControllerRepository,
  RunControllerRepositorySnapshot
} from './repository';
import {
  canonicalRunControllerSnapshot,
  parseRunControllerCommandCompletionProof,
  parseRunControllerEvent,
  RUN_CONTROLLER_LIMITS
} from './schema';

const DRIVER_RESULT_MAX_BYTES = RUN_CONTROLLER_LIMITS.normalTransitionBytes;
const DEFAULT_HOST_CALL_TIMEOUT_MS = 30_000;
const MAX_HOST_CALL_TIMEOUT_MS = 120_000;
const WORKSTREAM_FENCE_KINDS: readonly RunControllerCommandKind[] = Object.freeze([
  'evidence.validate-preliminary-report', 'authority.settle-usage',
  'mediator.finalize-receipts', 'evidence.validate-final-report'
]);
const PRE_CONTROLLER_KINDS: readonly RunControllerCommandKind[] = Object.freeze([
  'fidelity.preflight', 'authority.initialize', 'authority.acquire-controller'
]);
const FIXED_BINDING_NAMES: Readonly<Record<RunControllerCommandKind, readonly string[]>> = Object.freeze({
  'fidelity.preflight': Object.freeze(['graph', 'plan', 'requirements']),
  'authority.initialize': Object.freeze(['approval', 'graph', 'mode-selection', 'plan']),
  'authority.acquire-controller': Object.freeze(['authority-state', 'graph', 'plan']),
  'authority.issue-eo-ticket': Object.freeze(['graph', 'plan']),
  'mediator.spawn-eo': Object.freeze(['graph', 'plan', 'ticket-ref']),
  'authority.claim-workstream': Object.freeze(['graph', 'plan', 'spawn-ref', 'ticket-ref']),
  'evidence.validate-preliminary-report': Object.freeze(['graph', 'plan', 'report']),
  'authority.settle-usage': Object.freeze(['graph', 'plan', 'preliminary-evidence', 'report']),
  'mediator.finalize-receipts': Object.freeze([
    'graph', 'pending-projection-inputs', 'plan', 'settled-usage'
  ]),
  'evidence.validate-final-report': Object.freeze([
    'committed-projections', 'graph', 'plan', 'report-input', 'settled-usage'
  ]),
  'integration.root-milestone': Object.freeze([
    'budget-summary', 'committed-projections', 'eo-final-evidence', 'eo-final-report',
    'graph', 'plan', 'settled-usage'
  ]),
  'integration.root-global-seal-verdict': Object.freeze([
    'budget-summary', 'committed-projections', 'graph', 'milestone-evidence',
    'milestone-report', 'plan', 'settled-usage'
  ]),
  'checkpoint.persist': Object.freeze(['graph', 'plan']),
  'authority.cancel': Object.freeze(['closure-reason', 'graph', 'plan']),
  'descendant.signal': Object.freeze(['graph', 'plan']),
  'descendant.force': Object.freeze(['graph', 'plan']),
  'controller.recover-pending-command': Object.freeze(['graph', 'plan'])
});
const CHECKPOINT_BINDING_NAME_SETS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['assessment', 'graph', 'plan']),
  Object.freeze(['graph', 'milestone-evidence', 'plan']),
  Object.freeze(['graph', 'plan', 'report-evidence']),
  Object.freeze(['graph', 'plan'])
]);

type HostCommand<K extends RunControllerCommandKind> = RunControllerCommand & Readonly<{ kind: K }>;
export type RunControllerHostRequestFor<K extends RunControllerCommandKind> = Readonly<{
  kind: K;
  idempotencyKey: string;
  command: HostCommand<K>;
  protectedPayload: ProtectedRunControllerCommandPayload;
  modelDigest: Digest;
}>;
export type RunControllerHostRequest = {
  [K in RunControllerCommandKind]: RunControllerHostRequestFor<K>
}[RunControllerCommandKind];
export type RunControllerHostExecuteOnceRequest = Exclude<
  RunControllerHostRequest,
  RunControllerHostRequestFor<'controller.recover-pending-command'>
>;

type RunControllerHostExecutableKind = Exclude<
  RunControllerCommandKind,
  'controller.recover-pending-command'
>;
type RunControllerHostProofFor<K extends RunControllerHostExecutableKind> =
  RunControllerCommandCompletionProof extends infer P
    ? P extends { kind: RunControllerCommandKind }
      ? K extends P['kind'] ? P & Readonly<{ kind: K }> : never
      : never
    : never;
export type RunControllerHostAppliedResultFor<K extends RunControllerHostExecutableKind> = Readonly<{
  status: 'applied';
  kind: K;
  observedAt: string;
  proof: RunControllerHostProofFor<K>;
}>;
export type RunControllerHostAppliedResult = {
  [K in RunControllerHostExecutableKind]: RunControllerHostAppliedResultFor<K>
}[RunControllerHostExecutableKind];
export type RunControllerHostIndeterminateCode = 'ack-lost' | 'timeout' | 'transport' | 'unknown';
export type RunControllerHostExecutionResult =
  | RunControllerHostAppliedResult
  | {
      [K in RunControllerHostExecutableKind]: Readonly<{
        status: 'in-progress';
        kind: K;
        observedAt: string;
      }>
    }[RunControllerHostExecutableKind]
  | {
      [K in RunControllerHostExecutableKind]: Readonly<{
        status: 'indeterminate';
        kind: K;
        observedAt: string;
        code: RunControllerHostIndeterminateCode;
      }>
    }[RunControllerHostExecutableKind];
export type RunControllerHostReconciliationResult =
  | RunControllerHostAppliedResult
  | {
      [K in RunControllerCommandKind]: Readonly<{
        status: 'still-uncertain' | 'unsupported';
        kind: K;
        observedAt: string;
      }>
    }[RunControllerCommandKind]
  | {
      [K in RunControllerCommandKind]: Readonly<{
        status: 'not-applied';
        kind: K;
        observedAt: string;
        quiesced: true;
        quiescenceDigest: Digest;
      }>
    }[RunControllerCommandKind];

export interface RunControllerHostExecutionContext {
  readonly signal: AbortSignal;
}

export interface RunControllerHostPort {
  reconcile(
    request: RunControllerHostRequest,
    context: Readonly<RunControllerHostExecutionContext>
  ): Promise<RunControllerHostReconciliationResult>;
  /**
   * Production adapters MUST atomically and durably claim idempotencyKey before any effect.
   * idempotencyKey MUST equal command.id. Repeated/concurrent claims must join or reconcile
   * the durable attempt and must never start a second effect, including across processes.
   * They return the same durable applied result, or a typed in-progress/indeterminate outcome.
   */
  executeOnce(
    request: RunControllerHostExecuteOnceRequest,
    context: Readonly<RunControllerHostExecutionContext>
  ): Promise<RunControllerHostExecutionResult>;
}

export type RunControllerDriverEventPhase =
  | 'reconcile' | 'execute' | 'failure' | 'uncertain' | 'recovery';

export interface RunControllerTrustedEventSource {
  eventId(input: Readonly<{ commandId: string; phase: RunControllerDriverEventPhase }>): string;
  now(): string;
}

export type RunControllerDriverStatus =
  | 'advanced' | 'blocked' | 'terminal' | 'recovery-required'
  | 'incompatible' | 'unavailable' | 'step-limit';

export type RunControllerDriverReasonCode =
  | 'approval-required' | 'eo-running' | 'paused' | 'no-progress'
  | 'recovery-still-uncertain' | 'protected-state-invalid'
  | 'protected-state-missing' | 'repository-unavailable' | 'repository-incompatible'
  | 'command-binding-invalid' | 'host-result-invalid' | 'host-reconcile-unavailable'
  | 'host-reconciliation-unsupported' | 'completion-commit-unknown'
  | 'completion-conflict' | 'transition-rejected' | 'step-limit';

export interface RunControllerDriverResult {
  readonly status: RunControllerDriverStatus;
  readonly state: Readonly<RunControllerView> | null;
  readonly reasonCode: RunControllerDriverReasonCode | null;
  readonly steps: number;
}

export interface CreateRunControllerDriverOptions {
  repository: ProtectedRunControllerRepository;
  host: RunControllerHostPort;
  eventSource: RunControllerTrustedEventSource;
  hostCallTimeoutMs?: number;
}

export class RunControllerHostKnownFailureError extends Error {
  readonly name = 'RunControllerHostKnownFailureError';
  constructor(
    readonly code: 'rejected' | 'conflict' | 'policy-denied' | 'invalid-input',
    readonly observedAt: string
  ) {
    super('RunController host reported a known failure');
  }
}

function frozenResult(
  status: RunControllerDriverStatus,
  state: Readonly<RunControllerState> | null,
  reasonCode: RunControllerDriverReasonCode | null,
  steps = 1
): Readonly<RunControllerDriverResult> {
  return canonicalRunControllerSnapshot({
    status,
    state: state === null ? null : projectRunController(state),
    reasonCode,
    steps
  });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function computeRunControllerDriverEventId(
  commandId: string,
  phase: RunControllerDriverEventPhase
): string {
  return `rcevt:${computeRunControllerBindingDigest('driver-event-id', { commandId, phase }).slice(7)}`;
}

function eventId(
  source: RunControllerTrustedEventSource,
  commandId: string,
  phase: RunControllerDriverEventPhase
): string {
  const expected = computeRunControllerDriverEventId(commandId, phase);
  const supplied = source.eventId(canonicalRunControllerSnapshot({ commandId, phase }));
  if (supplied !== expected) throw new Error('Trusted event source returned noncanonical event ID');
  return supplied;
}

function timestampFromSource(source: RunControllerTrustedEventSource): string {
  const value = source.now();
  if (!canonicalTimestamp(value)) throw new Error('Trusted event source returned noncanonical timestamp');
  return value;
}

function expectedFence(state: Readonly<RunControllerState>, kind: RunControllerCommandKind): number | null {
  if (PRE_CONTROLLER_KINDS.includes(kind)) return null;
  if (WORKSTREAM_FENCE_KINDS.includes(kind)) return state.execution.workstreamLeaseFence;
  return state.authorityAcquired ? state.controllerLeaseFence : null;
}

function expectedNode(state: Readonly<RunControllerState>, kind: RunControllerCommandKind): string | null {
  if (['authority.issue-eo-ticket', 'mediator.spawn-eo', 'authority.claim-workstream',
    'evidence.validate-preliminary-report', 'authority.settle-usage',
    'mediator.finalize-receipts', 'evidence.validate-final-report'].includes(kind)) {
    return state.execution.nodeId;
  }
  if (kind === 'integration.root-milestone') return state.model.milestones[0].integrationNodeId;
  if (kind === 'integration.root-global-seal-verdict') return state.globalIntegration.nodeId;
  return null;
}

function bindingNamesValid(
  state: Readonly<RunControllerState>,
  kind: RunControllerCommandKind,
  names: readonly string[],
  active: boolean
): boolean {
  let candidates: readonly (readonly string[])[] = [FIXED_BINDING_NAMES[kind]];
  if (kind === 'checkpoint.persist') {
    if (!active) {
      candidates = CHECKPOINT_BINDING_NAME_SETS;
    } else if (state.phase === 'cancellation-checkpoint') {
      candidates = [FIXED_BINDING_NAMES[kind]];
    } else if (state.phase === 'report-resolution') {
      candidates = [CHECKPOINT_BINDING_NAME_SETS[2]];
    } else if (state.phase === 'milestone-hold' || state.milestone.state === 'accepted') {
      candidates = [CHECKPOINT_BINDING_NAME_SETS[1]];
    } else {
      candidates = [CHECKPOINT_BINDING_NAME_SETS[0]];
    }
  }
  return candidates.some(expected =>
    names.length === expected.length && names.every((name, index) => name === expected[index]));
}

function validateCommandEntry(
  state: Readonly<RunControllerState>,
  entry: Readonly<Pick<RunControllerState['outbox'][number], 'command' | 'protectedPayload'>>,
  active: boolean
): void {
  const { command, protectedPayload } = entry;
  const names = protectedPayload.bindings.map(binding => binding.name);
  const plan = protectedPayload.bindings.find(binding => binding.name === 'plan');
  const graph = protectedPayload.bindings.find(binding => binding.name === 'graph');
  if (command.runId !== state.runId || command.projectId !== state.projectId || command.ordinal !== 0 ||
      command.nodeId !== expectedNode(state, command.kind) ||
      state.modelDigest !== computeRunControllerModelDigest(state.model) ||
      plan?.digest !== state.model.planDigest || graph?.digest !== state.model.graphDigest ||
      !bindingNamesValid(state, command.kind, names, active) ||
      command.payloadDigest !== computeRunControllerPayloadDigest(protectedPayload) ||
      command.id !== computeRunControllerCommandId({
        runId: command.runId,
        projectId: command.projectId,
        controllerEpoch: command.expectedControllerEpoch,
        expectedLeaseFence: command.expectedLeaseFence,
        graphEpoch: protectedPayload.graphEpoch,
        transitionSequence: command.transitionSequence,
        ordinal: command.ordinal,
        kind: command.kind,
        nodeId: command.nodeId,
        attempt: command.attempt,
        payloadDigest: command.payloadDigest
      }) || (active && (
        command.expectedControllerEpoch !== state.controllerEpoch ||
        command.expectedLeaseFence !== expectedFence(state, command.kind) ||
        protectedPayload.graphEpoch !== state.graphEpoch ||
        protectedPayload.cancellationGeneration !== state.cancellationGeneration
      ))) {
    throw new Error('Protected RunController command binding is invalid');
  }
}

function materialize(
  state: Readonly<RunControllerState>,
  entry: Readonly<Pick<RunControllerState['outbox'][number], 'command' | 'protectedPayload'>>,
  active: boolean
): RunControllerHostRequest {
  validateCommandEntry(state, entry, active);
  return canonicalRunControllerSnapshot({
    kind: entry.command.kind,
    idempotencyKey: entry.command.id,
    command: entry.command,
    protectedPayload: entry.protectedPayload,
    modelDigest: state.modelDigest
  }) as RunControllerHostRequest;
}

function snapshotHostResult(value: unknown): Record<string, unknown> {
  const snapshot = canonicalRunControllerSnapshot(value) as unknown;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      Buffer.byteLength(canonicalizeJson(snapshot), 'utf8') > DRIVER_RESULT_MAX_BYTES) {
    throw new Error('Host result is not a bounded record');
  }
  return snapshot as Record<string, unknown>;
}

type BoundedHostCallResult<T> =
  | Readonly<{ status: 'resolved'; value: T }>
  | Readonly<{ status: 'rejected'; error: unknown }>
  | Readonly<{ status: 'timed-out' }>;

interface HostExecutionFlight {
  readonly promise: Promise<RunControllerHostExecutionResult>;
}

const HOST_EXECUTION_FLIGHTS = new WeakMap<RunControllerHostPort, Map<string, HostExecutionFlight>>();

function executeHostOnceSingleFlight(
  host: RunControllerHostPort,
  request: RunControllerHostExecuteOnceRequest,
  context: Readonly<RunControllerHostExecutionContext>
): Promise<RunControllerHostExecutionResult> {
  if (request.idempotencyKey !== request.command.id) {
    return Promise.reject(new TypeError('RunController host idempotency key must equal command ID'));
  }
  let flights = HOST_EXECUTION_FLIGHTS.get(host);
  if (!flights) {
    flights = new Map();
    HOST_EXECUTION_FLIGHTS.set(host, flights);
  }
  const existing = flights.get(request.command.id);
  if (existing) return existing.promise;

  const flight: HostExecutionFlight = {
    promise: Promise.resolve().then(() => host.executeOnce(request, context))
  };
  flights.set(request.command.id, flight);
  const cleanup = () => {
    if (flights?.get(request.command.id) !== flight) return;
    flights.delete(request.command.id);
    if (flights.size === 0) HOST_EXECUTION_FLIGHTS.delete(host);
  };
  void flight.promise.then(cleanup, cleanup);
  return flight.promise;
}

function boundedHostCall<T>(
  timeoutMs: number,
  invoke: (context: Readonly<RunControllerHostExecutionContext>) => Promise<T>
): Promise<BoundedHostCallResult<T>> {
  const controller = new AbortController();
  const context = Object.freeze({ signal: controller.signal });
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        controller.abort();
      } catch {
        // Host abort listeners are outside the controller trust boundary.
      }
      resolve(Object.freeze({ status: 'timed-out' as const }));
    }, timeoutMs);
    Promise.resolve().then(() => invoke(context)).then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.freeze({ status: 'resolved' as const, value }));
    }, error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.freeze({ status: 'rejected' as const, error }));
    });
  });
}

function parseReconciliation(
  value: unknown,
  expectedCommand: Readonly<RunControllerCommand>
): RunControllerHostReconciliationResult {
  const result = snapshotHostResult(value);
  if (result.kind !== expectedCommand.kind || !canonicalTimestamp(result.observedAt)) {
    throw new Error('Host result binding is invalid');
  }
  if (result.status === 'applied') {
    if (!exactKeys(result, ['kind', 'observedAt', 'proof', 'status']) || !result.proof ||
        typeof result.proof !== 'object' || Array.isArray(result.proof)) {
      throw new Error('Applied host reconciliation is invalid');
    }
    const proof = parseRunControllerCommandCompletionProof(result.proof, expectedCommand.kind);
    return canonicalRunControllerSnapshot({
      status: 'applied', kind: expectedCommand.kind, observedAt: result.observedAt, proof
    }) as RunControllerHostAppliedResult;
  }
  if (result.status === 'not-applied') {
    if (!exactKeys(result, ['kind', 'observedAt', 'quiesced', 'quiescenceDigest', 'status']) ||
        result.quiesced !== true ||
        result.quiescenceDigest !== computeRunControllerQuiescenceDigest(expectedCommand)) {
      throw new Error('Host quiescence proof is invalid');
    }
    return canonicalRunControllerSnapshot({
      status: 'not-applied',
      kind: expectedCommand.kind,
      observedAt: result.observedAt,
      quiesced: true,
      quiescenceDigest: result.quiescenceDigest
    }) as RunControllerHostReconciliationResult;
  }
  if (!['still-uncertain', 'unsupported'].includes(String(result.status)) ||
      !exactKeys(result, ['kind', 'observedAt', 'status'])) {
    throw new Error('Host reconciliation is invalid');
  }
  return canonicalRunControllerSnapshot({
    status: result.status,
    kind: expectedCommand.kind,
    observedAt: result.observedAt
  }) as RunControllerHostReconciliationResult;
}

function parseExecution(
  value: unknown,
  expectedCommand: Readonly<RunControllerCommand> & Readonly<{ kind: RunControllerHostExecutableKind }>
): RunControllerHostExecutionResult {
  const result = snapshotHostResult(value);
  if (result.kind !== expectedCommand.kind || !canonicalTimestamp(result.observedAt)) {
    throw new Error('Host execution binding is invalid');
  }
  if (result.status === 'applied') return parseReconciliation(result, expectedCommand) as RunControllerHostAppliedResult;
  if (result.status === 'in-progress' && exactKeys(result, ['kind', 'observedAt', 'status'])) {
    return canonicalRunControllerSnapshot({
      status: 'in-progress', kind: expectedCommand.kind, observedAt: result.observedAt
    }) as RunControllerHostExecutionResult;
  }
  if (result.status === 'indeterminate' &&
      ['ack-lost', 'timeout', 'transport', 'unknown'].includes(String(result.code)) &&
      exactKeys(result, ['code', 'kind', 'observedAt', 'status'])) {
    return canonicalRunControllerSnapshot({
      status: 'indeterminate', kind: expectedCommand.kind,
      observedAt: result.observedAt, code: result.code
    }) as RunControllerHostExecutionResult;
  }
  throw new Error('Host executeOnce result is invalid');
}

function resultDigest(commandId: string, proof: RunControllerCommandCompletionProof): Digest {
  switch (proof.kind) {
    case 'fidelity.preflight': return proof.assessmentDigest;
    case 'evidence.validate-preliminary-report':
    case 'evidence.validate-final-report': return proof.evidenceDigest;
    case 'mediator.finalize-receipts':
      return computeRunControllerBindingDigest('finalized-projections', proof.finalizedProjectionDigests);
    case 'checkpoint.persist': return proof.checkpointDigest;
    default: return computeRunControllerBindingDigest('host-command-result', { commandId, proof });
  }
}

function successfulEvent(
  command: Readonly<RunControllerCommand>,
  applied: RunControllerHostAppliedResult,
  phase: 'reconcile' | 'execute',
  source: RunControllerTrustedEventSource
): Readonly<RunControllerEvent> {
  if (applied.kind !== command.kind || applied.proof.kind !== command.kind) {
    throw new Error('Host proof kind does not match command');
  }
  const base = {
    eventId: eventId(source, command.id, phase),
    occurredAt: applied.observedAt,
    commandId: command.id,
    controllerEpoch: command.expectedControllerEpoch,
    leaseFence: command.expectedLeaseFence,
    attempt: command.attempt
  };
  if (applied.proof.kind === 'fidelity.preflight') {
    return parseRunControllerEvent({
      ...base,
      type: 'preflight-result',
      fidelity: applied.proof.fidelity,
      requestedMode: applied.proof.requestedMode,
      assessmentDigest: applied.proof.assessmentDigest
    });
  }
  if (applied.proof.kind === 'evidence.validate-preliminary-report' ||
      applied.proof.kind === 'evidence.validate-final-report') {
    return parseRunControllerEvent({
      ...base,
      type: applied.proof.kind === 'evidence.validate-preliminary-report'
        ? 'preliminary-report-outcome' : 'final-report-outcome',
      authority: applied.proof.authority,
      classification: applied.proof.classification,
      reportDigest: applied.proof.reportDigest,
      evidenceDigest: applied.proof.evidenceDigest,
      requestedDisposition: applied.proof.requestedDisposition
    });
  }
  return parseRunControllerEvent({
    ...base,
    type: 'command-completion',
    outcome: 'succeeded',
    resultDigest: resultDigest(command.id, applied.proof),
    proof: applied.proof
  });
}

function failureEvent(
  command: Readonly<RunControllerCommand>,
  outcome: 'failed' | 'uncertain',
  code: string,
  occurredAt: string,
  phase: 'failure' | 'uncertain' | 'reconcile',
  source: RunControllerTrustedEventSource
): Readonly<RunControllerEvent> {
  if (!canonicalTimestamp(occurredAt)) throw new Error('Host failure timestamp is invalid');
  return parseRunControllerEvent({
    type: 'command-completion',
    eventId: eventId(source, command.id, phase),
    occurredAt,
    commandId: command.id,
    controllerEpoch: command.expectedControllerEpoch,
    leaseFence: command.expectedLeaseFence,
    attempt: command.attempt,
    outcome,
    resultDigest: computeRunControllerBindingDigest(`host-${outcome}`, { commandId: command.id, code }),
    proof: null
  });
}

function reconciliationDigest(
  commandId: string,
  result: RunControllerHostReconciliationResult
): Digest {
  return computeRunControllerBindingDigest('host-reconciliation', {
    commandId,
    status: result.status,
    quiescenceDigest: result.status === 'not-applied' ? result.quiescenceDigest : null,
    proof: result.status === 'applied' ? result.proof : null
  });
}

function recoveryEvent(
  command: Readonly<RunControllerCommand>,
  result: RunControllerHostReconciliationResult,
  source: RunControllerTrustedEventSource
): Readonly<RunControllerEvent> {
  if (result.kind !== command.kind ||
      (result.status === 'applied' && result.proof.kind !== command.kind)) {
    throw new Error('Recovered host proof kind does not match command');
  }
  return parseRunControllerEvent({
    type: 'recovery',
    eventId: eventId(source, command.id, 'recovery'),
    occurredAt: result.observedAt,
    targetCommandId: command.id,
    reconciliationDigest: reconciliationDigest(command.id, result),
    disposition: result.status === 'applied' ? 'applied' : result.status,
    quiescenceDigest: result.status === 'not-applied' ? result.quiescenceDigest : null,
    resultDigest: result.status === 'applied' ? resultDigest(command.id, result.proof) : null,
    proof: result.status === 'applied' ? result.proof : null
  });
}

function blockedReason(state: Readonly<RunControllerState>): RunControllerDriverReasonCode {
  if (state.phase === 'approval') return 'approval-required';
  if (state.phase === 'eo-running') return 'eo-running';
  if (state.publicState === 'paused') return 'paused';
  return 'no-progress';
}

function eventWasCommitted(
  snapshot: RunControllerRepositorySnapshot,
  event: Readonly<RunControllerEvent>
): boolean {
  const expectedDigest = computeRunControllerEventDigest(event);
  return snapshot.state.processedEvents.some(processed =>
    processed.eventId === event.eventId && processed.eventDigest === expectedDigest);
}

export function createRunControllerDriver(options: CreateRunControllerDriverOptions): Readonly<{
  step(): Promise<Readonly<RunControllerDriverResult>>;
  runUntilBlocked(maxSteps: number): Promise<Readonly<RunControllerDriverResult>>;
}> {
  if (!options || typeof options !== 'object' ||
      typeof options.repository?.read !== 'function' ||
      typeof options.repository?.transactExpected !== 'function' ||
      typeof options.host?.reconcile !== 'function' || typeof options.host?.executeOnce !== 'function' ||
      typeof options.eventSource?.eventId !== 'function' || typeof options.eventSource?.now !== 'function') {
    throw new TypeError('RunController driver requires repository, host, and trusted event source');
  }
  const hostCallTimeoutMs = options.hostCallTimeoutMs === undefined
    ? DEFAULT_HOST_CALL_TIMEOUT_MS : options.hostCallTimeoutMs;
  if (!Number.isSafeInteger(hostCallTimeoutMs) || hostCallTimeoutMs < 1 ||
      hostCallTimeoutMs > MAX_HOST_CALL_TIMEOUT_MS) {
    throw new RangeError(`hostCallTimeoutMs must be a safe integer from 1 through ${MAX_HOST_CALL_TIMEOUT_MS}`);
  }

  async function rereadAfterConflict(
    event: Readonly<RunControllerEvent>,
    reason: RunControllerDriverReasonCode
  ): Promise<Readonly<RunControllerDriverResult>> {
    const read = await options.repository.read();
    if (read.status === 'active') {
      if (eventWasCommitted(read.snapshot, event)) {
        return frozenResult(
          ['completed', 'failed', 'cancelled'].includes(read.snapshot.state.publicState)
            ? 'terminal' : 'advanced',
          read.snapshot.state,
          null
        );
      }
      return frozenResult('recovery-required', read.snapshot.state, reason);
    }
    if (read.status === 'incompatible') return frozenResult('incompatible', null, 'repository-incompatible');
    if (read.status === 'recovery-required') return frozenResult('recovery-required', null, 'protected-state-invalid');
    return frozenResult('unavailable', null,
      read.status === 'missing' ? 'protected-state-missing' : 'repository-unavailable');
  }

  async function persist(
    event: Readonly<RunControllerEvent>,
    expectedGeneration: number,
    unchangedIsBlocked = false
  ): Promise<Readonly<RunControllerDriverResult>> {
    const written = await options.repository.transactExpected(event, expectedGeneration);
    if (written.status === 'unknown') {
      return rereadAfterConflict(event, 'completion-commit-unknown');
    }
    if (written.status === 'generation-conflict' || written.status === 'concurrency-exhausted') {
      return rereadAfterConflict(event, 'completion-conflict');
    }
    if (written.status === 'committed' || written.status === 'unchanged') {
      if (written.status === 'unchanged' && unchangedIsBlocked) {
        return frozenResult('blocked', written.snapshot.state, 'recovery-still-uncertain');
      }
      if (written.status === 'unchanged') {
        return frozenResult('blocked', written.snapshot.state, 'no-progress');
      }
      return frozenResult(
        ['completed', 'failed', 'cancelled'].includes(written.snapshot.state.publicState)
          ? 'terminal' : 'advanced',
        written.snapshot.state,
        null
      );
    }
    if (written.status === 'incompatible') return frozenResult('incompatible', null, 'repository-incompatible');
    if (written.status === 'recovery-required') {
      return frozenResult('recovery-required', null, 'protected-state-invalid');
    }
    if (written.status === 'rejected') {
      return frozenResult('recovery-required', written.snapshot?.state ?? null, 'transition-rejected');
    }
    return frozenResult('unavailable', null,
      written.status === 'missing' ? 'protected-state-missing' : 'repository-unavailable');
  }

  async function reconcileHost(request: RunControllerHostRequest):
  Promise<RunControllerHostReconciliationResult | Readonly<RunControllerDriverResult>> {
    const call = await boundedHostCall(hostCallTimeoutMs,
      context => options.host.reconcile(request, context));
    if (call.status !== 'resolved') {
      return frozenResult('recovery-required', null, 'host-reconcile-unavailable');
    }
    try {
      return parseReconciliation(call.value, request.command);
    } catch {
      return frozenResult('recovery-required', null, 'host-result-invalid');
    }
  }

  async function recover(
    snapshot: RunControllerRepositorySnapshot
  ): Promise<Readonly<RunControllerDriverResult>> {
    const targetId = snapshot.state.recoverySummary.uncertainCommandIds[0];
    const target = snapshot.state.completedCommands.find(entry => entry.command.id === targetId);
    if (!target) return frozenResult('recovery-required', snapshot.state, 'protected-state-invalid');
    let request: RunControllerHostRequest;
    try {
      request = materialize(snapshot.state, target, false);
    } catch {
      return frozenResult('recovery-required', snapshot.state, 'command-binding-invalid');
    }
    const reconciled = await reconcileHost(request);
    if ('reasonCode' in reconciled) {
      return frozenResult(reconciled.status, snapshot.state, reconciled.reasonCode);
    }
    if (reconciled.status === 'unsupported') {
      return frozenResult('recovery-required', snapshot.state, 'host-reconciliation-unsupported');
    }
    let event: Readonly<RunControllerEvent>;
    try {
      event = recoveryEvent(target.command, reconciled, options.eventSource);
    } catch {
      return frozenResult('recovery-required', snapshot.state, 'host-result-invalid');
    }
    return persist(event, snapshot.generation, reconciled.status === 'still-uncertain');
  }

  async function executeActive(
    snapshot: RunControllerRepositorySnapshot,
    request: RunControllerHostRequest
  ): Promise<Readonly<RunControllerDriverResult>> {
    if (request.kind === 'controller.recover-pending-command') {
      return frozenResult('recovery-required', snapshot.state, 'command-binding-invalid');
    }
    let event: Readonly<RunControllerEvent>;
    const call = await boundedHostCall(hostCallTimeoutMs,
      context => executeHostOnceSingleFlight(options.host, request, context));
    if (call.status !== 'resolved') {
      try {
        if (call.status === 'timed-out') {
          event = failureEvent(request.command, 'uncertain', 'timeout',
            timestampFromSource(options.eventSource), 'uncertain', options.eventSource);
        } else if (call.error instanceof RunControllerHostKnownFailureError) {
          event = failureEvent(request.command, 'failed', call.error.code, call.error.observedAt,
            'failure', options.eventSource);
        } else {
          event = failureEvent(request.command, 'uncertain', 'unknown',
            timestampFromSource(options.eventSource), 'uncertain', options.eventSource);
        }
      } catch {
        return frozenResult('recovery-required', snapshot.state, 'host-result-invalid');
      }
      return persist(event, snapshot.generation);
    }
    try {
      const execution = parseExecution(call.value, request.command);
      if (execution.status !== 'applied') {
        event = failureEvent(request.command, 'uncertain',
          execution.status === 'indeterminate' ? execution.code : 'in-progress',
          execution.observedAt, 'uncertain', options.eventSource);
      } else {
        event = successfulEvent(request.command, execution, 'execute', options.eventSource);
      }
    } catch {
      return frozenResult('recovery-required', snapshot.state, 'host-result-invalid');
    }
    return persist(event, snapshot.generation);
  }

  async function step(): Promise<Readonly<RunControllerDriverResult>> {
    const read = await options.repository.read();
    if (read.status === 'missing') return frozenResult('unavailable', null, 'protected-state-missing');
    if (read.status === 'incompatible') return frozenResult('incompatible', null, 'repository-incompatible');
    if (read.status === 'recovery-required') {
      return frozenResult('recovery-required', null, 'protected-state-invalid');
    }
    if (read.status === 'unavailable') return frozenResult('unavailable', null, 'repository-unavailable');
    const { snapshot } = read;
    if (['completed', 'failed', 'cancelled'].includes(snapshot.state.publicState)) {
      return frozenResult('terminal', snapshot.state, null);
    }
    if (snapshot.state.phase === 'recovery-required') return recover(snapshot);
    const entry = snapshot.state.outbox[0];
    if (!entry) return frozenResult('blocked', snapshot.state, blockedReason(snapshot.state));
    let request: RunControllerHostRequest;
    try {
      request = materialize(snapshot.state, entry, true);
    } catch {
      return frozenResult('recovery-required', snapshot.state, 'command-binding-invalid');
    }
    const reconciled = await reconcileHost(request);
    if ('reasonCode' in reconciled) {
      return frozenResult(reconciled.status, snapshot.state, reconciled.reasonCode);
    }
    if (reconciled.status === 'applied') {
      try {
        return persist(successfulEvent(entry.command, reconciled, 'reconcile', options.eventSource),
          snapshot.generation);
      } catch {
        return frozenResult('recovery-required', snapshot.state, 'host-result-invalid');
      }
    }
    if (reconciled.status === 'still-uncertain') {
      try {
        return persist(failureEvent(entry.command, 'uncertain',
          reconciliationDigest(entry.command.id, reconciled), reconciled.observedAt,
          'reconcile', options.eventSource), snapshot.generation);
      } catch {
        return frozenResult('recovery-required', snapshot.state, 'host-result-invalid');
      }
    }
    if (reconciled.status === 'unsupported') {
      return frozenResult('recovery-required', snapshot.state, 'host-reconciliation-unsupported');
    }
    return executeActive(snapshot, request);
  }

  async function runUntilBlocked(maxSteps: number): Promise<Readonly<RunControllerDriverResult>> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 1024) {
      throw new RangeError('maxSteps must be a safe integer from 1 through 1024');
    }
    let latest: Readonly<RunControllerDriverResult> | null = null;
    for (let count = 1; count <= maxSteps; count += 1) {
      latest = await step();
      if (latest.status !== 'advanced') {
        return canonicalRunControllerSnapshot({ ...latest, steps: count });
      }
    }
    return canonicalRunControllerSnapshot({
      status: 'step-limit' as const,
      state: latest?.state ?? null,
      reasonCode: 'step-limit' as const,
      steps: maxSteps
    });
  }

  return Object.freeze({ step, runUntilBlocked });
}
