import {
  acquireControllerLease,
  acquireWorkstreamLease,
  controllerLeasePlaceholder,
  controllerProof,
  createLeaseAuthorityState,
  DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LEASE_TTL_MS,
  heartbeatControllerLease,
  heartbeatWorkstreamLease,
  invalidateWorkstreamLeasesByTicketHandles,
  LeaseAuthorityState,
  LeaseSources,
  parseLeaseAuthorityState,
  releaseControllerLease,
  releaseWorkstreamLease,
  validateControllerLease,
  validateWorkstreamLease,
  workstreamLeasePlaceholder,
  workstreamProof
} from '../../src/agents/run/authority/leases';
import { TicketAuthorityError } from '../../src/agents/run/authority/state';
import { compilePlanGraph, HostIdentityProvider } from '../../src/agents';
import {
  createTicketAuthorityBroker,
  createTicketAuthorityBrokerForTest
} from '../../src/agents/run/authority/tickets';

const START = Date.parse('2026-09-12T00:00:00.000Z');
const BINDING = {
  runId: 'run:lease-test',
  projectId: 'project:lease-test',
  graphEpoch: 7,
  cancellationGeneration: 3
} as const;
const HOLDER_A = {
  providerId: 'host:test',
  sessionRef: 'session:a',
  principalRef: 'principal:a'
} as const;
const HOLDER_B = {
  providerId: 'host:test',
  sessionRef: 'session:b',
  principalRef: 'principal:b'
} as const;
const NODE = 'workstream-4-core-3-api';
const RUN_WINDOW = {
  runStartedAt: '2026-09-12T00:00:00.000Z',
  runDeadlineAt: '2026-09-12T02:00:00.000Z'
} as const;
const entropy = (label: string) => () => Buffer.alloc(32, label);

function clock() {
  let wallMs = START;
  let monotonicMs = 1_000;
  let domain = 'test-clock-domain';
  let ref = 0;
  const sources: LeaseSources = {
    wallClock: () => new Date(wallMs),
    monotonicClock: () => monotonicMs,
    clockDomainId: () => domain,
    testOnlyRandomBytes: () => Buffer.alloc(32, ++ref)
  };
  return {
    sources,
    set: (wallOffsetMs: number, monotonicOffsetMs = wallOffsetMs) => {
      wallMs = START + wallOffsetMs;
      monotonicMs = 1_000 + monotonicOffsetMs;
    },
    setAbsolute: (wall: number, monotonic: number) => {
      wallMs = wall;
      monotonicMs = monotonic;
    },
    setDomain: (value: string) => { domain = value; }
  };
}

function freshState() {
  return createLeaseAuthorityState({ ...BINDING, ...RUN_WINDOW });
}

function controllerInput(
  holder: { providerId: string; sessionRef: string; principalRef: string } = HOLDER_A,
  overrides = {}
) {
  return { ...BINDING, holder, ...overrides };
}

function controllerOperation(lease: ReturnType<typeof acquireControllerLease>['lease'], overrides = {}) {
  return { ...BINDING, holder: lease.holder, proof: controllerProof(lease), ...overrides };
}

function executionTicket(controller: ReturnType<typeof acquireControllerLease>['lease'], overrides = {}) {
  return {
    ...BINDING,
    holder: HOLDER_A,
    lease: controllerLeasePlaceholder(controller),
    ticketHandleId: 'opaque-ticket:lease-test-ticket',
    nodeId: NODE,
    recipientRole: 'EXECUTION' as const,
    expiresAt: '2026-09-12T00:10:00.000Z',
    ...overrides
  };
}

function workstreamAcquireInput(
  controller: ReturnType<typeof acquireControllerLease>['lease'],
  overrides = {}
) {
  return {
    ...BINDING,
    nodeId: NODE,
    holder: HOLDER_A,
    controllerHolder: HOLDER_A,
    controllerProof: controllerProof(controller),
    ticket: executionTicket(controller),
    ...overrides
  };
}

function workstreamOperation(lease: ReturnType<typeof acquireWorkstreamLease>['lease'], overrides = {}) {
  return {
    ...BINDING,
    nodeId: lease.nodeId,
    holder: lease.holder,
    proof: workstreamProof(lease),
    ...overrides
  };
}

describe('controller lease transitions', () => {
  test('uses exact 60s TTL and 15s heartbeat defaults with canonical timestamps', () => {
    const time = clock();
    const initial = freshState();
    expect(initial.ttlMs).toBe(DEFAULT_LEASE_TTL_MS);
    expect(initial.heartbeatIntervalMs).toBe(DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS);

    const acquired = acquireControllerLease(initial, controllerInput(), time.sources);
    expect(acquired.lease).toMatchObject({
      kind: 'controller',
      generation: 1,
      fence: 1,
      acquiredAt: '2026-09-12T00:00:00.000Z',
      heartbeatAt: '2026-09-12T00:00:00.000Z',
      expiresAt: '2026-09-12T00:01:00.000Z',
      releasedAt: null,
      lifecycle: 'active'
    });
    expect(acquired.lease.leaseRef).toBe(
      `opaque-lease:controller:${Buffer.alloc(32, 1).toString('base64url')}`
    );
  });

  test('same pure acquisition from same generation and sources has same successor', () => {
    const initial = freshState();
    const deterministic = (): LeaseSources => ({
      wallClock: () => new Date(START),
      monotonicClock: () => 1_000,
      testOnlyRandomBytes: entropy('same-race-successor-ref')
    });
    const left = acquireControllerLease(initial, controllerInput(), deterministic());
    const right = acquireControllerLease(initial, controllerInput(), deterministic());
    expect(left).toEqual(right);
    expect(initial.controllerLease).toBeNull();
  });

  test('competing pure controller races propose same next generation/fence before CAS', () => {
    const initial = freshState();
    const left = acquireControllerLease(initial, controllerInput(HOLDER_A), {
      wallClock: () => new Date(START), monotonicClock: () => 1_000,
      testOnlyRandomBytes: entropy('controller-race-left-ref')
    });
    const right = acquireControllerLease(initial, controllerInput(HOLDER_B), {
      wallClock: () => new Date(START), monotonicClock: () => 1_000,
      testOnlyRandomBytes: entropy('controller-race-right-ref')
    });
    expect([left.lease.generation, left.lease.fence]).toEqual([1, 1]);
    expect([right.lease.generation, right.lease.fence]).toEqual([1, 1]);
  });

  test('active lease denies races; exact expiry permits takeover and fences old holder', () => {
    const time = clock();
    const first = acquireControllerLease(freshState(), controllerInput(), time.sources);
    expect(() => acquireControllerLease(first.state, controllerInput(HOLDER_B), time.sources))
      .toThrow(/active and unexpired/);

    time.set(60_000);
    const takeover = acquireControllerLease(first.state, controllerInput(HOLDER_B), time.sources);
    expect(takeover.lease.generation).toBe(2);
    expect(takeover.lease.fence).toBe(2);
    expect(takeover.lease.leaseRef).not.toBe(first.lease.leaseRef);
    expect(() => validateControllerLease(
      takeover.state,
      controllerOperation(first.lease),
      time.sources
    )).toThrow(/stale/);
    expect(() => heartbeatControllerLease(
      takeover.state,
      controllerOperation(first.lease),
      time.sources
    )).toThrow(/stale/);
    expect(() => releaseControllerLease(
      takeover.state,
      controllerOperation(first.lease),
      time.sources
    )).toThrow(/stale/);
  });

  test('rejects monotonic rollback in-domain and establishes baseline after cross-domain takeover', () => {
    const time = clock();
    const first = acquireControllerLease(freshState(), controllerInput(), time.sources);
    time.setAbsolute(START + 15_000, 999);
    expect(() => heartbeatControllerLease(first.state, controllerOperation(first.lease), time.sources))
      .toThrow(/regressed/);

    time.setAbsolute(START + 60_000, 5);
    time.setDomain('replacement-process-domain');
    const takeover = acquireControllerLease(first.state, controllerInput(HOLDER_B), time.sources);
    expect(takeover.lease.clockDomainId).toBe('replacement-process-domain');
    expect(takeover.lease.acquiredMonotonicMs).toBe(5);
    expect(takeover.state.monotonicHighWaters).toEqual([
      { domainId: 'replacement-process-domain', highWaterMs: 5 },
      { domainId: 'test-clock-domain', highWaterMs: 1_000 }
    ]);
  });

  test('domain round trip A->B->A cannot reset the original monotonic baseline', () => {
    const time = clock();
    const first = acquireControllerLease(freshState(), controllerInput(), time.sources);
    time.setAbsolute(START + 60_000, 5);
    time.setDomain('replacement-process-domain');
    const takeover = acquireControllerLease(first.state, controllerInput(HOLDER_B), time.sources);
    time.setAbsolute(START + 120_000, 999);
    time.setDomain('test-clock-domain');
    expect(() => acquireControllerLease(takeover.state, controllerInput(), time.sources))
      .toThrow(/regressed/);
  });

  test('rejects live controller operations from changed process clock domain before expiry', () => {
    const time = clock();
    const first = acquireControllerLease(freshState(), controllerInput(), time.sources);
    time.setAbsolute(START + 15_000, 5);
    time.setDomain('reused-pid-new-process-domain');
    expect(() => validateControllerLease(first.state, controllerOperation(first.lease), time.sources))
      .toThrow(/clock domain/i);
    expect(() => heartbeatControllerLease(first.state, controllerOperation(first.lease), time.sources))
      .toThrow(/clock domain/i);
    expect(() => releaseControllerLease(first.state, controllerOperation(first.lease), time.sources))
      .toThrow(/clock domain/i);
  });

  test('caps controller lease at trusted run deadline', () => {
    const state = createLeaseAuthorityState({
      ...BINDING,
      runStartedAt: '2026-09-12T00:00:00.000Z',
      runDeadlineAt: '2026-09-12T00:00:30.000Z'
    });
    const acquired = acquireControllerLease(state, controllerInput(), clock().sources);
    expect(acquired.lease.expiresAt).toBe('2026-09-12T00:00:30.000Z');
    expect(acquired.lease.authorityDeadlineAt).toBe('2026-09-12T00:00:30.000Z');
  });

  test('heartbeat rejects before cadence, accepts exact cadence, and extends from host clock', () => {
    const time = clock();
    const first = acquireControllerLease(freshState(), controllerInput(), time.sources);
    time.set(14_999);
    expect(() => heartbeatControllerLease(
      first.state,
      controllerOperation(first.lease),
      time.sources
    )).toThrow(/before configured cadence/);

    time.set(15_000);
    const heartbeat = heartbeatControllerLease(
      first.state,
      controllerOperation(first.lease),
      time.sources
    );
    expect(heartbeat.lease.heartbeatAt).toBe('2026-09-12T00:00:15.000Z');
    expect(heartbeat.lease.expiresAt).toBe('2026-09-12T00:01:15.000Z');
    expect(heartbeat.lease.generation).toBe(1);
    expect(heartbeat.lease.fence).toBe(1);
  });

  test('release is idempotent only for exact current released ref', () => {
    const time = clock();
    const first = acquireControllerLease(freshState(), controllerInput(), time.sources);
    time.set(1_000);
    const released = releaseControllerLease(
      first.state,
      controllerOperation(first.lease),
      time.sources
    );
    const replay = releaseControllerLease(
      released.state,
      controllerOperation(released.lease),
      time.sources
    );
    expect(replay).toEqual(released);
    expect(released.lease.generation).toBe(1);
    expect(() => releaseControllerLease(released.state, {
      ...controllerOperation(released.lease),
      proof: { ...controllerProof(released.lease), leaseRef: 'opaque-lease:controller:stale-ref-value-x' }
    }, time.sources)).toThrow(/stale/);
  });

  test.each([
    [{ runId: 'run:other' }, 'run'],
    [{ projectId: 'project:other' }, 'project'],
    [{ graphEpoch: 8 }, 'graph epoch'],
    [{ cancellationGeneration: 4 }, 'cancellation'],
    [{ holder: HOLDER_B }, 'holder']
  ])('rejects cross-binding controller operation %#', (change, reason) => {
    const time = clock();
    const first = acquireControllerLease(freshState(), controllerInput(), time.sources);
    expect(() => validateControllerLease(
      first.state,
      controllerOperation(first.lease, change),
      time.sources
    )).toThrow(new RegExp(reason));
  });

  test('rejects exact expiry, monotonic regression, and generation exhaustion', () => {
    const time = clock();
    const first = acquireControllerLease(freshState(), controllerInput(), time.sources);
    time.set(60_000);
    expect(() => validateControllerLease(
      first.state,
      controllerOperation(first.lease),
      time.sources
    )).toThrow(/expired/);

    time.setAbsolute(START, 999);
    expect(() => validateControllerLease(
      first.state,
      controllerOperation(first.lease),
      time.sources
    )).toThrow(/regressed/);

    time.setAbsolute(START - 1, 1_000);
    expect(() => validateControllerLease(
      first.state,
      controllerOperation(first.lease),
      time.sources
    )).toThrow(/wall clock regressed/);

    const released = JSON.parse(JSON.stringify(first.state));
    released.controllerLease.lifecycle = 'released';
    released.controllerLease.releasedAt = released.controllerLease.heartbeatAt;
    released.controllerLease.generation = Number.MAX_SAFE_INTEGER;
    released.controllerLease.fence = Number.MAX_SAFE_INTEGER;
    released.controllerGenerationHighWater = Number.MAX_SAFE_INTEGER;
    released.controllerFenceHighWater = Number.MAX_SAFE_INTEGER;
    expect(() => acquireControllerLease(released, controllerInput(), clock().sources))
      .toThrow(/exhausted/);
  });
});

describe('workstream lease transitions', () => {
  function withController() {
    const time = clock();
    const controller = acquireControllerLease(freshState(), controllerInput(), time.sources);
    return { time, controller };
  }

  test('requires live controller authority and matching EXECUTION ticket', () => {
    const { time, controller } = withController();
    const acquired = acquireWorkstreamLease(
      controller.state,
      workstreamAcquireInput(controller.lease),
      time.sources
    );
    expect(acquired.lease).toMatchObject({
      kind: 'workstream', nodeId: NODE, generation: 1, fence: 1, lifecycle: 'active'
    });

    expect(() => acquireWorkstreamLease(controller.state, workstreamAcquireInput(controller.lease, {
      ticket: executionTicket(controller.lease, { recipientRole: 'LEAF' })
    }), time.sources)).toThrow();
    expect(() => acquireWorkstreamLease(controller.state, workstreamAcquireInput(controller.lease, {
      nodeId: 'workstream-other',
      ticket: executionTicket(controller.lease)
    }), time.sources)).toThrow(/matching EXECUTION ticket/);
  });

  test('binds controller lineage and atomically invalidates children on controller release', () => {
    const { time, controller } = withController();
    const workstream = acquireWorkstreamLease(
      controller.state, workstreamAcquireInput(controller.lease), time.sources
    );
    expect(workstream.lease).toMatchObject({
      controllerLeaseRef: controller.lease.leaseRef,
      controllerFence: controller.lease.fence
    });
    time.set(1_000);
    const released = releaseControllerLease(
      workstream.state, controllerOperation(controller.lease), time.sources
    );
    expect(released.state.workstreamLeases[0].lifecycle).toBe('invalidated');
    expect(() => validateWorkstreamLease(
      released.state, workstreamOperation(workstream.lease), time.sources
    )).toThrow(/lineage|released|stale/i);
  });

  test('one active lease per node; exact-expiry takeover invalidates old operations', () => {
    const { time, controller } = withController();
    const first = acquireWorkstreamLease(
      controller.state,
      workstreamAcquireInput(controller.lease),
      time.sources
    );
    expect(() => acquireWorkstreamLease(
      first.state,
      workstreamAcquireInput(controller.lease),
      time.sources
    )).toThrow(/active and unexpired/);

    time.set(15_000);
    const controllerHeartbeat = heartbeatControllerLease(
      first.state,
      controllerOperation(controller.lease),
      time.sources
    );
    time.set(60_000);
    const takeover = acquireWorkstreamLease(controllerHeartbeat.state, workstreamAcquireInput(controllerHeartbeat.lease, {
      holder: HOLDER_B,
      ticket: executionTicket(controllerHeartbeat.lease, { holder: HOLDER_B })
    }), time.sources);
    expect(takeover.lease.generation).toBe(2);
    expect(takeover.lease.fence).toBe(2);
    expect(() => validateWorkstreamLease(
      takeover.state,
      workstreamOperation(first.lease),
      time.sources
    )).toThrow(/stale/);
  });

  test('same pure workstream race request has same successor', () => {
    const { controller } = withController();
    const deterministic = (): LeaseSources => ({
      wallClock: () => new Date(START),
      monotonicClock: () => 1_000,
      clockDomainId: () => controller.lease.clockDomainId,
      testOnlyRandomBytes: entropy('same-workstream-race-ref')
    });
    const input = workstreamAcquireInput(controller.lease);
    const left = acquireWorkstreamLease(controller.state, input, deterministic());
    const right = acquireWorkstreamLease(controller.state, input, deterministic());
    expect(left).toEqual(right);
  });

  test('workstream heartbeat cadence, validation, release replay, and stale ref are strict', () => {
    const { time, controller } = withController();
    const first = acquireWorkstreamLease(
      controller.state,
      workstreamAcquireInput(controller.lease),
      time.sources
    );
    expect(validateWorkstreamLease(
      first.state,
      workstreamOperation(first.lease),
      time.sources
    ).leaseRef).toBe(first.lease.leaseRef);
    time.set(15_000);
    const heartbeat = heartbeatWorkstreamLease(
      first.state,
      workstreamOperation(first.lease),
      time.sources
    );
    time.set(16_000);
    const released = releaseWorkstreamLease(
      heartbeat.state,
      workstreamOperation(heartbeat.lease),
      time.sources
    );
    expect(releaseWorkstreamLease(
      released.state,
      workstreamOperation(released.lease),
      time.sources
    )).toEqual(released);
    expect(() => heartbeatWorkstreamLease(
      released.state,
      workstreamOperation(first.lease),
      time.sources
    )).toThrow(/released|stale/);
  });

  test('rejects live workstream operations from changed process clock domain', () => {
    const { time, controller } = withController();
    const first = acquireWorkstreamLease(
      controller.state, workstreamAcquireInput(controller.lease), time.sources
    );
    time.setAbsolute(START + 15_000, 5);
    time.setDomain('replacement-process-domain');
    expect(() => validateWorkstreamLease(first.state, workstreamOperation(first.lease), time.sources))
      .toThrow(/clock domain/i);
    expect(() => heartbeatWorkstreamLease(first.state, workstreamOperation(first.lease), time.sources))
      .toThrow(/clock domain/i);
    expect(() => releaseWorkstreamLease(first.state, workstreamOperation(first.lease), time.sources))
      .toThrow(/clock domain/i);
  });

  test('ticket-handle invalidation preserves a replacement lease on the same node', () => {
    const { time, controller } = withController();
    const first = acquireWorkstreamLease(
      controller.state, workstreamAcquireInput(controller.lease), time.sources
    );
    time.set(15_000);
    const liveController = heartbeatControllerLease(
      first.state, controllerOperation(controller.lease), time.sources
    );
    time.set(60_000);
    const replacement = acquireWorkstreamLease(liveController.state, workstreamAcquireInput(liveController.lease, {
      ticket: executionTicket(liveController.lease, { ticketHandleId: 'opaque-ticket:replacement-ticket' })
    }), time.sources);
    const invalidated = invalidateWorkstreamLeasesByTicketHandles(
      replacement.state, [first.lease.ticketHandleId], time.sources
    );
    expect(invalidated.workstreamLeases[0]).toMatchObject({
      ticketHandleId: 'opaque-ticket:replacement-ticket', lifecycle: 'active'
    });
  });

  test.each([
    [{ runId: 'run:other' }, 'run'],
    [{ projectId: 'project:other' }, 'project'],
    [{ nodeId: 'workstream-other' }, 'absent|node'],
    [{ graphEpoch: 8 }, 'graph epoch'],
    [{ cancellationGeneration: 4 }, 'cancellation'],
    [{ holder: HOLDER_B }, 'holder']
  ])('rejects cross-binding workstream operation %#', (change, reason) => {
    const { time, controller } = withController();
    const first = acquireWorkstreamLease(
      controller.state,
      workstreamAcquireInput(controller.lease),
      time.sources
    );
    expect(() => validateWorkstreamLease(
      first.state,
      workstreamOperation(first.lease, change),
      time.sources
    )).toThrow(new RegExp(reason));
  });

  test('workstream generation/fence exhaustion fails closed', () => {
    const { time, controller } = withController();
    const first = acquireWorkstreamLease(
      controller.state,
      workstreamAcquireInput(controller.lease),
      time.sources
    );
    const exhausted: any = JSON.parse(JSON.stringify(first.state));
    exhausted.workstreamLeases[0].lifecycle = 'released';
    exhausted.workstreamLeases[0].releasedAt = exhausted.workstreamLeases[0].heartbeatAt;
    exhausted.workstreamLeases[0].generation = Number.MAX_SAFE_INTEGER;
    exhausted.workstreamLeases[0].fence = Number.MAX_SAFE_INTEGER;
    exhausted.workstreamHighWaters[0].generation = Number.MAX_SAFE_INTEGER;
    exhausted.workstreamHighWaters[0].fence = Number.MAX_SAFE_INTEGER;
    expect(() => acquireWorkstreamLease(
      exhausted,
      workstreamAcquireInput(controller.lease),
      time.sources
    )).toThrow(/exhausted/);
  });
});

describe('lease state hardening', () => {
  test('returns detached null-prototype deeply frozen state', () => {
    const time = clock();
    const input: any = { ...BINDING, holder: { ...HOLDER_A } };
    const acquired = acquireControllerLease(freshState(), input, time.sources);
    input.holder.sessionRef = 'mutated';
    expect(acquired.lease.holder.sessionRef).toBe('session:a');
    expect(Object.getPrototypeOf(acquired.state)).toBeNull();
    expect(Object.getPrototypeOf(acquired.lease)).toBeNull();
    expect(Object.isFrozen(acquired.state)).toBe(true);
    expect(Object.isFrozen(acquired.lease.holder)).toBe(true);
  });

  test('rejects proxies/accessors without invocation', () => {
    const state = freshState();
    const getter = jest.fn(() => 'run:lease-test');
    const accessor: any = controllerInput();
    Object.defineProperty(accessor, 'runId', { enumerable: true, get: getter });
    expect(() => acquireControllerLease(state, accessor, clock().sources)).toThrow(TicketAuthorityError);
    expect(getter).not.toHaveBeenCalled();

    const get = jest.fn(Reflect.get);
    const proxy = new Proxy(state, { get });
    expect(() => parseLeaseAuthorityState(proxy)).toThrow(TicketAuthorityError);
    expect(get).not.toHaveBeenCalled();
  });

  test.each([
    ['unknown key', (state: any) => { state.extra = true; }],
    ['controller rollback', (state: any) => { state.controllerLease.generation = 0; }],
    ['fence rollback', (state: any) => { state.controllerLease.fence = 0; }],
    ['controller role misuse', (state: any) => { state.controllerLease.holderRole = 'EXECUTION'; }],
    ['binding mismatch', (state: any) => { state.controllerLease.runId = 'run:other'; }],
    ['timestamp disorder', (state: any) => { state.controllerLease.expiresAt = state.controllerLease.acquiredAt; }],
    ['caller expiry extension', (state: any) => { state.controllerLease.expiresAt = '2026-09-12T00:02:00.000Z'; }]
  ])('rejects malformed state: %s', (_label, mutate) => {
    const time = clock();
    const acquired = acquireControllerLease(freshState(), controllerInput(), time.sources);
    const state: any = JSON.parse(JSON.stringify(acquired.state));
    mutate(state);
    expect(() => parseLeaseAuthorityState(state)).toThrow(TicketAuthorityError);
  });
});

describe('ticket lease integration', () => {
  const identity = {
    providerId: 'host:test',
    sessionRef: 'session:a',
    principalRef: 'principal:a'
  } as const;

  function compiledGraph() {
    return compilePlanGraph({
      planKey: 'lease-ticket',
      planRevision: 1,
      objective: 'Lease-gated tickets',
      scope: ['src/**'],
      outOfScope: [],
      milestones: [{
        key: 'core',
        dependsOn: [],
        criteria: ['Core complete'],
        verification: 'Run tests',
        writeSet: ['src/**'],
        integrationCriteria: ['Integrated'],
        workstreams: [{
          key: 'api',
          criteria: ['API complete'],
          writeSet: ['src/**'],
          leaves: [{ key: 'leaf', criteria: ['Leaf complete'], writeSet: ['src/file.ts'] }]
        }]
      }],
      integrationCriteria: ['Complete'],
      regressionCriteria: [],
      expectedSideEffects: [],
      policy: {},
      budgets: {},
      adapterRequirements: [],
      pauseRules: [],
      failureRules: [],
      cancelRules: [],
      completionRules: []
    });
  }

  function provider(): HostIdentityProvider {
    return {
      currentHostIdentity: async () => identity,
      bindHandle: () => undefined,
      identityForHandle: () => null
    };
  }

  function rootGrant(lease: ReturnType<typeof controllerLeasePlaceholder>) {
    return {
      nodeId: 'workstream-4-core-3-api',
      scope: 'API work',
      roots: ['src/**'],
      operationClasses: ['fs.write'],
      toolClasses: ['editor'],
      credentialClasses: [],
      approvalRefs: ['approval:plan'],
      budgets: { actions: 10 },
      expiresAt: '2026-09-12T00:10:00.000Z',
      maxChildDepth: 1,
      maxFanout: 1,
      lease
    };
  }

  function ticketBinding(broker: ReturnType<typeof createTicketAuthorityBroker>, handle: string) {
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
      cancellationGeneration: state.cancellationGeneration
    };
  }

  test('root issuance needs controller lease; authority resolution and EO delegation need workstream lease', async () => {
    const time = clock();
    let leases = freshState();
    const controller = acquireControllerLease(leases, controllerInput(), time.sources);
    leases = controller.state;
    const compiled = compiledGraph();
    const common = {
      compiled,
      runId: BINDING.runId,
      projectId: BINDING.projectId,
      graphEpoch: BINDING.graphEpoch,
      cancellationGeneration: BINDING.cancellationGeneration,
      hostIdentityProvider: provider(),
      rootAuthority: {
        roots: ['src/**'],
        operationClasses: ['fs.write'],
        toolClasses: ['editor'],
        credentialClasses: [],
        approvalRefs: ['approval:plan'],
        budgets: { actions: 10 },
        expiresAt: '2026-09-12T00:20:00.000Z',
        maxChildDepth: 2,
        maxFanout: 2
      },
      now: () => new Date(START),
      leaseSources: time.sources
    };
    const ticketRandom = (() => {
      let value = 0;
      return () => `ticket-lease-random-${String(++value).padStart(4, '0')}`;
    })();

    const absent = createTicketAuthorityBrokerForTest(common, { random: ticketRandom });
    await expect(absent.issueRoot(rootGrant(controllerLeasePlaceholder(controller.lease))))
      .rejects.toMatchObject({ code: 'lease-required' });

    const broker = createTicketAuthorityBrokerForTest(
      { ...common, leaseState: () => leases },
      { random: ticketRandom }
    );
    await expect(broker.issueRoot(rootGrant({
      ...controllerLeasePlaceholder(controller.lease), generation: 2
    }))).rejects.toMatchObject({ code: 'stale-lease' });

    const issued = await broker.issueRoot(rootGrant(controllerLeasePlaceholder(controller.lease)));
    const binding = ticketBinding(broker, issued.handle);
    expect(await broker.resolveForAuthority(binding))
      .toMatchObject({ ok: false, code: 'lease-required' });
    const claims = await broker.resolveClaimsOnly(binding);
    expect(claims.ok).toBe(true);
    if (!claims.ok) return;

    const workstream = acquireWorkstreamLease(leases, {
      ...BINDING,
      nodeId: claims.claims.nodeId,
      holder: identity,
      controllerHolder: identity,
      controllerProof: controllerProof(controller.lease),
      ticket: claims.claims
    }, {
      ...time.sources,
      testOnlyRandomBytes: entropy('ticket-workstream-lease-ref')
    });
    leases = workstream.state;
    const currentLease = workstreamLeasePlaceholder(workstream.lease);
    expect(await broker.resolveForAuthority({ ...binding, lease: { ...currentLease, generation: 2 } }))
      .toMatchObject({ ok: false, code: 'stale-lease' });
    expect(await broker.resolveForAuthority({ ...binding, lease: currentLease }))
      .toMatchObject({ ok: true });

    const leafGrant = {
      parentHandle: issued.handle,
      nodeId: 'leaf-4-core-3-api-4-leaf',
      scope: 'Leaf work',
      roots: ['src/**'],
      operationClasses: ['fs.write'],
      toolClasses: ['editor'],
      credentialClasses: [],
      approvalRefs: ['approval:plan'],
      budgets: { actions: 5 },
      expiresAt: '2026-09-12T00:05:00.000Z',
      maxChildDepth: 0,
      maxFanout: 1
    };
    await expect(broker.delegate(leafGrant)).rejects.toMatchObject({ code: 'lease-required' });
    await expect(broker.delegate({
      ...leafGrant,
      lease: { ...currentLease, fence: 2 }
    })).rejects.toMatchObject({ code: 'stale-lease' });
    await expect(broker.delegate({ ...leafGrant, lease: currentLease })).resolves.toHaveProperty('handle');
  });

  test('ticket authority rejects released and takeover-stale workstream lease', async () => {
    const time = clock();
    let leases = freshState();
    const controller = acquireControllerLease(leases, controllerInput(), time.sources);
    leases = controller.state;
    const broker = createTicketAuthorityBrokerForTest({
      compiled: compiledGraph(),
      runId: BINDING.runId,
      projectId: BINDING.projectId,
      graphEpoch: BINDING.graphEpoch,
      cancellationGeneration: BINDING.cancellationGeneration,
      hostIdentityProvider: provider(),
      rootAuthority: {
        roots: ['src/**'], operationClasses: ['fs.write'], toolClasses: ['editor'],
        credentialClasses: [], approvalRefs: [], budgets: {},
        expiresAt: '2026-09-12T00:20:00.000Z', maxChildDepth: 2, maxFanout: 2
      },
      leaseState: () => leases,
      leaseSources: time.sources,
      now: () => new Date(START)
    }, {
      random: (() => { let n = 0; return () => `stale-ticket-random-${String(++n).padStart(4, '0')}`; })()
    });
    const issued = await broker.issueRoot({
      ...rootGrant(controllerLeasePlaceholder(controller.lease)), approvalRefs: [], budgets: {}
    });
    const binding = ticketBinding(broker, issued.handle);
    const claims = await broker.resolveClaimsOnly(binding);
    if (!claims.ok) throw new Error(claims.reason);
    const workstream = acquireWorkstreamLease(leases, {
      ...BINDING, nodeId: claims.claims.nodeId, holder: identity, controllerHolder: identity,
      controllerProof: controllerProof(controller.lease), ticket: claims.claims
    }, { ...time.sources, testOnlyRandomBytes: entropy('released-workstream-ref') });
    leases = workstream.state;
    const oldLease = workstreamLeasePlaceholder(workstream.lease);
    const released = releaseWorkstreamLease(
      leases,
      workstreamOperation(workstream.lease),
      time.sources
    );
    leases = released.state;
    expect(await broker.resolveForAuthority({ ...binding, lease: oldLease }))
      .toMatchObject({ ok: false, code: 'inactive-lease' });
    const takeover = acquireWorkstreamLease(leases, {
      ...BINDING, nodeId: claims.claims.nodeId, holder: identity, controllerHolder: identity,
      controllerProof: controllerProof(controller.lease), ticket: claims.claims
    }, { ...time.sources, testOnlyRandomBytes: entropy('takeover-workstream-ref') });
    leases = takeover.state;
    expect(await broker.resolveForAuthority({ ...binding, lease: oldLease }))
      .toMatchObject({ ok: false, code: 'stale-lease' });
  });
});
