import {
  CasConflictError,
  IndeterminateStoreCommitError,
  InMemoryProtectedStoreAdapter,
  ProtectedControllerStore,
  ProtectedControllerStoreWriter,
  RecoveryRequiredError,
  UnsupportedStoreSchemaError
} from '../../src/agents/run/store';
import { compilePlanGraph } from '../../src/agents/run/compiler';
import { compileRunModel } from '../../src/agents/run/controller/model';
import {
  createProtectedRunControllerRepository,
  runControllerStoreKey
} from '../../src/agents/run/controller/repository';
import {
  computeRunControllerModelDigest,
  Digest,
  RunControllerEvent
} from '../../src/agents/run/controller/algebra';
import { reduceRunController } from '../../src/agents/run/controller/reducer';

const D = (hex: string): Digest => `sha256:${hex.repeat(64).slice(0, 64)}` as Digest;

function compiledModel() {
  return compileRunModel(compilePlanGraph({
    planKey: 'repository', planRevision: 2, objective: 'Test repository',
    scope: ['src/**'], outOfScope: [],
    milestones: [{
      key: 'core', dependsOn: [], criteria: ['done'], verification: 'npm test',
      writeSet: ['src/**'], integrationCriteria: ['integrated'],
      workstreams: [{ key: 'runtime', criteria: ['done'], writeSet: ['src/**'], leaves: [] }]
    }],
    integrationCriteria: ['all'], regressionCriteria: ['none'], expectedSideEffects: ['writes'],
    policy: {}, adapterRequirements: ['trusted'], pauseRules: ['pause'], failureRules: ['fail'],
    cancelRules: ['cancel'], completionRules: ['complete']
  }));
}

function create(): RunControllerEvent {
  const model = compiledModel();
  return {
    type: 'create', eventId: 'create', occurredAt: '2026-09-14T01:00:00.000Z',
    runId: 'run:repository', projectId: 'project:repository', model,
    modelDigest: computeRunControllerModelDigest(model),
    fidelityRequirementsDigest: D('1')
  };
}

async function fixture(writerOverride?: ProtectedControllerStoreWriter) {
  const adapter = new InMemoryProtectedStoreAdapter();
  const store = new ProtectedControllerStore({ storeId: 'controller-repository-test', adapter });
  const writer = writerOverride ?? await store.openWriter();
  const repository = createProtectedRunControllerRepository({
    runId: 'run:repository', projectId: 'project:repository', reader: store.reader(), writer
  });
  return { adapter, store, writer, repository };
}

describe('WP-230C1 protected RunController repository', () => {
  test('uses deterministic domain-separated hashed key', () => {
    expect(runControllerStoreKey('project:repository', 'run:repository'))
      .toBe('run-controller/d06258849d1a021f8dd85bfc733f957aed46c912d5b9236f2af21cce674b593a');
    expect(runControllerStoreKey('project:repository', 'run:other'))
      .not.toBe(runControllerStoreKey('project:repository', 'run:repository'));
    expect(() => runControllerStoreKey('', 'run')).toThrow(/projectId/);
  });

  test('initializes and reads one frozen protected aggregate without executing command', async () => {
    const fx = await fixture();
    const initialized = await fx.repository.initialize(create());
    expect(initialized.status).toBe('committed');
    if (initialized.status !== 'committed') throw new Error('Expected commit');
    expect(initialized.snapshot.generation).toBe(1);
    expect(initialized.transition).toMatchObject({ ok: true, commands: [{ kind: 'fidelity.preflight' }] });
    expect(initialized.snapshot.state.outbox[0].command)
      .toEqual((initialized.transition as any).commands[0]);
    expect(Object.isFrozen(initialized.snapshot.state)).toBe(true);
    expect(Object.isFrozen(initialized.snapshot.state.outbox[0].protectedPayload.bindings)).toBe(true);

    const read = await fx.repository.read();
    expect(read).toEqual(expect.objectContaining({ status: 'active', key: fx.repository.key }));
    if (read.status === 'active') expect(read.snapshot).toEqual(initialized.snapshot);
  });

  test('CAS race retries and exact event replay does not duplicate intent or counters', async () => {
    const fx = await fixture();
    const initialized = await fx.repository.initialize(create());
    if (initialized.status !== 'committed') throw new Error('Expected commit');
    const command = initialized.snapshot.state.outbox[0].command;
    const event = {
      type: 'preflight-result', eventId: 'preflight', occurredAt: '2026-09-14T01:00:01.000Z',
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      fidelity: 'exact', requestedMode: 'autonomous', assessmentDigest: D('2')
    } as const;
    const [left, right] = await Promise.all([
      fx.repository.transact(event), fx.repository.transact(event)
    ]);
    expect([left.status, right.status].sort()).toEqual(['committed', 'unchanged']);
    const read = await fx.repository.read();
    if (read.status !== 'active') throw new Error('Expected active');
    expect(read.snapshot.state.counters).toEqual({
      transitionSequence: 2, eventsApplied: 2, commandsIssued: 1
    });
    expect(read.snapshot.state.processedEvents.map(item => item.eventId)).toEqual(['create', 'preflight']);
  });

  test('expected-generation transaction never rebases a completion onto newer state', async () => {
    const fx = await fixture();
    const initialized = await fx.repository.initialize(create());
    if (initialized.status !== 'committed') throw new Error('Expected commit');
    const command = initialized.snapshot.state.outbox[0].command;
    const event = {
      type: 'preflight-result', eventId: 'expected-preflight', occurredAt: '2026-09-14T01:00:01.000Z',
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      fidelity: 'exact', requestedMode: 'autonomous', assessmentDigest: D('2')
    } as const;
    await expect(fx.repository.transactExpected(event, initialized.snapshot.generation + 1))
      .resolves.toMatchObject({
        status: 'generation-conflict', expectedGeneration: initialized.snapshot.generation + 1,
        actualGeneration: initialized.snapshot.generation
      });
    expect((await fx.repository.read() as any).snapshot.state.phase).toBe('preflight');
    await expect(fx.repository.transactExpected(event, initialized.snapshot.generation))
      .resolves.toMatchObject({ status: 'committed' });
    await expect(fx.repository.transactExpected(event, 0)).rejects.toThrow(/expectedGeneration/);
  });

  test('lost commit acknowledgement returns explicit unknown and requires reread reconciliation', async () => {
    const adapter = new InMemoryProtectedStoreAdapter();
    const store = new ProtectedControllerStore({ storeId: 'controller-lost-ack', adapter });
    const base = await store.openWriter();
    let loseAck = true;
    const writer: ProtectedControllerStoreWriter = {
      ...base,
      async compareAndSwap(input) {
        const record = await base.compareAndSwap(input);
        if (loseAck) {
          loseAck = false;
          throw new IndeterminateStoreCommitError('ack lost');
        }
        return record;
      }
    };
    const repository = createProtectedRunControllerRepository({
      runId: 'run:repository', projectId: 'project:repository', reader: store.reader(), writer
    });
    const result = await repository.initialize(create());
    expect(result).toMatchObject({
      status: 'unknown', expectedGeneration: 0, eventId: 'create',
      reason: expect.stringContaining('reread and reconcile')
    });
    const reread = await repository.read();
    expect(reread.status).toBe('active');
    if (reread.status !== 'active') throw new Error('Expected committed state after ack loss');
    const reconciled = reduceRunController(reread.snapshot.state, create());
    expect(reconciled).toMatchObject({ ok: true, code: 'applied' });
    expect((reconciled as any).state.counters).toEqual(reread.snapshot.state.counters);
  });

  test('fails closed on corrupt semantic state, old controller schema, and store recovery/incompatibility', async () => {
    const fx = await fixture();
    const initialized = await fx.repository.initialize(create());
    if (initialized.status !== 'committed') throw new Error('Expected commit');
    const corrupt: any = JSON.parse(JSON.stringify(initialized.snapshot.state));
    corrupt.model.graphDigest = D('f');
    corrupt.outbox[0].protectedPayload.bindings.find((item: any) => item.name === 'graph').digest = D('f');
    await fx.writer.compareAndSwap({
      key: fx.repository.key, expectedGeneration: initialized.snapshot.generation, value: corrupt
    });
    await expect(fx.repository.read()).resolves.toMatchObject({
      status: 'recovery-required', reason: expect.stringContaining('integrity mismatch')
    });

    const oldFx = await fixture();
    const oldInitialized = await oldFx.repository.initialize(create());
    if (oldInitialized.status !== 'committed') throw new Error('Expected commit');
    const old: any = JSON.parse(JSON.stringify(oldInitialized.snapshot.state));
    old.schemaVersion = 0;
    await oldFx.writer.compareAndSwap({
      key: oldFx.repository.key, expectedGeneration: oldInitialized.snapshot.generation, value: old
    });
    await expect(oldFx.repository.read()).resolves.toMatchObject({
      status: 'recovery-required', reason: expect.stringContaining('schemaVersion 0')
    });

    const unavailableWriter = await oldFx.store.openWriter();
    const recovering = createProtectedRunControllerRepository({
      runId: 'run:repository', projectId: 'project:repository',
      reader: {
        ...oldFx.store.reader(),
        async read() { return { status: 'recovery-required', key: 'x', generation: 2, reason: 'corrupt' } as const; }
      },
      writer: unavailableWriter
    });
    await expect(recovering.read()).resolves.toMatchObject({ status: 'recovery-required', reason: 'corrupt' });
    const incompatible = createProtectedRunControllerRepository({
      runId: 'run:repository', projectId: 'project:repository',
      reader: {
        ...oldFx.store.reader(),
        async read() { return { status: 'incompatible', key: 'x', schemaMajor: 9 } as const; }
      },
      writer: unavailableWriter
    });
    await expect(incompatible.read()).resolves.toMatchObject({ status: 'incompatible', schemaMajor: 9 });
  });

  test('reports bounded CAS exhaustion without running or returning new effects', async () => {
    const fx = await fixture();
    const initialized = await fx.repository.initialize(create());
    if (initialized.status !== 'committed') throw new Error('Expected commit');
    const command = initialized.snapshot.state.outbox[0].command;
    const writer: ProtectedControllerStoreWriter = {
      ...fx.writer,
      async compareAndSwap() { throw new CasConflictError('race'); }
    };
    const repository = createProtectedRunControllerRepository({
      runId: 'run:repository', projectId: 'project:repository', reader: fx.store.reader(), writer,
      maxCasRetries: 2
    });
    const result = await repository.transact({
      type: 'preflight-result', eventId: 'never-commits', occurredAt: '2026-09-14T01:00:01.000Z',
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      fidelity: 'exact', requestedMode: 'autonomous', assessmentDigest: D('2')
    });
    expect(result).toEqual(expect.objectContaining({ status: 'concurrency-exhausted', attempts: 2 }));
    const read = await fx.repository.read();
    if (read.status !== 'active') throw new Error('Expected active');
    expect(read.snapshot.state.phase).toBe('preflight');
    expect(read.snapshot.state.outbox).toHaveLength(1);
  });

  test.each([
    [new RecoveryRequiredError('reconcile protected state'), 'recovery-required', undefined],
    [new UnsupportedStoreSchemaError(7), 'incompatible', 7]
  ] as const)('maps CAS-time %s distinctly', async (failure, status, schemaMajor) => {
    const fx = await fixture();
    const initialized = await fx.repository.initialize(create());
    if (initialized.status !== 'committed') throw new Error('Expected commit');
    const command = initialized.snapshot.state.outbox[0].command;
    const writer: ProtectedControllerStoreWriter = {
      ...fx.writer,
      async compareAndSwap() { throw failure; }
    };
    const repository = createProtectedRunControllerRepository({
      runId: 'run:repository', projectId: 'project:repository', reader: fx.store.reader(), writer
    });
    const result = await repository.transact({
      type: 'preflight-result', eventId: `cas-${status}`, occurredAt: '2026-09-14T01:00:01.000Z',
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      fidelity: 'exact', requestedMode: 'autonomous', assessmentDigest: D('2')
    });
    expect(result).toMatchObject({
      status,
      ...(schemaMajor === undefined ? { reason: failure.message } : { schemaMajor })
    });
  });

  test.each([
    [new RecoveryRequiredError('reconcile protected read'), 'recovery-required', undefined],
    [new UnsupportedStoreSchemaError(8), 'incompatible', 8]
  ] as const)('maps read-time %s distinctly', async (failure, status, schemaMajor) => {
    const fx = await fixture();
    const repository = createProtectedRunControllerRepository({
      runId: 'run:repository', projectId: 'project:repository',
      reader: {
        ...fx.store.reader(),
        async read() { throw failure; }
      },
      writer: fx.writer
    });
    await expect(repository.read()).resolves.toMatchObject({
      status,
      ...(schemaMajor === undefined ? { reason: failure.message } : { schemaMajor })
    });
  });

  test('binding mismatch and malformed events fail closed without CAS mutation', async () => {
    const fx = await fixture();
    const initialized = await fx.repository.initialize(create());
    if (initialized.status !== 'committed') throw new Error('Expected commit');
    const before = fx.adapter.testOnlySnapshot(fx.repository.key).mutationCount;
    await expect(fx.repository.transact(new Proxy({}, {}))).resolves.toMatchObject({
      status: 'rejected', transition: { ok: false, code: 'invalid-event' }
    });
    expect(fx.adapter.testOnlySnapshot(fx.repository.key).mutationCount).toBe(before);

    const raw: any = JSON.parse(JSON.stringify(initialized.snapshot.state));
    raw.projectId = 'different-project';
    await fx.writer.compareAndSwap({
      key: fx.repository.key, expectedGeneration: initialized.snapshot.generation, value: raw
    });
    await expect(fx.repository.read()).resolves.toMatchObject({ status: 'recovery-required' });
  });

  test.each(['initialize', 'transact'] as const)(
    '%s propagates non-active read status before event reduction', async method => {
      const cases = [
        {
          expected: { status: 'recovery-required', reason: 'recover first' },
          read: async () => ({
            status: 'recovery-required', key: 'ignored', generation: 3, reason: 'recover first'
          } as const)
        },
        {
          expected: { status: 'incompatible', schemaMajor: 9 },
          read: async () => ({ status: 'incompatible', key: 'ignored', schemaMajor: 9 } as const)
        },
        {
          expected: { status: 'unavailable', reason: 'store offline' },
          read: async () => { throw new Error('store offline'); }
        }
      ];
      for (const item of cases) {
        const fx = await fixture();
        let writes = 0;
        const repository = createProtectedRunControllerRepository({
          runId: 'run:repository', projectId: 'project:repository',
          reader: { ...fx.store.reader(), read: item.read } as any,
          writer: {
            ...fx.writer,
            async compareAndSwap(input) {
              writes += 1;
              return fx.writer.compareAndSwap(input);
            }
          }
        });
        const event = method === 'initialize' ? create() : new Proxy({}, {});
        await expect(repository[method](event)).resolves.toMatchObject(item.expected);
        expect(writes).toBe(0);
      }
    }
  );

  test('missing propagates from transact while initialize alone may create', async () => {
    const fx = await fixture();
    await expect(fx.repository.transact(new Proxy({}, {}))).resolves.toMatchObject({ status: 'missing' });
    await expect(fx.repository.initialize(create())).resolves.toMatchObject({ status: 'committed' });
  });

  test('initialize rejects non-create before reading or exposing unwritten state', async () => {
    const fx = await fixture();
    let reads = 0;
    const baseReader = fx.store.reader();
    const repository = createProtectedRunControllerRepository({
      runId: 'run:repository', projectId: 'project:repository',
      reader: {
        ...baseReader,
        async read<T>(key: string) {
          reads += 1;
          return baseReader.read<T>(key);
        }
      },
      writer: fx.writer
    });
    const result = await repository.initialize({
      type: 'drive', eventId: 'initialize-drive', occurredAt: '2026-09-14T01:00:01.000Z',
      inputDigest: D('2')
    });
    expect(result).toMatchObject({
      status: 'rejected', transition: { ok: false, code: 'not-created', state: undefined }
    });
    expect(reads).toBe(0);
  });

  test('active initialize permits only exact create replay and preserves stored snapshot', async () => {
    const fx = await fixture();
    const event = create();
    const initialized = await fx.repository.initialize(event);
    if (initialized.status !== 'committed') throw new Error('Expected commit');
    const mutations = fx.adapter.testOnlySnapshot(fx.repository.key).mutationCount;

    const replay = await fx.repository.initialize(event);
    expect(replay).toMatchObject({ status: 'unchanged', transition: { ok: true, code: 'applied' } });
    if (replay.status !== 'unchanged') throw new Error('Expected unchanged replay');
    expect(replay.transition.state).toBe(replay.snapshot.state);
    expect(replay.snapshot.state).toEqual(initialized.snapshot.state);

    const sameIdConflict = await fx.repository.initialize({
      ...event, fidelityRequirementsDigest: D('2')
    });
    expect(sameIdConflict).toMatchObject({
      status: 'rejected', transition: { ok: false, code: 'event-id-conflict' }
    });
    const differentCreate = await fx.repository.initialize({
      ...event, eventId: 'different-create', occurredAt: '2026-09-14T01:00:01.000Z'
    });
    expect(differentCreate).toMatchObject({
      status: 'rejected', transition: { ok: false, code: 'already-created' }
    });
    expect(fx.adapter.testOnlySnapshot(fx.repository.key).mutationCount).toBe(mutations);
  });

  test('active initialize cannot return unchanged for a mutating event', async () => {
    const fx = await fixture();
    const initialized = await fx.repository.initialize(create());
    if (initialized.status !== 'committed') throw new Error('Expected commit');
    const command = initialized.snapshot.state.outbox[0].command;
    const mutations = fx.adapter.testOnlySnapshot(fx.repository.key).mutationCount;
    const result = await fx.repository.initialize({
      type: 'preflight-result', eventId: 'initialize-preflight',
      occurredAt: '2026-09-14T01:00:01.000Z', commandId: command.id,
      controllerEpoch: command.expectedControllerEpoch, leaseFence: command.expectedLeaseFence,
      attempt: command.attempt, fidelity: 'exact', requestedMode: 'autonomous', assessmentDigest: D('2')
    });
    expect(result).toMatchObject({
      status: 'rejected', transition: { ok: false, code: 'not-created', state: undefined }
    });
    expect(result).not.toHaveProperty('snapshot');
    expect(fx.adapter.testOnlySnapshot(fx.repository.key).mutationCount).toBe(mutations);
  });
});
