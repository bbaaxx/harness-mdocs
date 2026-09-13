import {
  authorityRunStoreKey,
  createProtectedAuthorityRepository
} from '../../src/agents/run/authority/protected-repository';
import { TicketAuthorityError } from '../../src/agents/run/authority/state';
import { controllerProof, workstreamProof } from '../../src/agents/run/authority/leases';
import {
  createRunAuthorityManager,
  createRunAuthorityManagerForTest,
  parseRunAuthorityState,
  RunAuthorityManagerOptions
} from '../../src/agents/run/authority/manager';
import * as publicAuthority from '../../src/agents/run/authority';
import { compilePlanGraph } from '../../src/agents/run/compiler';
import {
  AttestationChallengeParams,
  createFakeTrustedControlPlane
} from '../../src/agents/run/trust';
import {
  IndeterminateStoreCommitError,
  InMemoryProtectedStoreAdapter,
  ProtectedControllerStore,
  ProtectedControllerStoreWriter
} from '../../src/agents/run/store';

interface CounterState {
  runId: string;
  projectId: string;
  count: number;
}

const EXECUTION_BUDGETS = Object.freeze({
  toolActionsGlobal: 30, toolActionsEo: 20, toolActionsLeaf: 10,
  tokensGlobal: 50, tokensEo: 50, tokensLeaf: 20,
  costUsdGlobal: 2, costUsdEo: 1
});
const LEAF_BUDGETS = Object.freeze({
  toolActionsGlobal: 10, toolActionsEo: 10, toolActionsLeaf: 10,
  tokensGlobal: 20, tokensEo: 20, tokensLeaf: 20,
  costUsdGlobal: 1, costUsdEo: 1
});

function parseCounter(value: unknown): Readonly<CounterState> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'count,projectId,runId') throw new Error('invalid counter state');
  const state = value as Record<string, unknown>;
  if (typeof state.runId !== 'string' || !Number.isSafeInteger(state.count) || (state.count as number) < 0) {
    throw new Error('invalid counter state');
  }
  if (typeof state.projectId !== 'string') throw new Error('invalid counter state');
  return Object.freeze({ runId: state.runId, projectId: state.projectId, count: state.count as number });
}

async function setup(runId = 'run:persistence') {
  const adapter = new InMemoryProtectedStoreAdapter();
  const store = new ProtectedControllerStore({ storeId: 'authority-test', adapter });
  const writer = await store.openWriter();
  const repository = createProtectedAuthorityRepository({
    runId, projectId: 'project:persistence', reader: store.reader(), writer, parseState: parseCounter
  });
  return { adapter, store, writer, repository };
}

describe('protected run authority repository', () => {
  test('initializes exactly once under one aggregate key', async () => {
    const { store, repository } = await setup();
    const initialized = await repository.initialize({
      runId: 'run:persistence', projectId: 'project:persistence', count: 0
    });
    expect(initialized.generation).toBe(1);
    await expect(repository.initialize({
      runId: 'run:persistence', projectId: 'project:persistence', count: 0
    }))
      .rejects.toMatchObject({ code: 'already-initialized' });
    expect(await store.reader().list('run-authority/')).toEqual([
      authorityRunStoreKey('project:persistence', 'run:persistence')
    ]);
  });

  test('racing writers reread and recompute after CAS conflict without lost update', async () => {
    const { store, writer, repository } = await setup();
    await repository.initialize({ runId: 'run:persistence', projectId: 'project:persistence', count: 0 });
    const second = createProtectedAuthorityRepository({
      runId: 'run:persistence', projectId: 'project:persistence',
      reader: store.reader(), writer, parseState: parseCounter
    });
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const transition = async (state: Readonly<CounterState>) => {
      arrivals += 1;
      if (arrivals <= 2) {
        if (arrivals === 2) release();
        await barrier;
      }
      return { state: { ...state, count: state.count + 1 }, result: state.count + 1 };
    };
    const results = await Promise.all([
      repository.transact({}, transition),
      second.transact({}, transition)
    ]);
    expect(results.map(result => result.result).sort()).toEqual([1, 2]);
    expect((await repository.read())!.state.count).toBe(2);
  });

  test('snapshots hostile input before reads and never invokes accessors', async () => {
    const { repository } = await setup();
    await repository.initialize({ runId: 'run:persistence', projectId: 'project:persistence', count: 0 });
    const getter = jest.fn(() => 1);
    const input = Object.defineProperty({}, 'poison', { enumerable: true, get: getter });
    await expect(repository.transact(input, state => ({ state: { ...state }, result: true })))
      .rejects.toThrow(/accessor/i);
    expect(getter).not.toHaveBeenCalled();
    expect((await repository.read())!.generation).toBe(1);
  });

  test('fails closed on corrupted/recovery-required protected state', async () => {
    const { adapter, repository } = await setup();
    await repository.initialize({ runId: 'run:persistence', projectId: 'project:persistence', count: 0 });
    adapter.testOnlyReplaceValueRaw(
      authorityRunStoreKey('project:persistence', 'run:persistence'), '{bad-json'
    );
    await expect(repository.read()).rejects.toMatchObject({ code: 'store-unavailable' });
  });

  test('reports unknown commit and does not blindly retry indeterminate outcome', async () => {
    const { store, writer, repository } = await setup();
    await repository.initialize({ runId: 'run:persistence', projectId: 'project:persistence', count: 0 });
    let commits = 0;
    const uncertainWriter: ProtectedControllerStoreWriter = {
      ...writer,
      compareAndSwap: async input => {
        commits += 1;
        const committed = await writer.compareAndSwap(input);
        throw new IndeterminateStoreCommitError(`lost acknowledgement ${committed.generation}`);
      }
    };
    const uncertain = createProtectedAuthorityRepository({
      runId: 'run:persistence', projectId: 'project:persistence',
      reader: store.reader(), writer: uncertainWriter, parseState: parseCounter
    });
    await expect(uncertain.transact({}, state => ({
      state: { ...state, count: state.count + 1 }, result: true
    }))).rejects.toMatchObject({ code: 'commit-unknown' });
    expect(commits).toBe(1);
    expect((await repository.read())!.state.count).toBe(1);
  });

  test('rejects malformed persisted binding instead of repairing it', async () => {
    const { writer, repository } = await setup();
    await repository.initialize({ runId: 'run:persistence', projectId: 'project:persistence', count: 0 });
    await writer.compareAndSwap({
      key: authorityRunStoreKey('project:persistence', 'run:persistence'), expectedGeneration: 1,
      value: { runId: 'other-run', projectId: 'project:persistence', count: 0 }
    });
    const error = await repository.read().catch(value => value);
    expect(error).toBeInstanceOf(TicketAuthorityError);
    expect(error).toMatchObject({ code: 'store-unavailable' });
  });
});

describe('run authority manager persistence', () => {
  test('validates approval internally and commits ticket plus reservation in one aggregate generation', async () => {
    const now = new Date('2026-09-12T00:00:00.000Z');
    const planInput = {
      planKey: 'manager-test', planRevision: 1, objective: 'Persist authority',
      scope: ['src/**'], outOfScope: [],
      milestones: [{
        key: 'core', dependsOn: [], criteria: ['Complete'], verification: 'Run tests',
        writeSet: ['src/**'], integrationCriteria: ['Integrated'],
        workstreams: [{
          key: 'api', criteria: ['API done'], writeSet: ['src/api/**'],
          leaves: [{ key: 'handler', criteria: ['Handler done'], writeSet: ['src/api/handler.ts'] }]
        }]
      }],
      integrationCriteria: ['Integrated'], regressionCriteria: [], expectedSideEffects: [],
      policy: {}, budgets: {
        maxActiveExecutionOrchestrators: 8, maxGlobalDescendants: 16, maxCumulativeSpawns: 32,
        toolActionsGlobal: 300, toolActionsEo: 300, toolActionsLeaf: 300,
        tokensGlobal: 500, tokensEo: 500, tokensLeaf: 500,
        costUsdGlobal: 16, costUsdEo: 16
      }, adapterRequirements: [], pauseRules: [], failureRules: [],
      cancelRules: [], completionRules: []
    };
    const compiled = compilePlanGraph(planInput);
    const controlPlane = createFakeTrustedControlPlane({ now: () => new Date(now) });
    const binding: AttestationChallengeParams = {
      planDigest: compiled.plan.digest as AttestationChallengeParams['planDigest'],
      graphDigest: compiled.graph.digest as AttestationChallengeParams['graphDigest'],
      planRevision: compiled.planRevision, projectId: 'project:fake',
      hostSessionRef: 'host-session:fake', principalRef: 'principal:fake'
    };
    const approvalChallenge = await controlPlane.attestation.beginChallenge(binding);
    const approval = await controlPlane.attestation.recordApproval(approvalChallenge.challengeId, 'approved');
    const modeChallenge = await controlPlane.attestation.beginChallenge(binding);
    const modeSelection = await controlPlane.attestation.recordModeSelection(
      modeChallenge.challengeId, 'autonomous'
    );
    const adapter = new InMemoryProtectedStoreAdapter();
    const store = new ProtectedControllerStore({ storeId: 'manager-authority-test', adapter });
    const writer = await store.openWriter();
    let loseFinalizeAck = true;
    let loseLeaseAck = false;
    let loseClaimAck = false;
    let loseUsageIntentAck = false;
    let loseUsageFinalizeAck = false;
    let loseProviderReleaseStageAck = false;
    let loseProviderReleaseFinalizeAck = false;
    let loseBindAckBeforeCommit = false;
    let loseUnboundClearAck = false;
    let runConcurrentFinalizeOnOrphanStage = false;
    let concurrentIssueInput: any = null;
    let concurrentIssueResult: any = null;
    let runConcurrentBindOnOrphanStage = false;
    let inFlightOpId: string | null = null;
    let markBBound: (() => void) | null = null;
    let bFinalizeGateToAwait: Promise<void> | null = null;
    let redirectClaimToHandle: string | null = null;
    const uncertainWriter: ProtectedControllerStoreWriter = {
      ...writer,
      compareAndSwap: async input => {
        if (loseBindAckBeforeCommit &&
            (input.value as any).pendingIssuance?.status === 'provider-reserved') {
          loseBindAckBeforeCommit = false;
          throw new IndeterminateStoreCommitError('lost provider binding acknowledgement before commit');
        }
        let committedInput = input;
        if (redirectClaimToHandle) {
          const value: any = JSON.parse(JSON.stringify(input.value));
          const workstream = value.leaseState?.workstreamLeases?.find(
            (item: any) => item.lifecycle === 'active'
          );
          const claimed = workstream && value.ticketState?.tickets?.find(
            (item: any) => item.ticket.ticketHandleId === workstream.ticketHandleId
          );
          const redirected = value.ticketState?.tickets?.find(
            (item: any) => item.ticket.ticketHandleId === redirectClaimToHandle
          );
          if (!workstream || !claimed || !redirected) throw new Error('claim redirect fixture is invalid');
          claimed.nonceStatus = 'issued';
          redirected.nonceStatus = 'claimed';
          workstream.ticketHandleId = redirectClaimToHandle;
          workstream.authorityDeadlineAt = redirected.ticket.expiresAt;
          redirectClaimToHandle = null;
          committedInput = { ...input, value };
          await writer.compareAndSwap(committedInput);
          throw new IndeterminateStoreCommitError('lost redirected execution claim acknowledgement');
        }
        if (loseUnboundClearAck && !(committedInput.value as any).pendingIssuance &&
            (committedInput.value as any).stateKind === 'initialized') {
          loseUnboundClearAck = false;
          throw new IndeterminateStoreCommitError('unbound saga clear failed before commit');
        }
        if (runConcurrentFinalizeOnOrphanStage &&
            (committedInput.value as any).pendingIssuance?.status === 'release-pending-unbound') {
          runConcurrentFinalizeOnOrphanStage = false;
          concurrentIssueResult = await racingManager.issueExecutionTicket(concurrentIssueInput);
        }
        if (runConcurrentBindOnOrphanStage &&
            (committedInput.value as any).pendingIssuance?.status === 'release-pending-unbound') {
          runConcurrentBindOnOrphanStage = false;
          concurrentIssueResult = racingManager.issueExecutionTicket(concurrentIssueInput);
          await new Promise<void>(resolve => { markBBound = resolve; });
        }
        if (bFinalizeGateToAwait && !(committedInput.value as any).pendingIssuance &&
            (committedInput.value as any).issuanceMappings?.some(
              (mapping: any) => mapping.operationId === inFlightOpId)) {
          const gate = bFinalizeGateToAwait;
          bFinalizeGateToAwait = null;
          await gate;
        }
        const record = await writer.compareAndSwap(committedInput);
        if ((committedInput.value as any).pendingIssuance?.operationId === inFlightOpId &&
            (committedInput.value as any).pendingIssuance?.status === 'provider-reserved') {
          markBBound?.();
        }
        if (loseFinalizeAck && input.expectedGeneration === 1) {
          loseFinalizeAck = false;
          throw new IndeterminateStoreCommitError('lost initialization finalize acknowledgement');
        }
        if (loseUsageIntentAck && (input.value as any).pendingIssuance) {
          loseUsageIntentAck = false;
          throw new IndeterminateStoreCommitError('lost usage intent acknowledgement');
        }
        if (loseUsageFinalizeAck && !(input.value as any).pendingIssuance &&
            (input.value as any).providerUsage?.some((item: any) => item.status === 'reserved')) {
          loseUsageFinalizeAck = false;
          throw new IndeterminateStoreCommitError('lost ticket finalize acknowledgement');
        }
        if (loseProviderReleaseStageAck &&
            (input.value as any).providerUsage?.some((item: any) => item.status === 'release-pending')) {
          loseProviderReleaseStageAck = false;
          throw new IndeterminateStoreCommitError('lost provider release stage acknowledgement');
        }
        if (loseProviderReleaseFinalizeAck &&
            (input.value as any).providerUsage?.some((item: any) => item.status === 'released')) {
          loseProviderReleaseFinalizeAck = false;
          throw new IndeterminateStoreCommitError('lost provider release finalize acknowledgement');
        }
        if (loseClaimAck) {
          loseClaimAck = false;
          throw new IndeterminateStoreCommitError('lost execution claim acknowledgement');
        }
        if (loseLeaseAck) {
          loseLeaseAck = false;
          throw new IndeterminateStoreCommitError('lost lease acknowledgement');
        }
        return record;
      }
    };
    const verifyPair = jest.fn(controlPlane.attestation.verifyPair);
    const attestationByKey = new Map<string, Promise<any>>();
    const attestationByReservation = new Map<string, any>();
    const reservePair = jest.fn(async (request: any) => {
      let reserved = attestationByKey.get(request.idempotencyKey);
      if (!reserved) {
        reserved = (async () => {
          const verified = await verifyPair(request.approval, request.modeSelection, request.expected);
          if (!verified.ok) throw new Error(verified.reason);
          const reservationId = `attestation-reservation:${request.idempotencyKey}`;
          attestationByReservation.set(reservationId, {
            ok: true, reservationId,
            approvalEventId: request.approval.eventId,
            modeSelectionEventId: request.modeSelection.eventId,
            approvalRef: request.approval.verificationRef,
            modeSelectionRef: request.modeSelection.verificationRef,
            mode: request.modeSelection.mode,
            initializationRequestDigest: request.initializationRequestDigest,
            projectId: request.expected.projectId,
            hostSessionRef: request.expected.hostSessionRef,
            principalRef: request.expected.principalRef,
            planDigest: request.expected.planDigest,
            graphDigest: request.expected.graphDigest,
            planRevision: request.expected.planRevision
          });
          return {
            reservationId, idempotencyKey: request.idempotencyKey,
            expiresAt: '2026-09-12T00:05:00.000Z'
          };
        })();
        attestationByKey.set(request.idempotencyKey, reserved);
      }
      return reserved;
    });
    const verifyReservedPair = jest.fn(async (reservationId: string) => {
      const result = attestationByReservation.get(reservationId);
      if (!result) throw new Error('unknown attestation reservation');
      return result;
    });
    const attestationProvider = {
      reservePair,
      verifyReservedPair,
      reconcileReservedPair: jest.fn(async (reservationId: string) =>
        attestationByReservation.get(reservationId) ?? null)
    };
    const usageSample = jest.fn(async (scope: string) => ({
      ...await controlPlane.meter.sample(scope), model: 'fake-model',
      cost: { currency: 'USD', value: 0 }
    }));
    const usageReservations = new Map<string, any>();
    const usageReservationStartedAt = new Map<string, string>();
    let usageReserveGate: Promise<void> | null = null;
    let usageReserveStarted: (() => void) | null = null;
    const usageReserve = jest.fn(async (request: any) => {
      usageReserveStarted?.();
      if (usageReserveGate) await usageReserveGate;
      const existing = usageReservations.get(request.idempotencyKey);
      if (existing) return existing;
      const reservation = {
        providerReservationId: `provider-usage:${request.idempotencyKey}`,
        idempotencyKey: request.idempotencyKey,
        opaqueScope: request.scope.opaqueScope
      };
      usageReservations.set(request.idempotencyKey, reservation);
      usageReservationStartedAt.set(reservation.providerReservationId, now.toISOString());
      return reservation;
    });
    const usageFinalize = jest.fn(async (providerReservationId: string) => {
      const reservation = [...usageReservations.values()].find(
        value => value.providerReservationId === providerReservationId
      );
      if (!reservation) throw new Error('unknown usage reservation');
      const timestamp = usageReservationStartedAt.get(providerReservationId);
      if (!timestamp) throw new Error('unknown usage reservation timestamp');
      return {
        ...await usageSample(reservation.opaqueScope),
        timestamp
      };
    });
    const usageCommit = jest.fn(async (_providerReservationId: string, _sampleDigest: string) => undefined);
    const usageRelease = jest.fn(async (_providerReservationId: string, _idempotencyKey: string) => undefined);
    const usageMeter = {
      reserve: usageReserve, finalize: usageFinalize, commit: usageCommit, release: usageRelease
    };
    let currentHost = await controlPlane.identity.currentHostIdentity();
    const hostIdentityProvider = {
      ...controlPlane.identity,
      currentHostIdentity: async () => currentHost
    };
    const managerOptions: RunAuthorityManagerOptions = {
      runId: 'run:manager', projectId: 'project:fake', compiled,
      reader: store.reader(), writer: uncertainWriter, hostIdentityProvider,
      attestationProvider, usageMeter,
      usageBinding: {
        source: 'fake-trusted-control-plane', provider: 'fake', model: 'fake-model',
        priceTableVersion: '0', currency: 'USD'
      },
      usageSettlementTimeoutMs: 25
    };
    let entropy = 0;
    let monotonicMs = 1000;
    const manager = createRunAuthorityManagerForTest(managerOptions, {
      now: () => new Date(now), monotonicClock: () => monotonicMs,
      clockDomainId: () => 'manager-clock-domain',
      randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    const initialization = {
      idempotencyKey: 'manager-initialization-0001', approval, modeSelection,
    };
    const racingManager = createRunAuthorityManagerForTest(managerOptions, {
      now: () => new Date(now), monotonicClock: () => monotonicMs,
      clockDomainId: () => 'manager-clock-domain',
      randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    const initializationRace = await Promise.allSettled([
      manager.initialize(initialization), racingManager.initialize(initialization)
    ]);
    expect(initializationRace.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    expect(verifyPair).toHaveBeenCalledTimes(1);
    const initializationReservationRequest = reservePair.mock.calls[0][0];
    expect(initializationReservationRequest.idempotencyKey).toBe(
      `run-init:project:fake:run:manager:${initializationReservationRequest.initializationRequestDigest}`
    );
    const initialized = await manager.read();
    expect(await manager.initialize(initialization)).toEqual(initialized);
    expect(verifyPair).toHaveBeenCalledTimes(1);
    const initializedAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (initializedAggregate.status !== 'active') throw new Error('Expected initialized aggregate');
    expect(initializedAggregate.record.value.ticketState.rootAuthority).toEqual({
      roots: compiled.plan.payload.scope,
      operationClasses: [], toolClasses: [], credentialClasses: [],
      approvalRefs: [approval.verificationRef, modeSelection.verificationRef].sort(),
      budgets: compiled.plan.payload.budgets,
      expiresAt: '2026-09-12T01:00:00.000Z',
      maxChildDepth: 2,
      maxFanout: compiled.plan.payload.budgets.maxActiveExecutionOrchestrators
    });
    expect(publicAuthority).not.toHaveProperty('createTicketAuthorityBroker');
    await expect(manager.initialize({ ...initialization, rootAuthority: {} } as any))
      .rejects.toMatchObject({ code: 'invalid-input' });
    const pendingManager = createRunAuthorityManagerForTest({
      ...managerOptions, runId: 'run:pending-initialization'
    }, {
      now: () => new Date(now), monotonicClock: () => monotonicMs,
      clockDomainId: () => 'manager-clock-domain',
      randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    await expect(pendingManager.initialize(initialization))
      .rejects.toMatchObject({ code: 'binding-mismatch' });
    expect(verifyPair).toHaveBeenCalledTimes(2);
    expect((await store.reader().read(authorityRunStoreKey(
      'project:fake', 'run:pending-initialization'
    ))).status).toBe('missing');
    for (const providerOverride of [
      { attestationProvider: null },
      { attestationProvider: {} },
      { attestationProvider: { reservePair } },
      { attestationProvider: { reservePair, verifyReservedPair } },
      { usageMeter: null },
      { usageMeter: {} },
      { usageMeter: { reserve: usageReserve } },
      { usageMeter: { reserve: usageReserve, finalize: usageFinalize } },
      { usageMeter: { reserve: usageReserve, finalize: usageFinalize, commit: usageCommit } }
    ]) {
      expect(() => createRunAuthorityManager({
        ...managerOptions, ...providerOverride
      } as any)).toThrow(/provider is required|usage meter is required/i);
    }
    await expect(pendingManager.initialize(initialization))
      .rejects.toMatchObject({ code: 'binding-mismatch' });
    expect(verifyPair).toHaveBeenCalledTimes(2);
    const hugeCompiled = compilePlanGraph({
      ...planInput,
      planKey: 'manager-huge-deadline',
      budgets: { wallTimeMinutesRun: Number.MAX_SAFE_INTEGER }
    });
    const hugeBinding: AttestationChallengeParams = {
      ...binding,
      planDigest: hugeCompiled.plan.digest as AttestationChallengeParams['planDigest'],
      graphDigest: hugeCompiled.graph.digest as AttestationChallengeParams['graphDigest']
    };
    const hugeApprovalChallenge = await controlPlane.attestation.beginChallenge(hugeBinding);
    const hugeApproval = await controlPlane.attestation.recordApproval(hugeApprovalChallenge.challengeId, 'approved');
    const hugeModeChallenge = await controlPlane.attestation.beginChallenge(hugeBinding);
    const hugeMode = await controlPlane.attestation.recordModeSelection(hugeModeChallenge.challengeId, 'autonomous');
    const hugeReserveCalls = reservePair.mock.calls.length;
    const hugeManager = createRunAuthorityManagerForTest({
      ...managerOptions, runId: 'run:huge-deadline', compiled: hugeCompiled
    }, {
      now: () => new Date(now), monotonicClock: () => monotonicMs,
      clockDomainId: () => 'manager-clock-domain', randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    await expect(hugeManager.initialize({
      idempotencyKey: 'manager-huge-deadline-0001', approval: hugeApproval, modeSelection: hugeMode
    })).rejects.toMatchObject({ code: 'invalid-input' });
    expect(reservePair).toHaveBeenCalledTimes(hugeReserveCalls);
    expect((await store.reader().read(authorityRunStoreKey(
      'project:fake', 'run:huge-deadline'
    ))).status).toBe('missing');

    const expiringApprovalChallenge = await controlPlane.attestation.beginChallenge(binding);
    const expiringApproval = await controlPlane.attestation.recordApproval(
      expiringApprovalChallenge.challengeId, 'approved'
    );
    const expiringModeChallenge = await controlPlane.attestation.beginChallenge(binding);
    const expiringMode = await controlPlane.attestation.recordModeSelection(
      expiringModeChallenge.challengeId, 'autonomous'
    );
    const expiringManager = createRunAuthorityManagerForTest({
      ...managerOptions,
      runId: 'run:expiring-attestation',
      attestationProvider: {
        ...attestationProvider,
        reservePair: async request => {
          const reservation = await reservePair(request);
          now.setTime(Date.parse(reservation.expiresAt));
          return reservation;
        }
      }
    }, {
      now: () => new Date(now), monotonicClock: () => monotonicMs,
      clockDomainId: () => 'manager-clock-domain', randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    await expect(expiringManager.initialize({
      idempotencyKey: 'manager-expiring-attestation-0001',
      approval: expiringApproval,
      modeSelection: expiringMode
    })).rejects.toMatchObject({ code: 'binding-mismatch' });
    expect((await store.reader().read(authorityRunStoreKey(
      'project:fake', 'run:expiring-attestation'
    ))).status).toBe('missing');
    now.setTime(Date.parse('2026-09-12T00:00:00.000Z'));

    const mismatchedApprovalChallenge = await controlPlane.attestation.beginChallenge(binding);
    const mismatchedApproval = await controlPlane.attestation.recordApproval(
      mismatchedApprovalChallenge.challengeId, 'approved'
    );
    const mismatchedModeChallenge = await controlPlane.attestation.beginChallenge(binding);
    const mismatchedMode = await controlPlane.attestation.recordModeSelection(
      mismatchedModeChallenge.challengeId, 'autonomous'
    );
    const mismatchedManager = createRunAuthorityManagerForTest({
      ...managerOptions,
      runId: 'run:mismatched-attestation',
      attestationProvider: {
        ...attestationProvider,
        verifyReservedPair: async reservationId => ({
          ...await verifyReservedPair(reservationId),
          initializationRequestDigest: `sha256:${'0'.repeat(64)}`
        })
      }
    }, {
      now: () => new Date(now), monotonicClock: () => monotonicMs,
      clockDomainId: () => 'manager-clock-domain', randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    await expect(mismatchedManager.initialize({
      idempotencyKey: 'manager-mismatched-attestation-0001',
      approval: mismatchedApproval,
      modeSelection: mismatchedMode
    })).rejects.toMatchObject({ code: 'initialization-recovery-required' });
    const mismatchedAggregate = await store.reader().read<any>(authorityRunStoreKey(
      'project:fake', 'run:mismatched-attestation'
    ));
    expect(mismatchedAggregate.status).toBe('active');
    if (mismatchedAggregate.status === 'active') {
      expect(mismatchedAggregate.record.value.stateKind).toBe('initialization-pending');
    }
    const ownerHost = currentHost;
    currentHost = { ...ownerHost!, sessionRef: 'host-session:other' };
    await expect(manager.acquireControllerLease()).rejects.toMatchObject({ code: 'host-identity-mismatch' });
    currentHost = ownerHost;
    loseLeaseAck = true;
    const lease = await manager.acquireControllerLease();
    await expect(manager.acquireControllerLease()).rejects.toMatchObject({ code: 'lease-held' });
    const beforeIncompleteCharge = await manager.read();
    await expect(manager.issueExecutionTicket({
      operationId: 'manager-issue-incomplete-charge', controllerProof: controllerProof(lease),
      ticket: {
        nodeId: 'workstream-4-core-3-api', scope: 'api', roots: ['src/api/**'],
        budgets: { tokensGlobal: 1, tokensEo: 1 },
        expiresAt: '2026-09-12T00:10:00.000Z', maxChildDepth: 0, maxFanout: 1
      }
    })).rejects.toMatchObject({ code: 'invalid-input' });
    expect((await manager.read()).generation).toBe(beforeIncompleteCharge.generation);
    const beforeIssue = await manager.read();
    const executionIssue = {
      operationId: 'manager-issue-execution-0001',
      controllerProof: controllerProof(lease),
      ticket: {
        nodeId: 'workstream-4-core-3-api', scope: 'api', roots: ['src/api/**'],
        approvalRefs: [approval.verificationRef],
        budgets: EXECUTION_BUDGETS,
        expiresAt: '2026-09-12T00:30:00.000Z', maxChildDepth: 1, maxFanout: 1
      }
    };
    loseUsageIntentAck = true;
    loseUsageFinalizeAck = true;
    let releaseUsageReserve!: () => void;
    let markUsageReserveStarted!: () => void;
    const usageReserveHasStarted = new Promise<void>(resolve => { markUsageReserveStarted = resolve; });
    usageReserveStarted = markUsageReserveStarted;
    usageReserveGate = new Promise<void>(resolve => { releaseUsageReserve = resolve; });
    const pendingExecutionIssue = manager.issueExecutionTicket(executionIssue);
    await usageReserveHasStarted;
    await expect(manager.acquireControllerLease()).rejects.toMatchObject({ code: 'lease-held' });
    now.setTime(now.getTime() + 20_000);
    monotonicMs += 20_000;
    await expect(manager.heartbeatControllerLease(controllerProof(lease))).resolves.toHaveProperty(
      'leaseRef', lease.leaseRef
    );
    now.setTime(now.getTime() + 20_000);
    monotonicMs += 20_000;
    await expect(manager.heartbeatControllerLease(controllerProof(lease))).resolves.toHaveProperty(
      'leaseRef', lease.leaseRef
    );
    await expect(manager.issueExecutionTicket({
      ...executionIssue, operationId: 'manager-conflicting-pending-issue'
    })).rejects.toMatchObject({ code: 'reservation-conflict' });
    releaseUsageReserve();
    const issued = await pendingExecutionIssue;
    usageReserveGate = null;
    usageReserveStarted = null;
    const [repeatedIssue, racingIssue] = await Promise.all([
      manager.issueExecutionTicket(executionIssue), racingManager.issueExecutionTicket(executionIssue)
    ]);
    expect(repeatedIssue).toEqual(issued);
    expect(racingIssue).toEqual(issued);
    expect(issued.handle).toMatch(/^opaque-ticket:/);
    const persisted = await manager.read();
    expect(persisted.generation).toBe(beforeIssue.generation + 5);
    expect(persisted.ticketCount).toBe(1);
    expect(persisted.reservationCount).toBe(1);
    expect(usageReservations.size).toBe(1);
    const firstUsageRequest = usageReserve.mock.calls[0][0];
    expect(firstUsageRequest.idempotencyKey).toBe(
      `ticket-usage:project:fake:run:manager:manager-issue-execution-0001:${firstUsageRequest.scope.ticketRequestDigest}`
    );
    expect(await manager.issueExecutionTicket(executionIssue)).toEqual(issued);
    expect((await manager.read()).generation).toBe(persisted.generation);
    const aggregate = await store.reader().read<any>(authorityRunStoreKey('project:fake', 'run:manager'));
    expect(aggregate.status).toBe('active');
    if (aggregate.status !== 'active') throw new Error('Expected active authority aggregate');
    expect(aggregate.record.value.budgets.reservations).toEqual([
      expect.objectContaining({
        ticketHandleId: issued.handle, status: 'pending', role: 'EXECUTION'
      })
    ]);
    await expect(manager.issueExecutionTicket({
      operationId: 'manager-issue-execution-0001',
      controllerProof: controllerProof(lease),
      ticket: {
        nodeId: 'workstream-4-core-3-api', scope: 'api', roots: ['src/api/**'],
        approvalRefs: [approval.verificationRef],
        budgets: { ...EXECUTION_BUDGETS, tokensGlobal: 25 },
        expiresAt: '2026-09-12T00:30:00.000Z', maxChildDepth: 1, maxFanout: 1
      }
    })).rejects.toMatchObject({ code: 'reservation-conflict' });
    expect((await manager.read()).ticketCount).toBe(1);

    await expect(manager.claimExecutionAndAcquireWorkstream({
      handle: issued.handle, controllerProof: controllerProof(lease), unexpected: true
    } as any)).rejects.toMatchObject({ code: 'invalid-input' });
    loseClaimAck = true;
    const claims = await Promise.allSettled([
      manager.claimExecutionAndAcquireWorkstream({
        handle: issued.handle, controllerProof: controllerProof(lease)
      }),
      racingManager.claimExecutionAndAcquireWorkstream({
        handle: issued.handle, controllerProof: controllerProof(lease)
      })
    ]);
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter(result => result.status === 'rejected').every(result =>
      result.reason?.code !== 'commit-unknown')).toBe(true);
    const workstream = claims.find(result => result.status === 'fulfilled')!.value;
    await expect(manager.heartbeatWorkstreamLease(null as any))
      .rejects.toMatchObject({ code: 'invalid-input' });
    const proofGetter = jest.fn(() => workstreamProof(workstream));
    const hostileHeartbeat = Object.defineProperty({ nodeId: workstream.nodeId }, 'proof', {
      enumerable: true, get: proofGetter
    });
    await expect(manager.heartbeatWorkstreamLease(hostileHeartbeat as any)).rejects.toThrow(/accessor/i);
    expect(proofGetter).not.toHaveBeenCalled();
    const leaf = await manager.issueLeafTicket({
      operationId: 'manager-issue-leaf-0001', workstreamProof: workstreamProof(workstream),
      ticket: {
        parentHandle: issued.handle, nodeId: 'leaf-4-core-3-api-7-handler', scope: 'handler',
        roots: ['src/api/handler.ts'], approvalRefs: [approval.verificationRef],
        budgets: LEAF_BUDGETS,
        expiresAt: '2026-09-12T00:10:00.000Z', maxChildDepth: 0, maxFanout: 1
      }
    });
    expect(await manager.inspectTicket(leaf.handle)).toEqual({
      authority: false, ticketHandleId: leaf.handle, role: 'LEAF',
      expiresAt: '2026-09-12T00:10:00.000Z'
    });
    const afterLeaf = await store.reader().read<any>(authorityRunStoreKey('project:fake', 'run:manager'));
    if (afterLeaf.status !== 'active') throw new Error('Expected active aggregate');
    const leafReservation = afterLeaf.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === leaf.handle
    );
    await manager.reconcileUsage(leafReservation.reservationId);
    const leafProviderUsage = afterLeaf.record.value.providerUsage.find(
      (item: any) => item.reservationId === leafReservation.reservationId
    );
    expect(usageSample).toHaveBeenCalledWith(leafProviderUsage.opaqueScope);
    const afterLeafReconcile = await manager.read();
    await manager.reconcileUsage(leafReservation.reservationId);
    expect((await manager.read()).generation).toBe(afterLeafReconcile.generation);
    expect(usageFinalize).toHaveBeenCalledTimes(1);
    expect(usageCommit).toHaveBeenCalledTimes(1);
    const rootReservation = afterLeaf.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === issued.handle
    );
    await manager.reconcileUsage(rootReservation.reservationId);
    await expect(manager.releaseReservation(rootReservation.reservationId))
      .rejects.toMatchObject({ code: 'reservation-conflict' });
    expect(await manager.revokeTicket(issued.handle)).toBe(true);
    await expect(manager.inspectTicket(leaf.handle)).rejects.toMatchObject({ code: 'inactive-ticket' });
    await expect(manager.heartbeatWorkstreamLease({
      nodeId: workstream.nodeId, proof: workstreamProof(workstream)
    })).rejects.toMatchObject({ code: 'inactive-lease' });

    const releasable = await manager.issueExecutionTicket({
      operationId: 'manager-issue-execution-0002', controllerProof: controllerProof(lease),
      ticket: {
        nodeId: 'workstream-4-core-3-api', scope: 'releasable', roots: ['src/api/**'],
        budgets: {
          toolActionsGlobal: 1, toolActionsEo: 1,
          tokensGlobal: 1, tokensEo: 1,
          costUsdGlobal: 0.1, costUsdEo: 0.1
        },
        expiresAt: '2026-09-12T00:10:00.000Z', maxChildDepth: 1, maxFanout: 1
      }
    });
    const beforeRelease = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (beforeRelease.status !== 'active') throw new Error('Expected active aggregate');
    const releasableReservation = beforeRelease.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === releasable.handle
    );
    loseProviderReleaseStageAck = true;
    loseProviderReleaseFinalizeAck = true;
    await manager.releaseReservation(releasableReservation.reservationId);
    const afterRelease = await manager.read();
    await manager.releaseReservation(releasableReservation.reservationId);
    expect((await manager.read()).generation).toBe(afterRelease.generation);
    await expect(manager.inspectTicket(releasable.handle)).rejects.toMatchObject({ code: 'inactive-ticket' });
    expect(usageRelease).toHaveBeenCalledWith(
      expect.stringContaining('manager-issue-execution-0002'),
      `ticket-usage-release:project:fake:run:manager:${releasableReservation.reservationId}`
    );

    const recoverableIssue = {
      ...executionIssue,
      operationId: 'manager-recover-pending-issue',
      ticket: { ...executionIssue.ticket, scope: 'recoverable' }
    };
    usageReserve.mockImplementationOnce(async () => { throw new Error('provider temporarily unavailable'); });
    await expect(manager.issueExecutionTicket(recoverableIssue))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    const beforeRecovery = await manager.read();
    const pendingRecoveryAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (pendingRecoveryAggregate.status !== 'active') throw new Error('Expected active aggregate');
    expect(pendingRecoveryAggregate.record.value.pendingIssuance).toMatchObject({
      operationId: recoverableIssue.operationId, status: 'intent'
    });
    const recoveredIssue = await manager.recoverPendingIssuance();
    expect(recoveredIssue?.handle).toMatch(/^opaque-ticket:/);
    expect((await manager.read()).ticketCount).toBe(beforeRecovery.ticketCount + 1);
    const recoveredAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (recoveredAggregate.status !== 'active') throw new Error('Expected active aggregate');
    const recoveredReservation = recoveredAggregate.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === recoveredIssue!.handle
    );
    loseProviderReleaseStageAck = true;
    loseProviderReleaseFinalizeAck = true;
    expect(await manager.revokeTicket(recoveredIssue!.handle)).toBe(true);
    expect(usageRelease).toHaveBeenCalledWith(
      expect.stringContaining('manager-recover-pending-issue'),
      `ticket-usage-release:project:fake:run:manager:${recoveredReservation.reservationId}`
    );

    const abortableIssue = {
      ...executionIssue,
      operationId: 'manager-abort-pending-issue',
      ticket: { ...executionIssue.ticket, scope: 'abortable' }
    };
    usageReserve.mockImplementationOnce(async () => { throw new Error('provider temporarily unavailable'); });
    await expect(manager.issueExecutionTicket(abortableIssue))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    const beforeAbort = await manager.read();
    expect(beforeAbort.unsettledUsage).toEqual([{
      pendingOperationId: abortableIssue.operationId,
      idempotencyKey: expect.stringContaining(
        `ticket-usage:project:fake:run:manager:${abortableIssue.operationId}:`
      ),
      reason: 'pending-issuance-unresolved',
      recovery: 'abortPendingIssuance'
    }]);
    usageRelease.mockRejectedValueOnce(new Error('provider release temporarily unavailable'));
    await expect(manager.abortPendingIssuance())
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    expect(await manager.abortPendingIssuance()).toBe(true);
    expect(await manager.abortPendingIssuance()).toBe(false);
    expect((await manager.read()).ticketCount).toBe(beforeAbort.ticketCount);
    const retriedAfterAbort = await manager.issueExecutionTicket(abortableIssue);
    expect(retriedAfterAbort.handle).toMatch(/^opaque-ticket:/);
    expect(await manager.revokeTicket(retriedAfterAbort.handle)).toBe(true);
    await expect(manager.issueExecutionTicket({
      ...abortableIssue, ticket: { ...abortableIssue.ticket, scope: 'conflicting-after-abort' }
    })).rejects.toMatchObject({ code: 'reservation-conflict' });

    const conflictIssue = {
      ...executionIssue,
      operationId: 'manager-bind-conflict-issue',
      ticket: { ...executionIssue.ticket, scope: 'bind-conflict' }
    };
    usageReserve.mockImplementationOnce(async () => { throw new Error('provider temporarily unavailable'); });
    await expect(manager.issueExecutionTicket(conflictIssue))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    for (const alt of ['alt-1', 'alt-2']) {
      usageReserve.mockImplementationOnce(async (request: any) => {
        const reservation = {
          providerReservationId: `provider-usage-${alt}:${request.idempotencyKey}`,
          idempotencyKey: request.idempotencyKey,
          opaqueScope: request.scope.opaqueScope
        };
        usageReservations.set(`${request.idempotencyKey}:${alt}`, reservation);
        usageReservationStartedAt.set(reservation.providerReservationId, now.toISOString());
        return reservation;
      });
    }
    const bindingRace = await Promise.allSettled([
      manager.recoverPendingIssuance(),
      racingManager.recoverPendingIssuance()
    ]);
    const bindingFulfilled = bindingRace.filter(result => result.status === 'fulfilled');
    const bindingRejected = bindingRace.filter(result => result.status === 'rejected');
    expect(bindingFulfilled.length).toBeGreaterThanOrEqual(1);
    const bindingHandles = bindingFulfilled.map(result =>
      (result as PromiseFulfilledResult<any>).value.handle);
    expect(new Set(bindingHandles).size).toBe(1);
    for (const rejected of bindingRejected) {
      expect((rejected as PromiseRejectedResult).reason)
        .toMatchObject({ code: 'reservation-conflict' });
    }
    expect(usageRelease).toHaveBeenCalledWith(
      expect.stringContaining('provider-usage-alt-'),
      expect.stringContaining('ticket-usage-release:project:fake:run:manager:')
    );
    expect(usageRelease.mock.calls.filter(call =>
      String(call[0]).includes('provider-usage-alt-'))).toHaveLength(1);
    const conflictWinnerHandle = bindingHandles[0];
    expect(await manager.recoverPendingIssuance()).toBeNull();
    expect(await manager.issueExecutionTicket(conflictIssue))
      .toEqual({ handle: conflictWinnerHandle });

    const unboundIssue = {
      ...executionIssue,
      operationId: 'manager-unbound-bind-loss',
      ticket: { ...executionIssue.ticket, scope: 'unbound-bind-loss' }
    };
    const reserveCallsBefore = usageReserve.mock.calls.length;
    loseBindAckBeforeCommit = true;
    loseUnboundClearAck = true;
    await expect(manager.issueExecutionTicket(unboundIssue))
      .rejects.toMatchObject({ code: 'commit-unknown' });
    const unboundAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (unboundAggregate.status !== 'active') throw new Error('Expected active aggregate');
    expect(unboundAggregate.record.value.pendingIssuance).toMatchObject({
      operationId: unboundIssue.operationId,
      status: 'release-pending-unbound',
      providerReservation: expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          `ticket-usage:project:fake:run:manager:${unboundIssue.operationId}:`
        )
      })
    });
    expect(usageReserve.mock.calls.length).toBe(reserveCallsBefore + 1);
    expect(await manager.abortPendingIssuance()).toBe(true);
    expect(usageReserve.mock.calls.length).toBe(reserveCallsBefore + 1);
    expect(usageRelease).toHaveBeenCalledWith(
      expect.stringContaining('manager-unbound-bind-loss'),
      expect.stringContaining('ticket-usage-release:project:fake:run:manager:')
    );
    expect((await manager.read()).unsettledUsage).toEqual([]);
    const recoveredUnbound = await manager.issueExecutionTicket(unboundIssue);
    expect(recoveredUnbound.handle).toMatch(/^opaque-ticket:/);
    expect(await manager.revokeTicket(recoveredUnbound.handle)).toBe(true);

    const interleavedIssue = {
      ...executionIssue,
      operationId: 'manager-interleaved-finalize',
      ticket: { ...executionIssue.ticket, scope: 'interleaved-finalize' }
    };
    loseBindAckBeforeCommit = true;
    runConcurrentFinalizeOnOrphanStage = true;
    concurrentIssueInput = interleavedIssue;
    const interleavedHandle = await manager.issueExecutionTicket(interleavedIssue);
    expect(concurrentIssueResult?.handle).toMatch(/^opaque-ticket:/);
    expect(interleavedHandle).toEqual({ handle: concurrentIssueResult.handle });
    expect(usageRelease.mock.calls.filter(call =>
      String(call[0]).includes('manager-interleaved-finalize'))).toHaveLength(0);
    const interleavedAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (interleavedAggregate.status !== 'active') throw new Error('Expected active aggregate');
    const interleavedReservation = interleavedAggregate.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === interleavedHandle.handle
    );
    await expect(manager.reconcileUsage(interleavedReservation.reservationId)).resolves.toBeDefined();
    expect((await manager.read()).unsettledUsage).toEqual([]);

    const inFlightIssue = {
      ...executionIssue,
      operationId: 'manager-inflight-bind',
      ticket: { ...executionIssue.ticket, scope: 'inflight-bind' }
    };
    inFlightOpId = inFlightIssue.operationId;
    let releaseBFinalize!: () => void;
    bFinalizeGateToAwait = new Promise<void>(resolve => { releaseBFinalize = resolve; });
    loseBindAckBeforeCommit = true;
    runConcurrentBindOnOrphanStage = true;
    concurrentIssueInput = inFlightIssue;
    const aOutcome = await manager.issueExecutionTicket(inFlightIssue).catch(error => error);
    expect(aOutcome).toMatchObject({ code: 'commit-unknown' });
    expect(usageRelease.mock.calls.filter(call =>
      String(call[0]).includes('manager-inflight-bind'))).toHaveLength(0);
    const inFlightAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (inFlightAggregate.status !== 'active') throw new Error('Expected active aggregate');
    expect(inFlightAggregate.record.value.pendingIssuance).toMatchObject({
      operationId: inFlightIssue.operationId, status: 'provider-reserved'
    });
    releaseBFinalize();
    const bHandle = await concurrentIssueResult;
    expect(bHandle.handle).toMatch(/^opaque-ticket:/);
    expect((await manager.read()).unsettledUsage).toEqual([]);
    expect(await manager.issueExecutionTicket(inFlightIssue)).toEqual({ handle: bHandle.handle });
    inFlightOpId = null;

    await manager.recordRetry({
      operationId: 'retry-api-1', nodeId: 'workstream-4-core-3-api', leaseProof: controllerProof(lease)
    });
    await expect(manager.recordRetry({
      operationId: 'retry-api-2', nodeId: 'workstream-4-core-3-api', leaseProof: controllerProof(lease)
    })).rejects.toMatchObject({ code: 'budget-exceeded' });
    await manager.recordLocalFix({
      operationId: 'fix-api-1', nodeId: 'workstream-4-core-3-api', leaseProof: controllerProof(lease)
    });
    await manager.recordLocalFix({
      operationId: 'fix-api-2', nodeId: 'workstream-4-core-3-api', leaseProof: controllerProof(lease)
    });
    await expect(manager.recordLocalFix({
      operationId: 'fix-api-3', nodeId: 'workstream-4-core-3-api', leaseProof: controllerProof(lease)
    })).rejects.toMatchObject({ code: 'budget-exceeded' });
    await manager.recordReplacement({
      operationId: 'replace-api-1', nodeId: 'workstream-4-core-3-api', leaseProof: controllerProof(lease)
    });
    await manager.recordResume({
      operationId: 'resume-api-1', nodeId: 'workstream-4-core-3-api', leaseProof: controllerProof(lease)
    });
    expect((await manager.read()).cumulative).toEqual(expect.objectContaining({
      retries: 1, localFixes: 2, replacements: 1, resumes: 1
    }));
    const beforeWrongRoleCounter = await manager.read();
    await expect(manager.recordRetry({
      operationId: 'leaf-retry-with-controller-proof',
      nodeId: 'leaf-4-core-3-api-7-handler',
      leaseProof: controllerProof(lease)
    })).rejects.toMatchObject({ code: 'lease-required' });
    expect((await manager.read()).generation).toBe(beforeWrongRoleCounter.generation);

    const semanticallyValid = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (semanticallyValid.status !== 'active') throw new Error('Expected active aggregate');
    const base = semanticallyValid.record.value;
    const corruptions = [
      (value: any) => { value.approvedPlanDigest = `sha256:${'0'.repeat(64)}`; },
      (value: any) => { value.ticketState.tickets[1].parentTicketHandleId = 'missing-parent'; },
      (value: any) => { value.budgets.reservations[1].parentTicketHandleId = 'missing-parent'; },
      (value: any) => { value.fanoutCounters[0].issuedChildren += 1; },
      (value: any) => { value.totalDescendants += 1; },
      (value: any) => {
        value.leaseState.workstreamLeases[0].lifecycle = 'active';
        value.leaseState.workstreamLeases[0].releasedAt = null;
        value.leaseState.workstreamLeases[0].controllerFence += 1;
      },
      (value: any) => { value.ticketDeadlines[1].hardDeadlineAt = value.runDeadlineAt; },
      (value: any) => { value.ticketState.tickets[1].roots = ['src/**']; },
      (value: any) => { value.usageBinding.model = 'other-model'; },
      (value: any) => { value.ticketState.rootAuthority.operationClasses = ['forged']; },
      (value: any) => { value.providerUsage.pop(); },
      (value: any) => { value.providerUsage[0].opaqueScope = value.providerUsage[1].opaqueScope; },
      (value: any) => { value.leaseState.workstreamLeases[0].ticketHandleId = 'other-ticket'; }
    ];
    for (const corrupt of corruptions) {
      const changed = JSON.parse(JSON.stringify(base));
      corrupt(changed);
      expect(() => parseRunAuthorityState(changed, compiled, {
        runId: 'run:manager', projectId: 'project:fake', usageBinding: managerOptions.usageBinding
      })).toThrow(TicketAuthorityError);
    }

    now.setTime(now.getTime() + 30_000);
    monotonicMs += 30_000;
    const replacementController = await manager.acquireControllerLease();
    const beforeStaleCounter = await manager.read();
    await expect(manager.recordRetry({
      operationId: 'retry-with-stale-controller',
      nodeId: 'workstream-4-core-3-api',
      leaseProof: controllerProof(lease)
    })).rejects.toMatchObject({ code: 'stale-lease' });
    expect((await manager.read()).generation).toBe(beforeStaleCounter.generation);

    const hungIssue = await manager.issueExecutionTicket({
      ...executionIssue,
      operationId: 'manager-hung-settlement',
      controllerProof: controllerProof(replacementController),
      ticket: { ...executionIssue.ticket, scope: 'hung-settlement' }
    });
    const hungWorkstream = await manager.claimExecutionAndAcquireWorkstream({
      handle: hungIssue.handle,
      controllerProof: controllerProof(replacementController)
    });

    now.setTime(now.getTime() + 10_000);
    monotonicMs += 10_000;
    const workstreamHeartbeat = await manager.heartbeatWorkstreamLease({
      nodeId: hungWorkstream.nodeId, proof: workstreamProof(hungWorkstream)
    });
    now.setTime(now.getTime() + 1_000);
    monotonicMs += 1_000;
    const releasedWorkstream = await manager.releaseWorkstreamLease({
      nodeId: hungWorkstream.nodeId, proof: workstreamProof(workstreamHeartbeat)
    });
    expect(releasedWorkstream.lifecycle).toBe('released');
    const controllerHeartbeat = await manager.heartbeatControllerLease(
      controllerProof(replacementController)
    );
    now.setTime(now.getTime() + 1_000);
    monotonicMs += 1_000;
    const releasedController = await manager.releaseControllerLease(
      controllerProof(controllerHeartbeat)
    );
    expect(releasedController.lifecycle).toBe('released');
    const settlementController = await manager.acquireControllerLease();

    const commitPendingIssue = await manager.issueExecutionTicket({
      ...executionIssue,
      operationId: 'manager-commit-pending-settlement',
      controllerProof: controllerProof(settlementController),
      ticket: { ...executionIssue.ticket, scope: 'commit-pending-settlement' }
    });
    const commitPendingWorkstream = await manager.claimExecutionAndAcquireWorkstream({
      handle: commitPendingIssue.handle,
      controllerProof: controllerProof(settlementController)
    });
    let preCancelAggregateForCommit = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (preCancelAggregateForCommit.status !== 'active') throw new Error('Expected active aggregate');
    const commitPendingReservation = preCancelAggregateForCommit.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === commitPendingIssue.handle
    );
    usageCommit.mockImplementationOnce(async () => {
      throw new Error('provider commit acknowledgement lost');
    });
    await expect(manager.reconcileUsage(commitPendingReservation.reservationId))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    const commitPendingAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (commitPendingAggregate.status !== 'active') throw new Error('Expected active aggregate');
    expect(commitPendingAggregate.record.value.providerUsage.find(
      (item: any) => item.reservationId === commitPendingReservation.reservationId
    )).toMatchObject({ status: 'commit-pending' });
    await manager.releaseWorkstreamLease({
      nodeId: commitPendingWorkstream.nodeId,
      proof: workstreamProof(commitPendingWorkstream)
    });

    const accountingIssue = await manager.issueExecutionTicket({
      ...executionIssue,
      operationId: 'manager-account-after-cancel',
      controllerProof: controllerProof(settlementController),
      ticket: { ...executionIssue.ticket, scope: 'account-after-cancel' }
    });
    const cancellationReleaseIssue = await manager.issueExecutionTicket({
      ...executionIssue,
      operationId: 'manager-release-on-cancel',
      controllerProof: controllerProof(settlementController),
      ticket: { ...executionIssue.ticket, scope: 'release-on-cancel' }
    });
    redirectClaimToHandle = cancellationReleaseIssue.handle;
    await expect(manager.claimExecutionAndAcquireWorkstream({
      handle: accountingIssue.handle,
      controllerProof: controllerProof(settlementController)
    })).rejects.toMatchObject({ code: 'commit-unknown' });
    const preCancelAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (preCancelAggregate.status !== 'active') throw new Error('Expected active aggregate');
    const accountingReservation = preCancelAggregate.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === cancellationReleaseIssue.handle
    );
    const cancellationReleaseReservation = preCancelAggregate.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === accountingIssue.handle
    );
    const hungReservation = preCancelAggregate.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === hungIssue.handle
    );

    const defaultFinalize = usageFinalize.getMockImplementation()!;
    usageFinalize.mockImplementation(async (providerReservationId: string) =>
      providerReservationId.includes('manager-hung-settlement')
        ? new Promise<any>(() => {})
        : defaultFinalize(providerReservationId));
    let hungReleaseFails = true;
    usageRelease.mockImplementation(async (providerReservationId: string) => {
      if (hungReleaseFails && providerReservationId.includes('manager-hung-settlement')) {
        hungReleaseFails = false;
        throw new Error('provider release temporarily unavailable');
      }
    });

    const beforeCancel = await manager.read();
    currentHost = { ...ownerHost!, sessionRef: 'host-session:replacement-operator' };
    loseProviderReleaseStageAck = true;
    loseProviderReleaseFinalizeAck = true;
    const cancelled = await manager.cancel();
    expect(cancelled.lifecycle).toBe('cancelled');
    expect(cancelled.cancellationGeneration).toBe(1);
    expect(cancelled.generation).toBe(beforeCancel.generation + 8);
    expect(cancelled.unsettledUsage).toEqual([
      { reservationId: hungReservation.reservationId, reason: 'provider-release-pending' }
    ]);
    const settled = await manager.cancel();
    expect(settled.unsettledUsage).toEqual([]);
    expect(settled.generation).toBe(cancelled.generation + 1);
    expect((await manager.cancel()).generation).toBe(settled.generation);
    expect(usageRelease).toHaveBeenCalledWith(
      expect.stringContaining('manager-account-after-cancel'),
      `ticket-usage-release:project:fake:run:manager:${cancellationReleaseReservation.reservationId}`
    );
    expect(usageRelease).toHaveBeenCalledWith(
      expect.stringContaining('manager-hung-settlement'),
      `ticket-usage-release:project:fake:run:manager:${hungReservation.reservationId}`
    );
    expect(usageCommit).toHaveBeenCalledWith(
      expect.stringContaining('manager-commit-pending-settlement'),
      expect.stringMatching(/^sha256:/)
    );
    const postCancelAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (postCancelAggregate.status !== 'active') throw new Error('Expected active aggregate');
    expect(postCancelAggregate.record.value.budgets.reservations.find(
      (item: any) => item.reservationId === hungReservation.reservationId
    )).toMatchObject({ status: 'released' });
    expect(postCancelAggregate.record.value.budgets.reservations.find(
      (item: any) => item.reservationId === accountingReservation.reservationId
    )).toMatchObject({ status: 'committed' });
    expect(postCancelAggregate.record.value.providerUsage.find(
      (item: any) => item.reservationId === commitPendingReservation.reservationId
    )).toMatchObject({ status: 'committed' });
    const restartedManager = createRunAuthorityManager(managerOptions);
    await expect(restartedManager.cancel()).resolves.toMatchObject({
      lifecycle: 'cancelled', unsettledUsage: []
    });
    expect((await restartedManager.read()).generation).toBe(settled.generation);
    await expect(restartedManager.releaseReservation(hungReservation.reservationId))
      .resolves.toBeDefined();
    expect((await restartedManager.read()).generation).toBe(settled.generation);
    now.setTime(Date.parse('2026-09-12T02:00:00.000Z'));
    monotonicMs += 2 * 60 * 60 * 1000;
    await expect(manager.reconcileUsage(accountingReservation.reservationId)).resolves.toBeDefined();
    const afterLateAccounting = await manager.read();
    const reopened = createRunAuthorityManager(managerOptions);
    expect(await reopened.read()).toEqual(afterLateAccounting);
    await expect(reopened.acquireControllerLease()).rejects.toMatchObject({ code: 'cancelled' });
    expect((await reopened.read()).generation).toBe(afterLateAccounting.generation);

    const crossProject = createRunAuthorityManager({ ...managerOptions, projectId: 'project:other' });
    await expect(crossProject.read()).rejects.toMatchObject({ code: 'invalid-state' });

    const corrupted = JSON.parse(JSON.stringify((await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    ) as any).record.value));
    corrupted.totalDescendants += 1;
    await writer.compareAndSwap({
      key: authorityRunStoreKey('project:fake', 'run:manager'),
      expectedGeneration: afterLateAccounting.generation,
      value: corrupted
    });
    await expect(reopened.read()).rejects.toMatchObject({ code: 'recovery-required' });
  }, 30_000);
});
