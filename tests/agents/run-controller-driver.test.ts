import {
  RunControllerHostAppliedResult,
  RunControllerHostExecutionContext,
  RunControllerHostExecutionResult,
  RunControllerHostKnownFailureError,
  RunControllerHostPort,
  RunControllerHostReconciliationResult,
  RunControllerHostRequest,
  RunControllerHostExecuteOnceRequest,
  RunControllerDriverEventPhase,
  RunControllerTrustedEventSource,
  computeRunControllerDriverEventId,
  createRunControllerDriver
} from '../../src/agents/run/controller';
import {
  computeRunControllerBindingDigest,
  computeRunControllerModelDigest,
  computeRunControllerQuiescenceDigest,
  Digest,
  RunControllerCommandCompletionProof,
  RunControllerEvent
} from '../../src/agents/run/controller/algebra';
import { compileRunModel } from '../../src/agents/run/controller/model';
import {
  createProtectedRunControllerRepository,
  ProtectedRunControllerRepository
} from '../../src/agents/run/controller/repository';
import { compilePlanGraph } from '../../src/agents/run/compiler';
import {
  IndeterminateStoreCommitError,
  InMemoryProtectedStoreAdapter,
  ProtectedControllerStore,
  ProtectedControllerStoreWriter
} from '../../src/agents/run/store';
import * as publicRun from '../../src/agents/run';

const D = (name: string): Digest => computeRunControllerBindingDigest('driver-test', name);

function model() {
  return compileRunModel(compilePlanGraph({
    planKey: 'controller-driver', planRevision: 1, objective: 'Exercise internal driver',
    scope: ['src/**'], outOfScope: [],
    milestones: [{
      key: 'core', dependsOn: [], criteria: ['complete'], verification: 'npm test',
      writeSet: ['src/**'], integrationCriteria: ['integrated'],
      workstreams: [{ key: 'runtime', criteria: ['works'], writeSet: ['src/**'], leaves: [] }]
    }],
    integrationCriteria: ['all'], regressionCriteria: ['none'], expectedSideEffects: ['writes'],
    policy: {}, adapterRequirements: ['trusted'], pauseRules: ['pause'], failureRules: ['fail'],
    cancelRules: ['cancel'], completionRules: ['complete']
  }));
}

class TestClock {
  private value = Date.parse('2026-09-14T12:00:00.000Z');
  next(): string {
    this.value += 1_000;
    return new Date(this.value).toISOString();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function eventSource(clock: TestClock): RunControllerTrustedEventSource {
  return Object.freeze({
    eventId(input: Readonly<{ commandId: string; phase: RunControllerDriverEventPhase }>) {
      return computeRunControllerDriverEventId(input.commandId, input.phase);
    },
    now: () => clock.next()
  }) as RunControllerTrustedEventSource;
}

function binding(request: RunControllerHostRequest, name: string): Digest {
  const value = request.protectedPayload.bindings.find(item => item.name === name)?.digest;
  if (!value) throw new Error(`Missing ${name} binding`);
  return value;
}

type FakeDurableAttemptStatus = 'executing' | 'applied' | 'uncertain' | 'not-applied';

interface FakeDurableAttempt {
  readonly kind: RunControllerHostExecuteOnceRequest['kind'];
  readonly promise: Promise<RunControllerHostExecutionResult>;
  status: FakeDurableAttemptStatus;
}

class FakeIndeterminateError extends Error {
  constructor(
    readonly code: 'ack-lost' | 'timeout' | 'transport' | 'unknown',
    readonly observedAt: string
  ) {
    super('Fake durable host outcome is indeterminate');
  }
}

class FakeDurableCommandLedger {
  readonly applied = new Map<string, RunControllerHostAppliedResult>();
  readonly appliedReconciliations = new Map<string, RunControllerHostAppliedResult>();
  readonly attempts = new Map<string, FakeDurableAttempt>();
  readonly liveExecutions = new Set<string>();
  readonly claimCounts = new Map<string, number>();
  readonly effectCounts = new Map<string, number>();
}

class FakeRunControllerHost implements RunControllerHostPort {
  readonly ledger: Map<string, RunControllerHostAppliedResult>;
  readonly reconcileCalls: RunControllerHostRequest[] = [];
  readonly executeCalls: RunControllerHostExecuteOnceRequest[] = [];
  readonly reconcileContexts: Readonly<RunControllerHostExecutionContext>[] = [];
  readonly executeContexts: Readonly<RunControllerHostExecutionContext>[] = [];
  readonly executionKinds: string[] = [];
  readonly reconciliation = new Map<string, RunControllerHostReconciliationResult>();
  readonly ackLostKinds = new Set<string>();
  readonly knownFailureKinds = new Set<string>();
  readonly unsupportedKinds = new Set<string>();
  readonly reconcileGates = new Map<string, Promise<void>>();
  readonly gates = new Map<string, Promise<void>>();
  readonly liveExecutions: Set<string>;
  readonly abortAcknowledged = new Set<string>();
  readonly ignoreAbortCommandIds = new Set<string>();
  readonly signalCounts: number[] = [0];
  readonly forceCounts: number[] = [0];
  fidelity: 'exact' | 'supervised' | 'plan-only' | 'unsupported' = 'exact';
  requestedMode: 'milestone' | 'autonomous' = 'autonomous';
  preliminaryClassification: 'rejected' | 'quarantined' | 'valid-completion-blocked' =
    'valid-completion-blocked';
  finalClassification: 'accepted' | 'rejected' | 'quarantined' | 'valid-completion-blocked' = 'accepted';
  extraResultField = false;
  proofTransform: ((proof: RunControllerCommandCompletionProof) => unknown) | null = null;

  constructor(
    readonly clock: TestClock,
    readonly durable = new FakeDurableCommandLedger()
  ) {
    this.ledger = durable.applied;
    this.liveExecutions = durable.liveExecutions;
  }

  private validateIdempotencyKey(request: RunControllerHostRequest): void {
    if (request.idempotencyKey !== request.command.id) {
      throw new TypeError('Fake host idempotency key must equal command ID');
    }
  }

  private digest(request: RunControllerHostRequest, name: string): Digest {
    return computeRunControllerBindingDigest(`fake-host-${name}`, request.command.id);
  }

  private proof(request: RunControllerHostExecuteOnceRequest): RunControllerCommandCompletionProof {
    switch (request.kind) {
      case 'fidelity.preflight':
        return { kind: request.kind, fidelity: this.fidelity, requestedMode: this.requestedMode,
          assessmentDigest: this.digest(request, 'assessment') };
      case 'authority.initialize':
        return { kind: request.kind, authorityStateDigest: this.digest(request, 'authority'),
          authorityInitialized: true };
      case 'authority.acquire-controller':
        return { kind: request.kind, controllerLeaseRefDigest: this.digest(request, 'controller-lease'),
          controllerEpoch: request.command.expectedControllerEpoch + 1, leaseFence: 11 };
      case 'authority.issue-eo-ticket':
        return { kind: request.kind, ticketRefDigest: this.digest(request, 'ticket') };
      case 'mediator.spawn-eo':
        return { kind: request.kind, spawnRefDigest: this.digest(request, 'spawn') };
      case 'authority.claim-workstream':
        return { kind: request.kind, workstreamLeaseRefDigest: this.digest(request, 'workstream'),
          leaseFence: 13 };
      case 'evidence.validate-preliminary-report':
        return { kind: request.kind, authority: false, classification: this.preliminaryClassification,
          reportDigest: binding(request, 'report'), evidenceDigest: this.digest(request, 'preliminary-evidence'),
          requestedDisposition: 'complete' };
      case 'authority.settle-usage':
        return { kind: request.kind, settledUsageDigest: this.digest(request, 'usage'),
          projectionDigests: [this.digest(request, 'projection')],
          budgetSummary: { trusted: true, reserved: 10, committed: 7, currency: 'USD' } };
      case 'mediator.finalize-receipts':
        return { kind: request.kind, finalizedProjectionDigests: [this.digest(request, 'receipt')] };
      case 'evidence.validate-final-report':
        return { kind: request.kind, authority: false, classification: this.finalClassification,
          reportDigest: binding(request, 'report-input'), evidenceDigest: this.digest(request, 'final-evidence'),
          requestedDisposition: 'pause' };
      case 'integration.root-milestone':
        return { kind: request.kind, integrationAccepted: true,
          evidenceDigest: this.digest(request, 'milestone-evidence') };
      case 'integration.root-global-seal-verdict':
        return { kind: request.kind, accepted: true, reportKind: 'goal-verdict/v1',
          verdictDigest: this.digest(request, 'verdict'), finalState: 'completed',
          unresolvedCount: 0, pendingCount: 0 };
      case 'checkpoint.persist':
        return { kind: request.kind, checkpointDigest: this.digest(request, 'checkpoint') };
      case 'authority.cancel':
        return { kind: request.kind, authorityCancelled: true,
          cancellationGeneration: request.protectedPayload.cancellationGeneration };
      case 'descendant.signal':
        return { kind: request.kind, pendingDescendants: this.signalCounts.shift() ?? 0 };
      case 'descendant.force':
        return { kind: request.kind, pendingDescendants: this.forceCounts.shift() ?? 0 };
    }
  }

  private async waitForGate(
    request: RunControllerHostExecuteOnceRequest,
    context: Readonly<RunControllerHostExecutionContext>
  ): Promise<void> {
    const gate = this.gates.get(request.command.id);
    if (!gate) return;
    if (this.ignoreAbortCommandIds.has(request.command.id)) {
      await gate;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        this.abortAcknowledged.add(request.command.id);
        reject(new FakeIndeterminateError('timeout', this.clock.next()));
      };
      if (context.signal.aborted) {
        onAbort();
        return;
      }
      context.signal.addEventListener('abort', onAbort, { once: true });
      gate.then(() => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener('abort', onAbort);
        resolve();
      }, error => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  async reconcile(
    request: RunControllerHostRequest,
    context: Readonly<RunControllerHostExecutionContext>
  ): Promise<RunControllerHostReconciliationResult> {
    this.validateIdempotencyKey(request);
    this.reconcileCalls.push(request);
    this.reconcileContexts.push(context);
    await this.reconcileGates.get(request.command.id);
    const applied = this.ledger.get(request.command.id);
    if (applied) {
      let reconciled = this.durable.appliedReconciliations.get(request.command.id);
      if (!reconciled) {
        reconciled = Object.freeze({ ...applied, observedAt: this.clock.next() });
        this.durable.appliedReconciliations.set(request.command.id, reconciled);
      }
      return reconciled;
    }
    const attempt = this.durable.attempts.get(request.command.id);
    if (attempt?.status === 'executing') {
      return { status: 'still-uncertain', kind: request.kind, observedAt: this.clock.next() };
    }
    const controlled = this.reconciliation.get(request.command.id);
    if (controlled) return controlled;
    if (this.unsupportedKinds.has(request.kind)) {
      return { status: 'unsupported', kind: request.kind, observedAt: this.clock.next() };
    }
    if (attempt?.status === 'uncertain') {
      return { status: 'still-uncertain', kind: request.kind, observedAt: this.clock.next() };
    }
    return {
      status: 'not-applied', kind: request.kind, observedAt: this.clock.next(),
      quiesced: true, quiescenceDigest: computeRunControllerQuiescenceDigest(request.command)
    };
  }

  executeOnce(
    request: RunControllerHostExecuteOnceRequest,
    context: Readonly<RunControllerHostExecutionContext>
  ): Promise<RunControllerHostExecutionResult> {
    this.validateIdempotencyKey(request);
    this.executeCalls.push(request);
    this.executeContexts.push(context);
    const applied = this.ledger.get(request.command.id);
    if (applied) return Promise.resolve(applied);
    const existing = this.durable.attempts.get(request.command.id);
    if (existing) return existing.promise;

    const completion = deferred<RunControllerHostExecutionResult>();
    const attempt: FakeDurableAttempt = {
      kind: request.kind,
      status: 'executing',
      promise: completion.promise
    };
    this.durable.attempts.set(request.command.id, attempt);
    this.durable.claimCounts.set(request.command.id,
      (this.durable.claimCounts.get(request.command.id) ?? 0) + 1);
    this.liveExecutions.add(request.command.id);
    this.executionKinds.push(request.kind);
    void Promise.resolve().then(async () => {
      try {
        await this.waitForGate(request, context);
        if (this.knownFailureKinds.has(request.kind)) {
          throw new RunControllerHostKnownFailureError('rejected', this.clock.next());
        }
        const proof = this.proof(request);
        const result = Object.freeze({
          status: 'applied' as const,
          kind: request.kind,
          observedAt: this.clock.next(),
          proof: this.proofTransform?.(proof) ?? proof
        }) as RunControllerHostAppliedResult;
        this.ledger.set(request.command.id, result);
        this.durable.effectCounts.set(request.command.id,
          (this.durable.effectCounts.get(request.command.id) ?? 0) + 1);
        attempt.status = 'applied';
        if (this.ackLostKinds.has(request.kind)) {
          this.ackLostKinds.delete(request.kind);
          completion.resolve({
            status: 'indeterminate', kind: request.kind,
            observedAt: result.observedAt, code: 'ack-lost'
          });
          return;
        }
        completion.resolve(this.extraResultField ? { ...result, extra: true } as any : result);
      } catch (error) {
        if (attempt.status !== 'applied') {
          attempt.status = this.abortAcknowledged.has(request.command.id) ? 'not-applied' : 'uncertain';
        }
        if (error instanceof FakeIndeterminateError) {
          completion.resolve({
            status: 'indeterminate', kind: request.kind,
            observedAt: error.observedAt, code: error.code
          });
        } else {
          completion.reject(error);
        }
      } finally {
        this.liveExecutions.delete(request.command.id);
      }
    });
    return completion.promise;
  }
}

interface Fixture {
  clock: TestClock;
  adapter: InMemoryProtectedStoreAdapter;
  store: ProtectedControllerStore;
  writer: ProtectedControllerStoreWriter;
  repository: ProtectedRunControllerRepository;
  host: FakeRunControllerHost;
  driver: ReturnType<typeof createRunControllerDriver>;
}

async function fixture(writerFactory?: (
  base: ProtectedControllerStoreWriter
) => ProtectedControllerStoreWriter, hostCallTimeoutMs?: number): Promise<Fixture> {
  const clock = new TestClock();
  const adapter = new InMemoryProtectedStoreAdapter();
  const store = new ProtectedControllerStore({ storeId: 'run-controller-driver-test', adapter });
  const base = await store.openWriter();
  const writer = writerFactory?.(base) ?? base;
  const repository = createProtectedRunControllerRepository({
    runId: 'run:driver', projectId: 'project:driver', reader: store.reader(), writer
  });
  const compiled = model();
  const created: RunControllerEvent = {
    type: 'create', eventId: 'driver-create', occurredAt: clock.next(),
    runId: 'run:driver', projectId: 'project:driver', model: compiled,
    modelDigest: computeRunControllerModelDigest(compiled), fidelityRequirementsDigest: D('requirements')
  };
  const initialized = await repository.initialize(created);
  if (initialized.status !== 'committed' && initialized.status !== 'unknown') {
    throw new Error(`Fixture initialization failed: ${initialized.status}`);
  }
  const host = new FakeRunControllerHost(clock);
  const driver = createRunControllerDriver({
    repository, host, eventSource: eventSource(clock), hostCallTimeoutMs
  });
  return { clock, adapter, store, writer, repository, host, driver };
}

async function state(fx: Fixture) {
  const read = await fx.repository.read();
  if (read.status !== 'active') throw new Error(`Expected active state: ${read.status}`);
  return read.snapshot.state;
}

async function activeRequest(fx: Fixture): Promise<RunControllerHostExecuteOnceRequest> {
  const current = await state(fx);
  const entry = current.outbox[0];
  if (entry.command.kind === 'controller.recover-pending-command') {
    throw new Error('Expected executable command');
  }
  return Object.freeze({
    kind: entry.command.kind,
    idempotencyKey: entry.command.id,
    command: entry.command,
    protectedPayload: entry.protectedPayload,
    modelDigest: current.modelDigest
  }) as RunControllerHostExecuteOnceRequest;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for concurrent test condition');
}

async function transact(fx: Fixture, event: RunControllerEvent): Promise<void> {
  const result = await fx.repository.transact(event);
  if (result.status !== 'committed' && result.status !== 'unchanged') {
    throw new Error(`Expected event commit: ${result.status}`);
  }
}

async function approve(fx: Fixture): Promise<void> {
  const current = await state(fx);
  await transact(fx, {
    type: 'trusted-approval-mode-accepted', eventId: `approve-${current.mode}-${current.counters.eventsApplied}`,
    occurredAt: fx.clock.next(), mode: fx.host.requestedMode,
    approvalDigest: D('approval'), modeSelectionDigest: D('mode-selection')
  });
}

async function driveReport(fx: Fixture, reportDigest = D('report')): Promise<void> {
  await transact(fx, {
    type: 'drive', eventId: `drive-${(await state(fx)).counters.eventsApplied}`,
    occurredAt: fx.clock.next(), inputDigest: reportDigest
  });
}

async function reachApproval(fx: Fixture): Promise<void> {
  await expect(fx.driver.runUntilBlocked(4)).resolves.toMatchObject({
    status: 'blocked', reasonCode: 'approval-required'
  });
}

async function reachEoRunning(fx: Fixture): Promise<void> {
  await reachApproval(fx);
  await approve(fx);
  await expect(fx.driver.runUntilBlocked(8)).resolves.toMatchObject({
    status: 'blocked', reasonCode: 'eo-running'
  });
}

describe('WP-230C2 internal imperative RunController driver', () => {
  test('drives autonomous fake lifecycle through exact closure and returns safe projection', async () => {
    const fx = await fixture();
    await reachEoRunning(fx);
    await driveReport(fx);
    const result = await fx.driver.runUntilBlocked(16);
    expect(result).toMatchObject({ status: 'terminal', state: { state: 'completed', progressPercent: 100 } });
    expect(fx.host.executionKinds).toEqual([
      'fidelity.preflight', 'authority.initialize', 'authority.acquire-controller',
      'authority.issue-eo-ticket', 'mediator.spawn-eo', 'authority.claim-workstream',
      'evidence.validate-preliminary-report', 'authority.settle-usage',
      'mediator.finalize-receipts', 'evidence.validate-final-report',
      'integration.root-milestone', 'integration.root-global-seal-verdict',
      'authority.cancel', 'descendant.signal', 'checkpoint.persist'
    ]);
    const completed = (await state(fx)).completedCommands;
    expect(completed.find(item => item.command.kind === 'fidelity.preflight')?.completionEvent.type)
      .toBe('preflight-result');
    expect(completed.find(item =>
      item.command.kind === 'evidence.validate-preliminary-report')?.completionEvent.type)
      .toBe('preliminary-report-outcome');
    expect(completed.find(item =>
      item.command.kind === 'evidence.validate-final-report')?.completionEvent.type)
      .toBe('final-report-outcome');
    expect(completed.filter(item => ![
      'fidelity.preflight', 'evidence.validate-preliminary-report', 'evidence.validate-final-report'
    ].includes(item.command.kind)).every(item => item.completionEvent.type === 'command-completion')).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/outbox|protectedPayload|commandId|leaseFence|RefDigest/);
    for (const request of [...fx.host.reconcileCalls, ...fx.host.executeCalls]) {
      expect(request.idempotencyKey).toBe(request.command.id);
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.command)).toBe(true);
      expect(Object.isFrozen(request.protectedPayload.bindings)).toBe(true);
      expect(JSON.stringify(request)).not.toMatch(/Exercise internal driver|src\/\*\*|npm test/);
    }
    for (const context of [...fx.host.reconcileContexts, ...fx.host.executeContexts]) {
      expect(Object.isFrozen(context)).toBe(true);
      expect(context.signal).toBeInstanceOf(AbortSignal);
      expect(context.signal.aborted).toBe(false);
    }
    expect(publicRun).not.toHaveProperty('createRunControllerDriver');
  });

  test('stops for milestone hold, supervised fallback, and host pause until trusted continuation', async () => {
    const milestone = await fixture();
    milestone.host.requestedMode = 'milestone';
    await reachEoRunning(milestone);
    await driveReport(milestone);
    await expect(milestone.driver.runUntilBlocked(12)).resolves.toMatchObject({
      status: 'blocked', state: { state: 'paused', reasonCode: 'milestone-hold' }
    });
    let current = await state(milestone);
    await transact(milestone, {
      type: 'trusted-continuation', eventId: 'continue-milestone', occurredAt: milestone.clock.next(),
      checkpointDigest: current.continuationCheckpointDigest!
    });
    const milestoneResult = await milestone.driver.runUntilBlocked(8);
    expect(milestoneResult).toMatchObject({
      status: 'terminal', reasonCode: null, state: { state: 'completed' }
    });

    const supervised = await fixture();
    supervised.host.fidelity = 'supervised';
    await expect(supervised.driver.runUntilBlocked(4)).resolves.toMatchObject({
      status: 'blocked', state: { state: 'paused', reasonCode: 'supervised-checkpoint' }
    });
    current = await state(supervised);
    await transact(supervised, {
      type: 'trusted-continuation', eventId: 'continue-supervised', occurredAt: supervised.clock.next(),
      checkpointDigest: current.continuationCheckpointDigest!
    });
    expect((await supervised.driver.step()).reasonCode).toBe('approval-required');

    await approve(supervised);
    await supervised.driver.runUntilBlocked(8);
    await transact(supervised, {
      type: 'pause', eventId: 'host-pause', occurredAt: supervised.clock.next(),
      reasonDigest: D('host-pause'), checkpointDigest: D('host-checkpoint')
    });
    await expect(supervised.driver.step()).resolves.toMatchObject({
      status: 'blocked', state: { reasonCode: 'paused-by-host' }
    });
    await transact(supervised, {
      type: 'trusted-continuation', eventId: 'host-continue', occurredAt: supervised.clock.next(),
      checkpointDigest: D('host-checkpoint')
    });
    expect((await supervised.driver.step()).reasonCode).toBe('eo-running');
  });

  test.each([
    ['rejected', 'terminal', 'failed', 'report-rejected'],
    ['quarantined', 'blocked', 'paused', 'report-quarantined'],
    ['valid-completion-blocked', 'blocked', 'paused', 'report-completion-blocked']
  ] as const)('maps final report %s branch without accepting invalid completion',
    async (classification, status, publicState, reasonCode) => {
      const fx = await fixture();
      fx.host.finalClassification = classification;
      await reachEoRunning(fx);
      await driveReport(fx);
      const result = await fx.driver.runUntilBlocked(16);
      expect(result).toMatchObject({ status, state: { state: publicState, reasonCode } });
      expect((await state(fx)).execution.state).not.toBe('accepted');
    });

  test.each([
    ['rejected', 'terminal', 'failed', 'report-rejected'],
    ['quarantined', 'blocked', 'paused', 'report-quarantined']
  ] as const)('maps preliminary report %s branch before settlement',
    async (classification, status, publicState, reasonCode) => {
      const fx = await fixture();
      fx.host.preliminaryClassification = classification;
      await reachEoRunning(fx);
      await driveReport(fx);
      const result = await fx.driver.runUntilBlocked(8);
      expect(result).toMatchObject({ status, state: { state: publicState, reasonCode } });
      expect(fx.host.executionKinds).not.toContain('authority.settle-usage');
    });

  test('reconciles effect committed before acknowledgement exactly once across restart', async () => {
    const fx = await fixture();
    await reachApproval(fx);
    await approve(fx);
    fx.host.ackLostKinds.add('authority.initialize');
    await expect(fx.driver.step()).resolves.toMatchObject({
      status: 'advanced', state: { state: 'paused', reasonCode: 'recovery-required' }
    });
    const restarted = createRunControllerDriver({
      repository: fx.repository, host: fx.host, eventSource: eventSource(fx.clock)
    });
    await expect(restarted.step()).resolves.toMatchObject({ status: 'advanced' });
    expect(fx.host.executeCalls.filter(call => call.kind === 'authority.initialize')).toHaveLength(1);
    await expect(restarted.runUntilBlocked(8)).resolves.toMatchObject({
      status: 'blocked', reasonCode: 'eo-running'
    });
  });

  test('rereads exact event after repository commit acknowledgement loss without repeating host effect', async () => {
    let loseCompletionAck = false;
    const fx = await fixture(base => ({
      ...base,
      async compareAndSwap(input) {
        const record = await base.compareAndSwap(input);
        if (loseCompletionAck && (input.value as any).completedCommands?.length > 0) {
          loseCompletionAck = false;
          throw new IndeterminateStoreCommitError('completion acknowledgement lost');
        }
        return record;
      }
    }));
    loseCompletionAck = true;
    await expect(fx.driver.step()).resolves.toMatchObject({ status: 'advanced' });
    expect(fx.host.executeCalls).toHaveLength(1);
    const restarted = createRunControllerDriver({
      repository: fx.repository, host: fx.host, eventSource: eventSource(fx.clock)
    });
    await expect(restarted.step()).resolves.toMatchObject({ status: 'blocked', reasonCode: 'approval-required' });
    expect(fx.host.executeCalls).toHaveLength(1);
  });

  test('concurrent step calls on one driver share one host execution and exact controller event', async () => {
    const fx = await fixture();
    const command = (await state(fx)).outbox[0].command;
    const reconcileGate = deferred<void>();
    fx.host.reconcileGates.set(command.id, reconcileGate.promise);

    const first = fx.driver.step();
    const second = fx.driver.step();
    await waitFor(() => fx.host.reconcileCalls.length === 2);
    reconcileGate.resolve();

    const results = await Promise.all([first, second]);
    expect(results.map(result => result.status)).toEqual(['advanced', 'advanced']);
    expect(fx.host.executeCalls).toHaveLength(1);
    expect(fx.host.durable.claimCounts.get(command.id)).toBe(1);
    expect(fx.host.durable.effectCounts.get(command.id)).toBe(1);
    expect((await state(fx)).completedCommands).toHaveLength(1);
  });

  test('separate drivers sharing one host share one host execution', async () => {
    const fx = await fixture();
    const command = (await state(fx)).outbox[0].command;
    const other = createRunControllerDriver({
      repository: fx.repository, host: fx.host, eventSource: eventSource(fx.clock)
    });
    const reconcileGate = deferred<void>();
    fx.host.reconcileGates.set(command.id, reconcileGate.promise);

    const first = fx.driver.step();
    const second = other.step();
    await waitFor(() => fx.host.reconcileCalls.length === 2);
    reconcileGate.resolve();

    const results = await Promise.all([first, second]);
    expect(results.map(result => result.status)).toEqual(['advanced', 'advanced']);
    expect(fx.host.executeCalls).toHaveLength(1);
    expect(fx.host.durable.claimCounts.get(command.id)).toBe(1);
    expect(fx.host.durable.effectCounts.get(command.id)).toBe(1);
  });

  test('separate host wrappers rely on shared durable command ledger for exactly one effect', async () => {
    const fx = await fixture();
    const command = (await state(fx)).outbox[0].command;
    const otherHost = new FakeRunControllerHost(fx.clock, fx.host.durable);
    const other = createRunControllerDriver({
      repository: fx.repository, host: otherHost, eventSource: eventSource(fx.clock)
    });
    const reconcileGate = deferred<void>();
    fx.host.reconcileGates.set(command.id, reconcileGate.promise);
    otherHost.reconcileGates.set(command.id, reconcileGate.promise);

    const first = fx.driver.step();
    const second = other.step();
    await waitFor(() => fx.host.reconcileCalls.length === 1 && otherHost.reconcileCalls.length === 1);
    reconcileGate.resolve();

    const results = await Promise.all([first, second]);
    expect(results.map(result => result.status)).toEqual(['advanced', 'advanced']);
    expect(fx.host.executeCalls).toHaveLength(1);
    expect(otherHost.executeCalls).toHaveLength(1);
    expect(fx.host.durable.claimCounts.get(command.id)).toBe(1);
    expect(fx.host.durable.effectCounts.get(command.id)).toBe(1);
    expect((await state(fx)).completedCommands).toHaveLength(1);
  });

  test('driver observing an executing durable claim records uncertainty without a new attempt', async () => {
    const fx = await fixture();
    const command = (await state(fx)).outbox[0].command;
    const effectGate = deferred<void>();
    fx.host.gates.set(command.id, effectGate.promise);
    const executing = fx.driver.step();
    await waitFor(() => fx.host.liveExecutions.has(command.id));

    const otherHost = new FakeRunControllerHost(fx.clock, fx.host.durable);
    const observer = createRunControllerDriver({
      repository: fx.repository, host: otherHost, eventSource: eventSource(fx.clock)
    });
    await expect(observer.step()).resolves.toMatchObject({
      status: 'advanced', state: { state: 'paused', reasonCode: 'recovery-required' }
    });
    expect(otherHost.executeCalls).toHaveLength(0);
    expect(fx.host.durable.claimCounts.get(command.id)).toBe(1);
    expect((await state(fx)).outbox).toHaveLength(0);

    effectGate.resolve();
    await expect(executing).resolves.toMatchObject({
      status: 'recovery-required', reasonCode: 'completion-conflict'
    });
    await expect(observer.step()).resolves.toMatchObject({ status: 'advanced' });
    expect(fx.host.durable.effectCounts.get(command.id)).toBe(1);
    expect(fx.host.durable.claimCounts.get(command.id)).toBe(1);
  });

  test('durable executeOnce claim joins concurrent wrappers and returns byte-identical applied result', async () => {
    const fx = await fixture();
    const request = await activeRequest(fx);
    const otherHost = new FakeRunControllerHost(fx.clock, fx.host.durable);
    const effectGate = deferred<void>();
    fx.host.gates.set(request.command.id, effectGate.promise);
    const context = Object.freeze({ signal: new AbortController().signal });

    const first = fx.host.executeOnce(request, context);
    const second = otherHost.executeOnce(request, context);
    expect(first).toBe(second);
    await waitFor(() => fx.host.liveExecutions.has(request.command.id));
    await expect(otherHost.reconcile(request, context)).resolves.toMatchObject({
      status: 'still-uncertain', kind: request.kind
    });
    expect(fx.host.durable.claimCounts.get(request.command.id)).toBe(1);
    expect(fx.host.durable.effectCounts.get(request.command.id)).toBeUndefined();

    effectGate.resolve();
    const results: RunControllerHostExecutionResult[] = await Promise.all([first, second]);
    expect(results[0]).toBe(results[1]);
    expect(JSON.stringify(results[0])).toBe(JSON.stringify(results[1]));
    expect(fx.host.durable.effectCounts.get(request.command.id)).toBe(1);
  });

  test('lost acknowledgement with concurrent restart reconciles one durable effect and exact event', async () => {
    const fx = await fixture();
    const command = (await state(fx)).outbox[0].command;
    fx.host.ackLostKinds.add(command.kind);
    await expect(fx.driver.step()).resolves.toMatchObject({
      status: 'advanced', state: { state: 'paused', reasonCode: 'recovery-required' }
    });
    expect(fx.host.durable.claimCounts.get(command.id)).toBe(1);
    expect(fx.host.durable.effectCounts.get(command.id)).toBe(1);

    const restartHostA = new FakeRunControllerHost(fx.clock, fx.host.durable);
    const restartHostB = new FakeRunControllerHost(fx.clock, fx.host.durable);
    const restartedA = createRunControllerDriver({
      repository: fx.repository, host: restartHostA, eventSource: eventSource(fx.clock)
    });
    const restartedB = createRunControllerDriver({
      repository: fx.repository, host: restartHostB, eventSource: eventSource(fx.clock)
    });
    const reconcileGate = deferred<void>();
    restartHostA.reconcileGates.set(command.id, reconcileGate.promise);
    restartHostB.reconcileGates.set(command.id, reconcileGate.promise);
    const first = restartedA.step();
    const second = restartedB.step();
    await waitFor(() => restartHostA.reconcileCalls.length === 1 && restartHostB.reconcileCalls.length === 1);
    reconcileGate.resolve();

    const results = await Promise.all([first, second]);
    expect(results.map(result => result.status)).toEqual(['advanced', 'advanced']);
    expect(fx.host.durable.claimCounts.get(command.id)).toBe(1);
    expect(fx.host.durable.effectCounts.get(command.id)).toBe(1);
    expect(restartHostA.executeCalls).toHaveLength(0);
    expect(restartHostB.executeCalls).toHaveLength(0);
    expect((await state(fx)).completedCommands).toHaveLength(1);
  });

  test('executeOnce rejects mismatched idempotency key before durable claim', async () => {
    const fx = await fixture();
    const request = await activeRequest(fx);
    const malformed = { ...request, idempotencyKey: `${request.command.id}:wrong` };
    const context = Object.freeze({ signal: new AbortController().signal });
    expect(() => fx.host.executeOnce(malformed, context)).toThrow(/idempotency key/);
    expect(fx.host.durable.attempts.size).toBe(0);
    expect(fx.host.durable.claimCounts.size).toBe(0);
  });

  test.each(['in-progress', 'indeterminate'] as const)(
    'typed executeOnce %s outcome records uncertainty without retrying', async status => {
      const fx = await fixture();
      const command = (await state(fx)).outbox[0].command;
      const host: RunControllerHostPort = {
        reconcile: fx.host.reconcile.bind(fx.host),
        async executeOnce(request) {
          return status === 'in-progress'
            ? { status, kind: request.kind, observedAt: fx.clock.next() }
            : { status, kind: request.kind, observedAt: fx.clock.next(), code: 'transport' };
        }
      };
      const driver = createRunControllerDriver({
        repository: fx.repository, host, eventSource: eventSource(fx.clock)
      });
      await expect(driver.step()).resolves.toMatchObject({
        status: 'advanced', state: { state: 'paused', reasonCode: 'recovery-required' }
      });
      const current = await state(fx);
      expect(current.outbox).toHaveLength(0);
      expect(current.completedCommands).toHaveLength(1);
      expect(current.completedCommands[0]).toMatchObject({
        command: { id: command.id }, outcome: 'uncertain'
      });
    }
  );

  test('recovers unknown completion CAS with absent event through host ledger after restart', async () => {
    let loseCompletion = false;
    const fx = await fixture(base => ({
      ...base,
      async compareAndSwap(input) {
        if (loseCompletion && (input.value as any).completedCommands?.length > 0) {
          loseCompletion = false;
          throw new IndeterminateStoreCommitError('completion outcome unknown before write');
        }
        return base.compareAndSwap(input);
      }
    }));
    loseCompletion = true;
    await expect(fx.driver.step()).resolves.toMatchObject({
      status: 'recovery-required', reasonCode: 'completion-commit-unknown'
    });
    expect((await state(fx)).outbox).toHaveLength(1);
    const restarted = createRunControllerDriver({
      repository: fx.repository, host: fx.host, eventSource: eventSource(fx.clock)
    });
    await expect(restarted.step()).resolves.toMatchObject({ status: 'advanced' });
    expect(fx.host.executeCalls).toHaveLength(1);
    expect(fx.host.reconcileCalls).toHaveLength(2);
  });

  test.each([
    ['project', (value: any) => { value.projectId = 'project:tampered'; }],
    ['graph', (value: any) => { value.model.graphDigest = D('tampered-graph'); }],
    ['payload', (value: any) => { value.outbox[0].command.payloadDigest = D('tampered-payload'); }],
    ['fence', (value: any) => { value.outbox[0].command.expectedLeaseFence = 99; }],
    ['cancellation', (value: any) => { value.outbox[0].protectedPayload.cancellationGeneration = 1; }]
  ] as const)('rejects stale/tampered %s protected command before host invocation', async (_label, mutate) => {
    const fx = await fixture();
    const read = await fx.repository.read();
    if (read.status !== 'active') throw new Error('Expected active state');
    const corrupt = JSON.parse(JSON.stringify(read.snapshot.state));
    mutate(corrupt);
    await fx.writer.compareAndSwap({
      key: fx.repository.key, expectedGeneration: read.snapshot.generation, value: corrupt
    });
    await expect(fx.driver.step()).resolves.toMatchObject({ status: 'recovery-required' });
    expect(fx.host.reconcileCalls).toHaveLength(0);
    expect(fx.host.executeCalls).toHaveLength(0);
  });

  test('handles applied, not-applied, and still-uncertain reconciliation without blind replay', async () => {
    const appliedFx = await fixture();
    const appliedState = await state(appliedFx);
    const appliedRequest = appliedState.outbox[0];
    const prior = await appliedFx.host.executeOnce({
      kind: appliedRequest.command.kind,
      idempotencyKey: appliedRequest.command.id,
      command: appliedRequest.command,
      protectedPayload: appliedRequest.protectedPayload,
      modelDigest: appliedState.modelDigest
    } as RunControllerHostExecuteOnceRequest,
    Object.freeze({ signal: new AbortController().signal }));
    expect(prior.status).toBe('applied');
    appliedFx.host.executeCalls.length = 0;
    await expect(appliedFx.driver.step()).resolves.toMatchObject({ status: 'advanced' });
    expect(appliedFx.host.executeCalls).toHaveLength(0);

    const uncertainFx = await fixture();
    let current = await state(uncertainFx);
    const first = current.outbox[0].command;
    uncertainFx.host.reconciliation.set(first.id, {
      status: 'still-uncertain', kind: first.kind, observedAt: uncertainFx.clock.next()
    });
    await uncertainFx.driver.step();
    expect((await state(uncertainFx)).phase).toBe('recovery-required');
    expect(uncertainFx.host.executeCalls).toHaveLength(0);
    uncertainFx.host.reconciliation.set(first.id, {
      status: 'still-uncertain', kind: first.kind, observedAt: uncertainFx.clock.next()
    });
    await expect(uncertainFx.driver.step()).resolves.toMatchObject({
      status: 'blocked', reasonCode: 'recovery-still-uncertain'
    });
    expect(uncertainFx.host.executeCalls).toHaveLength(0);
    uncertainFx.host.reconciliation.set(first.id, {
      status: 'not-applied', kind: first.kind, observedAt: uncertainFx.clock.next(),
      quiesced: true, quiescenceDigest: computeRunControllerQuiescenceDigest(first)
    });
    await expect(uncertainFx.driver.step()).resolves.toMatchObject({ status: 'advanced' });
    current = await state(uncertainFx);
    expect(current.outbox[0].command.attempt).toBe(2);
    uncertainFx.host.reconciliation.delete(first.id);
    await uncertainFx.driver.step();
    expect(uncertainFx.host.executeCalls).toHaveLength(1);

    const unsupportedFx = await fixture();
    unsupportedFx.host.unsupportedKinds.add('authority.initialize');
    await reachApproval(unsupportedFx);
    await approve(unsupportedFx);
    await expect(unsupportedFx.driver.step()).resolves.toMatchObject({
      status: 'recovery-required', reasonCode: 'host-reconciliation-unsupported'
    });
    expect(unsupportedFx.host.executeCalls.filter(call => call.kind === 'authority.initialize')).toHaveLength(0);
  });

  test.each(['fidelity.preflight', 'evidence.validate-preliminary-report'] as const)(
    'unsupported reconciliation for %s never executes', async kind => {
      const fx = await fixture();
      if (kind === 'evidence.validate-preliminary-report') {
        await reachEoRunning(fx);
        await driveReport(fx);
      }
      fx.host.unsupportedKinds.add(kind);
      await expect(fx.driver.step()).resolves.toMatchObject({
        status: 'recovery-required', reasonCode: 'host-reconciliation-unsupported'
      });
      expect(fx.host.executeCalls.filter(call => call.kind === kind)).toHaveLength(0);
      expect((await state(fx)).outbox[0].command.kind).toBe(kind);
    }
  );

  test.each([
    ['missing proof', (command: any, observedAt: string) => ({
      status: 'not-applied', kind: command.kind, observedAt
    })],
    ['random digest', (command: any, observedAt: string) => ({
      status: 'not-applied', kind: command.kind, observedAt,
      quiesced: true, quiescenceDigest: D('random-quiescence')
    })],
    ['stale-command digest', (command: any, observedAt: string) => ({
      status: 'not-applied', kind: command.kind, observedAt,
      quiesced: true,
      quiescenceDigest: computeRunControllerQuiescenceDigest({ ...command, attempt: command.attempt + 1 })
    })],
    ['extra field', (command: any, observedAt: string) => ({
      status: 'not-applied', kind: command.kind, observedAt,
      quiesced: true, quiescenceDigest: computeRunControllerQuiescenceDigest(command), extra: true
    })]
  ] as const)('malformed active quiescence %s fails closed before execute', async (_label, result) => {
    const fx = await fixture();
    const before = await fx.repository.read();
    if (before.status !== 'active') throw new Error('Expected active state');
    const command = before.snapshot.state.outbox[0].command;
    fx.host.reconciliation.set(command.id,
      result(command, fx.clock.next()) as RunControllerHostReconciliationResult);
    await expect(fx.driver.step()).resolves.toMatchObject({
      status: 'recovery-required', reasonCode: 'host-result-invalid'
    });
    expect(fx.host.executeCalls).toHaveLength(0);
    const after = await fx.repository.read();
    expect(after).toMatchObject({ status: 'active', snapshot: { generation: before.snapshot.generation } });
  });

  test('reconcile timeout aborts host context, fails closed, and never executes', async () => {
    const fx = await fixture(undefined, 10);
    const command = (await state(fx)).outbox[0].command;
    fx.host.reconcileGates.set(command.id, new Promise<void>(() => undefined));
    await expect(fx.driver.step()).resolves.toMatchObject({
      status: 'recovery-required', reasonCode: 'host-reconcile-unavailable'
    });
    expect(fx.host.reconcileContexts).toHaveLength(1);
    expect(fx.host.reconcileContexts[0].signal.aborted).toBe(true);
    expect(fx.host.executeCalls).toHaveLength(0);
    expect((await state(fx)).outbox[0].command.id).toBe(command.id);
  });

  test('execute timeout persists indeterminate completion and never retries blindly', async () => {
    const fx = await fixture(undefined, 10);
    const command = (await state(fx)).outbox[0].command;
    fx.host.gates.set(command.id, new Promise<void>(() => undefined));
    await expect(fx.driver.step()).resolves.toMatchObject({
      status: 'advanced', state: { state: 'paused', reasonCode: 'recovery-required' }
    });
    const current = await state(fx);
    expect(fx.host.executeContexts[0].signal.aborted).toBe(true);
    expect(fx.host.executeCalls).toHaveLength(1);
    expect(current.phase).toBe('recovery-required');
    expect(current.completedCommands.at(-1)).toMatchObject({
      command: { id: command.id }, outcome: 'uncertain',
      resultDigest: computeRunControllerBindingDigest('host-uncertain', {
        commandId: command.id, code: 'timeout'
      })
    });
  });

  test('live timed-out attempt remains uncertain and late resolution cannot create duplicate effect', async () => {
    const fx = await fixture(undefined, 10);
    const command = (await state(fx)).outbox[0].command;
    const gate = deferred<void>();
    fx.host.gates.set(command.id, gate.promise);
    fx.host.ignoreAbortCommandIds.add(command.id);
    await fx.driver.step();
    const timedOut = await fx.repository.read();
    if (timedOut.status !== 'active') throw new Error('Expected timed-out state');
    await expect(fx.driver.step()).resolves.toMatchObject({
      status: 'blocked', reasonCode: 'recovery-still-uncertain'
    });
    expect((await state(fx)).outbox).toHaveLength(0);
    expect(fx.host.executeCalls).toHaveLength(1);
    gate.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    const afterLateResult = await fx.repository.read();
    expect(afterLateResult).toMatchObject({
      status: 'active', snapshot: { generation: timedOut.snapshot.generation }
    });
    expect(fx.host.ledger.has(command.id)).toBe(true);
    expect(fx.host.ledger.size).toBe(1);
    await expect(fx.driver.step()).resolves.toMatchObject({ status: 'advanced' });
    expect(fx.host.executeCalls).toHaveLength(1);
    expect((await state(fx)).completedCommands).toHaveLength(1);
  });

  test('acknowledged abort yields exact quiescence proof and one safe retry effect', async () => {
    const fx = await fixture(undefined, 10);
    const command = (await state(fx)).outbox[0].command;
    fx.host.gates.set(command.id, new Promise<void>(() => undefined));
    await fx.driver.step();
    expect(fx.host.abortAcknowledged.has(command.id)).toBe(true);
    expect(fx.host.liveExecutions.has(command.id)).toBe(false);
    await expect(fx.driver.step()).resolves.toMatchObject({ status: 'advanced' });
    const recovered = await state(fx);
    expect(recovered.completedCommands.find(completed => completed.command.id === command.id))
      .toMatchObject({
        outcome: 'not-applied',
        reconciliationEvent: {
          disposition: 'not-applied',
          quiescenceDigest: computeRunControllerQuiescenceDigest(command)
        }
      });
    const retry = recovered.outbox[0].command;
    expect(retry).toMatchObject({ kind: command.kind, attempt: 2 });
    expect(retry.id).not.toBe(command.id);
    await expect(fx.driver.step()).resolves.toMatchObject({ status: 'advanced' });
    expect(fx.host.executeCalls.map(call => call.command.attempt)).toEqual([1, 2]);
    expect(fx.host.ledger.size).toBe(1);
    expect(fx.host.ledger.has(retry.id)).toBe(true);
  });

  test('late execute rejection is observed without mutating timed-out state', async () => {
    const fx = await fixture(undefined, 10);
    const command = (await state(fx)).outbox[0].command;
    const gate = deferred<void>();
    fx.host.gates.set(command.id, gate.promise);
    await fx.driver.step();
    const timedOut = await fx.repository.read();
    if (timedOut.status !== 'active') throw new Error('Expected timed-out state');
    gate.reject(new Error('late host rejection'));
    await new Promise<void>(resolve => setImmediate(resolve));
    const afterLateRejection = await fx.repository.read();
    expect(afterLateRejection).toMatchObject({
      status: 'active', snapshot: { generation: timedOut.snapshot.generation }
    });
    expect(fx.host.ledger.has(command.id)).toBe(false);
  });

  test.each([
    ['unknown property', (proof: any) => ({ ...proof, unexpected: true })],
    ['omitted field', (proof: any) => {
      const { assessmentDigest: _assessmentDigest, ...rest } = proof;
      return rest;
    }],
    ['wrong enum', (proof: any) => ({ ...proof, fidelity: 'approximate' })],
    ['malformed digest', (proof: any) => ({ ...proof, assessmentDigest: 'bad-digest' })]
  ] as const)('strict host proof parsing rejects %s without state mutation', async (_label, transform) => {
    const fx = await fixture();
    fx.host.proofTransform = transform;
    const before = await fx.repository.read();
    if (before.status !== 'active') throw new Error('Expected active state');
    await expect(fx.driver.step()).resolves.toMatchObject({
      status: 'recovery-required', reasonCode: 'host-result-invalid'
    });
    const after = await fx.repository.read();
    expect(after).toMatchObject({ status: 'active', snapshot: { generation: before.snapshot.generation } });
    expect((after as typeof before).snapshot.state.outbox[0].command.id)
      .toBe(before.snapshot.state.outbox[0].command.id);
  });

  test.each([
    ['malformed budget', (proof: any) => ({
      ...proof, budgetSummary: { ...proof.budgetSummary, committed: proof.budgetSummary.reserved + 1 }
    })],
    ['malformed projection array', (proof: any) => ({
      ...proof, projectionDigests: [proof.projectionDigests[0], proof.projectionDigests[0]]
    })]
  ] as const)('strict settlement proof parsing rejects %s without state mutation',
    async (_label, transform) => {
      const fx = await fixture();
      await reachEoRunning(fx);
      await driveReport(fx);
      await fx.driver.step();
      expect((await state(fx)).outbox[0].command.kind).toBe('authority.settle-usage');
      fx.host.proofTransform = transform;
      const before = await fx.repository.read();
      if (before.status !== 'active') throw new Error('Expected active state');
      await expect(fx.driver.step()).resolves.toMatchObject({
        status: 'recovery-required', reasonCode: 'host-result-invalid'
      });
      const after = await fx.repository.read();
      expect(after).toMatchObject({ status: 'active', snapshot: { generation: before.snapshot.generation } });
    });

  test('strict descendant proof parsing rejects malformed count without state mutation', async () => {
    const fx = await fixture();
    await reachEoRunning(fx);
    await transact(fx, {
      type: 'cancel', eventId: 'malformed-count-cancel', occurredAt: fx.clock.next(), reasonDigest: D('cancel')
    });
    await fx.driver.step();
    expect((await state(fx)).outbox[0].command.kind).toBe('descendant.signal');
    fx.host.proofTransform = proof => ({ ...proof, pendingDescendants: -1 });
    const before = await fx.repository.read();
    if (before.status !== 'active') throw new Error('Expected active state');
    await expect(fx.driver.step()).resolves.toMatchObject({
      status: 'recovery-required', reasonCode: 'host-result-invalid'
    });
    const after = await fx.repository.read();
    expect(after).toMatchObject({ status: 'active', snapshot: { generation: before.snapshot.generation } });
  });

  test.each([0, 120_001, 1.5, Number.NaN, null] as const)(
    'rejects invalid hostCallTimeoutMs %s', async timeout => {
      const fx = await fixture();
      expect(() => createRunControllerDriver({
        repository: fx.repository,
        host: fx.host,
        eventSource: eventSource(fx.clock),
        hostCallTimeoutMs: timeout as number
      })).toThrow(/hostCallTimeoutMs/);
    }
  );

  test('cancellation interrupts active command, drains in bounded force turns, reconciles, and checkpoints', async () => {
    const fx = await fixture();
    await reachEoRunning(fx);
    await driveReport(fx);
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>(resolve => { releaseExecution = resolve; });
    const active = await state(fx);
    const interrupted = active.outbox[0].command;
    fx.host.gates.set(interrupted.id, executionGate);
    const executing = fx.driver.step();
    while (!fx.host.executeCalls.some(call => call.command.id === interrupted.id)) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await transact(fx, {
      type: 'cancel', eventId: 'cancel-active-command', occurredAt: fx.clock.next(),
      reasonDigest: D('cancel-active')
    });
    releaseExecution();
    await expect(executing).resolves.toMatchObject({
      status: 'recovery-required', reasonCode: 'completion-conflict'
    });
    fx.host.signalCounts.splice(0, fx.host.signalCounts.length, 1);
    fx.host.forceCounts.splice(0, fx.host.forceCounts.length, 1, 0);
    await expect(fx.driver.runUntilBlocked(8)).resolves.toMatchObject({
      status: 'blocked', state: { reasonCode: 'descendant-drain-incomplete' }
    });
    expect(fx.host.executionKinds.indexOf('authority.cancel')).toBeLessThan(
      fx.host.executionKinds.indexOf('descendant.signal')
    );
    expect(fx.host.executionKinds.indexOf('descendant.signal')).toBeLessThan(
      fx.host.executionKinds.indexOf('descendant.force')
    );
    const paused = await state(fx);
    await transact(fx, {
      type: 'trusted-continuation', eventId: 'continue-force', occurredAt: fx.clock.next(),
      checkpointDigest: paused.continuationCheckpointDigest!
    });
    const cancellationResult = await fx.driver.runUntilBlocked(8);
    expect(cancellationResult).toMatchObject({
      status: 'terminal', reasonCode: null, state: { state: 'cancelled' }
    });
    expect(fx.host.executeCalls.filter(call => call.command.id === interrupted.id)).toHaveLength(1);
    expect(fx.host.executeCalls.filter(call => call.kind === 'descendant.force')).toHaveLength(2);
    expect(fx.host.executionKinds.at(-1)).toBe('checkpoint.persist');
  });

  test('maps known failure, malformed host result, step cap, and no-progress without leaking commands', async () => {
    const failure = await fixture();
    failure.host.knownFailureKinds.add('fidelity.preflight');
    await expect(failure.driver.step()).resolves.toMatchObject({
      status: 'terminal', state: { state: 'failed', reasonCode: 'effect-failed' }
    });

    const malformed = await fixture();
    malformed.host.extraResultField = true;
    await expect(malformed.driver.step()).resolves.toMatchObject({
      status: 'recovery-required', reasonCode: 'host-result-invalid', state: { state: 'preparing' }
    });
    expect((await state(malformed)).outbox).toHaveLength(1);

    const capped = await fixture();
    await capped.driver.step();
    await approve(capped);
    const limited = await capped.driver.runUntilBlocked(2);
    expect(limited).toMatchObject({ status: 'step-limit', steps: 2, reasonCode: 'step-limit' });
    expect(JSON.stringify(limited)).not.toMatch(/protectedPayload|bindings|commandId/);

    const idle = await fixture();
    await reachApproval(idle);
    await expect(idle.driver.step()).resolves.toMatchObject({
      status: 'blocked', reasonCode: 'approval-required'
    });
    await expect(idle.driver.runUntilBlocked(0)).rejects.toThrow(/maxSteps/);
  });
});
