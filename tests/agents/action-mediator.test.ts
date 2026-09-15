import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as publicAgents from '../../src/agents';

import {
  ActionOperation,
  computeUsageSampleDigest,
  createOpaqueHandle,
  createRunKillSwitch,
  deriveOperationMetadataBindings,
  OpaqueHandle,
  ProtectedControllerStore,
  sealContract,
  StructuredAction
} from '../../src/agents';
import type {
  ResolvedActionAuthority,
  StructuredActionExecutor
} from '../../src/agents/run/trust/mediator';
import { InMemoryProtectedStoreAdapter } from '../../src/agents/run/store/in-memory-adapter';
import { IndeterminateStoreCommitError } from '../../src/agents/run/store/types';
import { canonicalizeJson } from '../../src/agents/contracts/canonicalize';
import { controllerProof, workstreamProof } from '../../src/agents/run/authority/leases';
import { authorityRunStoreKey } from '../../src/agents/run/authority/protected-repository';
import { createRunAuthorityActionVerifier } from '../../src/agents/run/authority/action-verifier-internal';
import { deriveAuthorityUsageActual } from '../../src/agents/run/authority/usage-accounting';
import {
  createRunAuthorityManagerForTest,
  runAuthorityReportBackend
} from '../../src/agents/run/authority/manager';
import { compilePlanGraph } from '../../src/agents/run/compiler';
import { AttestationChallengeParams, createFakeTrustedControlPlane } from '../../src/agents/run/trust';
import {
  actionReceiptAuthorityScope,
  computeStoredActionCompletionDigest,
  createActionMediator,
  type DelegatedReceiptAuthorityScope
} from '../../src/agents/run/trust/mediator-internal';

const D0 = `sha256:${'0'.repeat(64)}`;
const D1 = `sha256:${'1'.repeat(64)}`;
const HANDLE = createOpaqueHandle('trusted-action-handle');
const ACTION: StructuredAction = {
  operation: 'process.exec',
  argv: ['allowlisted-binary', '--fixed-flag'],
  writeSet: [],
  sideEffectClass: 'external'
};

function mediatorHash(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256')
    .update(domain, 'utf8').update('\0').update(canonicalizeJson(value), 'utf8').digest('hex')}`;
}

function resealIntentRequest(action: any): void {
  action.requestDigest = mediatorHash('harness-mdocs/action-intent-request/v1', {
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
    actionDigest: action.actionDigest,
    adapterKind: action.adapterKind,
    budgetCharge: action.budgetCharge,
    approvalRefs: action.approvalRefs,
    credentialClasses: action.credentialClasses,
    declaredPaths: action.declaredPaths,
    declaredResources: action.declaredResources,
    nodeId: action.nodeId,
    targetNodeId: action.targetNodeId,
    authorityRef: action.authority.authorityRef,
    spawnChildTicketRef: action.authority.spawnChildTicketRef,
    graphEpoch: action.authority.graphEpoch,
    cancellationGeneration: action.authority.cancellationGeneration,
    lease: {
      kind: action.authority.lease.kind,
      ref: action.authority.lease.ref,
      generation: action.authority.lease.generation,
      fence: action.authority.lease.fence,
      acquiredAt: action.authority.lease.acquiredAt
    }
  });
}

function resealFinalizedReceipts(value: any, usage: any): void {
  for (const action of value.actions.filter((item: any) => item.finalizedReceipt)) {
    const preliminary = action.receipt;
    const payload = {
      ...preliminary.payload,
      preliminaryReceiptDigest: preliminary.digest,
      usageStatus: 'committed',
      usageSampleDigest: usage.sampleDigest,
      usageAmounts: usage.amounts,
      usageCurrency: usage.currency,
      usageDescendantCommitted: usage.descendantCommitted,
      usageActual: usage.actual,
      usageFinal: usage.final
    };
    const id = `receipt-final:${mediatorHash('harness-mdocs/final-action-receipt-id/v1', {
      preliminaryReceiptId: preliminary.id,
      preliminaryReceiptDigest: preliminary.digest,
      usage
    }).slice(7)}`;
    action.finalizedReceipt = sealContract('action-receipt/v1', id, payload);
  }
}

function authority(overrides: Partial<ResolvedActionAuthority> = {}): ResolvedActionAuthority {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    approvedPlanDigest: D0,
    approvedGraphDigest: D1,
    graphId: 'graph-1',
    graphRevision: 1,
    graphEpoch: 2,
    cancellationGeneration: 3,
    authorityKind: 'delegation-ticket',
    authorityRef: HANDLE,
    parentAuthorityRef: null,
    authorityGeneration: 4,
    authorityExpiresAt: '2026-09-13T00:20:00.000Z',
    nodeId: 'execution-node',
    parentNodeId: 'root-node',
    issuerRole: 'PLAN_ROOT',
    recipientRole: 'EXECUTION',
    handleLineage: [HANDLE],
    spawnChildTicketRef: null,
    reportDestination: 'controller:execution-node',
    reportSchemaRef: 'execution-report/v1',
    lease: {
      kind: 'workstream',
      ref: 'workstream-lease-1',
      generation: 5,
      fence: 6,
      acquiredAt: '2026-09-13T00:00:00.000Z',
      expiresAt: '2026-09-13T00:10:00.000Z'
    },
    operationClasses: ['process.exec'],
    toolClasses: [],
    credentialClasses: [],
    approvalRefs: ['approval-1'],
    approvalsCurrent: true,
    writeSet: [],
    criteria: ['criterion-1'],
    globalActionLimit: 2,
    localActionLimit: 2,
    eoLineageKey: HANDLE,
    eoLineageActionLimit: 2,
    usage: {
      reservationId: 'budget-1',
      authorityInstanceId: D0,
      usageBindingDigest: D1,
      status: 'pending',
      startedAt: '2026-09-13T00:00:00.000Z',
      deadlineAt: '2026-09-13T00:20:00.000Z',
      final: null,
      sampleDigest: null,
      amounts: { toolActionsEo: 2 },
      currency: 'USD',
      descendantCommitted: {},
      actual: {},
      measuredUsageRequired: false
    },
    ...overrides
  };
}

function successfulResult(request: Parameters<StructuredActionExecutor['execute']>[0]) {
  return {
    resultClass: 'success' as const,
    startedAt: '2026-09-13T00:00:02.000Z',
    endedAt: '2026-09-13T00:00:03.000Z',
    actualTargets: [],
    actualResources: [...request.declaredResources],
    inputMetadata: { argvDigest: deriveOperationMetadataBindings(request.action).argvDigest },
    resultMetadata: { durationMs: 1000, exitCode: 0 },
    workspaceBefore: { scope: [], entries: [] },
    workspaceAfter: { scope: [], entries: [] },
    mutations: [],
    artifactHashes: []
  };
}

function successfulExecutor(
  onExecute: StructuredActionExecutor['execute'] | null = null
): StructuredActionExecutor {
  return {
    kind: 'allowlisted-process',
    operations: ['process.exec'],
    validate: request => request.action.operation === 'process.exec' &&
      request.action.argv[0] === 'allowlisted-binary',
    requiredCredentialClasses: () => [],
    async execute(request, guard) {
      await guard.assertCurrent();
      return onExecute ? onExecute(request, guard) : successfulResult(request);
    }
  };
}

function committedUsage(grant: ResolvedActionAuthority, actionCount: number) {
  const final = {
    source: 'trusted-meter', provider: 'trusted-provider', model: 'trusted-model',
    priceTableVersion: 'prices-v1', actionCount, confidence: 'authoritative' as const,
    timestamp: '2026-09-13T00:00:05.000Z'
  };
  return {
    runId: grant.runId,
    projectId: grant.projectId,
    authorityKind: grant.authorityKind,
    authorityRef: grant.authorityKind === 'delegation-ticket' ? grant.authorityRef : null,
    nodeId: grant.nodeId,
    reservationId: grant.usage.reservationId,
    authorityInstanceId: grant.usage.authorityInstanceId,
    usageBindingDigest: grant.usage.usageBindingDigest,
    settlementConstraintDigest: null,
    status: 'committed' as const,
    startedAt: grant.usage.startedAt,
    deadlineAt: grant.usage.deadlineAt,
    final,
    sampleDigest: computeUsageSampleDigest(final),
    amounts: grant.usage.amounts,
    currency: grant.usage.currency,
    descendantCommitted: {},
    actual: Object.fromEntries(Object.keys(grant.usage.amounts).map(key => [key, actionCount]))
  };
}

async function fixture(options: {
  grant?: ResolvedActionAuthority;
  executor?: StructuredActionExecutor;
  verify?: jest.Mock;
} = {}) {
  const adapter = new InMemoryProtectedStoreAdapter();
  const store = new ProtectedControllerStore({ storeId: 'mediator-test', adapter });
  const writer = await store.openWriter();
  const killSwitch = createRunKillSwitch({ routeEnabled: true, runEnabled: true });
  let clock = new Date('2026-09-13T00:00:01.000Z');
  const grant = options.grant ?? authority();
  const verify = options.verify ?? jest.fn(async request => {
    if (request.handle !== HANDLE) {
      const error = new Error('unknown opaque handle');
      Object.assign(error, { code: 'unknown-handle' });
      throw error;
    }
    return grant;
  });
  const executor = options.executor ?? successfulExecutor();
  const host = createActionMediator({
    reader: store.reader(), writer, authority: { verifyAndReserve: verify },
    executors: [executor], killSwitch, now: () => new Date(clock)
  });
  return {
    adapter, store, writer, killSwitch, host, mediator: host.mediator, executor, verify, grant,
    setClock(value: string) { clock = new Date(value); }
  };
}

async function trustedDelegatedFixture(options: {
  actionLimit?: number;
  leafCount?: number;
  runId?: string;
  projectId?: string;
  entropyStart?: number;
  store?: ProtectedControllerStore;
  writer?: Awaited<ReturnType<ProtectedControllerStore['openWriter']>>;
} = {}) {
  const actionLimit = options.actionLimit ?? 2;
  const leafCount = options.leafCount ?? 0;
  const runId = options.runId ?? 'run-1';
  const projectId = options.projectId ?? 'project-1';
  const now = new Date('2026-09-13T00:00:00.000Z');
  let monotonic = 1000;
  const compiled = compilePlanGraph({
    planKey: `mediator-authority-${actionLimit}`,
    planRevision: 1,
    objective: 'Test trusted delegated receipt finalization',
    scope: ['src/**'], outOfScope: [],
    milestones: [{
      key: 'core', dependsOn: [], criteria: ['Complete'], verification: 'Test',
      writeSet: ['src/**'], integrationCriteria: ['Integrated'],
      workstreams: [{
        key: 'api', criteria: ['API'], writeSet: ['src/api/**'],
        leaves: Array.from({ length: leafCount }, (_, index) => ({
          key: `handler-${index + 1}`,
          criteria: [`Handler ${index + 1}`],
          writeSet: [`src/api/handler-${index + 1}/**`]
        }))
      }]
    }],
    integrationCriteria: ['Integrated'], regressionCriteria: [], expectedSideEffects: [],
    policy: { authority: { operationClasses: ['process.exec'] } },
    budgets: {
      maxActiveExecutionOrchestrators: Math.max(1, leafCount), maxLeavesPerEO: Math.max(1, leafCount),
      maxGlobalDescendants: 1 + leafCount, maxCumulativeSpawns: 1 + leafCount,
      toolActionsGlobal: actionLimit, toolActionsEo: actionLimit,
      toolActionsLeaf: leafCount > 0 ? actionLimit : 1,
      tokensGlobal: Math.max(1, leafCount), tokensEo: Math.max(1, leafCount),
      tokensLeaf: Math.max(1, leafCount),
      costUsdGlobal: Math.max(1, leafCount), costUsdEo: Math.max(1, leafCount)
    },
    adapterRequirements: [], pauseRules: [], failureRules: [], cancelRules: [], completionRules: []
  });
  const controlPlane = createFakeTrustedControlPlane({ projectId, now: () => new Date(now) });
  const binding: AttestationChallengeParams = {
    planDigest: compiled.plan.digest as AttestationChallengeParams['planDigest'],
    graphDigest: compiled.graph.digest as AttestationChallengeParams['graphDigest'],
    planRevision: compiled.planRevision,
    projectId, hostSessionRef: 'host-session:fake', principalRef: 'principal:fake'
  };
  const approvalChallenge = await controlPlane.attestation.beginChallenge(binding);
  const approval = await controlPlane.attestation.recordApproval(approvalChallenge.challengeId, 'approved');
  const modeChallenge = await controlPlane.attestation.beginChallenge(binding);
  const modeSelection = await controlPlane.attestation.recordModeSelection(modeChallenge.challengeId, 'autonomous');
  const attestations = new Map<string, any>();
  const authorityAdapter = new InMemoryProtectedStoreAdapter();
  const authorityStore = new ProtectedControllerStore({ storeId: 'mediator-run-authority', adapter: authorityAdapter });
  const authorityWriter = await authorityStore.openWriter();
  let finalizeFailure = false;
  let actionCount: number | undefined = actionLimit;
  let sampleTimestamp = '2026-09-13T00:00:05.000Z';
  const finalize = jest.fn(async (): Promise<any> => {
    if (finalizeFailure) throw new Error('provider unavailable');
    return {
      source: 'trusted-meter', provider: 'trusted-provider', model: 'trusted-model',
      priceTableVersion: 'prices-v1', inputTokens: 0, outputTokens: 0,
      cost: { currency: 'USD', value: 0 },
      ...(actionCount === undefined ? {} : { actionCount }),
      confidence: 'authoritative' as const, timestamp: sampleTimestamp
    };
  });
  const commit = jest.fn(async () => undefined);
  let entropy = options.entropyStart ?? 0;
  const manager = createRunAuthorityManagerForTest({
    runId, projectId, compiled,
    reader: authorityStore.reader(), writer: authorityWriter,
    hostIdentityProvider: controlPlane.identity,
    attestationProvider: {
      reservePair: async request => {
        const verified = await controlPlane.attestation.verifyPair(
          request.approval, request.modeSelection, request.expected);
        if (!verified.ok) throw new Error(verified.reason);
        const reservationId = `attestation:${request.idempotencyKey}`;
        attestations.set(reservationId, {
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
        return { reservationId, idempotencyKey: request.idempotencyKey,
          expiresAt: '2026-09-13T00:05:00.000Z' };
      },
      verifyReservedPair: async reservationId => attestations.get(reservationId),
      reconcileReservedPair: async reservationId => attestations.get(reservationId) ?? null
    },
    usageMeter: {
      reserve: async request => ({
        providerReservationId: `provider:${request.idempotencyKey}`,
        idempotencyKey: request.idempotencyKey,
        opaqueScope: request.scope.opaqueScope
      }),
      finalize,
      commit,
      release: async () => undefined
    },
    usageBinding: {
      source: 'trusted-meter', provider: 'trusted-provider', model: 'trusted-model',
      priceTableVersion: 'prices-v1', currency: 'USD'
    }
  }, {
    now: () => new Date(now), monotonicClock: () => monotonic,
    clockDomainId: () => 'mediator-authority-clock',
    randomBytes: () => Buffer.alloc(32, ++entropy)
  });
  await manager.initialize({ idempotencyKey: 'initialize-mediator-authority', approval, modeSelection });
  const controller = await manager.acquireControllerLease();
  const eoNode = compiled.graph.payload.nodes.find(node => node.ownerRole === 'EXECUTION')!;
  const issued = await manager.issueExecutionTicket({
    operationId: 'issue-mediator-authority', controllerProof: controllerProof(controller),
    ticket: {
      nodeId: eoNode.nodeId, scope: 'api', roots: eoNode.writeSet,
      operationClasses: ['process.exec'], approvalRefs: [approval.verificationRef],
      budgets: {
        toolActionsGlobal: actionLimit, toolActionsEo: actionLimit,
        ...(leafCount > 0 ? { toolActionsLeaf: actionLimit } : {}),
        tokensGlobal: Math.max(1, leafCount), tokensEo: Math.max(1, leafCount),
        ...(leafCount > 0 ? { tokensLeaf: leafCount } : {}),
        costUsdGlobal: Math.max(1, leafCount), costUsdEo: Math.max(1, leafCount)
      },
      expiresAt: '2026-09-13T00:10:00.000Z', maxChildDepth: 1, maxFanout: Math.max(1, leafCount)
    }
  });
  let workstream = await manager.claimExecutionAndAcquireWorkstream({
    handle: issued.handle, controllerProof: controllerProof(controller)
  });
  const leaves = [] as Array<{ handle: OpaqueHandle; nodeId: string }>;
  const leafActionLimit = leafCount > 0 ? Math.floor(actionLimit / leafCount) : actionLimit;
  for (const [index, leafNode] of compiled.graph.payload.nodes
    .filter(node => node.ownerRole === 'LEAF').entries()) {
    const leaf = await manager.issueLeafTicket({
      operationId: `issue-mediator-leaf-${index + 1}`,
      workstreamProof: workstreamProof(workstream),
      ticket: {
        parentHandle: issued.handle,
        nodeId: leafNode.nodeId,
        scope: `handler-${index + 1}`,
        roots: leafNode.writeSet,
        operationClasses: ['process.exec'],
        approvalRefs: [approval.verificationRef],
        budgets: {
          toolActionsGlobal: leafActionLimit,
          toolActionsEo: leafActionLimit,
          toolActionsLeaf: leafActionLimit,
          tokensGlobal: 1,
          tokensEo: 1,
          tokensLeaf: 1,
          costUsdGlobal: 1,
          costUsdEo: 1
        },
        expiresAt: '2026-09-13T00:10:00.000Z',
        maxChildDepth: 0,
        maxFanout: 1
      }
    });
    leaves.push({ handle: leaf.handle, nodeId: leafNode.nodeId });
  }
  const mediationStore = options.store ?? new ProtectedControllerStore({
    storeId: 'mediator-trusted-finalization', adapter: new InMemoryProtectedStoreAdapter()
  });
  const mediationWriter = options.writer ?? await mediationStore.openWriter();
  let clock = new Date('2026-09-13T00:00:01.000Z');
  let grant: ResolvedActionAuthority | undefined;
  const grants = new Map<string, ResolvedActionAuthority>();
  let approvalsCurrent = true;
  let resultStartedAt = '2026-09-13T00:00:02.000Z';
  let resultEndedAt = '2026-09-13T00:00:03.000Z';
  const verifier = createRunAuthorityActionVerifier({
    manager,
    approvals: { areCurrent: async refs => approvalsCurrent && refs.includes(approval.verificationRef) }
  });
  const verify = jest.fn(async request => {
    grant = await verifier.verifyAndReserve(request);
    grants.set(request.handle, grant);
    return grant;
  });
  const execute = jest.fn(async request => ({
    ...successfulResult(request), startedAt: resultStartedAt, endedAt: resultEndedAt
  }));
  const host = createActionMediator({
    reader: mediationStore.reader(), writer: mediationWriter,
    authority: { verifyAndReserve: verify }, executors: [successfulExecutor(execute)],
    killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
    now: () => new Date(clock)
  });
  const authorizationOptions = {
    adapterKind: 'allowlisted-process', graphEpoch: 0, cancellationGeneration: 0,
    approvalRefs: [approval.verificationRef],
    leaseProof: {
      kind: 'workstream' as const,
      nodeId: eoNode.nodeId,
      leaseRef: workstream.leaseRef,
      generation: workstream.generation,
      fence: workstream.fence
    }
  };
  return {
    manager, backend: runAuthorityReportBackend(manager), host, store: mediationStore, authorityStore,
    writer: mediationWriter, handle: issued.handle, leaves, verify, execute, finalize, commit,
    options: authorizationOptions,
    grant: () => {
      if (!grant) throw new Error('Authority grant has not been verified');
      return grant;
    },
    grantFor(handle: string) {
      const value = grants.get(handle);
      if (!value) throw new Error(`Authority grant for ${handle} has not been verified`);
      return value;
    },
    setClock(value: string) { clock = new Date(value); },
    setFinalizeFailure(value: boolean) { finalizeFailure = value; },
    setApprovalsCurrent(value: boolean) { approvalsCurrent = value; },
    setActionCount(value: number | undefined) { actionCount = value; },
    setSampleTimestamp(value: string) { sampleTimestamp = value; },
    setResultWindow(startedAt: string, endedAt: string) {
      resultStartedAt = startedAt;
      resultEndedAt = endedAt;
    },
    async renewLease() {
      now.setTime(now.getTime() + 20_000);
      monotonic += 20_000;
      workstream = await manager.heartbeatWorkstreamLease({
        nodeId: eoNode.nodeId,
        proof: workstreamProof(workstream)
      });
      return {
        ...authorizationOptions,
        leaseProof: {
          kind: 'workstream' as const,
          nodeId: eoNode.nodeId,
          leaseRef: workstream.leaseRef,
          generation: workstream.generation,
          fence: workstream.fence
        }
      };
    }
  };
}

const authorization = {
  idempotencyKey: 'action-key-1',
  actionId: 'action-1',
  adapterKind: 'allowlisted-process',
  graphEpoch: 2,
  cancellationGeneration: 3,
  approvalRefs: ['approval-1']
} as const;

describe('mandatory ActionMediator', () => {
  test('persists canonical intent, revalidates, executes adapter, and seals strict receipt', async () => {
    let observedLifecycle: string | undefined;
    const fx = await fixture({ executor: successfulExecutor(async request => {
      const stored = await fx.store.reader().read<any>('intent/run-1');
      observedLifecycle = stored.status === 'active'
        ? stored.record.value.actions[0].lifecycle : undefined;
      return {
        resultClass: 'success', startedAt: '2026-09-13T00:00:02.000Z',
        endedAt: '2026-09-13T00:00:03.000Z', actualTargets: [],
        actualResources: [...request.declaredResources],
        inputMetadata: { argvDigest: deriveOperationMetadataBindings(request.action).argvDigest },
        resultMetadata: { durationMs: 1000, exitCode: 0 },
        workspaceBefore: { scope: [], entries: [] },
        workspaceAfter: { scope: [], entries: [] }, mutations: [], artifactHashes: []
      };
    }) });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    expect((await fx.store.reader().read<any>('intent/run-1')).status).toBe('active');
    if (!decision.allowed) return;
    fx.setClock('2026-09-13T00:00:04.000Z');
    const result = await fx.mediator.execute(decision.reservationId);
    expect(observedLifecycle).toBe('executing');
    expect(fx.verify).toHaveBeenCalledTimes(5);
    expect(fx.verify.mock.calls.map(call => call[0].phase)).toEqual([
      'authorize', 'pre-execute', 'pre-execute', 'effect', 'post-effect'
    ]);
    expect(result).toMatchObject({ resultClass: 'success' });
    expect(result.receiptRef).toMatch(/^receipt:/);
    expect(result.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result).not.toHaveProperty('receipt');
    const receipt = await fx.host.receiptEvidence(decision.reservationId);
    expect(receipt?.kind).toBe('action-receipt/v1');
    expect((receipt?.payload as any).usageStatus).toBe('pending');
    expect(receipt?.payload).not.toHaveProperty('adapterKind');
    expect(receipt?.payload).not.toHaveProperty('actualTargets');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(receipt?.payload)).toBe(true);
    const publicJson = JSON.stringify([decision, result]);
    for (const secret of [HANDLE, 'workstream-lease-1', 'budget-1', 'approval-1']) {
      expect(publicJson).not.toContain(secret);
    }
    for (const capabilityKey of ['authorityRef', 'handleLineage', 'leaseRef', 'leaseFence',
      'credentialClasses', 'eoLineageKey', 'providerReservationId', 'spawnChildTicketRef',
      'receipt', 'actionId']) {
      expect(publicJson).not.toContain(`"${capabilityKey}"`);
    }
    const stored = await fx.store.reader().read<any>('intent/run-1');
    if (stored.status !== 'active') throw new Error('Expected protected mediation state');
    expect(stored.record.value.actions[0].completion.actualResources).toHaveLength(1);
    expect(stored.record.value.actions[0].completion.actualResources[0])
      .toMatch(/^action-resource:[0-9a-f]{64}$/);
    expect(stored.record.value.actions[0].completion.actualResources[0]).not.toContain('allowlisted-binary');
  });

  test('same idempotency replays, conflicting reuse rejects, and action budget is cumulative', async () => {
    const fx = await fixture({ grant: authority({ localActionLimit: 1 }) });
    const first = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    const replay = await fx.mediator.authorize(HANDLE, { ...ACTION, argv: [...ACTION.argv] }, authorization);
    expect(replay).toEqual(first);
    expect(await fx.mediator.authorize(HANDLE, {
      ...ACTION, argv: ['allowlisted-binary', '--different']
    }, authorization))
      .toMatchObject({ allowed: false, code: 'idempotency-conflict' });
    expect(await fx.mediator.authorize(HANDLE, ACTION, {
      ...authorization, idempotencyKey: 'action-key-2', actionId: 'action-2'
    })).toMatchObject({ allowed: false, code: 'budget-exceeded' });
  });

  test('caller cannot reflect an opaque handle through public action identity', async () => {
    const fx = await fixture();
    const decision = await fx.mediator.authorize(HANDLE, ACTION, {
      ...authorization, actionId: HANDLE
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    fx.setClock('2026-09-13T00:00:04.000Z');
    const result = await fx.mediator.execute(decision.reservationId);
    expect(result.actionRef).toMatch(/^public-action:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain(HANDLE);
  });

  test('public denials sanitize authority, store, and kill-switch exception detail', async () => {
    const authoritySecret = `${HANDLE}:provider-secret`;
    const authorityFailure = await fixture({ verify: jest.fn(async () => {
      throw new Error(authoritySecret);
    }) });
    const authorityDecision = await authorityFailure.mediator.authorize(HANDLE, ACTION, authorization);
    expect(authorityDecision).toEqual({
      allowed: false, code: 'policy-denied', reason: 'Authority verification denied (policy-denied)'
    });
    expect(JSON.stringify(authorityDecision)).not.toContain(authoritySecret);

    const adapter = new InMemoryProtectedStoreAdapter();
    const store = new ProtectedControllerStore({ storeId: 'sanitized-store-error', adapter });
    const writer = await store.openWriter();
    const host = createActionMediator({
      reader: store.reader(),
      writer: { ...writer, compareAndSwap: async () => { throw new Error(`${HANDLE}:store-secret`); } },
      authority: { verifyAndReserve: async () => authority() },
      executors: [successfulExecutor()],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true })
    });
    const storeDecision = await host.mediator.authorize(HANDLE, ACTION, authorization);
    expect(storeDecision).toEqual({
      allowed: false, code: 'store-unavailable', reason: 'Protected mediation store unavailable'
    });
    expect(JSON.stringify(storeDecision)).not.toContain(HANDLE);

    const killed = await fixture();
    killed.killSwitch.disableEffects(`${HANDLE}:kill-secret`);
    expect(await killed.mediator.authorize(HANDLE, ACTION, authorization)).toEqual({
      allowed: false, code: 'kill-switch', reason: 'Run effects disabled'
    });
  });

  test('global action budget spans distinct authority handles', async () => {
    const secondHandle = createOpaqueHandle('second-trusted-action-handle');
    const fx = await fixture({ verify: jest.fn(async request => authority({
      authorityRef: request.handle,
      handleLineage: [request.handle],
      eoLineageKey: request.handle,
      globalActionLimit: 1,
      localActionLimit: 1,
      eoLineageActionLimit: 1
    })) });
    expect((await fx.mediator.authorize(HANDLE, ACTION, authorization)).allowed).toBe(true);
    expect(await fx.mediator.authorize(secondHandle, ACTION, {
      ...authorization, idempotencyKey: 'action-key-2', actionId: 'action-2'
    })).toMatchObject({ allowed: false, code: 'budget-exceeded' });
  });

  test('EO lineage budget includes direct EO actions and child LEAF actions', async () => {
    const eo = createOpaqueHandle('eo-lineage');
    const leaf = createOpaqueHandle('eo-lineage-leaf');
    const otherEo = createOpaqueHandle('other-eo-lineage');
    const grants = new Map<string, ResolvedActionAuthority>([
      [eo, authority({ authorityRef: eo, handleLineage: [eo], localActionLimit: 10,
        eoLineageKey: eo, eoLineageActionLimit: 2, globalActionLimit: 20 })],
      [leaf, authority({ authorityRef: leaf, parentAuthorityRef: eo, authorityGeneration: 5,
        recipientRole: 'LEAF', issuerRole: 'EXECUTION', handleLineage: [eo, leaf],
        localActionLimit: 10, eoLineageKey: eo, eoLineageActionLimit: 2, globalActionLimit: 20 })],
      [otherEo, authority({ authorityRef: otherEo, handleLineage: [otherEo], localActionLimit: 10,
        eoLineageKey: otherEo, eoLineageActionLimit: 2, globalActionLimit: 20 })]
    ]);
    const fx = await fixture({ verify: jest.fn(async request => grants.get(request.handle)!) });
    const authorize = (handle: string, ordinal: string) => fx.mediator.authorize(handle, ACTION, {
      ...authorization, actionId: `lineage-action-${ordinal}`, idempotencyKey: `lineage-key-${ordinal}`
    });
    expect((await authorize(eo, 'eo')).allowed).toBe(true);
    expect((await authorize(leaf, 'leaf')).allowed).toBe(true);
    expect(await authorize(leaf, 'exhausted')).toMatchObject({ allowed: false, code: 'budget-exceeded' });
    expect((await authorize(otherEo, 'other-eo')).allowed).toBe(true);
  });

  test('sibling LEAF authorities share their parent EO lineage limit', async () => {
    const eo = createOpaqueHandle('sibling-eo');
    const leafA = createOpaqueHandle('sibling-leaf-a');
    const leafB = createOpaqueHandle('sibling-leaf-b');
    const leafGrant = (handle: string): ResolvedActionAuthority => authority({
      authorityRef: handle, parentAuthorityRef: eo, authorityGeneration: 5,
      recipientRole: 'LEAF', issuerRole: 'EXECUTION', handleLineage: [eo, handle],
      localActionLimit: 2, eoLineageKey: eo, eoLineageActionLimit: 2, globalActionLimit: 20
    });
    const grants = new Map([[leafA, leafGrant(leafA)], [leafB, leafGrant(leafB)]]);
    const fx = await fixture({ verify: jest.fn(async request => grants.get(request.handle)!) });
    const authorize = (handle: string, ordinal: string) => fx.mediator.authorize(handle, ACTION, {
      ...authorization, actionId: `sibling-action-${ordinal}`, idempotencyKey: `sibling-key-${ordinal}`
    });
    expect((await authorize(leafA, 'a')).allowed).toBe(true);
    expect((await authorize(leafB, 'b')).allowed).toBe(true);
    expect(await authorize(leafA, 'c')).toMatchObject({ allowed: false, code: 'budget-exceeded' });
  });

  test('executor registration is immutable and rejects unknown operation values', async () => {
    const operations: ActionOperation[] = ['process.exec'];
    const executor = { ...successfulExecutor(), operations };
    const fx = await fixture({ executor });
    operations.push('network.request');
    expect(await fx.mediator.authorize(HANDLE, {
      operation: 'network.request', url: 'https://example.test', method: 'GET',
      payloadDigest: D0,
      writeSet: [], sideEffectClass: 'external'
    }, { ...authorization, adapterKind: 'allowlisted-process' }))
      .toMatchObject({ allowed: false, code: 'unknown-operation' });

    await expect(fixture({ executor: {
      ...successfulExecutor(), operations: ['process.exec', 'process.exec']
    } })).rejects.toThrow('unknown or duplicate operations');
    await expect(fixture({ executor: {
      ...successfulExecutor(), requiredCredentialClasses: undefined as any
    } })).rejects.toThrow('registration is malformed');
  });

  test('forged handle, drift, approval, scope, write boundary, and unknown adapter fail before effect', async () => {
    const execute = jest.fn(async request => successfulResult(request));
    const fx = await fixture({ executor: successfulExecutor(execute) });
    await expect(fx.mediator.authorize(createOpaqueHandle('forged'), ACTION, authorization))
      .resolves.toMatchObject({ allowed: false, code: 'no-handle' });
    await expect(fx.mediator.authorize(HANDLE, ACTION, { ...authorization, graphEpoch: 99 }))
      .resolves.toMatchObject({ allowed: false, code: 'stale-generation' });
    const noApproval = await fixture({ grant: authority({ approvalsCurrent: false }) });
    await expect(noApproval.mediator.authorize(HANDLE, ACTION, authorization))
      .resolves.toMatchObject({ allowed: false, code: 'approval-invalid' });
    const noOperation = await fixture({ grant: authority({ operationClasses: [] }) });
    await expect(noOperation.mediator.authorize(HANDLE, ACTION, authorization))
      .resolves.toMatchObject({ allowed: false, code: 'policy-denied' });
    await expect(fx.mediator.authorize(HANDLE, {
      operation: 'fs.write', path: '../escape', contentDigest: D0, declaredBytes: 0,
      writeSet: ['src/**'], sideEffectClass: 'workspace'
    }, authorization)).resolves.toMatchObject({ allowed: false, code: 'invalid-request' });
    await expect(fx.mediator.authorize(HANDLE, ACTION, {
      ...authorization, adapterKind: 'model-callback'
    })).resolves.toMatchObject({ allowed: false, code: 'unknown-operation' });
    expect(execute).not.toHaveBeenCalled();
  });

  test('kill switch and live authority cancellation deny before execution starts', async () => {
    const execute = jest.fn(async request => successfulResult(request));
    const killed = await fixture({ executor: successfulExecutor(execute) });
    const first = await killed.mediator.authorize(HANDLE, ACTION, authorization);
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    killed.killSwitch.disableEffects('test halt');
    expect(await killed.mediator.execute(first.reservationId)).toMatchObject({
      resultClass: 'failure', failureReason: 'kill-switch-before-effect'
    });
    const deniedState = await killed.store.reader().read<any>('intent/run-1');
    if (deniedState.status !== 'active') throw new Error('Expected denied mediation state');
    expect(deniedState.record.value.actions[0]).toMatchObject({
      lifecycle: 'denied', startedAt: null
    });

    let cancellationActive = false;
    const cancelled = await fixture({ executor: successfulExecutor(execute), verify: jest.fn(async () => {
      if (cancellationActive) {
        const error = new Error('Run authority is cancelled');
        Object.assign(error, { code: 'cancelled' });
        throw error;
      }
      return authority();
    }) });
    const second = await cancelled.mediator.authorize(HANDLE, ACTION, authorization);
    expect(second.allowed).toBe(true);
    if (!second.allowed) return;
    cancellationActive = true;
    expect(await cancelled.mediator.authorize(HANDLE, ACTION, authorization)).toMatchObject({
      allowed: false, code: 'cancelled', reason: 'Authority verification denied (cancelled)'
    });
    const retained = await cancelled.store.reader().read<any>('intent/run-1');
    if (retained.status !== 'active') throw new Error('Expected retained mediation charge');
    expect(retained.record.value.actions).toHaveLength(1);
    expect(retained.record.value.actions[0].lifecycle).toBe('intent');
    expect(await cancelled.mediator.execute(second.reservationId)).toMatchObject({
      resultClass: 'failure', failureReason: 'authority-revalidation-denied:cancelled'
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('concurrent execute invokes adapter at most once and replay returns persisted receipt', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const execute = jest.fn(async request => {
      await gate;
      return successfulResult(request);
    });
    const fx = await fixture({ executor: successfulExecutor(execute) });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    fx.setClock('2026-09-13T00:00:04.000Z');
    const first = fx.mediator.execute(decision.reservationId);
    await new Promise(resolve => setImmediate(resolve));
    const second = fx.mediator.execute(decision.reservationId);
    await new Promise(resolve => setImmediate(resolve));
    release();
    const results = await Promise.all([first, second]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.some(result => result.resultClass === 'success')).toBe(true);
    expect((await fx.mediator.execute(decision.reservationId)).resultClass).toBe('success');
  });

  test('final live guard observes revocation committed during execution claim', async () => {
    const adapter = new InMemoryProtectedStoreAdapter();
    const store = new ProtectedControllerStore({ storeId: 'final-guard', adapter });
    const baseWriter = await store.openWriter();
    let revoked = false;
    const writer = {
      ...baseWriter,
      async compareAndSwap<T>(input: Parameters<typeof baseWriter.compareAndSwap<T>>[0]) {
        const committed = await baseWriter.compareAndSwap(input);
        if ((input.value as any)?.actions?.some((item: any) => item.lifecycle === 'executing')) {
          revoked = true;
        }
        return committed;
      }
    };
    const execute = jest.fn(async request => successfulResult(request));
    const verify = jest.fn(async () => authority({ approvalsCurrent: !revoked }));
    const host = createActionMediator({
      reader: store.reader(), writer, authority: { verifyAndReserve: verify },
      executors: [successfulExecutor(execute)],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date('2026-09-13T00:00:04.000Z')
    });
    const decision = await host.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(await host.mediator.execute(decision.reservationId)).toMatchObject({
      resultClass: 'uncertain', uncertaintyStatus: 'final-authority-generation-drift'
    });
    const uncertainState = await store.reader().read<any>('intent/run-1');
    if (uncertainState.status !== 'active') throw new Error('Expected uncertain mediation state');
    expect(uncertainState.record.value.actions[0]).toMatchObject({
      lifecycle: 'uncertain', startedAt: expect.any(String)
    });
    expect(verify).toHaveBeenCalledTimes(3);
    expect(execute).not.toHaveBeenCalled();
  });

  test('live binding permits heartbeat expiry extension and cumulative usage snapshots', async () => {
    let heartbeat = false;
    const verify = jest.fn(async () => authority(heartbeat ? {
      lease: { ...authority().lease, expiresAt: '2026-09-13T00:20:00.000Z' },
      usage: { ...authority().usage }
    } : {}));
    const fx = await fixture({ verify });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    heartbeat = true;
    expect(await fx.mediator.authorize(HANDLE, ACTION, authorization)).toEqual(decision);
    fx.setClock('2026-09-13T00:00:04.000Z');
    expect(await fx.mediator.execute(decision.reservationId)).toMatchObject({ resultClass: 'success' });
    expect(verify).toHaveBeenCalledTimes(6);
  });

  test('idempotent replay rejects narrowed live limits while retaining original charge', async () => {
    let narrowed = false;
    const fx = await fixture({ verify: jest.fn(async () => authority({
      localActionLimit: narrowed ? 1 : 2
    })) });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    narrowed = true;
    expect(await fx.mediator.authorize(HANDLE, ACTION, authorization)).toEqual({
      allowed: false, code: 'policy-denied', reason: 'Persisted authority binding changed'
    });
    const stored = await fx.store.reader().read<any>('intent/run-1');
    if (stored.status !== 'active') throw new Error('Expected retained mediation charge');
    expect(stored.record.value.actions).toHaveLength(1);
  });

  test.each([
    ['cancellation generation', { cancellationGeneration: 4 }],
    ['lease fence', { lease: { ...authority().lease, fence: 7 } }],
    ['approval revocation', { approvalsCurrent: false }]
  ] as const)('effect guard rejects %s changed during adapter preparation', async (_name, drift) => {
    let prepared = false;
    let effects = 0;
    const verify = jest.fn(async () => authority(prepared ? drift : {}));
    const executor: StructuredActionExecutor = {
      kind: 'allowlisted-process', operations: ['process.exec'], validate: () => true,
      requiredCredentialClasses: () => [],
      async execute(request, guard) {
        prepared = true;
        await guard.assertCurrent();
        effects += 1;
        return successfulResult(request);
      }
    };
    const fx = await fixture({ verify, executor });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(await fx.mediator.execute(decision.reservationId)).toMatchObject({
      resultClass: 'uncertain', uncertaintyStatus: 'effect-guard-rejected'
    });
    expect(effects).toBe(0);
  });

  test.each([
    ['cancellation generation', { cancellationGeneration: 4 }],
    ['lease fence', { lease: { ...authority().lease, fence: 7 } }],
    ['approval revocation', { approvalsCurrent: false }]
  ] as const)('post-effect authority refresh rejects %s drift before receipt sealing', async (_name, drift) => {
    let effectReturned = false;
    let effects = 0;
    const verify = jest.fn(async request => authority(
      request.phase === 'post-effect' && effectReturned ? drift : {}
    ));
    const executor: StructuredActionExecutor = {
      kind: 'allowlisted-process', operations: ['process.exec'], validate: () => true,
      requiredCredentialClasses: () => [],
      async execute(request, guard) {
        await guard.assertCurrent();
        effects += 1;
        effectReturned = true;
        return successfulResult(request);
      }
    };
    const fx = await fixture({ verify, executor });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(await fx.mediator.execute(decision.reservationId)).toMatchObject({
      resultClass: 'uncertain', uncertaintyStatus: 'post-effect-authority-generation-drift'
    });
    expect(effects).toBe(1);
    expect(await fx.host.receiptEvidence(decision.reservationId)).toBeNull();
  });

  test.each(['omitted', 'duplicated'] as const)('%s effect guard cannot produce trusted success', async mode => {
    const executor: StructuredActionExecutor = {
      kind: 'allowlisted-process', operations: ['process.exec'], validate: () => true,
      requiredCredentialClasses: () => [],
      async execute(request, guard) {
        if (mode === 'duplicated') {
          await guard.assertCurrent();
          await guard.assertCurrent();
        }
        return successfulResult(request);
      }
    };
    const fx = await fixture({ executor });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(await fx.mediator.execute(decision.reservationId)).toMatchObject({
      resultClass: 'uncertain',
      uncertaintyStatus: mode === 'omitted' ? 'effect-guard-not-satisfied' : 'effect-guard-rejected'
    });
  });

  test('credential policy drift is checked before claim and again by effect guard', async () => {
    let required = ['vault-token'];
    let effects = 0;
    const executor: StructuredActionExecutor = {
      kind: 'allowlisted-process', operations: ['process.exec'], validate: () => true,
      requiredCredentialClasses: () => required,
      async execute(request, guard) {
        required = ['rotated-token'];
        await guard.assertCurrent();
        effects += 1;
        return successfulResult(request);
      }
    };
    const fx = await fixture({ executor, grant: authority({
      credentialClasses: ['rotated-token', 'vault-token']
    }) });
    const first = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    required = ['rotated-token'];
    expect(await fx.mediator.execute(first.reservationId)).toMatchObject({
      resultClass: 'failure', failureReason: 'executor-policy-drift'
    });
    expect(effects).toBe(0);

    required = ['vault-token'];
    const guarded = await fx.mediator.authorize(HANDLE, ACTION, {
      ...authorization, actionId: 'credential-guard-action', idempotencyKey: 'credential-guard-key'
    });
    expect(guarded.allowed).toBe(true);
    if (!guarded.allowed) return;
    expect(await fx.mediator.execute(guarded.reservationId)).toMatchObject({
      resultClass: 'uncertain', uncertaintyStatus: 'effect-guard-rejected'
    });
    expect(effects).toBe(0);
  });

  test('exact canonical resources are mandatory and caller cannot substitute raw resources', async () => {
    const execute = jest.fn(async request => ({
      ...successfulResult(request), actualResources: []
    }));
    const fx = await fixture({ executor: successfulExecutor(execute) });
    expect(await fx.mediator.authorize(HANDLE, ACTION, {
      ...authorization, declaredResources: ['https://secret.example/token']
    })).toMatchObject({ allowed: false, code: 'invalid-request' });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(await fx.mediator.execute(decision.reservationId)).toMatchObject({
      resultClass: 'uncertain', uncertaintyStatus: 'executor-target-boundary-violation'
    });

    const rawMetadata = await fixture({ executor: successfulExecutor(async request => ({
      ...successfulResult(request),
      inputMetadata: { executableRef: 'allowlisted-binary' }
    })) });
    const rawDecision = await rawMetadata.mediator.authorize(HANDLE, ACTION, authorization);
    expect(rawDecision.allowed).toBe(true);
    if (!rawDecision.allowed) return;
    rawMetadata.setClock('2026-09-13T00:00:04.000Z');
    expect(await rawMetadata.mediator.execute(rawDecision.reservationId)).toMatchObject({
      resultClass: 'uncertain', uncertaintyStatus: 'executor-metadata-not-redacted'
    });
  });

  test('ordered LEAF lineage preserves parent then child when lexical order is reversed', async () => {
    const parent = 'zz-parent-ticket';
    expect(parent > HANDLE).toBe(true);
    const fx = await fixture({ grant: authority({
      parentAuthorityRef: parent,
      recipientRole: 'LEAF', issuerRole: 'EXECUTION',
      handleLineage: [parent, HANDLE], eoLineageKey: parent
    }) });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    fx.setClock('2026-09-13T00:00:04.000Z');
    const result = await fx.mediator.execute(decision.reservationId);
    expect(result).toMatchObject({ resultClass: 'success' });
    expect(((await fx.host.receiptEvidence(decision.reservationId))?.payload as any)?.handleLineage)
      .toEqual([parent, HANDLE]);
  });

  test('controller-root actions share one pending authority-scoped usage reservation', async () => {
    const verify = jest.fn(async request => authority({
      authorityKind: 'controller-root', authorityRef: request.handle,
      parentAuthorityRef: null, authorityGeneration: null,
      nodeId: 'root-node', parentNodeId: null, issuerRole: null, recipientRole: 'PLAN_ROOT',
      handleLineage: [], spawnChildTicketRef: null, reportDestination: 'controller:root-node',
      eoLineageKey: null, eoLineageActionLimit: 2,
      lease: { kind: 'controller', ref: request.handle, generation: 1, fence: 1,
        acquiredAt: '2026-09-13T00:00:00.000Z', expiresAt: '2026-09-13T00:10:00.000Z' },
      usage: { ...authority().usage, reservationId: 'root-action:root-node',
        amounts: { toolActionsGlobal: 2 }, measuredUsageRequired: false }
    }));
    const adapter = new InMemoryProtectedStoreAdapter();
    const store = new ProtectedControllerStore({ storeId: 'root-actions', adapter });
    let clock = new Date('2026-09-13T00:00:01.000Z');
    const host = createActionMediator({
      reader: store.reader(), writer: await store.openWriter(),
      authority: { verifyAndReserve: verify },
      executors: [successfulExecutor()],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date(clock)
    });
    const first = await host.mediator.authorize(HANDLE, ACTION, {
      ...authorization, nodeId: 'root-node'
    });
    const second = await host.mediator.authorize(HANDLE, ACTION, {
      ...authorization, nodeId: 'root-node', actionId: 'action-2', idempotencyKey: 'action-key-2'
    });
    if (!first.allowed || !second.allowed) throw new Error(JSON.stringify([first, second]));
    clock = new Date('2026-09-13T00:00:04.000Z');
    expect(await host.mediator.execute(first.reservationId)).toMatchObject({ resultClass: 'success' });
    expect(await host.mediator.execute(second.reservationId)).toMatchObject({ resultClass: 'success' });
    const firstReceipt = await host.receiptEvidence(first.reservationId);
    const secondReceipt = await host.receiptEvidence(second.reservationId);
    expect((firstReceipt?.payload as any)?.usageStatus).toBe('pending');
    expect((firstReceipt?.payload as any)).not.toHaveProperty('usageFinal');
    expect((firstReceipt?.payload as any)?.usageReservationId)
      .toBe((secondReceipt?.payload as any)?.usageReservationId);
    expect(firstReceipt?.digest).not.toBe(secondReceipt?.digest);
  });

  test('pre-issued spawn ticket is bound once and executor cannot substitute it', async () => {
    const child = createOpaqueHandle('pre-issued-child');
    const spawnAction: StructuredAction = {
      operation: 'agent.spawn', agentRef: 'leaf-child', requestDigest: D0,
      writeSet: [], sideEffectClass: 'none'
    };
    const executor: StructuredActionExecutor = {
      kind: 'spawn-adapter', operations: ['agent.spawn'], validate: () => true,
      requiredCredentialClasses: () => [],
      async execute(request, guard) {
        await guard.assertCurrent();
        return {
          resultClass: 'success', startedAt: '2026-09-13T00:00:02.000Z',
          endedAt: '2026-09-13T00:00:03.000Z', actualTargets: [],
          actualResources: [...request.declaredResources],
          inputMetadata: deriveOperationMetadataBindings(request.action),
          resultMetadata: { childTicketRef: request.spawnChildTicketRef },
          workspaceBefore: { scope: [], entries: [] }, workspaceAfter: { scope: [], entries: [] },
          mutations: [], artifactHashes: []
        };
      }
    };
    const fx = await fixture({ executor, grant: authority({
      operationClasses: ['agent.spawn'], spawnChildTicketRef: child
    }) });
    const decisions = await Promise.all([
      fx.mediator.authorize(HANDLE, spawnAction, {
        ...authorization, adapterKind: 'spawn-adapter', targetNodeId: 'leaf-child'
      }),
      fx.mediator.authorize(HANDLE, spawnAction, {
        ...authorization, adapterKind: 'spawn-adapter', targetNodeId: 'leaf-child',
        actionId: 'spawn-action-2', idempotencyKey: 'spawn-key-2'
      })
    ]);
    expect(decisions.filter(item => item.allowed)).toHaveLength(1);
    expect(decisions).toContainEqual(expect.objectContaining({
      allowed: false, code: 'idempotency-conflict'
    }));
    const first = decisions.find(item => item.allowed);
    if (!first?.allowed) return;
    fx.setClock('2026-09-13T00:00:04.000Z');
    expect(await fx.mediator.execute(first.reservationId)).toMatchObject({ resultClass: 'success' });
    expect(((await fx.host.receiptEvidence(first.reservationId))?.payload as any)?.childTicketRef).toBe(child);

    const absent = await fixture({ executor, grant: authority({
      operationClasses: ['agent.spawn'], spawnChildTicketRef: null
    }) });
    expect(await absent.mediator.authorize(HANDLE, spawnAction, {
      ...authorization, adapterKind: 'spawn-adapter', targetNodeId: 'leaf-child'
    })).toMatchObject({ allowed: false, code: 'policy-denied' });

    const substituted = await fixture({ grant: authority({
      operationClasses: ['agent.spawn'], spawnChildTicketRef: child
    }), executor: {
      ...executor,
      async execute(request, guard) {
        await guard.assertCurrent();
        return {
          resultClass: 'success', startedAt: '2026-09-13T00:00:02.000Z',
          endedAt: '2026-09-13T00:00:03.000Z', actualTargets: [],
          actualResources: [...request.declaredResources],
          inputMetadata: deriveOperationMetadataBindings(request.action),
          resultMetadata: { childTicketRef: createOpaqueHandle('executor-invented-child') },
          workspaceBefore: { scope: [], entries: [] }, workspaceAfter: { scope: [], entries: [] },
          mutations: [], artifactHashes: []
        };
      }
    } });
    const substitutedDecision = await substituted.mediator.authorize(HANDLE, spawnAction, {
      ...authorization, adapterKind: 'spawn-adapter', targetNodeId: 'leaf-child'
    });
    expect(substitutedDecision.allowed).toBe(true);
    if (!substitutedDecision.allowed) return;
    substituted.setClock('2026-09-13T00:00:04.000Z');
    expect(await substituted.mediator.execute(substitutedDecision.reservationId)).toMatchObject({
      resultClass: 'uncertain', uncertaintyStatus: 'spawn-child-ticket-mismatch'
    });
  });

  test.each([
    ['failure', null],
    ['uncertain', null]
  ] as const)('spawn %s seals null child ticket without accepting executor invention', async (
    resultClass,
    childTicketRef
  ) => {
    const child = createOpaqueHandle(`pre-issued-${resultClass}-child`);
    const executor: StructuredActionExecutor = {
      kind: 'spawn-adapter', operations: ['agent.spawn'], validate: () => true,
      requiredCredentialClasses: () => [],
      async execute(request, guard) {
        await guard.assertCurrent();
        return {
          resultClass,
          ...(resultClass === 'uncertain' ? { uncertaintyStatus: 'spawn-outcome-unknown' } : {}),
          startedAt: '2026-09-13T00:00:02.000Z', endedAt: '2026-09-13T00:00:03.000Z',
          actualTargets: [], actualResources: [...request.declaredResources],
          inputMetadata: deriveOperationMetadataBindings(request.action),
          resultMetadata: {
            childTicketRef,
            errorCode: 'spawn-failed'
          },
          workspaceBefore: { scope: [], entries: [] }, workspaceAfter: { scope: [], entries: [] },
          mutations: [], artifactHashes: []
        };
      }
    };
    const fx = await fixture({ executor, grant: authority({
      operationClasses: ['agent.spawn'], spawnChildTicketRef: child
    }) });
    const decision = await fx.mediator.authorize(HANDLE, {
      operation: 'agent.spawn', agentRef: 'leaf-child', requestDigest: D0,
      writeSet: [], sideEffectClass: 'none'
    }, { ...authorization, adapterKind: 'spawn-adapter', targetNodeId: 'leaf-child' });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    fx.setClock('2026-09-13T00:00:04.000Z');
    expect(await fx.mediator.execute(decision.reservationId)).toMatchObject({ resultClass });
    expect(((await fx.host.receiptEvidence(decision.reservationId))?.payload as any)?.childTicketRef).toBeNull();
  });

  test.each([
    ['network.request', {
      operation: 'network.request', url: 'https://example.test/private', method: 'POST',
      payloadDigest: D0,
      writeSet: [], sideEffectClass: 'external'
    }],
    ['tool.invoke', {
      operation: 'tool.invoke', tool: 'deploy-tool', argumentsDigest: D0,
      writeSet: [], sideEffectClass: 'external'
    }]
  ] as const)('%s credential requirements come only from host executor policy', async (_name, action) => {
    const executor: StructuredActionExecutor = {
      kind: 'credentialed-effects', operations: ['network.request', 'tool.invoke'],
      validate: () => true,
      requiredCredentialClasses: () => ['vault-token'],
      execute: jest.fn()
    };
    const authorized = await fixture({ executor, grant: authority({
      operationClasses: ['network.request', 'tool.invoke'], toolClasses: ['deploy-tool'],
      credentialClasses: ['vault-token']
    }) });
    const implicit = await authorized.mediator.authorize(HANDLE, action as unknown as StructuredAction, {
      ...authorization, adapterKind: 'credentialed-effects'
    });
    expect(implicit.allowed).toBe(true);
    const persisted = await authorized.store.reader().read<any>('intent/run-1');
    if (persisted.status !== 'active') throw new Error('Expected credential-bound intent');
    expect(persisted.record.value.actions[0].credentialClasses).toEqual(['vault-token']);

    const explicitOmission = await fixture({ executor, grant: authority({
      operationClasses: ['network.request', 'tool.invoke'], toolClasses: ['deploy-tool'],
      credentialClasses: ['vault-token']
    }) });
    expect(await explicitOmission.mediator.authorize(HANDLE, action as unknown as StructuredAction, {
      ...authorization, adapterKind: 'credentialed-effects', credentialClasses: []
    })).toMatchObject({ allowed: false, code: 'policy-denied' });

    const outsideAuthority = await fixture({ executor, grant: authority({
      operationClasses: ['network.request', 'tool.invoke'], toolClasses: ['deploy-tool'],
      credentialClasses: []
    }) });
    expect(await outsideAuthority.mediator.authorize(HANDLE, action as unknown as StructuredAction, {
      ...authorization, adapterKind: 'credentialed-effects'
    })).toMatchObject({ allowed: false, code: 'policy-denied' });

    const unavailable = await fixture({ executor: {
      ...executor,
      requiredCredentialClasses: () => { throw new Error(`${HANDLE}:credential-provider-secret`); }
    }, grant: authority({
      operationClasses: ['network.request', 'tool.invoke'], toolClasses: ['deploy-tool'],
      credentialClasses: ['vault-token']
    }) });
    const unavailableDecision = await unavailable.mediator.authorize(
      HANDLE,
      action as unknown as StructuredAction,
      { ...authorization, adapterKind: 'credentialed-effects' }
    );
    expect(unavailableDecision).toEqual({
      allowed: false,
      code: 'policy-denied',
      reason: 'Structured executor credential policy unavailable'
    });
    expect(JSON.stringify(unavailableDecision)).not.toContain(HANDLE);
  });

  test('concurrent conflicting reconciliation preserves first terminal envelope byte-identically', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ordinal = 0;
    const executor: StructuredActionExecutor = {
      ...successfulExecutor(async () => { throw new Error('initial outcome unavailable'); }),
      reconcile: jest.fn(async request => {
        const current = ++ordinal;
        await gate;
        return {
          ...successfulResult(request),
          artifactHashes: [current === 1 ? D0 : D1]
        };
      })
    };
    const fx = await fixture({ executor });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    fx.setClock('2026-09-13T00:00:04.000Z');
    expect(await fx.mediator.execute(decision.reservationId)).toMatchObject({ resultClass: 'uncertain' });
    const left = fx.mediator.execute(decision.reservationId);
    const right = fx.mediator.execute(decision.reservationId);
    await new Promise(resolve => setImmediate(resolve));
    release();
    const outcomes = await Promise.all([left, right]);
    expect(outcomes.filter(item => item.resultClass === 'success')).toHaveLength(1);
    expect(outcomes).toContainEqual(expect.objectContaining({
      resultClass: 'uncertain', uncertaintyStatus: 'terminal-evidence-conflict'
    }));
    const firstEnvelope = await fx.host.receiptEvidence(decision.reservationId);
    const firstBytes = JSON.stringify(firstEnvelope);
    expect((await fx.mediator.execute(decision.reservationId)).resultClass).toBe('success');
    expect(JSON.stringify(await fx.host.receiptEvidence(decision.reservationId))).toBe(firstBytes);
  });

  test('executor throw and executing-without-reconciliation remain explicit uncertainty', async () => {
    const fx = await fixture({ executor: successfulExecutor(async () => {
      throw new Error('effect outcome hidden');
    }) });
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const result = await fx.mediator.execute(decision.reservationId);
    expect(result).toMatchObject({
      resultClass: 'uncertain', uncertaintyStatus: 'executor-threw-outcome-unknown'
    });
    expect(result).not.toHaveProperty('receiptRef');
    expect((await fx.mediator.execute(decision.reservationId)).uncertaintyStatus)
      .toBe('execution-outcome-unknown');
  });

  test('indeterminate receipt persistence never returns effect success', async () => {
    const adapter = new InMemoryProtectedStoreAdapter();
    const store = new ProtectedControllerStore({ storeId: 'indeterminate-receipt', adapter });
    const baseWriter = await store.openWriter();
    const execute = jest.fn(async request => successfulResult(request));
    let clock = new Date('2026-09-13T00:00:01.000Z');
    const writer = {
      ...baseWriter,
      async compareAndSwap<T>(input: Parameters<typeof baseWriter.compareAndSwap<T>>[0]) {
        const value = input.value as any;
        if (value?.actions?.some((item: any) => item.lifecycle === 'completed')) {
          throw new IndeterminateStoreCommitError('receipt commit unknown');
        }
        return baseWriter.compareAndSwap(input);
      }
    };
    const host = createActionMediator({
      reader: store.reader(), writer,
      authority: { verifyAndReserve: async () => authority() },
      executors: [successfulExecutor(execute)],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date(clock)
    });
    const decision = await host.mediator.authorize(HANDLE, ACTION, authorization);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    clock = new Date('2026-09-13T00:00:04.000Z');
    const result = await host.mediator.execute(decision.reservationId);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.resultClass).toBe('uncertain');
    expect(result.uncertaintyStatus).toBe('receipt-persistence-indeterminate');
    expect(result).not.toHaveProperty('receiptRef');
  });

  test('leaf authority cannot spawn and model command/callback fields never become authority', async () => {
    const spawnExecutor: StructuredActionExecutor = {
      kind: 'spawn-adapter', operations: ['agent.spawn'], validate: () => true,
      requiredCredentialClasses: () => [], execute: jest.fn()
    };
    const fx = await fixture({
      grant: authority({
        recipientRole: 'LEAF', issuerRole: 'EXECUTION', parentAuthorityRef: 'parent-ticket',
        parentNodeId: 'execution-node', handleLineage: ['parent-ticket', HANDLE],
        operationClasses: ['agent.spawn']
      }),
      executor: spawnExecutor
    });
    expect(await fx.mediator.authorize(HANDLE, {
      operation: 'agent.spawn', agentRef: 'agent', requestDigest: D0,
      writeSet: [], sideEffectClass: 'none'
    }, { ...authorization, adapterKind: 'spawn-adapter', targetNodeId: 'leaf-child' }))
      .toMatchObject({ allowed: false, code: 'policy-denied' });
    expect(await fx.mediator.authorize(HANDLE, {
      ...ACTION, command: 'sh -c "evil"', callback: 'arbitrary'
    } as any, authorization)).toMatchObject({ allowed: false, code: 'invalid-request' });
  });

  test('authority role, lineage, lease, and pending-usage relations are validated together', async () => {
    for (const malformed of [
      authority({ handleLineage: ['other-ticket'] }),
      authority({ lease: { ...authority().lease, kind: 'controller' } }),
      authority({ usage: { ...authority().usage, descendantCommitted: { toolActionsLeaf: 1 } } }),
      authority({ recipientRole: 'LEAF', issuerRole: 'EXECUTION', parentAuthorityRef: null })
    ]) {
      const fx = await fixture({ grant: malformed });
      expect(await fx.mediator.authorize(HANDLE, ACTION, authorization))
        .toMatchObject({ allowed: false, code: 'policy-denied' });
    }
  });

  test('oversized mediation aggregate fails closed before protected-store limit', async () => {
    const fx = await fixture();
    const largeAction: StructuredAction = {
      ...ACTION,
      argv: ['allowlisted-binary', ...Array.from({ length: 61 }, (_, index) =>
        `${index}:`.padEnd(15 * 1024, 'x'))]
    };
    expect(await fx.mediator.authorize(HANDLE, largeAction, authorization)).toEqual({
      allowed: false, code: 'store-unavailable', reason: 'Protected mediation store unavailable'
    });
    expect((await fx.store.reader().read('intent/run-1')).status).toBe('missing');
  });

  test('workspace, credential, node, and spawn bindings cannot be omitted or redirected', async () => {
    const fx = await fixture({ grant: authority({
      operationClasses: ['agent.spawn', 'git.mutate', 'network.request'],
      credentialClasses: ['registry-write'], writeSet: ['src/**']
    }), executor: {
      kind: 'bounded-effects', operations: ['agent.spawn', 'git.mutate', 'network.request'],
      validate: () => true,
      requiredCredentialClasses: request => request.action.operation === 'network.request'
        ? ['registry-write'] : [],
      execute: jest.fn()
    } });
    expect(await fx.mediator.authorize(HANDLE, {
      operation: 'git.mutate', args: ['commit'], writeSet: [], sideEffectClass: 'workspace'
    }, { ...authorization, adapterKind: 'bounded-effects' }))
      .toMatchObject({ allowed: false, code: 'write-set-violation' });
    expect(await fx.mediator.authorize(HANDLE, {
      operation: 'network.request', url: 'https://example.test', method: 'GET',
      payloadDigest: D0,
      writeSet: [], sideEffectClass: 'credential'
    }, { ...authorization, adapterKind: 'bounded-effects', credentialClasses: [] }))
      .toMatchObject({ allowed: false, code: 'policy-denied' });
    expect(await fx.mediator.authorize(HANDLE, {
      operation: 'network.request', url: 'https://example.test', method: 'GET',
      payloadDigest: D0,
      writeSet: [], sideEffectClass: 'external'
    }, { ...authorization, adapterKind: 'bounded-effects', nodeId: 'other-node' }))
      .toMatchObject({ allowed: false, code: 'policy-denied' });
    expect(await fx.mediator.authorize(HANDLE, {
      operation: 'agent.spawn', agentRef: 'other-child', requestDigest: D0,
      writeSet: [], sideEffectClass: 'none'
    }, { ...authorization, adapterKind: 'bounded-effects', targetNodeId: 'leaf-child' }))
      .toMatchObject({ allowed: false, code: 'policy-denied' });
  });

  test('finalizes delegated multi-action receipts once in action order without replaying effects', async () => {
    const fx = await trustedDelegatedFixture();
    const firstOptions = { ...fx.options, idempotencyKey: 'action-key-1', actionId: 'action-1' };
    const secondOptions = { ...fx.options, idempotencyKey: 'action-key-2', actionId: 'action-2' };
    const first = await fx.host.mediator.authorize(fx.handle, ACTION, firstOptions);
    const second = await fx.host.mediator.authorize(fx.handle, ACTION, secondOptions);
    if (!first.allowed || !second.allowed) throw new Error(JSON.stringify([first, second]));
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(first.reservationId);
    await fx.host.mediator.execute(second.reservationId);
    const firstPending = await fx.host.receiptEvidence(first.reservationId);
    const secondPending = await fx.host.receiptEvidence(second.reservationId);
    const scope = actionReceiptAuthorityScope(fx.grant()) as Readonly<DelegatedReceiptAuthorityScope>;
    await expect(fx.host.terminalReceipts({ ...scope, leaseFence: scope.leaseFence + 1 } as any))
      .rejects.toMatchObject({ code: 'scope-mismatch' });
    const finalizeCalls = fx.finalize.mock.calls.length;
    await expect(fx.host.finalizeDelegatedReceipts({
      ...scope, leaseFence: scope.leaseFence + 1
    } as any, fx.backend)).rejects.toMatchObject({ code: 'scope-mismatch' });
    expect(fx.finalize).toHaveBeenCalledTimes(finalizeCalls);
    fx.setFinalizeFailure(true);
    await expect(fx.host.finalizeDelegatedReceipts(scope as any, fx.backend))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    const settling = await fx.store.reader().read<any>('intent/run-1');
    expect(settling.status === 'active' &&
      settling.record.value.finalizedAuthorities[0]).toMatchObject({ status: 'settling', usage: null });
    const renewedOptions = await fx.renewLease();
    expect(await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...renewedOptions, idempotencyKey: 'action-key-frozen', actionId: 'action-frozen'
    })).toMatchObject({ allowed: false, code: 'policy-denied' });
    const heartbeatScope = actionReceiptAuthorityScope(fx.grant()) as Readonly<DelegatedReceiptAuthorityScope>;
    expect({
      leaseRef: heartbeatScope.leaseRef,
      leaseGeneration: heartbeatScope.leaseGeneration,
      leaseFence: heartbeatScope.leaseFence
    }).toEqual({
      leaseRef: scope.leaseRef,
      leaseGeneration: scope.leaseGeneration,
      leaseFence: scope.leaseFence
    });
    const renewedScope = {
      ...heartbeatScope,
      leaseGeneration: heartbeatScope.leaseGeneration + 1,
      leaseFence: heartbeatScope.leaseFence + 1
    };
    const beforeRenewedFinalize = fx.finalize.mock.calls.length;
    await expect(fx.host.finalizeDelegatedReceipts(renewedScope as any, fx.backend))
      .rejects.toMatchObject({ code: 'scope-mismatch' });
    expect(fx.finalize).toHaveBeenCalledTimes(beforeRenewedFinalize);
    const frozen = await fx.store.reader().read<any>('intent/run-1');
    expect(frozen.status === 'active' && frozen.record.value.finalizedAuthorities).toHaveLength(1);
    fx.setFinalizeFailure(false);
    const projected = await fx.host.finalizeDelegatedReceipts(scope as any, fx.backend);
    expect(projected.receipts.map(receipt => (receipt.payload as any).actionId))
      .toEqual(['action-1', 'action-2']);
    expect(projected.receipts.every(receipt => (receipt.payload as any).usageStatus === 'committed'))
      .toBe(true);
    expect((projected.receipts[0].payload as any).preliminaryReceiptDigest).toBe(firstPending?.digest);
    expect((projected.receipts[1].payload as any).preliminaryReceiptDigest).toBe(secondPending?.digest);
    expect(projected.receipts[0].id).not.toBe(firstPending?.id);
    expect(projected.receipts[1].id).not.toBe(secondPending?.id);
    expect(fx.execute).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(projected.receipts[0].payload)).toBe(true);

    const replayBytes = JSON.stringify(projected);
    expect(JSON.stringify(await fx.host.finalizeDelegatedReceipts(scope as any, fx.backend))).toBe(replayBytes);
    expect(fx.execute).toHaveBeenCalledTimes(2);
    expect((await fx.host.preliminaryReceiptEvidence(first.reservationId))?.id).toBe(firstPending?.id);
    expect((await fx.host.receiptEvidence(first.reservationId))?.id).toBe(projected.receipts[0].id);
    expect((await fx.host.terminalReceipts(scope)).map(receipt => receipt.id))
      .toEqual(projected.receipts.map(receipt => receipt.id));
    expect(await fx.host.mediator.authorize(fx.handle, ACTION, firstOptions)).toEqual(first);
    expect(await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: 'action-key-3', actionId: 'action-3'
    })).toMatchObject({ allowed: false, code: 'policy-denied' });

    const restarted = createActionMediator({
      reader: fx.store.reader(), writer: fx.writer,
      authority: { verifyAndReserve: fx.verify }, executors: [successfulExecutor(fx.execute)],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date('2026-09-13T00:00:06.000Z')
    });
    expect(JSON.stringify(await restarted.finalizeDelegatedReceipts(scope as any, fx.backend))).toBe(replayBytes);
    expect(fx.execute).toHaveBeenCalledTimes(2);
  });

  test('late trusted settlement preserves effect-time receipt acceptance across replay and restart', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 1 });
    const options = { ...fx.options, idempotencyKey: 'late-settlement', actionId: 'late-settlement' };
    const decision = await fx.host.mediator.authorize(fx.handle, ACTION, options);
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(decision.reservationId);
    const preliminaryState = await fx.store.reader().read<any>('intent/run-1');
    if (preliminaryState.status !== 'active') throw new Error('Expected completed preliminary receipt');
    const storedAction = preliminaryState.record.value.actions[0];
    expect(preliminaryState.record.value.schemaVersion).toBe(9);
    expect(storedAction.schemaVersion).toBe(9);
    expect(storedAction.completion.receiptReceivedAt).toBe('2026-09-13T00:00:04.000Z');
    expect(Date.parse(storedAction.completion.receiptReceivedAt))
      .toBeLessThan(Date.parse(storedAction.authority.lease.expiresAt));

    fx.setSampleTimestamp('2026-09-13T00:01:00.000Z');
    expect(Date.parse('2026-09-13T00:01:00.000Z'))
      .toBeGreaterThan(Date.parse(storedAction.authority.lease.expiresAt));
    expect(Date.parse('2026-09-13T00:01:00.000Z'))
      .toBeLessThan(Date.parse(storedAction.authority.usage.deadlineAt));
    const commitCalls = fx.commit.mock.calls.length;
    const scope = actionReceiptAuthorityScope(fx.grant());
    const projected = await fx.host.finalizeDelegatedReceipts(scope as any, fx.backend);
    expect(fx.commit).toHaveBeenCalledTimes(commitCalls + 1);
    expect(projected.receipts).toHaveLength(1);
    expect((projected.receipts[0].payload as any).usageFinal.timestamp)
      .toBe('2026-09-13T00:01:00.000Z');
    const persisted = await fx.store.reader().read<any>('intent/run-1');
    expect(persisted.status === 'active' && persisted.record.value.finalizedAuthorities[0])
      .toMatchObject({ status: 'finalized', usage: { final: { timestamp: '2026-09-13T00:01:00.000Z' } } });

    const bytes = JSON.stringify(projected);
    expect(JSON.stringify(await fx.host.finalizeDelegatedReceipts(scope as any, fx.backend))).toBe(bytes);
    expect(fx.commit).toHaveBeenCalledTimes(commitCalls + 1);
    const restarted = createActionMediator({
      reader: fx.store.reader(), writer: fx.writer,
      authority: { verifyAndReserve: fx.verify }, executors: [successfulExecutor(fx.execute)],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date('2026-09-13T00:01:01.000Z')
    });
    expect(JSON.stringify(await restarted.finalizeDelegatedReceipts(scope as any, fx.backend))).toBe(bytes);
    expect(fx.commit).toHaveBeenCalledTimes(commitCalls + 1);
    expect(fx.execute).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['before effect end', '2026-09-13T00:00:02.999Z'],
    ['after lease expiry', '2026-09-13T00:10:00.000Z']
  ])('rejects receiptReceivedAt tampering %s before any effect', async (_label, receiptReceivedAt) => {
    const fx = await fixture();
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.mediator.execute(decision.reservationId);
    const persisted = await fx.store.reader().read<any>('intent/run-1');
    if (persisted.status !== 'active') throw new Error('Expected completed action');
    const value = JSON.parse(JSON.stringify(persisted.record.value));
    value.actions[0].completion.receiptReceivedAt = receiptReceivedAt;
    value.actions[0].completionDigest = computeStoredActionCompletionDigest(value.actions[0]);
    const store = new ProtectedControllerStore({
      storeId: `receipt-time-tamper-${receiptReceivedAt}`,
      adapter: new InMemoryProtectedStoreAdapter()
    });
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'intent/run-1', expectedGeneration: 0, value });
    const execute = jest.fn();
    const restarted = createActionMediator({
      reader: store.reader(), writer,
      authority: { verifyAndReserve: fx.verify }, executors: [successfulExecutor(execute)],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date('2026-09-13T00:00:05.000Z')
    });
    await expect(restarted.receiptEvidence(decision.reservationId)).rejects.toThrow(/Protected/);
    expect(execute).not.toHaveBeenCalled();
  });

  test('rejects protected completion tampering when its digest is unchanged', async () => {
    const fx = await fixture();
    const decision = await fx.mediator.authorize(HANDLE, ACTION, authorization);
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.mediator.execute(decision.reservationId);
    const persisted = await fx.store.reader().read<any>('intent/run-1');
    if (persisted.status !== 'active') throw new Error('Expected completed action');
    const corruptions: Array<[string, (completion: any) => void]> = [
      ['result metadata', completion => { completion.resultMetadata.durationMs = 1001; }],
      ['workspace', completion => { completion.workspaceAfter.scope = ['src/**']; }],
      ['result class', completion => { completion.resultClass = 'failure'; }],
      ['receipt arrival', completion => {
        completion.receiptReceivedAt = '2026-09-13T00:00:04.500Z';
      }]
    ];
    for (const [label, corrupt] of corruptions) {
      const value = JSON.parse(JSON.stringify(persisted.record.value));
      corrupt(value.actions[0].completion);
      const store = new ProtectedControllerStore({
        storeId: `completion-digest-tamper-${label}`,
        adapter: new InMemoryProtectedStoreAdapter()
      });
      const writer = await store.openWriter();
      await writer.compareAndSwap({ key: 'intent/run-1', expectedGeneration: 0, value });
      const execute = jest.fn();
      const restarted = createActionMediator({
        reader: store.reader(), writer,
        authority: { verifyAndReserve: fx.verify }, executors: [successfulExecutor(execute)],
        killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true })
      });
      await expect(restarted.receiptEvidence(decision.reservationId))
        .rejects.toThrow('Protected executor completion binding is inconsistent');
      expect(execute).not.toHaveBeenCalled();
    }
  });

  test('rejects resealed receipt payloads when protected completion is fixed', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 1 });
    const decision = await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: 'fixed-completion', actionId: 'fixed-completion'
    });
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(decision.reservationId);
    await fx.host.finalizeDelegatedReceipts(actionReceiptAuthorityScope(fx.grant()) as any, fx.backend);
    const persisted = await fx.store.reader().read<any>('intent/run-1');
    if (persisted.status !== 'active') throw new Error('Expected finalized action');
    for (const field of ['receipt', 'finalizedReceipt'] as const) {
      const value = JSON.parse(JSON.stringify(persisted.record.value));
      const envelope = value.actions[0][field];
      value.actions[0][field] = sealContract('action-receipt/v1', envelope.id, {
        ...envelope.payload,
        executorCompletionDigest: D0
      });
      const store = new ProtectedControllerStore({
        storeId: `fixed-completion-${field}`,
        adapter: new InMemoryProtectedStoreAdapter()
      });
      const writer = await store.openWriter();
      await writer.compareAndSwap({ key: 'intent/run-1', expectedGeneration: 0, value });
      const restarted = createActionMediator({
        reader: store.reader(), writer,
        authority: { verifyAndReserve: fx.verify }, executors: [successfulExecutor()],
        killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true })
      });
      await expect(restarted.receiptEvidence(decision.reservationId)).rejects.toThrow(/Protected/);
    }
  });

  test('recomputed completion digest still requires both deterministic receipt projections', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 1 });
    const decision = await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: 'redigested-completion', actionId: 'redigested-completion'
    });
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(decision.reservationId);
    await fx.host.finalizeDelegatedReceipts(actionReceiptAuthorityScope(fx.grant()) as any, fx.backend);
    const persisted = await fx.store.reader().read<any>('intent/run-1');
    if (persisted.status !== 'active') throw new Error('Expected finalized action');
    for (const resealPreliminary of [false, true]) {
      const value = JSON.parse(JSON.stringify(persisted.record.value));
      const action = value.actions[0];
      action.completion.resultMetadata.durationMs = 1001;
      action.completionDigest = computeStoredActionCompletionDigest(action);
      if (resealPreliminary) {
        action.receipt = sealContract('action-receipt/v1', action.receipt.id, {
          ...action.receipt.payload,
          resultMetadata: { ...action.receipt.payload.resultMetadata, durationMs: 1001 },
          executorCompletionDigest: action.completionDigest
        });
      }
      const store = new ProtectedControllerStore({
        storeId: `redigested-completion-${String(resealPreliminary)}`,
        adapter: new InMemoryProtectedStoreAdapter()
      });
      const writer = await store.openWriter();
      await writer.compareAndSwap({ key: 'intent/run-1', expectedGeneration: 0, value });
      const restarted = createActionMediator({
        reader: store.reader(), writer,
        authority: { verifyAndReserve: fx.verify }, executors: [successfulExecutor()],
        killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true })
      });
      await expect(restarted.receiptEvidence(decision.reservationId)).rejects.toThrow(/Protected/);
    }
  });

  test('does not execute a previously authorized intent after authority usage settles', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 1 });
    const decision = await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: 'frozen-before-effect', actionId: 'frozen-before-effect'
    });
    if (!decision.allowed) throw new Error('Expected action intent');
    await fx.manager.cancel();
    await expect(fx.host.mediator.execute(decision.reservationId)).resolves.toMatchObject({
      resultClass: 'failure',
      failureReason: 'authority-revalidation-denied:cancelled'
    });
    expect(fx.execute).not.toHaveBeenCalled();
    expect(await fx.host.receiptEvidence(decision.reservationId)).toBeNull();
  });

  test('does not treat cancellation settlement as strict receipt settlement', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 1 });
    const decision = await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: 'cancelled-finalization', actionId: 'cancelled-finalization'
    });
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(decision.reservationId);
    await fx.manager.cancel();
    const authorityState = await fx.authorityStore.reader().read<any>(
      authorityRunStoreKey('project-1', 'run-1')
    );
    expect(authorityState.status === 'active' && authorityState.record.value.providerUsage[0])
      .toMatchObject({ status: 'committed', finalizeConstraintKind: 'cancellation' });
    await expect(fx.host.finalizeDelegatedReceipts(
      actionReceiptAuthorityScope(fx.grant()) as any,
      fx.backend
    )).rejects.toMatchObject({ code: 'reservation-conflict' });
    expect((await fx.host.receiptEvidence(decision.reservationId))?.id)
      .toMatch(/^receipt:/);
  });

  test.each([
    ['under-reported', 2],
    ['over-reported', 4],
    ['missing', undefined]
  ] as const)('rejects %s delegated action count before provider commit', async (_label, measured) => {
    const fx = await trustedDelegatedFixture({ actionLimit: 3 });
    const first = await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: `count-${_label}-1`, actionId: `count-${_label}-1`, budgetCharge: 1
    });
    const second = await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: `count-${_label}-2`, actionId: `count-${_label}-2`, budgetCharge: 2
    });
    if (!first.allowed || !second.allowed) throw new Error('Expected action intents');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(first.reservationId);
    await fx.host.mediator.execute(second.reservationId);
    const preliminary = await fx.host.receiptEvidence(first.reservationId);
    fx.setActionCount(measured);
    const scope = actionReceiptAuthorityScope(fx.grant());
    await expect(fx.host.finalizeDelegatedReceipts(scope as any, fx.backend))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    expect(fx.commit).not.toHaveBeenCalled();
    expect((await fx.host.receiptEvidence(first.reservationId))?.id).toBe(preliminary?.id);
  });

  test.each([
    ['before latest effect', '2026-09-13T00:00:02.999Z'],
    ['after reservation deadline', '2026-09-13T00:10:00.001Z']
  ])('rejects usage sample %s before provider commit', async (_label, timestamp) => {
    const fx = await trustedDelegatedFixture({ actionLimit: 1 });
    const decision = await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: `window-${_label}`, actionId: `window-${_label}`
    });
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(decision.reservationId);
    fx.setSampleTimestamp(timestamp);
    await expect(fx.host.finalizeDelegatedReceipts(
      actionReceiptAuthorityScope(fx.grant()) as any,
      fx.backend
    )).rejects.toMatchObject({ code: 'reservation-unresolved' });
    expect(fx.commit).not.toHaveBeenCalled();
  });

  test('rejects changed settlement constraints after durable finalization claim', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 1 });
    const decision = await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: 'constraint-replay', actionId: 'constraint-replay'
    });
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(decision.reservationId);
    fx.setActionCount(0);
    const scope = actionReceiptAuthorityScope(fx.grant());
    await expect(fx.host.finalizeDelegatedReceipts(scope as any, fx.backend))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    const finalizeCalls = fx.finalize.mock.calls.length;
    await expect(fx.backend.settleAndReadUsage({
      runId: scope.runId,
      projectId: scope.projectId,
      reservationId: scope.reservationId,
      authorityKind: 'delegation-ticket',
      authorityRef: scope.authorityRef as string,
      nodeId: scope.nodeId,
      authorityInstanceId: scope.authorityInstanceId,
      usageBindingDigest: scope.usageBindingDigest,
      notBefore: '2026-09-13T00:00:03.000Z',
      expectedActionCount: 2
    })).rejects.toMatchObject({ code: 'reservation-conflict' });
    expect(fx.finalize).toHaveBeenCalledTimes(finalizeCalls);
    expect(fx.commit).not.toHaveBeenCalled();
  });

  test('settles EO usage child-first with inclusive descendant action count and window', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 5, leafCount: 2 });
    const [firstLeaf, secondLeaf] = fx.leaves;
    const authorize = async (handle: OpaqueHandle, key: string) => {
      const decision = await fx.host.mediator.authorize(handle, {
        ...ACTION, argv: ['allowlisted-binary', key]
      }, { ...fx.options, idempotencyKey: key, actionId: key });
      if (!decision.allowed) throw new Error(`Expected ${key} intent`);
      return decision;
    };

    fx.setResultWindow('2026-09-13T00:00:02.000Z', '2026-09-13T00:00:03.000Z');
    const parent = await authorize(fx.handle, 'eo-direct');
    fx.setClock('2026-09-13T00:00:03.000Z');
    await fx.host.mediator.execute(parent.reservationId);
    const firstChild = await authorize(firstLeaf.handle, 'leaf-one');
    fx.setResultWindow('2026-09-13T00:00:03.000Z', '2026-09-13T00:00:04.000Z');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(firstChild.reservationId);
    const secondChildA = await authorize(secondLeaf.handle, 'leaf-two-a');
    fx.setResultWindow('2026-09-13T00:00:04.000Z', '2026-09-13T00:00:05.000Z');
    fx.setClock('2026-09-13T00:00:05.000Z');
    await fx.host.mediator.execute(secondChildA.reservationId);
    const secondChildB = await authorize(secondLeaf.handle, 'leaf-two-b');
    fx.setResultWindow('2026-09-13T00:00:05.000Z', '2026-09-13T00:00:06.000Z');
    fx.setClock('2026-09-13T00:00:06.000Z');
    await fx.host.mediator.execute(secondChildB.reservationId);

    const parentScope = actionReceiptAuthorityScope(fx.grantFor(fx.handle));
    const parentFinalizeCalls = fx.finalize.mock.calls.length;
    await expect(fx.host.finalizeDelegatedReceipts(parentScope as any, fx.backend))
      .rejects.toMatchObject({ code: 'authority-not-terminal' });
    expect(fx.finalize).toHaveBeenCalledTimes(parentFinalizeCalls);

    fx.setActionCount(1);
    fx.setSampleTimestamp('2026-09-13T00:00:04.000Z');
    await fx.host.finalizeDelegatedReceipts(
      actionReceiptAuthorityScope(fx.grantFor(firstLeaf.handle)) as any,
      fx.backend
    );
    fx.setActionCount(2);
    fx.setSampleTimestamp('2026-09-13T00:00:06.000Z');
    await fx.host.finalizeDelegatedReceipts(
      actionReceiptAuthorityScope(fx.grantFor(secondLeaf.handle)) as any,
      fx.backend
    );

    fx.setActionCount(3);
    await expect(fx.host.finalizeDelegatedReceipts(parentScope as any, fx.backend))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    fx.setActionCount(4);
    fx.setSampleTimestamp('2026-09-13T00:00:05.999Z');
    await expect(fx.host.finalizeDelegatedReceipts(parentScope as any, fx.backend))
      .rejects.toMatchObject({ code: 'reservation-unresolved' });
    fx.setSampleTimestamp('2026-09-13T00:00:06.000Z');
    const projected = await fx.host.finalizeDelegatedReceipts(parentScope as any, fx.backend);
    expect(projected.usage.final.actionCount).toBe(4);
    expect(projected.usage.descendantCommitted).toMatchObject({
      toolActionsGlobal: 3,
      toolActionsEo: 3
    });
    expect(projected.usage.actual).toMatchObject({
      toolActionsGlobal: 1,
      toolActionsEo: 1
    });
    expect(projected.receipts).toHaveLength(1);
    expect(fx.commit).toHaveBeenCalledTimes(3);
  });

  test.each(['barrier', 'action'] as const)(
    'EO finalization and LEAF authorization race atomically with %s CAS winning',
    async winner => {
      const mediationStore = new ProtectedControllerStore({
        storeId: `eo-freeze-race-${winner}`,
        adapter: new InMemoryProtectedStoreAdapter()
      });
      const baseWriter = await mediationStore.openWriter();
      let racing = false;
      const firstAttempts = new Set<string>();
      let firstCommits = 0;
      let firstConflicts = 0;
      let releaseBoth!: () => void;
      const bothArrived = new Promise<void>(resolve => { releaseBoth = resolve; });
      let releaseWinner!: () => void;
      const winnerCommitted = new Promise<void>(resolve => { releaseWinner = resolve; });
      let releaseLoser!: () => void;
      const loserFinished = new Promise<void>(resolve => { releaseLoser = resolve; });
      const writer = {
        ...baseWriter,
        async compareAndSwap<T>(input: Parameters<typeof baseWriter.compareAndSwap<T>>[0]) {
          const value = input.value as any;
          const contender = value?.eoLineageBarriers?.length > 0
            ? 'barrier'
            : value?.actions?.some((item: any) => item.idempotencyKey === 'race-leaf')
              ? 'action' : null;
          if (racing && contender && !firstAttempts.has(contender)) {
            firstAttempts.add(contender);
            if (firstAttempts.size === 2) releaseBoth();
            await bothArrived;
            if (contender !== winner) await winnerCommitted;
            try {
              const committed = await baseWriter.compareAndSwap(input);
              firstCommits += 1;
              if (contender === winner) {
                releaseWinner();
                await loserFinished;
              }
              return committed;
            } catch (error) {
              if ((error as Error).name === 'CasConflictError') firstConflicts += 1;
              throw error;
            } finally {
              if (contender !== winner) releaseLoser();
            }
          }
          return baseWriter.compareAndSwap(input);
        }
      };
      const fx = await trustedDelegatedFixture({
        actionLimit: 2, leafCount: 1, store: mediationStore, writer
      });
      const parentOptions = {
        ...fx.options, idempotencyKey: 'race-parent', actionId: 'race-parent'
      };
      const parent = await fx.host.mediator.authorize(fx.handle, ACTION, parentOptions);
      if (!parent.allowed) throw new Error('Expected parent action intent');
      fx.setClock('2026-09-13T00:00:04.000Z');
      await fx.host.mediator.execute(parent.reservationId);
      fx.setActionCount(1);
      const parentScope = actionReceiptAuthorityScope(fx.grantFor(fx.handle));
      racing = true;
      const [parentResult, leafResult] = await Promise.allSettled([
        fx.host.finalizeDelegatedReceipts(parentScope as any, fx.backend),
        fx.host.mediator.authorize(fx.leaves[0].handle, ACTION, {
          ...fx.options, idempotencyKey: 'race-leaf', actionId: 'race-leaf'
        })
      ]);

      expect(firstAttempts).toEqual(new Set(['barrier', 'action']));
      expect(firstCommits).toBe(1);
      expect(firstConflicts).toBe(1);
      const persisted = await mediationStore.reader().read<any>('intent/run-1');
      if (persisted.status !== 'active') throw new Error('Expected raced mediation aggregate');
      if (winner === 'barrier') {
        expect(leafResult).toMatchObject({
          status: 'fulfilled', value: { allowed: false, code: 'policy-denied' }
        });
        expect(persisted.record.value.eoLineageBarriers).toHaveLength(1);
        expect(persisted.record.value.actions.some(
          (item: any) => item.idempotencyKey === 'race-leaf')).toBe(false);
        expect(await fx.host.mediator.authorize(fx.handle, ACTION, parentOptions)).toEqual(parent);
        expect(fx.execute).toHaveBeenCalledTimes(1);
      } else {
        expect(parentResult).toMatchObject({
          status: 'rejected', reason: { code: 'authority-not-terminal' }
        });
        expect(leafResult).toMatchObject({ status: 'fulfilled', value: { allowed: true } });
        expect(persisted.record.value.eoLineageBarriers).toHaveLength(0);
        expect(persisted.record.value.actions.some(
          (item: any) => item.idempotencyKey === 'race-leaf')).toBe(true);
      }
    }
  );

  test('finalizes completed effects while denied actions remain conservatively charged', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 2 });
    const first = await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: 'completed-before-denial', actionId: 'completed-before-denial'
    });
    if (!first.allowed) throw new Error('Expected first action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(first.reservationId);
    const denied = await fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: 'approval-denied-effect', actionId: 'approval-denied-effect'
    });
    if (!denied.allowed) throw new Error('Expected second action intent');
    fx.setApprovalsCurrent(false);
    await expect(fx.host.mediator.execute(denied.reservationId)).resolves.toMatchObject({
      resultClass: 'failure',
      failureReason: 'authority-generation-drift'
    });
    fx.setApprovalsCurrent(true);
    await expect(fx.host.mediator.authorize(fx.handle, ACTION, {
      ...fx.options, idempotencyKey: 'charged-after-denial', actionId: 'charged-after-denial'
    })).resolves.toMatchObject({ allowed: false, code: 'budget-exceeded' });
    fx.setActionCount(1);
    const projected = await fx.host.finalizeDelegatedReceipts(
      actionReceiptAuthorityScope(fx.grant()) as any,
      fx.backend
    );
    expect(projected.usage.final.actionCount).toBe(1);
    expect(projected.receipts).toHaveLength(1);
    expect(await fx.host.receiptEvidence(denied.reservationId)).toBeNull();
    expect(fx.execute).toHaveBeenCalledTimes(1);
  });

  test('root finalization computes one shared cumulative action sample and freezes root scope', async () => {
    const grant = authority({
      authorityKind: 'controller-root', authorityRef: HANDLE, parentAuthorityRef: null,
      authorityGeneration: null, nodeId: 'root-node', parentNodeId: null,
      issuerRole: null, recipientRole: 'PLAN_ROOT', handleLineage: [],
      reportDestination: 'controller:root-node',
      lease: { ...authority().lease, kind: 'controller', ref: HANDLE },
      globalActionLimit: 3, localActionLimit: 3, eoLineageKey: null, eoLineageActionLimit: 3,
      usage: {
        ...authority().usage,
        reservationId: 'root-action-budget-1',
        amounts: { toolActionsGlobal: 3 }
      }
    });
    const execute = jest.fn(async request => successfulResult(request));
    const fx = await fixture({ grant, executor: successfulExecutor(execute) });
    const rootOptions = { ...authorization, nodeId: 'root-node', budgetCharge: 2 };
    const first = await fx.mediator.authorize(HANDLE, ACTION, rootOptions);
    const second = await fx.mediator.authorize(HANDLE, ACTION, {
      ...rootOptions, idempotencyKey: 'root-action-key-2', actionId: 'root-action-2', budgetCharge: 1
    });
    if (!first.allowed || !second.allowed) throw new Error('Expected root intents');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.mediator.execute(first.reservationId);
    await fx.mediator.execute(second.reservationId);
    const projected = await fx.host.finalizeRootReceipts(actionReceiptAuthorityScope(grant) as any);
    expect(projected.usage.final).toMatchObject({
      source: 'harness-mdocs/action-mediator', actionCount: 3, confidence: 'authoritative'
    });
    expect(projected.usage.actual).toEqual({ toolActionsGlobal: 3 });
    expect(projected.receipts.map(receipt => (receipt.payload as any).usageSampleDigest))
      .toEqual([projected.usage.sampleDigest, projected.usage.sampleDigest]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await fx.mediator.authorize(HANDLE, ACTION, {
      ...rootOptions, idempotencyKey: 'root-action-key-3', actionId: 'root-action-3'
    })).toMatchObject({ allowed: false, code: 'policy-denied' });

    const persisted = await fx.store.reader().read<any>('intent/run-1');
    if (persisted.status !== 'active') throw new Error('Expected finalized root aggregate');
    const corruptions: Array<(value: any) => void> = [
      value => { value.actions[0].budgetCharge += 1; },
      value => {
        value.actions[0].endedAt = '2026-09-13T00:00:03.500Z';
        for (const field of ['receipt', 'finalizedReceipt']) {
          const envelope = value.actions[0][field];
          value.actions[0][field] = sealContract(
            'action-receipt/v1', envelope.id,
            { ...envelope.payload, endedAt: '2026-09-13T00:00:03.500Z' }
          );
        }
      },
      value => {
        const usage = value.finalizedAuthorities[0].usage;
        usage.final.actionCount = 2;
        usage.sampleDigest = computeUsageSampleDigest(usage.final);
        usage.actual.toolActionsGlobal = 2;
        for (const action of value.actions) {
          const envelope = action.finalizedReceipt;
          action.finalizedReceipt = sealContract('action-receipt/v1', envelope.id, {
            ...envelope.payload,
            usageFinal: usage.final,
            usageSampleDigest: usage.sampleDigest,
            usageActual: usage.actual
          });
        }
      }
    ];
    for (const [index, corrupt] of corruptions.entries()) {
      const value = JSON.parse(JSON.stringify(persisted.record.value));
      corrupt(value);
      const store = new ProtectedControllerStore({
        storeId: `root-restart-corruption-${index}`,
        adapter: new InMemoryProtectedStoreAdapter()
      });
      const writer = await store.openWriter();
      await writer.compareAndSwap({ key: 'intent/run-1', expectedGeneration: 0, value });
      const restarted = createActionMediator({
        reader: store.reader(), writer,
        authority: { verifyAndReserve: fx.verify },
        executors: [successfulExecutor()],
        killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
        now: () => new Date('2026-09-13T00:00:06.000Z')
      });
      await expect(restarted.terminalReceipts(actionReceiptAuthorityScope(grant)))
        .rejects.toThrow(/Protected/);
    }
  });

  test('root finalization spans sequential controller leases with stable scope and exact receipt fencing', async () => {
    const firstHandle = createOpaqueHandle('root-controller-lease-one');
    const secondHandle = createOpaqueHandle('root-controller-lease-two');
    const rootUsage = {
      ...authority().usage,
      reservationId: 'root-turnover-budget',
      amounts: { toolActionsGlobal: 3 },
      measuredUsageRequired: false
    };
    const rootGrant = (handle: OpaqueHandle, generation: number, fence: number,
      acquiredAt: string, expiresAt: string): ResolvedActionAuthority => authority({
      authorityKind: 'controller-root', authorityRef: handle, parentAuthorityRef: null,
      authorityGeneration: null, nodeId: 'root-node', parentNodeId: null,
      issuerRole: null, recipientRole: 'PLAN_ROOT', handleLineage: [],
      reportDestination: 'controller:root-node',
      lease: { kind: 'controller', ref: handle, generation, fence, acquiredAt, expiresAt },
      globalActionLimit: 3, localActionLimit: 3, eoLineageKey: null, eoLineageActionLimit: 3,
      usage: rootUsage
    });
    const firstGrant = rootGrant(
      firstHandle, 1, 1, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:03.050Z'
    );
    const secondGrant = rootGrant(
      secondHandle, 2, 2, '2026-09-13T00:00:03.100Z', '2026-09-13T00:10:00.000Z'
    );
    const grants = new Map<string, ResolvedActionAuthority>([
      [firstHandle, firstGrant], [secondHandle, secondGrant]
    ]);
    const verify = jest.fn(async request => {
      const grant = grants.get(request.handle);
      if (!grant) throw new Error('Unknown controller lease');
      return grant;
    });
    const execute = jest.fn(async request => ({
      ...successfulResult(request),
      startedAt: request.actionId === 'root-turnover-1'
        ? '2026-09-13T00:00:02.000Z' : '2026-09-13T00:00:03.200Z',
      endedAt: request.actionId === 'root-turnover-1'
        ? '2026-09-13T00:00:02.500Z' : '2026-09-13T00:00:03.500Z'
    }));
    const fx = await fixture({ verify, executor: successfulExecutor(execute) });
    const first = await fx.mediator.authorize(firstHandle, ACTION, {
      ...authorization, actionId: 'root-turnover-1', idempotencyKey: 'root-turnover-1',
      nodeId: 'root-node', budgetCharge: 2
    });
    if (!first.allowed) throw new Error('Expected first root intent');
    fx.setClock('2026-09-13T00:00:03.000Z');
    await fx.mediator.execute(first.reservationId);
    fx.setClock('2026-09-13T00:00:03.150Z');
    const second = await fx.mediator.authorize(secondHandle, ACTION, {
      ...authorization, actionId: 'root-turnover-2', idempotencyKey: 'root-turnover-2',
      nodeId: 'root-node', budgetCharge: 1
    });
    if (!second.allowed) throw new Error('Expected second root intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.mediator.execute(second.reservationId);

    const firstScope = actionReceiptAuthorityScope(firstGrant);
    const secondScope = actionReceiptAuthorityScope(secondGrant);
    const preliminary = [
      await fx.host.preliminaryReceiptEvidence(first.reservationId),
      await fx.host.preliminaryReceiptEvidence(second.reservationId)
    ];
    expect(firstScope).toEqual(secondScope);
    expect(firstScope).not.toHaveProperty('leaseRef');
    expect(firstScope).not.toHaveProperty('leaseGeneration');
    expect(firstScope).not.toHaveProperty('leaseFence');
    for (const [scope, code] of [
      [{ ...firstScope, reservationId: 'other-reservation' }, 'unknown-authority'],
      [{ ...firstScope, authorityInstanceId: D1 }, 'scope-mismatch'],
      [{ ...firstScope, approvedPlanDigest: D1 }, 'scope-mismatch'],
      [{ ...firstScope, approvedGraphDigest: D0 }, 'scope-mismatch'],
      [{ ...firstScope, nodeId: 'other-root' }, 'scope-mismatch'],
      [{ ...firstScope, leaseFence: 1 }, 'invalid-scope']
    ] as const) {
      await expect(fx.host.finalizeRootReceipts(scope as any)).rejects.toMatchObject({ code });
    }

    const projected = await fx.host.finalizeRootReceipts(firstScope as any);
    expect(projected.scope).toEqual(firstScope);
    expect(projected.usage.final.actionCount).toBe(3);
    expect(projected.usage.actual).toEqual({ toolActionsGlobal: 3 });
    expect(projected.receipts.map(receipt => (receipt.payload as any).actionId))
      .toEqual(['root-turnover-1', 'root-turnover-2']);
    expect(projected.receipts.map(receipt => ({
      ref: (receipt.payload as any).leaseRef,
      generation: (receipt.payload as any).leaseGeneration,
      fence: (receipt.payload as any).leaseFence
    }))).toEqual([
      { ref: firstHandle, generation: 1, fence: 1 },
      { ref: secondHandle, generation: 2, fence: 2 }
    ]);
    const persisted = await fx.store.reader().read<any>('intent/run-1');
    if (persisted.status !== 'active') throw new Error('Expected finalized root aggregate');
    expect(projected.receipts.map(receipt => (receipt.payload as any).executorCompletionDigest))
      .toEqual(persisted.record.value.actions.map((action: any) => action.completionDigest));
    expect(projected.receipts.map(receipt => (receipt.payload as any).executorCompletionDigest))
      .toEqual(preliminary.map(receipt => (receipt?.payload as any).executorCompletionDigest));
    const finalizedGeneration = persisted.record.generation;
    const bytes = JSON.stringify(projected);
    expect(JSON.stringify(await fx.host.finalizeRootReceipts(secondScope as any))).toBe(bytes);
    const replayed = await fx.store.reader().read<any>('intent/run-1');
    expect(replayed.status === 'active' && replayed.record.generation).toBe(finalizedGeneration);
    expect(replayed.status === 'active' && replayed.record.value.finalizedAuthorities).toHaveLength(1);
    const restarted = createActionMediator({
      reader: fx.store.reader(), writer: fx.writer, authority: { verifyAndReserve: verify },
      executors: [successfulExecutor(execute)],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date('2026-09-13T00:00:05.000Z')
    });
    expect(JSON.stringify(await restarted.finalizeRootReceipts(firstScope as any))).toBe(bytes);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test('rejects forged and cross-run report backends before settlement', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 1 });
    const options = { ...fx.options, idempotencyKey: 'nominal-action', actionId: 'nominal-action' };
    const decision = await fx.host.mediator.authorize(fx.handle, ACTION, options);
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(decision.reservationId);
    const scope = actionReceiptAuthorityScope(fx.grant());
    const forged = {
      settleAndReadUsage: jest.fn(),
      readUsage: jest.fn()
    };
    await expect(fx.host.finalizeDelegatedReceipts(scope as any, forged as any))
      .rejects.toMatchObject({ code: 'invalid-scope' });
    expect(forged.settleAndReadUsage).not.toHaveBeenCalled();
    const other = await trustedDelegatedFixture({
      actionLimit: 1, runId: 'run-other', projectId: 'project-other'
    });
    await expect(fx.host.finalizeDelegatedReceipts(scope as any, other.backend))
      .rejects.toMatchObject({ code: 'invalid-scope' });
    expect(other.finalize).not.toHaveBeenCalled();
    const otherManager = await trustedDelegatedFixture({ actionLimit: 1, entropyStart: 20 });
    await expect(fx.host.finalizeDelegatedReceipts(scope as any, otherManager.backend))
      .rejects.toMatchObject({ code: 'invalid-scope' });
    expect(otherManager.finalize).not.toHaveBeenCalled();
  });

  test('rejects consistently resealed EO finalization tampering during protected restart', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 1 });
    const options = { ...fx.options, idempotencyKey: 'integrity-action', actionId: 'integrity-action' };
    const decision = await fx.host.mediator.authorize(fx.handle, ACTION, options);
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(decision.reservationId);
    await fx.host.finalizeDelegatedReceipts(actionReceiptAuthorityScope(fx.grant()) as any, fx.backend);
    const persisted = await fx.store.reader().read<any>('intent/run-1');
    if (persisted.status !== 'active') throw new Error('Expected finalized mediation aggregate');
    const base = persisted.record.value;
    const reseal = (value: any, mutate: (payload: any) => void, id?: string) => {
      const current = value.actions[0].finalizedReceipt;
      const payload = JSON.parse(JSON.stringify(current.payload));
      mutate(payload);
      value.actions[0].finalizedReceipt = sealContract('action-receipt/v1', id ?? current.id, payload);
    };
    const corruptions: Array<(value: any) => void> = [
      value => {
        value.actions[0].budgetCharge += 1;
        resealIntentRequest(value.actions[0]);
      },
      value => {
        const action = value.actions[0];
        action.endedAt = '2026-09-13T00:00:03.500Z';
        action.receipt = sealContract('action-receipt/v1', action.receipt.id, {
          ...action.receipt.payload, endedAt: action.endedAt
        });
        resealFinalizedReceipts(value, value.finalizedAuthorities[0].usage);
      },
      value => {
        const usage = value.finalizedAuthorities[0].usage;
        usage.final.actionCount = 0;
        usage.sampleDigest = computeUsageSampleDigest(usage.final);
        usage.actual = deriveAuthorityUsageActual({
          amounts: usage.amounts,
          currency: usage.currency,
          sample: usage.final,
          descendantCommitted: usage.descendantCommitted
        });
        resealFinalizedReceipts(value, usage);
      },
      value => {
        const usage = value.finalizedAuthorities[0].usage;
        usage.descendantCommitted.toolActionsEo = 1;
        usage.actual = deriveAuthorityUsageActual({
          amounts: usage.amounts,
          currency: usage.currency,
          sample: usage.final,
          descendantCommitted: usage.descendantCommitted
        });
        resealFinalizedReceipts(value, usage);
      },
      value => { value.actions[0].action.argv[1] = '--malicious'; },
      value => reseal(value, payload => { payload.inputMetadata.argvDigest = D0; }),
      value => reseal(value, payload => { payload.workspaceAfter.scope = ['src/**']; }),
      value => reseal(value, payload => { payload.resultMetadata.exitCode = 9; }),
      value => reseal(value, payload => { payload.leaseFence += 1; }),
      value => reseal(value, payload => { payload.usageActual.toolActionsEo = 0; }),
      value => reseal(value, () => undefined, 'receipt-final:malicious-id'),
      value => { value.actions[0].finalizedReceipt.digest = D0; }
    ];
    for (const corrupt of corruptions) {
      const value = JSON.parse(JSON.stringify(base));
      corrupt(value);
      const store = new ProtectedControllerStore({
        storeId: `tampered-final-${corruptions.indexOf(corrupt)}`,
        adapter: new InMemoryProtectedStoreAdapter()
      });
      const writer = await store.openWriter();
      await writer.compareAndSwap({ key: 'intent/run-1', expectedGeneration: 0, value });
      const host = createActionMediator({
        reader: store.reader(), writer,
        authority: { verifyAndReserve: fx.verify }, executors: [successfulExecutor()],
        killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
        now: () => new Date('2026-09-13T00:00:06.000Z')
      });
      await expect(host.receiptEvidence(decision.reservationId)).rejects.toThrow(/Protected/);
    }
  });

  test('rejects consistently resealed LEAF budget charge tampering during protected restart', async () => {
    const fx = await trustedDelegatedFixture({ actionLimit: 1, leafCount: 1 });
    const leaf = fx.leaves[0];
    const decision = await fx.host.mediator.authorize(leaf.handle, ACTION, {
      ...fx.options, idempotencyKey: 'leaf-integrity', actionId: 'leaf-integrity'
    });
    if (!decision.allowed) throw new Error('Expected LEAF action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(decision.reservationId);
    fx.setActionCount(1);
    const scope = actionReceiptAuthorityScope(fx.grantFor(leaf.handle));
    await fx.host.finalizeDelegatedReceipts(scope as any, fx.backend);
    const persisted = await fx.store.reader().read<any>('intent/run-1');
    if (persisted.status !== 'active') throw new Error('Expected finalized LEAF aggregate');
    const value = JSON.parse(JSON.stringify(persisted.record.value));
    const action = value.actions.find((item: any) => item.idempotencyKey === 'leaf-integrity');
    action.budgetCharge += 1;
    resealIntentRequest(action);
    const store = new ProtectedControllerStore({
      storeId: 'leaf-restart-budget-corruption',
      adapter: new InMemoryProtectedStoreAdapter()
    });
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'intent/run-1', expectedGeneration: 0, value });
    const restarted = createActionMediator({
      reader: store.reader(), writer,
      authority: { verifyAndReserve: fx.verify }, executors: [successfulExecutor()],
      killSwitch: createRunKillSwitch({ routeEnabled: true, runEnabled: true }),
      now: () => new Date('2026-09-13T00:00:06.000Z')
    });
    await expect(restarted.terminalReceipts(scope)).rejects.toThrow(/Protected/);
  });

  test('lost finalization CAS acknowledgement reconciles by reread without effect replay', async () => {
    const adapter = new InMemoryProtectedStoreAdapter();
    const store = new ProtectedControllerStore({ storeId: 'projection-ack-loss', adapter });
    const baseWriter = await store.openWriter();
    let loseAck = true;
    const writer = {
      ...baseWriter,
      async compareAndSwap<T>(input: Parameters<typeof baseWriter.compareAndSwap<T>>[0]) {
        const record = await baseWriter.compareAndSwap(input);
        if (loseAck && (input.value as any)?.finalizedAuthorities?.some(
          (item: any) => item.status === 'finalized')) {
          loseAck = false;
          throw new IndeterminateStoreCommitError('projection acknowledgement lost');
        }
        return record;
      }
    };
    const fx = await trustedDelegatedFixture({ actionLimit: 1, store, writer });
    const options = { ...fx.options, idempotencyKey: 'ack-loss-action', actionId: 'ack-loss-action' };
    const decision = await fx.host.mediator.authorize(fx.handle, ACTION, options);
    if (!decision.allowed) throw new Error('Expected action intent');
    fx.setClock('2026-09-13T00:00:04.000Z');
    await fx.host.mediator.execute(decision.reservationId);
    await expect(fx.host.finalizeDelegatedReceipts(
      actionReceiptAuthorityScope(fx.grant()) as any,
      fx.backend
    )).resolves.toMatchObject({
      receipts: [expect.objectContaining({ id: expect.stringMatching(/^receipt-final:/) })]
    });
    expect(fx.execute).toHaveBeenCalledTimes(1);
  });

  test('rejects obsolete protected mediation aggregates loudly', async () => {
    const fx = await fixture();
    await fx.writer.compareAndSwap({
      key: 'intent/run-1', expectedGeneration: 0,
      value: {
        format: 'harness-mdocs/action-mediation', schemaVersion: 8,
        runId: 'run-1', projectId: 'project-1', actions: [], finalizedAuthorities: []
      }
    });
    await expect(fx.host.terminalReceipts(actionReceiptAuthorityScope(authority())))
      .rejects.toThrow('schemaVersion 8 is unsupported; expected 9');
  });

  test('mediator implementation imports no direct effect primitives', () => {
    for (const internalExport of [
      'createActionMediator', 'actionReceiptAuthorityScope', 'ActionReceiptProjectionError',
      'computeStoredActionCompletionDigest'
    ]) {
      expect(publicAgents).not.toHaveProperty(internalExport);
    }
    const root = path.resolve(__dirname, '../../src/agents/run/trust');
    for (const file of ['mediator.ts', 'mediator-internal.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toMatch(/from ['"](?:node:)?(?:child_process|fs|fs\/promises|net|http|https)['"]/);
      expect(source).not.toMatch(/(?<!\.)\b(?:exec|execFile|spawn|fork|writeFile|unlink|fetch)\s*\(/);
      expect(source).not.toMatch(/\brequire\s*\(/);
    }
  });
});
