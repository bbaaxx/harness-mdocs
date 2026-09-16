import * as crypto from 'crypto';

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
  runAuthorityReportBackend,
  RunAuthorityManagerOptions
} from '../../src/agents/run/authority/manager';
import * as publicAuthority from '../../src/agents/run/authority';
import { compilePlanGraph } from '../../src/agents/run/compiler';
import {
  AttestationChallengeParams,
  createFakeTrustedControlPlane,
  createRunKillSwitch
} from '../../src/agents/run/trust';
import type { StructuredActionExecutor } from '../../src/agents/run/trust/mediator';
import { deriveOperationMetadataBindings } from '../../src/agents/run/evidence';
import { createRunAuthorityActionVerifier } from '../../src/agents/run/authority/action-verifier-internal';
import { createActionMediator } from '../../src/agents/run/trust/mediator-internal';
import { computeAuthorityUsageSampleDigest } from '../../src/agents/run/authority/usage-accounting';
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
      policy: { authority: { operationClasses: ['agent.spawn', 'process.exec'] } }, budgets: {
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
    let loseLeafClaimAck = false;
    let loseUsageIntentAck = false;
    let loseUsageFinalizeAck = false;
    let loseFinalizeClaimAck = false;
    let loseSampleIntentAck = false;
    let loseUsageAccountingAck = false;
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
        if (loseFinalizeClaimAck && (committedInput.value as any).providerUsage?.some(
          (item: any) => item.status === 'finalize-claimed')) {
          loseFinalizeClaimAck = false;
          throw new IndeterminateStoreCommitError('lost finalization claim acknowledgement');
        }
        if (loseSampleIntentAck && (committedInput.value as any).providerUsage?.some(
          (item: any) => item.status === 'commit-pending')) {
          loseSampleIntentAck = false;
          throw new IndeterminateStoreCommitError('lost final usage intent acknowledgement');
        }
        if (loseUsageAccountingAck && (committedInput.value as any).providerUsage?.some(
          (item: any) => item.status === 'committed')) {
          loseUsageAccountingAck = false;
          throw new IndeterminateStoreCommitError('lost committed usage acknowledgement');
        }
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
        if (loseLeafClaimAck && (committedInput.value as any).ticketState?.tickets?.some(
            (item: any) => item.ticket.recipientRole === 'LEAF' && item.nonceStatus === 'claimed')) {
          loseLeafClaimAck = false;
          throw new IndeterminateStoreCommitError('lost leaf effect claim acknowledgement');
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
    let manager = createRunAuthorityManagerForTest(managerOptions, {
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
      operationClasses: ['agent.spawn', 'process.exec'], toolClasses: [], credentialClasses: [],
      approvalRefs: [approval.verificationRef, modeSelection.verificationRef].sort(),
      budgets: compiled.plan.payload.budgets,
      expiresAt: '2026-09-12T01:00:00.000Z',
      maxChildDepth: 2,
      maxFanout: compiled.plan.payload.budgets.maxActiveExecutionOrchestrators
    });
    expect(publicAuthority).not.toHaveProperty('createTicketAuthorityBroker');
    expect(publicAuthority).not.toHaveProperty('runAuthorityReportBackend');
    expect(publicAuthority).not.toHaveProperty('assertRunAuthorityReportBackend');
    expect(publicAuthority).not.toHaveProperty('computeRunAuthoritySettlementConstraintDigest');
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
        operationClasses: ['agent.spawn', 'process.exec'],
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
    const rootNode = compiled.graph.payload.nodes.find(node => node.ownerRole === 'PLAN_ROOT' &&
      compiled.graph.payload.edges.some(edge => edge.fromNodeId === node.nodeId &&
        edge.toNodeId === 'workstream-4-core-3-api'));
    if (!rootNode) throw new Error('Expected PLAN_ROOT integration node');
    const spawnExecutor: StructuredActionExecutor = {
      kind: 'manager-test-spawn', operations: ['agent.spawn'], validate: () => true,
      requiredCredentialClasses: () => [],
      execute: jest.fn(async (request, guard) => {
        await guard.assertCurrent();
        return {
          resultClass: 'success' as const, startedAt: now.toISOString(), endedAt: now.toISOString(),
          actualTargets: [], actualResources: [...request.declaredResources],
          inputMetadata: deriveOperationMetadataBindings(request.action),
          resultMetadata: { childTicketRef: request.spawnChildTicketRef },
          workspaceBefore: { scope: [], entries: [] }, workspaceAfter: { scope: [], entries: [] },
          mutations: [], artifactHashes: []
        };
      })
    };
    const spawnMediatorHost = createActionMediator({
      reader: store.reader(), writer: uncertainWriter,
      authority: createRunAuthorityActionVerifier({
        manager,
        approvals: { areCurrent: async refs => refs.includes(approval.verificationRef) }
      }),
      executors: [spawnExecutor],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date(now)
    });
    const ticketsBeforeRootSpawn = (await manager.read()).ticketCount;
    const rootSpawn = await spawnMediatorHost.mediator.authorize(lease.leaseRef, {
      operation: 'agent.spawn', agentRef: 'workstream-4-core-3-api',
      requestDigest: `sha256:${'3'.repeat(64)}`,
      writeSet: [], sideEffectClass: 'none'
    }, {
      actionId: 'manager-root-spawn', idempotencyKey: 'manager-root-spawn-key',
      adapterKind: 'manager-test-spawn', leaseProof: controllerProof(lease),
      nodeId: rootNode.nodeId, targetNodeId: 'workstream-4-core-3-api',
      graphEpoch: persisted.graphEpoch, cancellationGeneration: persisted.cancellationGeneration
    });
    expect(rootSpawn.allowed).toBe(true);
    if (!rootSpawn.allowed) throw new Error('Expected pre-bound root spawn');
    expect(await spawnMediatorHost.mediator.execute(rootSpawn.reservationId)).toMatchObject({
      resultClass: 'success'
    });
    expect(((await spawnMediatorHost.receiptEvidence(rootSpawn.reservationId))?.payload as any)
      ?.childTicketRef).toBe(issued.handle);
    expect((await manager.read()).ticketCount).toBe(ticketsBeforeRootSpawn);
    expect(await spawnMediatorHost.mediator.authorize(lease.leaseRef, {
      operation: 'agent.spawn', agentRef: 'workstream-4-core-3-api',
      requestDigest: `sha256:${'3'.repeat(64)}`,
      writeSet: [], sideEffectClass: 'none'
    }, {
      actionId: 'manager-root-spawn-duplicate', idempotencyKey: 'manager-root-spawn-duplicate-key',
      adapterKind: 'manager-test-spawn', leaseProof: controllerProof(lease),
      nodeId: rootNode.nodeId, targetNodeId: 'workstream-4-core-3-api'
    })).toMatchObject({ allowed: false, code: 'idempotency-conflict' });
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
    let approvalCurrentDuringFinalVerify = true;
    let approvalRaceChecks = 0;
    const approvalRaceVerifier = createRunAuthorityActionVerifier({
      manager,
      approvals: { areCurrent: async refs => {
        expect(refs).toEqual([approval.verificationRef]);
        approvalRaceChecks += 1;
        if (approvalRaceChecks === 1) {
          adapter.testOnlyBeforeNext('snapshot', () => { approvalCurrentDuringFinalVerify = false; });
        }
        return approvalCurrentDuringFinalVerify;
      } }
    });
    expect(await approvalRaceVerifier.verifyAndReserve({
      phase: 'effect', handle: issued.handle,
      actionId: 'manager-final-approval-race', idempotencyKey: 'manager-final-approval-race-key',
      actionDigest: `sha256:${'4'.repeat(64)}`, operation: 'process.exec',
      adapterKind: 'manager-test-process', leaseProof: workstreamProof(workstream)
    })).toMatchObject({ approvalsCurrent: false, approvalRefs: [approval.verificationRef] });
    expect(approvalRaceChecks).toBe(2);
    expect(await spawnMediatorHost.mediator.authorize(lease.leaseRef, {
      operation: 'agent.spawn', agentRef: 'workstream-4-core-3-api',
      requestDigest: `sha256:${'3'.repeat(64)}`,
      writeSet: [], sideEffectClass: 'none'
    }, {
      actionId: 'manager-root-spawn-inactive', idempotencyKey: 'manager-root-spawn-inactive-key',
      adapterKind: 'manager-test-spawn', leaseProof: controllerProof(lease),
      nodeId: rootNode.nodeId, targetNodeId: 'workstream-4-core-3-api'
    })).toMatchObject({ allowed: false, code: 'stale-generation' });
    const actionExecute = jest.fn(async (
      request: Parameters<StructuredActionExecutor['execute']>[0],
      guard: Parameters<StructuredActionExecutor['execute']>[1]
    ) => {
      await guard.assertCurrent();
      return {
        resultClass: 'success' as const, startedAt: now.toISOString(), endedAt: now.toISOString(),
        actualTargets: [], actualResources: [...request.declaredResources],
        inputMetadata: { argvDigest: deriveOperationMetadataBindings(request.action).argvDigest },
        resultMetadata: { durationMs: 0, exitCode: 0 },
        workspaceBefore: { scope: [], entries: [] }, workspaceAfter: { scope: [], entries: [] },
        mutations: [], artifactHashes: []
      };
    });
    const actionExecutor: StructuredActionExecutor = {
      kind: 'manager-test-process', operations: ['process.exec'], validate: () => true,
      requiredCredentialClasses: () => [],
      execute: actionExecute
    };
    const mediatorHost = createActionMediator({
      reader: store.reader(), writer: uncertainWriter,
      authority: createRunAuthorityActionVerifier({
        manager,
        approvals: { areCurrent: async refs => refs.includes(approval.verificationRef) }
      }),
      executors: [actionExecutor],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date(now)
    });
    const usageFinalizeCallsBeforeActions = usageFinalize.mock.calls.length;
    for (const ordinal of [1, 2]) {
      const decision = await mediatorHost.mediator.authorize(issued.handle, {
        operation: 'process.exec', argv: ['manager-test-binary', String(ordinal)],
        writeSet: [], sideEffectClass: 'external'
      }, {
        actionId: `manager-action-${ordinal}`,
        idempotencyKey: `manager-action-key-${ordinal}`,
        adapterKind: 'manager-test-process',
        leaseProof: workstreamProof(workstream),
        graphEpoch: persisted.graphEpoch,
        cancellationGeneration: persisted.cancellationGeneration,
        approvalRefs: [approval.verificationRef]
      });
      expect(decision.allowed).toBe(true);
      if (!decision.allowed) throw new Error('Expected mediated manager action');
      expect(await mediatorHost.mediator.execute(decision.reservationId)).toMatchObject({
        resultClass: 'success', receiptRef: expect.stringMatching(/^receipt:/)
      });
      expect((await mediatorHost.receiptEvidence(decision.reservationId))?.payload as any)
        .toMatchObject({ usageStatus: 'pending' });
    }
    const afterMediatedActions = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (afterMediatedActions.status !== 'active') throw new Error('Expected active authority aggregate');
    const mediatedTicketReservation = afterMediatedActions.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === issued.handle
    );
    expect(mediatedTicketReservation).toMatchObject({ status: 'pending' });
    expect(afterMediatedActions.record.value.providerUsage.find(
      (item: any) => item.reservationId === mediatedTicketReservation.reservationId
    )?.status).toBe('reserved');
    expect(actionExecutor.execute).toHaveBeenCalledTimes(2);
    expect(usageFinalize).toHaveBeenCalledTimes(usageFinalizeCallsBeforeActions);
    const rootReceipts = [];
    for (const ordinal of [1, 2]) {
      const rootDecision = await mediatorHost.mediator.authorize(lease.leaseRef, {
        operation: 'process.exec', argv: ['manager-test-binary', `root-${ordinal}`],
        writeSet: [], sideEffectClass: 'external'
      }, {
        actionId: `manager-root-action-${ordinal}`, idempotencyKey: `manager-root-action-key-${ordinal}`,
        adapterKind: 'manager-test-process', leaseProof: controllerProof(lease),
        nodeId: rootNode.nodeId,
        graphEpoch: persisted.graphEpoch, cancellationGeneration: persisted.cancellationGeneration
      });
      expect(rootDecision.allowed).toBe(true);
      if (!rootDecision.allowed) throw new Error('Expected mediated root action');
      expect(await mediatorHost.mediator.execute(rootDecision.reservationId)).toMatchObject({
        resultClass: 'success', receiptRef: expect.stringMatching(/^receipt:/)
      });
      rootReceipts.push(await mediatorHost.receiptEvidence(rootDecision.reservationId));
    }
    expect(rootReceipts.map(receipt => (receipt?.payload as any)?.usageReservationId))
      .toEqual([rootReceipts[0] && (rootReceipts[0].payload as any).usageReservationId,
        rootReceipts[0] && (rootReceipts[0].payload as any).usageReservationId]);
    expect(rootReceipts[0]?.digest).not.toBe(rootReceipts[1]?.digest);
    expect(rootReceipts[0]?.payload as any).toMatchObject({
      usageStatus: 'pending', usageReservationId: expect.stringMatching(/^root-action-budget:/),
      usageAmounts: { toolActionsGlobal: 300 }
    });
    expect(usageFinalize).toHaveBeenCalledTimes(usageFinalizeCallsBeforeActions);
    await expect(manager.heartbeatWorkstreamLease(null as any))
      .rejects.toMatchObject({ code: 'invalid-input' });
    const proofGetter = jest.fn(() => workstreamProof(workstream));
    const hostileHeartbeat = Object.defineProperty({ nodeId: workstream.nodeId }, 'proof', {
      enumerable: true, get: proofGetter
    });
    await expect(manager.heartbeatWorkstreamLease(hostileHeartbeat as any)).rejects.toThrow(/accessor/i);
    expect(proofGetter).not.toHaveBeenCalled();
    expect(await spawnMediatorHost.mediator.authorize(issued.handle, {
      operation: 'agent.spawn', agentRef: 'leaf-4-core-3-api-7-handler',
      requestDigest: `sha256:${'3'.repeat(64)}`,
      writeSet: [], sideEffectClass: 'none'
    }, {
      actionId: 'manager-eo-spawn-absent', idempotencyKey: 'manager-eo-spawn-absent-key',
      adapterKind: 'manager-test-spawn', leaseProof: workstreamProof(workstream),
      targetNodeId: 'leaf-4-core-3-api-7-handler'
    })).toMatchObject({ allowed: false, code: 'stale-generation' });
    const leaf = await manager.issueLeafTicket({
      operationId: 'manager-issue-leaf-0001', workstreamProof: workstreamProof(workstream),
      ticket: {
        parentHandle: issued.handle, nodeId: 'leaf-4-core-3-api-7-handler', scope: 'handler',
        roots: ['src/api/handler.ts'], operationClasses: ['process.exec'],
        approvalRefs: [approval.verificationRef],
        budgets: LEAF_BUDGETS,
        expiresAt: '2026-09-12T00:01:00.000Z', maxChildDepth: 0, maxFanout: 1
      }
    });
    let approvalMode: 'current' | 'denied' | 'throw' = 'current';
    let executorPolicyCurrent = true;
    const preEffectExecutor: StructuredActionExecutor = {
      ...actionExecutor,
      kind: 'manager-pre-effect-process',
      validate: () => executorPolicyCurrent
    };
    const preEffectHost = createActionMediator({
      reader: store.reader(), writer: uncertainWriter,
      authority: createRunAuthorityActionVerifier({
        manager,
        approvals: { areCurrent: async () => {
          if (approvalMode === 'throw') throw new Error('approval provider unavailable');
          return approvalMode === 'current';
        } }
      }),
      executors: [preEffectExecutor],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date(now)
    });
    for (const [suffix, mode] of [['denied', 'denied'], ['throw', 'throw']] as const) {
      approvalMode = 'current';
      const decision = await preEffectHost.mediator.authorize(leaf.handle, {
        operation: 'process.exec', argv: ['manager-test-binary', suffix],
        writeSet: [], sideEffectClass: 'external'
      }, {
        actionId: `manager-leaf-approval-${suffix}`,
        idempotencyKey: `manager-leaf-approval-${suffix}-key`,
        adapterKind: 'manager-pre-effect-process', leaseProof: workstreamProof(workstream)
      });
      expect(decision.allowed).toBe(true);
      if (!decision.allowed) throw new Error('Expected leaf approval-race intent');
      approvalMode = mode;
      expect(await preEffectHost.mediator.execute(decision.reservationId)).toMatchObject({
        resultClass: 'failure', failureReason: 'authority-generation-drift'
      });
      const afterDenial = await store.reader().read<any>(
        authorityRunStoreKey('project:fake', 'run:manager')
      );
      if (afterDenial.status !== 'active') throw new Error('Expected active authority aggregate');
      expect(afterDenial.record.value.ticketState.tickets.find(
        (item: any) => item.ticket.ticketHandleId === leaf.handle
      )?.nonceStatus).toBe('issued');
    }
    approvalMode = 'current';
    executorPolicyCurrent = true;
    const policyDecision = await preEffectHost.mediator.authorize(leaf.handle, {
      operation: 'process.exec', argv: ['manager-test-binary', 'policy-drift'],
      writeSet: [], sideEffectClass: 'external'
    }, {
      actionId: 'manager-leaf-policy-drift', idempotencyKey: 'manager-leaf-policy-drift-key',
      adapterKind: 'manager-pre-effect-process', leaseProof: workstreamProof(workstream)
    });
    expect(policyDecision.allowed).toBe(true);
    if (!policyDecision.allowed) throw new Error('Expected leaf policy-race intent');
    executorPolicyCurrent = false;
    expect(await preEffectHost.mediator.execute(policyDecision.reservationId)).toMatchObject({
      resultClass: 'failure', failureReason: 'executor-policy-drift'
    });
    const afterPolicyDenial = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (afterPolicyDenial.status !== 'active') throw new Error('Expected active authority aggregate');
    expect(afterPolicyDenial.record.value.ticketState.tickets.find(
      (item: any) => item.ticket.ticketHandleId === leaf.handle
    )?.nonceStatus).toBe('issued');
    expect(await mediatorHost.mediator.authorize(leaf.handle, {
      operation: 'process.exec', argv: ['manager-test-binary', 'invalid-policy'],
      writeSet: [], sideEffectClass: 'workspace'
    }, {
      actionId: 'manager-leaf-invalid-policy', idempotencyKey: 'manager-leaf-invalid-policy-key',
      adapterKind: 'manager-test-process', leaseProof: workstreamProof(workstream)
    })).toMatchObject({ allowed: false, code: 'policy-denied' });
    const afterRejectedLeaf = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (afterRejectedLeaf.status !== 'active') throw new Error('Expected active authority aggregate');
    expect(afterRejectedLeaf.record.value.ticketState.tickets.find(
      (item: any) => item.ticket.ticketHandleId === leaf.handle
    )?.nonceStatus).toBe('issued');
    const eoSpawn = await spawnMediatorHost.mediator.authorize(issued.handle, {
      operation: 'agent.spawn', agentRef: 'leaf-4-core-3-api-7-handler',
      requestDigest: `sha256:${'3'.repeat(64)}`,
      writeSet: [], sideEffectClass: 'none'
    }, {
      actionId: 'manager-eo-spawn', idempotencyKey: 'manager-eo-spawn-key',
      adapterKind: 'manager-test-spawn', leaseProof: workstreamProof(workstream),
      targetNodeId: 'leaf-4-core-3-api-7-handler'
    });
    expect(eoSpawn.allowed).toBe(true);
    if (!eoSpawn.allowed) throw new Error('Expected pre-bound EO spawn');
    expect(await spawnMediatorHost.mediator.execute(eoSpawn.reservationId)).toMatchObject({
      resultClass: 'success'
    });
    expect(((await spawnMediatorHost.receiptEvidence(eoSpawn.reservationId))?.payload as any)
      ?.childTicketRef).toBe(leaf.handle);
    expect(await spawnMediatorHost.mediator.authorize(issued.handle, {
      operation: 'agent.spawn', agentRef: 'leaf-4-core-3-api-7-handler',
      requestDigest: `sha256:${'3'.repeat(64)}`,
      writeSet: [], sideEffectClass: 'none'
    }, {
      actionId: 'manager-eo-spawn-duplicate', idempotencyKey: 'manager-eo-spawn-duplicate-key',
      adapterKind: 'manager-test-spawn', leaseProof: workstreamProof(workstream),
      targetNodeId: 'leaf-4-core-3-api-7-handler'
    })).toMatchObject({ allowed: false, code: 'idempotency-conflict' });
    expect(await spawnMediatorHost.mediator.authorize(leaf.handle, {
      operation: 'agent.spawn', agentRef: 'leaf-4-core-3-api-7-handler',
      requestDigest: `sha256:${'3'.repeat(64)}`,
      writeSet: [], sideEffectClass: 'none'
    }, {
      actionId: 'manager-leaf-spawn', idempotencyKey: 'manager-leaf-spawn-key',
      adapterKind: 'manager-test-spawn', leaseProof: workstreamProof(workstream),
      targetNodeId: 'leaf-4-core-3-api-7-handler'
    })).toMatchObject({ allowed: false, code: 'policy-denied' });
    const stillIssuedLeaf = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (stillIssuedLeaf.status !== 'active') throw new Error('Expected active authority aggregate');
    expect(stillIssuedLeaf.record.value.ticketState.tickets.find(
      (item: any) => item.ticket.ticketHandleId === leaf.handle
    )?.nonceStatus).toBe('issued');
    let approvalChecks = 0;
    const leafClaimHost = createActionMediator({
      reader: store.reader(), writer: uncertainWriter,
      authority: createRunAuthorityActionVerifier({
        manager,
        approvals: { areCurrent: async () => {
          approvalChecks += 1;
          if (approvalChecks === 7) {
            const beforeClaim = await store.reader().read<any>(
              authorityRunStoreKey('project:fake', 'run:manager')
            );
            if (beforeClaim.status !== 'active') throw new Error('Expected active authority aggregate');
            expect(beforeClaim.record.value.ticketState.tickets.find(
              (item: any) => item.ticket.ticketHandleId === leaf.handle
            )?.nonceStatus).toBe('issued');
          }
          return true;
        } }
      }),
      executors: [actionExecutor],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date(now)
    });
    const claimIntent = await leafClaimHost.mediator.authorize(leaf.handle, {
      operation: 'process.exec', argv: ['manager-test-binary', 'claim-after-approval'],
      writeSet: [], sideEffectClass: 'external'
    }, {
      actionId: 'manager-leaf-effect-claim', idempotencyKey: 'manager-leaf-effect-claim-key',
      adapterKind: 'manager-test-process', leaseProof: workstreamProof(workstream)
    });
    expect(claimIntent.allowed).toBe(true);
    if (!claimIntent.allowed) throw new Error('Expected leaf effect-claim intent');
    loseLeafClaimAck = true;
    expect(await leafClaimHost.mediator.execute(claimIntent.reservationId)).toMatchObject({
      resultClass: 'success'
    });
    expect(approvalChecks).toBe(10);
    const afterClaim = await store.reader().read<any>(authorityRunStoreKey('project:fake', 'run:manager'));
    if (afterClaim.status !== 'active') throw new Error('Expected active authority aggregate');
    expect(afterClaim.record.value.ticketState.tickets.find(
      (item: any) => item.ticket.ticketHandleId === leaf.handle
    )?.nonceStatus).toBe('claimed');
    expect(await manager.inspectTicket(leaf.handle)).toEqual({
      authority: false, ticketHandleId: leaf.handle, role: 'LEAF',
      expiresAt: '2026-09-12T00:01:00.000Z'
    });
    const leafIntent = await mediatorHost.mediator.authorize(leaf.handle, {
      operation: 'process.exec', argv: ['manager-test-binary', 'expires-before-effect'],
      writeSet: [], sideEffectClass: 'external'
    }, {
      actionId: 'manager-leaf-expiry', idempotencyKey: 'manager-leaf-expiry-key',
      adapterKind: 'manager-test-process', leaseProof: workstreamProof(workstream)
    });
    expect(leafIntent.allowed).toBe(true);
    if (!leafIntent.allowed) throw new Error('Expected persisted leaf intent');
    const effectsBeforeLeafExpiry = actionExecute.mock.calls.length;
    now.setTime(Date.parse('2026-09-12T00:01:00.000Z'));
    monotonicMs += 20_000;
    expect(await mediatorHost.mediator.execute(leafIntent.reservationId)).toMatchObject({
      resultClass: 'failure', failureReason: 'authority-revalidation-denied:stale-generation'
    });
    expect(actionExecute).toHaveBeenCalledTimes(effectsBeforeLeafExpiry);
    const expiredLeafState = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (expiredLeafState.status !== 'active') throw new Error('Expected active authority aggregate');
    expect(expiredLeafState.record.value.ticketState.tickets.find(
      (item: any) => item.ticket.ticketHandleId === leaf.handle
    )?.nonceStatus).toBe('claimed');
    const afterLeaf = await store.reader().read<any>(authorityRunStoreKey('project:fake', 'run:manager'));
    if (afterLeaf.status !== 'active') throw new Error('Expected active aggregate');
    const leafReservation = afterLeaf.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === leaf.handle
    );
    const leafMediation = await store.reader().read<any>('intent/run:manager');
    if (leafMediation.status !== 'active') throw new Error('Expected leaf mediation aggregate');
    const usageIdentity = leafMediation.record.value.actions.find(
      (item: any) => item.reservationId === claimIntent.reservationId
    ).authority.usage;
    const settlementConstraints = (
      reservation: any,
      authorityRef: string,
      nodeId: string,
      expectedActionCount = 0
    ) => ({
      runId: 'run:manager', projectId: 'project:fake', reservationId: reservation.reservationId,
      authorityKind: 'delegation-ticket' as const, authorityRef, nodeId,
      authorityInstanceId: usageIdentity.authorityInstanceId,
      usageBindingDigest: usageIdentity.usageBindingDigest,
      notBefore: reservation.startedAt,
      expectedActionCount
    });
    const leafSettlementConstraints = settlementConstraints(
      leafReservation, leaf.handle, 'leaf-4-core-3-api-7-handler'
    );
    const rootReservation = afterLeaf.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === issued.handle
    );
    const rootSettlementConstraints = settlementConstraints(
      rootReservation, issued.handle, executionIssue.ticket.nodeId
    );
    const reportBackend = runAuthorityReportBackend(manager);
    const parentFinalizeCalls = usageFinalize.mock.calls.filter(call =>
      String(call[0]).includes('manager-issue-execution-0001')).length;
    await expect(reportBackend.settleAndReadUsage(rootSettlementConstraints))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    expect(usageFinalize.mock.calls.filter(call =>
      String(call[0]).includes('manager-issue-execution-0001'))).toHaveLength(parentFinalizeCalls);
    await expect(reportBackend.readUsage(leafSettlementConstraints))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    loseFinalizeClaimAck = true;
    loseSampleIntentAck = true;
    loseUsageAccountingAck = true;
    const finalLeafUsage = await reportBackend.settleAndReadUsage(leafSettlementConstraints);
    expect(finalLeafUsage).toMatchObject({
      runId: 'run:manager',
      projectId: 'project:fake',
      authorityKind: 'delegation-ticket',
      authorityRef: leaf.handle,
      reservationId: leafReservation.reservationId,
      authorityInstanceId: expect.stringMatching(/^sha256:/),
      usageBindingDigest: expect.stringMatching(/^sha256:/),
      status: 'committed',
      final: { confidence: 'authoritative' },
      sampleDigest: expect.stringMatching(/^sha256:/),
      amounts: leafReservation.amounts,
      actual: expect.any(Object)
    });
    expect(Object.isFrozen(finalLeafUsage.final)).toBe(true);
    expect(JSON.stringify(finalLeafUsage)).not.toContain('provider-usage:');
    expect(JSON.stringify(finalLeafUsage)).not.toContain('settlement-owner:');
    const leafProviderUsage = afterLeaf.record.value.providerUsage.find(
      (item: any) => item.reservationId === leafReservation.reservationId
    );
    expect(usageSample).toHaveBeenCalledWith(leafProviderUsage.opaqueScope);
    const afterLeafReconcile = await manager.read();
    await manager.reconcileUsage(leafReservation.reservationId);
    expect((await manager.read()).generation).toBe(afterLeafReconcile.generation);
    expect(usageFinalize).toHaveBeenCalledTimes(1);
    expect(usageCommit).toHaveBeenCalledTimes(1);
    await reportBackend.settleAndReadUsage(rootSettlementConstraints);
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
    const finalizeCallsBeforeUnconstrained = usageFinalize.mock.calls.length;
    await expect(manager.reconcileUsage(interleavedReservation.reservationId))
      .rejects.toMatchObject({ code: 'settlement-constraints-required' });
    expect(usageFinalize).toHaveBeenCalledTimes(finalizeCallsBeforeUnconstrained);
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
    const staleV5 = JSON.parse(JSON.stringify(base));
    staleV5.schemaVersion = 5;
    expect(() => parseRunAuthorityState(staleV5, compiled, {
      runId: 'run:manager', projectId: 'project:fake', usageBinding: managerOptions.usageBinding
    })).toThrow(/schemaVersion 5.*expected 6/);
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
      (value: any) => {
        const usage = value.providerUsage.find((item: any) => item.finalSample !== null);
        usage.finalSample.actionCount += 1;
        usage.sampleDigest = computeAuthorityUsageSampleDigest(usage.finalSample);
        value.budgets.reservations.find((item: any) =>
          item.reservationId === usage.reservationId).sampleDigest = usage.sampleDigest;
      },
      (value: any) => {
        const usage = value.providerUsage.find((item: any) => item.finalSample !== null);
        usage.finalSample.timestamp = '2026-09-11T23:59:59.999Z';
        usage.sampleDigest = computeAuthorityUsageSampleDigest(usage.finalSample);
        value.budgets.reservations.find((item: any) =>
          item.reservationId === usage.reservationId).sampleDigest = usage.sampleDigest;
      },
      (value: any) => {
        const usage = value.providerUsage.find((item: any) => item.finalSample !== null);
        usage.finalSample.source = 'malicious-meter';
        usage.sampleDigest = computeAuthorityUsageSampleDigest(usage.finalSample);
        value.budgets.reservations.find((item: any) =>
          item.reservationId === usage.reservationId).sampleDigest = usage.sampleDigest;
      },
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
    const commitPendingConstraints = settlementConstraints(
      commitPendingReservation, commitPendingIssue.handle, executionIssue.ticket.nodeId
    );
    usageCommit.mockImplementationOnce(async () => {
      throw new Error('provider commit acknowledgement lost');
    });
    await expect(runAuthorityReportBackend(manager).settleAndReadUsage(commitPendingConstraints))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    const commitPendingAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (commitPendingAggregate.status !== 'active') throw new Error('Expected active aggregate');
    expect(commitPendingAggregate.record.value.providerUsage.find(
      (item: any) => item.reservationId === commitPendingReservation.reservationId
    )).toMatchObject({
      status: 'commit-pending', sampleDigest: expect.stringMatching(/^sha256:/),
      finalSample: { confidence: 'authoritative' }
    });
    expect(commitPendingAggregate.record.value.budgets.reservations.find(
      (item: any) => item.reservationId === commitPendingReservation.reservationId
    )).toMatchObject({ status: 'pending', sampleDigest: null, actual: {} });
    const recoveryEntropy = Buffer.alloc(32, 201);
    const recoveryOwner = `settlement-owner:${crypto.createHash('sha256')
      .update(recoveryEntropy).digest('base64url')}`;
    const commitPendingCorruptions: Array<[string, (usage: any) => void]> = [
      ['timestamp', usage => {
        usage.finalSample.timestamp = '2026-09-11T23:59:59.999Z';
        usage.sampleDigest = computeAuthorityUsageSampleDigest(usage.finalSample);
      }],
      ['action-count', usage => {
        usage.finalSample.actionCount += 1;
        usage.sampleDigest = computeAuthorityUsageSampleDigest(usage.finalSample);
      }],
      ['provider', usage => {
        usage.finalSample.provider = 'malicious-provider';
        usage.sampleDigest = computeAuthorityUsageSampleDigest(usage.finalSample);
      }],
      ['model', usage => {
        usage.finalSample.model = 'malicious-model';
        usage.sampleDigest = computeAuthorityUsageSampleDigest(usage.finalSample);
      }],
      ['price-table', usage => {
        usage.finalSample.priceTableVersion = 'malicious-prices';
        usage.sampleDigest = computeAuthorityUsageSampleDigest(usage.finalSample);
      }],
      ['currency', usage => {
        usage.finalSample.cost.currency = 'EUR';
        usage.sampleDigest = computeAuthorityUsageSampleDigest(usage.finalSample);
      }],
      ['confidence', usage => {
        usage.finalSample.confidence = 'estimated';
        usage.sampleDigest = computeAuthorityUsageSampleDigest(usage.finalSample);
      }],
      ['sample-digest', usage => { usage.sampleDigest = `sha256:${'0'.repeat(64)}`; }],
      ['constraint-kind', usage => { usage.finalizeConstraintKind = 'cancellation'; }],
      ['constraint-digest', usage => { usage.finalizeConstraintDigest = `sha256:${'0'.repeat(64)}`; }],
      ['claim-owner', usage => { usage.finalizeClaimOwnerId = 'settlement-owner:malicious'; }],
      ['claim-fence', usage => { usage.finalizeClaimWriterGeneration = 3; }]
    ];
    for (const [label, corrupt] of commitPendingCorruptions) {
      const value = JSON.parse(JSON.stringify(commitPendingAggregate.record.value));
      const provider = value.providerUsage.find(
        (item: any) => item.reservationId === commitPendingReservation.reservationId
      );
      provider.finalizeClaimWriterGeneration = 2;
      provider.finalizeClaimOwnerId = recoveryOwner;
      corrupt(provider);
      const tamperedStore = new ProtectedControllerStore({
        storeId: `commit-pending-tamper-${label}`,
        adapter: new InMemoryProtectedStoreAdapter()
      });
      const stagingWriter = await tamperedStore.openWriter();
      await stagingWriter.compareAndSwap({
        key: authorityRunStoreKey('project:fake', 'run:manager'), expectedGeneration: 0, value
      });
      const recoveryWriter = await tamperedStore.openWriter();
      const providerCommit = jest.fn(async () => undefined);
      const restarted = createRunAuthorityManagerForTest({
        ...managerOptions,
        reader: tamperedStore.reader(),
        writer: recoveryWriter,
        usageMeter: { ...usageMeter, commit: providerCommit }
      }, {
        now: () => new Date(now), monotonicClock: () => monotonicMs,
        clockDomainId: () => 'manager-clock-domain',
        randomBytes: () => Buffer.from(recoveryEntropy)
      });
      await expect(runAuthorityReportBackend(restarted)
        .settleAndReadUsage(commitPendingConstraints)).rejects.toBeInstanceOf(TicketAuthorityError);
      expect(providerCommit).not.toHaveBeenCalled();
      const afterTamper = await tamperedStore.reader().read<any>(
        authorityRunStoreKey('project:fake', 'run:manager')
      );
      if (afterTamper.status !== 'active') throw new Error('Expected tampered aggregate');
      expect(afterTamper.record.value.budgets).toEqual(value.budgets);
    }
    const commitRecoveryWriter = await store.openWriter();
    const restartedCommitPending = createRunAuthorityManagerForTest({
      ...managerOptions,
      writer: commitRecoveryWriter
    }, {
      now: () => new Date(now), monotonicClock: () => monotonicMs,
      clockDomainId: () => 'manager-clock-domain',
      randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    await expect(runAuthorityReportBackend(restartedCommitPending)
      .settleAndReadUsage(commitPendingConstraints))
      .resolves.toMatchObject({ status: 'committed' });
    expect(usageFinalize.mock.calls.filter(call =>
      String(call[0]).includes('manager-commit-pending-settlement'))).toHaveLength(1);
    manager = restartedCommitPending;
    await manager.releaseWorkstreamLease({
      nodeId: commitPendingWorkstream.nodeId,
      proof: workstreamProof(commitPendingWorkstream)
    });

    const concurrentIssue = await manager.issueExecutionTicket({
      ...executionIssue,
      operationId: 'manager-concurrent-settlement',
      controllerProof: controllerProof(settlementController),
      ticket: { ...executionIssue.ticket, scope: 'concurrent-settlement' }
    });
    const concurrentWorkstream = await manager.claimExecutionAndAcquireWorkstream({
      handle: concurrentIssue.handle,
      controllerProof: controllerProof(settlementController)
    });
    let concurrentAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (concurrentAggregate.status !== 'active') throw new Error('Expected active aggregate');
    const concurrentReservation = concurrentAggregate.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === concurrentIssue.handle
    );
    const concurrentConstraints = settlementConstraints(
      concurrentReservation, concurrentIssue.handle, executionIssue.ticket.nodeId
    );
    await Promise.all([
      runAuthorityReportBackend(manager).settleAndReadUsage(concurrentConstraints),
      runAuthorityReportBackend(manager).settleAndReadUsage(concurrentConstraints),
      runAuthorityReportBackend(manager).settleAndReadUsage(concurrentConstraints)
    ]);
    expect(usageFinalize.mock.calls.filter(call =>
      String(call[0]).includes('manager-concurrent-settlement'))).toHaveLength(1);
    await manager.releaseWorkstreamLease({
      nodeId: concurrentWorkstream.nodeId,
      proof: workstreamProof(concurrentWorkstream)
    });
    expect(await manager.revokeTicket(concurrentIssue.handle)).toBe(true);

    const sharedWriterIssue = await manager.issueExecutionTicket({
      ...executionIssue,
      operationId: 'manager-shared-writer-settlement',
      controllerProof: controllerProof(settlementController),
      ticket: { ...executionIssue.ticket, scope: 'shared-writer-settlement' }
    });
    const sharedWriterWorkstream = await manager.claimExecutionAndAcquireWorkstream({
      handle: sharedWriterIssue.handle,
      controllerProof: controllerProof(settlementController)
    });
    const sharedWriterAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (sharedWriterAggregate.status !== 'active') throw new Error('Expected active aggregate');
    const sharedWriterReservation = sharedWriterAggregate.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === sharedWriterIssue.handle
    );
    const sharedWriterConstraints = settlementConstraints(
      sharedWriterReservation, sharedWriterIssue.handle, executionIssue.ticket.nodeId
    );
    const sharedWriterManager = createRunAuthorityManagerForTest({
      ...managerOptions,
      writer: commitRecoveryWriter
    }, {
      now: () => new Date(now), monotonicClock: () => monotonicMs,
      clockDomainId: () => 'manager-clock-domain',
      randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    const sharedPriorFinalize = usageFinalize.getMockImplementation()!;
    let releaseSharedFinalize!: () => void;
    let markSharedFinalizeStarted!: () => void;
    const sharedFinalizeStarted = new Promise<void>(resolve => { markSharedFinalizeStarted = resolve; });
    const sharedFinalizeGate = new Promise<void>(resolve => { releaseSharedFinalize = resolve; });
    usageFinalize.mockImplementation(async (providerReservationId: string) => {
      if (providerReservationId.includes('manager-shared-writer-settlement')) {
        markSharedFinalizeStarted();
        await sharedFinalizeGate;
      }
      return sharedPriorFinalize(providerReservationId);
    });
    const owningSettlement = runAuthorityReportBackend(manager)
      .settleAndReadUsage(sharedWriterConstraints);
    await sharedFinalizeStarted;
    await expect(runAuthorityReportBackend(sharedWriterManager)
      .settleAndReadUsage(sharedWriterConstraints))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    expect(usageFinalize.mock.calls.filter(call =>
      String(call[0]).includes('manager-shared-writer-settlement'))).toHaveLength(1);
    releaseSharedFinalize();
    await expect(owningSettlement).resolves.toMatchObject({ status: 'committed' });
    usageFinalize.mockImplementation(sharedPriorFinalize);
    expect(JSON.stringify(await manager.read())).not.toContain('settlement-owner:');
    await manager.releaseWorkstreamLease({
      nodeId: sharedWriterWorkstream.nodeId,
      proof: workstreamProof(sharedWriterWorkstream)
    });
    expect(await manager.revokeTicket(sharedWriterIssue.handle)).toBe(true);

    const takeoverIssue = await manager.issueExecutionTicket({
      ...executionIssue,
      operationId: 'manager-finalize-claim-takeover',
      controllerProof: controllerProof(settlementController),
      ticket: { ...executionIssue.ticket, scope: 'finalize-claim-takeover' }
    });
    const takeoverWorkstream = await manager.claimExecutionAndAcquireWorkstream({
      handle: takeoverIssue.handle,
      controllerProof: controllerProof(settlementController)
    });
    const takeoverAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (takeoverAggregate.status !== 'active') throw new Error('Expected active aggregate');
    const takeoverReservation = takeoverAggregate.record.value.budgets.reservations.find(
      (item: any) => item.ticketHandleId === takeoverIssue.handle
    );
    const priorFinalize = usageFinalize.getMockImplementation()!;
    let releaseAbandonedFinalize!: () => void;
    let markAbandonedFinalizeStarted!: () => void;
    const abandonedFinalizeStarted = new Promise<void>(resolve => { markAbandonedFinalizeStarted = resolve; });
    const abandonedFinalizeGate = new Promise<void>(resolve => { releaseAbandonedFinalize = resolve; });
    let firstTakeoverFinalize = true;
    usageFinalize.mockImplementation(async (providerReservationId: string) => {
      if (providerReservationId.includes('manager-finalize-claim-takeover') && firstTakeoverFinalize) {
        firstTakeoverFinalize = false;
        markAbandonedFinalizeStarted();
        await abandonedFinalizeGate;
      }
      return priorFinalize(providerReservationId);
    });
    const takeoverConstraints = settlementConstraints(
      takeoverReservation, takeoverIssue.handle, executionIssue.ticket.nodeId
    );
    const abandonedSettlement = runAuthorityReportBackend(manager)
      .settleAndReadUsage(takeoverConstraints);
    await abandonedFinalizeStarted;
    const claimedAggregate = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (claimedAggregate.status !== 'active') throw new Error('Expected active aggregate');
    expect(claimedAggregate.record.value.providerUsage.find(
      (item: any) => item.reservationId === takeoverReservation.reservationId
    )).toMatchObject({
      status: 'finalize-claimed',
      finalizeClaimWriterGeneration: commitRecoveryWriter.writerGeneration,
      finalizeClaimOwnerId: expect.stringMatching(/^settlement-owner:/),
      finalizeConstraintDigest: expect.stringMatching(/^sha256:/),
      finalizeConstraintKind: 'strict-action',
      finalSample: null,
      sampleDigest: null
    });
    const takeoverBaseWriter = await store.openWriter();
    const takeoverWriter: ProtectedControllerStoreWriter = {
      ...takeoverBaseWriter,
      async compareAndSwap(input) {
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
          await takeoverBaseWriter.compareAndSwap(committedInput);
          throw new IndeterminateStoreCommitError('lost redirected execution claim acknowledgement');
        }
        const record = await takeoverBaseWriter.compareAndSwap(committedInput);
        if (loseProviderReleaseStageAck && (committedInput.value as any).providerUsage?.some(
          (item: any) => item.status === 'release-pending')) {
          loseProviderReleaseStageAck = false;
          throw new IndeterminateStoreCommitError('lost provider release stage acknowledgement');
        }
        if (loseProviderReleaseFinalizeAck && (committedInput.value as any).providerUsage?.some(
          (item: any) => item.status === 'released')) {
          loseProviderReleaseFinalizeAck = false;
          throw new IndeterminateStoreCommitError('lost provider release finalize acknowledgement');
        }
        return record;
      }
    };
    const takeoverManager = createRunAuthorityManagerForTest({
      ...managerOptions,
      writer: takeoverWriter,
      usageSettlementTimeoutMs: 2_000
    }, {
      now: () => new Date(now), monotonicClock: () => monotonicMs,
      clockDomainId: () => 'manager-clock-domain',
      randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    await expect(runAuthorityReportBackend(takeoverManager)
      .settleAndReadUsage(takeoverConstraints)).resolves.toBeDefined();
    releaseAbandonedFinalize();
    const [abandonedResult] = await Promise.allSettled([abandonedSettlement]);
    expect(abandonedResult.status).toBe('rejected');
    expect(usageFinalize.mock.calls.filter(call =>
      String(call[0]).includes('manager-finalize-claim-takeover'))).toHaveLength(2);
    expect(usageCommit.mock.calls.filter(call =>
      String(call[0]).includes('manager-finalize-claim-takeover'))).toHaveLength(1);
    const takenOver = await store.reader().read<any>(authorityRunStoreKey('project:fake', 'run:manager'));
    if (takenOver.status !== 'active') throw new Error('Expected active aggregate');
    expect(takenOver.record.writerGeneration).toBe(takeoverWriter.writerGeneration);
    expect(takenOver.record.value.providerUsage.find(
      (item: any) => item.reservationId === takeoverReservation.reservationId
    )).toMatchObject({
      status: 'committed',
      finalizeClaimWriterGeneration: takeoverWriter.writerGeneration,
      finalizeClaimOwnerId: expect.stringMatching(/^settlement-owner:/),
      finalizeConstraintDigest: expect.stringMatching(/^sha256:/),
      finalizeConstraintKind: 'strict-action'
    });
    manager = takeoverManager;
    usageFinalize.mockImplementation(priorFinalize);
    await manager.releaseWorkstreamLease({
      nodeId: takeoverWorkstream.nodeId,
      proof: workstreamProof(takeoverWorkstream)
    });
    expect(await manager.revokeTicket(takeoverIssue.handle)).toBe(true);

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
    let releaseFirstHungFinalize!: () => void;
    let rejectSecondHungFinalize!: (error: Error) => void;
    let releaseReplacementFinalize!: () => void;
    let markReplacementFinalizeStarted!: () => void;
    const firstHungFinalizeGate = new Promise<void>(resolve => { releaseFirstHungFinalize = resolve; });
    const secondHungFinalizeGate = new Promise<void>((_resolve, reject) => {
      rejectSecondHungFinalize = reject;
    });
    const replacementFinalizeGate = new Promise<void>(resolve => { releaseReplacementFinalize = resolve; });
    const replacementFinalizeStarted = new Promise<void>(resolve => { markReplacementFinalizeStarted = resolve; });
    let hungFinalizeAttempts = 0;
    usageFinalize.mockImplementation(async (providerReservationId: string) => {
      if (providerReservationId.includes('manager-hung-settlement')) {
        hungFinalizeAttempts += 1;
        if (hungFinalizeAttempts === 1) await firstHungFinalizeGate;
        if (hungFinalizeAttempts === 2) await secondHungFinalizeGate;
        if (hungFinalizeAttempts === 3) {
          markReplacementFinalizeStarted();
          await replacementFinalizeGate;
        }
      }
      return defaultFinalize(providerReservationId);
    });
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
    expect(cancelled.generation).toBe(beforeCancel.generation + 9);
    expect(cancelled.unsettledUsage).toEqual([
      { reservationId: hungReservation.reservationId, reason: 'provider-finalize-pending' }
    ]);
    const sameWriterRetry = await manager.cancel();
    expect(sameWriterRetry.unsettledUsage).toEqual([
      { reservationId: hungReservation.reservationId, reason: 'provider-finalize-pending' }
    ]);
    expect(sameWriterRetry.generation).toBe(cancelled.generation);
    const replacementSettlement = manager.cancel();
    await replacementFinalizeStarted;
    releaseFirstHungFinalize();
    rejectSecondHungFinalize(new Error('abandoned provider finalization failed'));
    await new Promise<void>(resolve => setImmediate(resolve));
    const beforeReplacementCommit = await store.reader().read<any>(
      authorityRunStoreKey('project:fake', 'run:manager')
    );
    if (beforeReplacementCommit.status !== 'active') throw new Error('Expected active aggregate');
    expect(beforeReplacementCommit.record.value.providerUsage.find(
      (item: any) => item.reservationId === hungReservation.reservationId
    )).toMatchObject({ status: 'finalize-claimed', finalSample: null, sampleDigest: null });
    expect(usageCommit.mock.calls.filter(call =>
      String(call[0]).includes('manager-hung-settlement'))).toHaveLength(0);
    const sharedReplacementSettlement = manager.cancel();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(usageFinalize.mock.calls.filter(call =>
      String(call[0]).includes('manager-hung-settlement'))).toHaveLength(3);
    releaseReplacementFinalize();
    const [settled, sharedSettled] = await Promise.all([
      replacementSettlement, sharedReplacementSettlement
    ]);
    expect(usageCommit.mock.calls.filter(call =>
      String(call[0]).includes('manager-hung-settlement'))).toHaveLength(1);
    expect(settled.unsettledUsage).toEqual([]);
    expect(sharedSettled.unsettledUsage).toEqual([]);
    expect(sharedSettled.generation).toBe(settled.generation);
    usageFinalize.mockImplementation(defaultFinalize);
    const recoveryWriter = await store.openWriter();
    const recoveryManager = createRunAuthorityManagerForTest({
      ...managerOptions,
      writer: recoveryWriter
    }, {
      now: () => new Date(now), monotonicClock: () => monotonicMs,
      clockDomainId: () => 'manager-clock-domain',
      randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    const recoveredSettlement = await recoveryManager.cancel();
    manager = recoveryManager;
    expect(recoveredSettlement.unsettledUsage).toEqual([]);
    expect(settled.generation).toBeGreaterThan(cancelled.generation);
    expect(recoveredSettlement.generation).toBe(settled.generation);
    expect((await manager.cancel()).generation).toBe(recoveredSettlement.generation);
    expect(usageRelease).toHaveBeenCalledWith(
      expect.stringContaining('manager-account-after-cancel'),
      `ticket-usage-release:project:fake:run:manager:${cancellationReleaseReservation.reservationId}`
    );
    expect(usageCommit).toHaveBeenCalledWith(
      expect.stringContaining('manager-hung-settlement'),
      expect.stringMatching(/^sha256:/)
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
    )).toMatchObject({ status: 'committed' });
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
      .rejects.toMatchObject({ code: 'reservation-conflict' });
    expect((await restartedManager.read()).generation).toBe(settled.generation);
    now.setTime(Date.parse('2026-09-12T02:00:00.000Z'));
    monotonicMs += 2 * 60 * 60 * 1000;
    await expect(manager.reconcileUsage(accountingReservation.reservationId))
      .rejects.toMatchObject({ code: 'settlement-constraints-required' });
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
    await recoveryWriter.compareAndSwap({
      key: authorityRunStoreKey('project:fake', 'run:manager'),
      expectedGeneration: afterLateAccounting.generation,
      value: corrupted
    });
    await expect(reopened.read()).rejects.toMatchObject({ code: 'recovery-required' });
  }, 300_000);
});
