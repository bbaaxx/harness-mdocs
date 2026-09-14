import * as fs from 'fs';
import * as path from 'path';

import {
  ActionOperation,
  createOpaqueHandle,
  createRunKillSwitch,
  deriveOperationMetadataBindings,
  OpaqueHandle,
  ProtectedControllerStore,
  StructuredAction
} from '../../src/agents';
import type {
  ResolvedActionAuthority,
  StructuredActionExecutor
} from '../../src/agents/run/trust/mediator';
import { InMemoryProtectedStoreAdapter } from '../../src/agents/run/store/in-memory-adapter';
import { IndeterminateStoreCommitError } from '../../src/agents/run/store/types';
import { createActionMediator } from '../../src/agents/run/trust/mediator-internal';

const D0 = `sha256:${'0'.repeat(64)}`;
const D1 = `sha256:${'1'.repeat(64)}`;
const HANDLE = createOpaqueHandle('trusted-action-handle');
const ACTION: StructuredAction = {
  operation: 'process.exec',
  argv: ['allowlisted-binary', '--fixed-flag'],
  writeSet: [],
  sideEffectClass: 'external'
};

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
    adapter, store, writer, killSwitch, host, mediator: host.mediator, executor, verify,
    setClock(value: string) { clock = new Date(value); }
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
    expect(stored.record.value.actions[0].actualResources).toHaveLength(1);
    expect(stored.record.value.actions[0].actualResources[0]).toMatch(/^action-resource:[0-9a-f]{64}$/);
    expect(stored.record.value.actions[0].actualResources[0]).not.toContain('allowlisted-binary');
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
    expect(first.allowed && second.allowed).toBe(true);
    if (!first.allowed || !second.allowed) return;
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

  test('mediator implementation imports no direct effect primitives', () => {
    const root = path.resolve(__dirname, '../../src/agents/run/trust');
    for (const file of ['mediator.ts', 'mediator-internal.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toMatch(/from ['"](?:node:)?(?:child_process|fs|fs\/promises|net|http|https)['"]/);
      expect(source).not.toMatch(/(?<!\.)\b(?:exec|execFile|spawn|fork|writeFile|unlink|fetch)\s*\(/);
      expect(source).not.toMatch(/\brequire\s*\(/);
    }
  });
});
