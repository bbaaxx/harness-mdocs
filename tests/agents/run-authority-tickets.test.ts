import {
  compilePlanGraph,
  HostIdentity,
  HostIdentityProvider,
  OpaqueHandle
} from '../../src/agents';
import {
  createTicketAuthorityBroker,
  createTicketAuthorityBrokerForTest,
  TicketAuthorityBroker,
  TicketAuthorityBrokerOptions
} from '../../src/agents/run/authority/tickets';
import {
  acquireControllerLease,
  acquireWorkstreamLease,
  controllerLeasePlaceholder,
  controllerProof,
  createLeaseAuthorityState,
  LeaseAuthorityState,
  workstreamLeasePlaceholder
} from '../../src/agents/run/authority/leases';
import { TicketAuthorityError } from '../../src/agents/run/authority/state';

const NOW_ISO = '2026-09-12T00:00:00.000Z';
const ROOT_EXPIRY = '2026-09-12T01:00:00.000Z';
const TICKET_EXPIRY = '2026-09-12T00:30:00.000Z';
const EO_NODE = 'workstream-4-core-3-api';
const LEAF_NODE = 'leaf-4-core-3-api-7-handler';
const CONTROLLER_LEASE = {
  ref: `opaque-lease:controller:${Buffer.alloc(32, 1).toString('base64url')}`,
  generation: 1,
  fence: 1
} as const;
const WORKSTREAM_LEASE = {
  ref: `opaque-lease:workstream:${Buffer.alloc(32, 2).toString('base64url')}`,
  generation: 1,
  fence: 1
} as const;

interface LeaseContext {
  state: Readonly<LeaseAuthorityState>;
  controller: ReturnType<typeof acquireControllerLease>['lease'];
  setState(state: Readonly<LeaseAuthorityState>): void;
}

const leaseContexts = new WeakMap<TicketAuthorityBroker, LeaseContext>();

function planInput() {
  return {
    planKey: 'authority-test',
    planRevision: 3,
    objective: 'Test ticket authority',
    scope: ['src/**'],
    outOfScope: [],
    milestones: [{
      key: 'core',
      dependsOn: [],
      criteria: ['Milestone complete'],
      verification: 'Run tests',
      writeSet: ['src/**'],
      integrationCriteria: ['Integration passes'],
      workstreams: [{
        key: 'api',
        criteria: ['API complete'],
        writeSet: ['src/api/**'],
        leaves: [{
          key: 'handler',
          criteria: ['Handler complete'],
          writeSet: ['src/api/handler.ts']
        }]
      }]
    }],
    integrationCriteria: ['All integrated'],
    regressionCriteria: [],
    expectedSideEffects: [],
    policy: {},
    budgets: {},
    adapterRequirements: [],
    pauseRules: [],
    failureRules: [],
    cancelRules: [],
    completionRules: []
  };
}

function identityProvider(current: () => HostIdentity | null | Promise<HostIdentity | null>): HostIdentityProvider {
  const bindings = new Map<OpaqueHandle, HostIdentity>();
  return {
    currentHostIdentity: async () => current(),
    bindHandle: (identity, handle) => bindings.set(handle, identity),
    identityForHandle: handle => bindings.get(handle) ?? null
  };
}

function randomSource() {
  let index = 0;
  return () => `deterministic-random-${String(++index).padStart(4, '0')}`;
}

function setup(overrides: Partial<TicketAuthorityBrokerOptions> = {}) {
  const compiled = compilePlanGraph(planInput());
  let now = new Date(NOW_ISO);
  let identity: HostIdentity = {
    providerId: 'host:test',
    sessionRef: 'session:test',
    principalRef: 'principal:test'
  };
  let monotonicMs = 1_000;
  let leaseRefIndex = 0;
  const leaseSources = {
    wallClock: () => new Date(now),
    monotonicClock: () => monotonicMs,
    clockDomainId: () => 'ticket-test-clock-domain',
    testOnlyRandomBytes: () => Buffer.alloc(32, ++leaseRefIndex)
  };
  let leaseState = createLeaseAuthorityState({
    runId: 'run:test',
    projectId: 'project:test',
    graphEpoch: 4,
    cancellationGeneration: 2,
    runStartedAt: NOW_ISO,
    runDeadlineAt: ROOT_EXPIRY
  });
  const controller = acquireControllerLease(leaseState, {
    runId: 'run:test',
    projectId: 'project:test',
    graphEpoch: 4,
    cancellationGeneration: 2,
    holder: identity
  }, leaseSources);
  leaseState = controller.state;
  const broker = createTicketAuthorityBrokerForTest({
    compiled,
    runId: 'run:test',
    projectId: 'project:test',
    graphEpoch: 4,
    cancellationGeneration: 2,
    hostIdentityProvider: identityProvider(() => identity),
    rootAuthority: {
      roots: ['src/**'],
      operationClasses: ['fs.read', 'fs.write'],
      toolClasses: ['editor', 'reader'],
      credentialClasses: ['registry-read'],
      approvalRefs: ['approval:plan'],
      budgets: { actions: 20, costUsd: 2 },
      expiresAt: ROOT_EXPIRY,
      maxChildDepth: 2,
      maxFanout: 4
    },
    now: () => new Date(now),
    leaseState: () => leaseState,
    leaseSources,
    ...overrides
  }, { random: randomSource() });
  const leaseContext: LeaseContext = {
    state: leaseState,
    controller: controller.lease,
    setState: value => {
      leaseState = value;
      leaseContext.state = value;
    }
  };
  leaseContexts.set(broker, leaseContext);
  return {
    broker,
    compiled,
    setNow: (value: string) => {
      const next = new Date(value);
      monotonicMs += Math.max(0, next.getTime() - now.getTime());
      now = next;
    },
    setIdentity: (value: HostIdentity) => { identity = value; }
  };
}

function rootInput(overrides: Record<string, unknown> = {}): any {
  return {
    nodeId: EO_NODE,
    scope: 'Implement API workstream',
    roots: ['src/**'],
    operationClasses: ['fs.write', 'fs.read', 'fs.write'],
    toolClasses: ['reader', 'editor'],
    credentialClasses: ['registry-read'],
    approvalRefs: ['approval:plan'],
    budgets: { costUsd: 1, actions: 10 },
    expiresAt: TICKET_EXPIRY,
    maxChildDepth: 1,
    maxFanout: 2,
    lease: CONTROLLER_LEASE,
    ...overrides
  };
}

function leafInput(parentHandle: string, overrides: Record<string, unknown> = {}): any {
  return {
    parentHandle,
    nodeId: LEAF_NODE,
    scope: 'Implement handler leaf',
    roots: ['src/api/**'],
    operationClasses: ['fs.write'],
    toolClasses: ['editor'],
    credentialClasses: [],
    approvalRefs: ['approval:plan'],
    budgets: { actions: 4, costUsd: 0.5 },
    expiresAt: '2026-09-12T00:20:00.000Z',
    maxChildDepth: 0,
    maxFanout: 1,
    lease: WORKSTREAM_LEASE,
    ...overrides
  };
}

function resolveInput(broker: TicketAuthorityBroker, handle: string, overrides = {}) {
  const state = broker.snapshot();
  return {
    handle,
    runId: state.runId,
    projectId: state.projectId,
    approvedPlanDigest: state.approvedPlanDigest,
    approvedGraphDigest: state.approvedGraphDigest,
    graphId: state.graphId,
    graphRevision: state.graphRevision,
    graphEpoch: state.graphEpoch,
    cancellationGeneration: state.cancellationGeneration,
    ...overrides
  };
}

function authorityInput(broker: TicketAuthorityBroker, handle: string, overrides = {}) {
  return { ...resolveInput(broker, handle), lease: WORKSTREAM_LEASE, ...overrides };
}

async function activateRoot(broker: TicketAuthorityBroker, issued: { handle: OpaqueHandle }) {
  const claims = await broker.claim(resolveInput(broker, issued.handle));
  expect(claims.ok).toBe(true);
  if (!claims.ok) throw new Error(claims.reason);
  const context = leaseContexts.get(broker)!;
  const workstream = acquireWorkstreamLease(context.state, {
    runId: 'run:test',
    projectId: 'project:test',
    graphEpoch: 4,
    cancellationGeneration: 2,
    nodeId: EO_NODE,
    holder: claims.claims.holder,
    controllerHolder: context.controller.holder,
    controllerProof: controllerProof(context.controller),
    ticket: claims.claims
  }, {
    wallClock: () => new Date(NOW_ISO),
    monotonicClock: () => 1_000,
    clockDomainId: () => 'ticket-test-clock-domain',
    testOnlyRandomBytes: () => Buffer.alloc(32, 2)
  });
  context.setState(workstream.state);
  return broker.resolveForAuthority(authorityInput(broker, issued.handle));
}

async function claimedRoot(broker: TicketAuthorityBroker) {
  const issued = await broker.issueRoot(rootInput());
  const resolved = await activateRoot(broker, issued);
  expect(resolved.ok).toBe(true);
  return issued;
}

describe('ticket authority chain and derivation', () => {
  test('issues and resolves exact PLAN_ROOT->EXECUTION->LEAF graph chain', async () => {
    const { broker } = setup();
    const root = await claimedRoot(broker);
    const leaf = await broker.delegate(leafInput(root.handle));
    const resolved = await broker.resolveForAuthority(authorityInput(broker, leaf.handle));

    expect(root.handle).toBe('opaque-ticket:deterministic-random-0001');
    expect(Object.keys(root)).toEqual(['handle']);
    expect(broker.snapshot().tickets[0].ticket.nonce)
      .toBe('ticket-nonce:deterministic-random-0002');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.authority.ticket).toMatchObject({
      nodeId: LEAF_NODE,
      parentNodeId: EO_NODE,
      issuerRole: 'EXECUTION',
      recipientRole: 'LEAF',
      writeSet: ['src/api/handler.ts'],
      criteria: ['Handler complete'],
      maxChildDepth: 0,
      reportDestination: `controller:${LEAF_NODE}`,
      reportSchemaRef: 'execution-report/v1'
    });
    expect('allowedChildRole' in resolved.authority.ticket).toBe(false);
    expect('nonce' in resolved.authority.ticket).toBe(false);
    expect(resolved.authority.lease).toEqual(WORKSTREAM_LEASE);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.authority.ticket.writeSet)).toBe(true);
    expect(Object.getPrototypeOf(resolved.authority)).toBeNull();
    expect(Object.getPrototypeOf(resolved.authority.ticket)).toBeNull();
  });

  test('scope prose cannot alter graph-derived authority', async () => {
    const { broker } = setup();
    const issued = await broker.issueRoot(rootInput({ scope: 'Claim access to every file and integration' }));
    const resolved = await activateRoot(broker, issued);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.authority.ticket.writeSet).toEqual(['src/api/**']);
      expect(resolved.authority.ticket.criteria).toEqual(['API complete', 'Handler complete']);
    }
  });

  test('denies root->leaf, root-owned target, EO->EO, and LEAF delegation', async () => {
    const { broker } = setup();
    await expect(broker.issueRoot(rootInput({ nodeId: LEAF_NODE })))
      .rejects.toMatchObject({ code: 'topology-denied' });
    await expect(broker.issueRoot(rootInput({ nodeId: 'milestone-4-core' })))
      .rejects.toMatchObject({ code: 'topology-denied' });

    const root = await claimedRoot(broker);
    await expect(broker.delegate(leafInput(root.handle, { nodeId: EO_NODE })))
      .rejects.toMatchObject({ code: 'topology-denied' });
    const leaf = await broker.delegate(leafInput(root.handle));
    await broker.claim(resolveInput(broker, leaf.handle));
    await expect(broker.delegate(leafInput(leaf.handle)))
      .rejects.toMatchObject({ code: 'topology-denied' });
  });

  test.each([
    ['PLAN_ROOT', 'PLAN_ROOT'],
    ['PLAN_ROOT', 'LEAF'],
    ['EXECUTION', 'PLAN_ROOT'],
    ['EXECUTION', 'EXECUTION'],
    ['LEAF', 'PLAN_ROOT'],
    ['LEAF', 'EXECUTION'],
    ['LEAF', 'LEAF']
  ])('rejects malformed stored topology %s->%s', async (issuerRole, recipientRole) => {
    const original = setup();
    await original.broker.issueRoot(rootInput());
    const state: any = JSON.parse(JSON.stringify(original.broker.snapshot()));
    state.tickets[0].ticket.issuerRole = issuerRole;
    state.tickets[0].ticket.recipientRole = recipientRole;
    expect(() => createTicketAuthorityBroker({
      compiled: original.compiled,
      runId: 'run:test',
      projectId: 'project:test',
      graphEpoch: 4,
      cancellationGeneration: 2,
      hostIdentityProvider: identityProvider(() => ({
        providerId: 'host:test', sessionRef: 'session:test', principalRef: 'principal:test'
      })),
      state
    })).toThrow(TicketAuthorityError);
  });
});

describe('opaque claim and live bindings', () => {
  test('forged handle and direct plain ticket are inert', async () => {
    const { broker } = setup();
    const forged = await broker.resolveClaimsOnly(resolveInput(broker, 'opaque-ticket:caller-minted-value'));
    expect(forged).toMatchObject({ ok: false, code: 'unknown-handle' });

    const plain = await broker.resolveClaimsOnly({
      ...resolveInput(broker, 'x'),
      handle: { ticketHandleId: 'opaque-ticket:caller-minted-value' }
    } as any);
    expect(plain).toMatchObject({ ok: false, code: 'invalid-input' });
  });

  test.each([
    ['runId', 'run:other', 'run-mismatch'],
    ['projectId', 'project:other', 'project-mismatch'],
    ['approvedPlanDigest', `sha256:${'1'.repeat(64)}`, 'plan-mismatch'],
    ['approvedGraphDigest', `sha256:${'2'.repeat(64)}`, 'graph-mismatch'],
    ['graphId', 'graph-other', 'graph-mismatch'],
    ['graphRevision', 9, 'graph-revision-mismatch'],
    ['graphEpoch', 5, 'graph-epoch-mismatch'],
    ['cancellationGeneration', 3, 'cancellation-generation-mismatch']
  ])('denies stale or mismatched %s', async (field, value, code) => {
    const { broker } = setup();
    const issued = await broker.issueRoot(rootInput());
    const result = await broker.resolveClaimsOnly(resolveInput(broker, issued.handle, { [field]: value }));
    expect(result).toMatchObject({ ok: false, code });
  });

  test('requires exact trusted host identity fields', async () => {
    const context = setup();
    const issued = await context.broker.issueRoot(rootInput());
    context.setIdentity({
      providerId: 'host:test',
      sessionRef: 'session:other',
      principalRef: 'principal:test'
    });
    await expect(context.broker.resolveClaimsOnly(resolveInput(context.broker, issued.handle)))
      .resolves.toMatchObject({ ok: false, code: 'host-identity-mismatch' });
  });

  test('pure resolution never consumes; claim consumes once and persists replay denial', async () => {
    const first = setup();
    const issued = await first.broker.issueRoot(rootInput());
    expect((await first.broker.resolveClaimsOnly(resolveInput(first.broker, issued.handle))).ok).toBe(true);
    expect((await first.broker.resolveClaimsOnly(resolveInput(first.broker, issued.handle))).ok).toBe(true);
    expect((await first.broker.claim(resolveInput(first.broker, issued.handle))).ok).toBe(true);
    expect(await first.broker.claim(resolveInput(first.broker, issued.handle)))
      .toMatchObject({ ok: false, code: 'replayed-ticket' });
    expect((await first.broker.resolveClaimsOnly(resolveInput(first.broker, issued.handle))).ok).toBe(true);

    const restored = createTicketAuthorityBrokerForTest({
      compiled: first.compiled,
      runId: 'run:test',
      projectId: 'project:test',
      graphEpoch: 4,
      cancellationGeneration: 2,
      hostIdentityProvider: identityProvider(() => ({
        providerId: 'host:test', sessionRef: 'session:test', principalRef: 'principal:test'
      })),
      state: first.broker.snapshot(),
      now: () => new Date(NOW_ISO)
    }, { random: randomSource() });
    expect(await restored.claim(resolveInput(restored, issued.handle)))
      .toMatchObject({ ok: false, code: 'replayed-ticket' });
  });

  test('denies exact expiry boundary and revoked lifecycle', async () => {
    const context = setup();
    const expired = await context.broker.issueRoot(rootInput());
    context.setNow(TICKET_EXPIRY);
    expect(await context.broker.resolveClaimsOnly(resolveInput(context.broker, expired.handle)))
      .toMatchObject({ ok: false, code: 'expired-ticket' });

    const other = setup();
    const revoked = await other.broker.issueRoot(rootInput());
    expect(other.broker.revoke(revoked.handle)).toBe(true);
    expect(await other.broker.resolveClaimsOnly(resolveInput(other.broker, revoked.handle)))
      .toMatchObject({ ok: false, code: 'inactive-ticket' });
  });

  test('parent revocation cascades and standalone child resolution checks ancestors', async () => {
    const context = setup();
    const root = await claimedRoot(context.broker);
    const leaf = await context.broker.delegate(leafInput(root.handle));
    const staleChildState: any = JSON.parse(JSON.stringify(context.broker.snapshot()));
    staleChildState.tickets[0].lifecycle = 'revoked';
    expect(context.broker.revoke(root.handle)).toBe(true);
    expect(context.broker.snapshot().tickets.map(record => record.lifecycle)).toEqual([
      'revoked', 'revoked'
    ]);
    expect(await context.broker.resolveForAuthority(authorityInput(context.broker, leaf.handle)))
      .toMatchObject({ ok: false, code: 'inactive-ticket' });

    const restored = createTicketAuthorityBroker({
      compiled: context.compiled, runId: 'run:test', projectId: 'project:test',
      graphEpoch: 4, cancellationGeneration: 2,
      hostIdentityProvider: identityProvider(() => ({
        providerId: 'host:test', sessionRef: 'session:test', principalRef: 'principal:test'
      })),
      state: staleChildState,
      now: () => new Date(NOW_ISO)
    });
    expect(await restored.resolveClaimsOnly(resolveInput(restored, leaf.handle)))
      .toMatchObject({ ok: false, code: 'inactive-ticket' });
  });
});

describe('component-wise attenuation', () => {
  test.each([
    ['roots', { roots: ['other/**'] }],
    ['operation classes', { operationClasses: ['network'] }],
    ['tool classes', { toolClasses: ['shell'] }],
    ['credential classes', { credentialClasses: ['registry-write'] }],
    ['approval refs', { approvalRefs: ['approval:other'] }],
    ['introduced budget', { budgets: { tokens: 1 } }],
    ['widened budget', { budgets: { actions: 11 } }],
    ['expiry', { expiresAt: '2026-09-12T00:31:00.000Z' }],
    ['depth', { maxChildDepth: 1 }],
    ['fanout', { maxFanout: 3 }]
  ])('denies widened child %s', async (_dimension, change) => {
    const { broker } = setup();
    const root = await claimedRoot(broker);
    await expect(broker.delegate(leafInput(root.handle, change)))
      .rejects.toBeInstanceOf(TicketAuthorityError);
  });

  test('omitted parent capability cannot be introduced by child', async () => {
    const { broker } = setup();
    const input = rootInput();
    delete input.credentialClasses;
    const root = await broker.issueRoot(input);
    await activateRoot(broker, root);
    await expect(broker.delegate(leafInput(root.handle, { credentialClasses: ['registry-read'] })))
      .rejects.toMatchObject({ code: 'attenuation-denied' });
  });

  test.each([
    [{ budgets: { actions: 0 } }, 'invalid-input'],
    [{ budgets: { actions: Number.POSITIVE_INFINITY } }, 'invalid-input'],
    [{ maxFanout: 0 }, 'invalid-input']
  ])('rejects malformed positive authority dimensions', async (change, code) => {
    const { broker } = setup();
    await expect(broker.issueRoot(rootInput(change))).rejects.toMatchObject({ code });
  });

  test.each(['writeSet', 'criteria'])('rejects stored %s not derived from graph', async field => {
    const original = setup();
    await original.broker.issueRoot(rootInput());
    const state: any = JSON.parse(JSON.stringify(original.broker.snapshot()));
    state.tickets[0].ticket[field] = field === 'writeSet' ? ['other/**'] : ['Caller criterion'];
    expect(() => createTicketAuthorityBroker({
      compiled: original.compiled,
      runId: 'run:test',
      projectId: 'project:test',
      graphEpoch: 4,
      cancellationGeneration: 2,
      hostIdentityProvider: identityProvider(() => ({
        providerId: 'host:test', sessionRef: 'session:test', principalRef: 'principal:test'
      })),
      state
    })).toThrow(/does not match graph|not covered/);
  });
});

describe('hostile input and canonical state', () => {
  test('snapshots caller input before await and ignores later mutation', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const compiled = compilePlanGraph(planInput());
    const broker = setup({
      hostIdentityProvider: identityProvider(async () => {
        await waiting;
        return { providerId: 'host:test', sessionRef: 'session:test', principalRef: 'principal:test' };
      }),
      compiled
    }).broker;
    const input = rootInput();
    const pending = broker.issueRoot(input);
    input.scope = 'mutated after call';
    input.operationClasses.push('network');
    release();
    const issued = await pending;
    const record = broker.snapshot().tickets.find(ticket => ticket.ticket.ticketHandleId === issued.handle)!;
    expect(record.ticket.scope).toBe('Implement API workstream');
    expect(record.ticket.operationClasses).toEqual(['fs.read', 'fs.write']);
  });

  test('rejects accessors without invocation and proxies without traps', async () => {
    const { broker } = setup();
    const getter = jest.fn(() => EO_NODE);
    const accessor = rootInput();
    Object.defineProperty(accessor, 'nodeId', { enumerable: true, get: getter });
    await expect(broker.issueRoot(accessor)).rejects.toMatchObject({ code: 'invalid-input' });
    expect(getter).not.toHaveBeenCalled();

    const get = jest.fn(Reflect.get);
    const proxy = new Proxy(rootInput(), { get });
    await expect(broker.issueRoot(proxy)).rejects.toMatchObject({ code: 'invalid-input' });
    expect(get).not.toHaveBeenCalled();
  });

  test('rejects accessor and proxy stored state without invoking traps', async () => {
    const original = setup();
    await original.broker.issueRoot(rootInput());
    const accessor: any = JSON.parse(JSON.stringify(original.broker.snapshot()));
    const getter = jest.fn(() => 'run:test');
    Object.defineProperty(accessor, 'runId', { enumerable: true, get: getter });
    expect(() => createTicketAuthorityBroker({
      compiled: original.compiled,
      runId: 'run:test',
      projectId: 'project:test',
      graphEpoch: 4,
      cancellationGeneration: 2,
      hostIdentityProvider: identityProvider(() => null),
      state: accessor
    })).toThrow(TicketAuthorityError);
    expect(getter).not.toHaveBeenCalled();

    const get = jest.fn(Reflect.get);
    const proxy = new Proxy(original.broker.snapshot(), { get });
    expect(() => createTicketAuthorityBroker({
      compiled: original.compiled,
      runId: 'run:test',
      projectId: 'project:test',
      graphEpoch: 4,
      cancellationGeneration: 2,
      hostIdentityProvider: identityProvider(() => null),
      state: proxy
    })).toThrow(TicketAuthorityError);
    expect(get).not.toHaveBeenCalled();
  });

  test('state is detached, null-prototype, deeply frozen, and deterministic', async () => {
    const context = setup();
    await context.broker.issueRoot(rootInput());
    const state = context.broker.snapshot();
    expect(Object.getPrototypeOf(state)).toBeNull();
    expect(Object.getPrototypeOf(state.tickets[0])).toBeNull();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.tickets)).toBe(true);
    expect(Object.isFrozen(state.tickets[0].ticket.budgets)).toBe(true);
    expect(state.tickets[0].ticket.operationClasses).toEqual(['fs.read', 'fs.write']);
  });

  test.each([
    ['unknown state key', (state: any) => { state.extra = true; }],
    ['unknown ticket key', (state: any) => { state.tickets[0].extra = true; }],
    ['unsafe budget', (state: any) => { state.tickets[0].ticket.budgets.actions = Infinity; }],
    ['stale graph epoch', (state: any) => { state.tickets[0].graphEpoch += 1; }],
    ['stale cancellation', (state: any) => { state.tickets[0].cancellationGeneration += 1; }]
  ])('rejects malformed stored state: %s', async (_label, mutate) => {
    const original = setup();
    await original.broker.issueRoot(rootInput());
    const state: any = JSON.parse(JSON.stringify(original.broker.snapshot()));
    mutate(state);
    expect(() => createTicketAuthorityBroker({
      compiled: original.compiled,
      runId: 'run:test',
      projectId: 'project:test',
      graphEpoch: 4,
      cancellationGeneration: 2,
      hostIdentityProvider: identityProvider(() => ({
        providerId: 'host:test', sessionRef: 'session:test', principalRef: 'principal:test'
      })),
      state
    })).toThrow(TicketAuthorityError);
  });
});
