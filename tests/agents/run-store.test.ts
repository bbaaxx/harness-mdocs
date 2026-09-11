import {
  AuthorityEnvelope,
  CasConflictError,
  computeAuthorityChecksum,
  CONTROLLER_AUTHORITY_FORMAT,
  createProjectControllerMirror,
  decodeAuthorityEnvelope,
  encodeAuthorityEnvelope,
  InMemoryProtectedStoreAdapter,
  ProtectedControllerStore,
  RecoveryRequiredError,
  STORE_VALUE_LIMITS,
  StaleWriterError,
  UnsupportedStoreSchemaError
} from '../../src/agents/run/store';
import { canonicalizeJson } from '../../src/agents/contracts';
import { createLegacyControllerStore } from '../../src/agents/run/trust/store';

function setup(storeId = 'store:test') {
  const adapter = new InMemoryProtectedStoreAdapter();
  const store = new ProtectedControllerStore({ storeId, adapter });
  return { adapter, store };
}

function mutateRaw(raw: Buffer, mutate: (value: Record<string, any>) => void): Buffer {
  const value = JSON.parse(raw.toString('utf8')) as Record<string, any>;
  mutate(value);
  return Buffer.from(canonicalizeJson(value));
}

function mutateRawAndRechecksum(raw: Buffer, mutate: (value: Record<string, any>) => void): Buffer {
  const value = JSON.parse(raw.toString('utf8')) as Record<string, any>;
  mutate(value);
  const { checksum: _checksum, ...preimage } = value;
  value.checksum = computeAuthorityChecksum(preimage as Omit<AuthorityEnvelope<unknown>, 'checksum'>);
  return Buffer.from(canonicalizeJson(value));
}

function replaceRawValue(raw: Buffer, valueJson: string): Buffer {
  const text = raw.toString('utf8');
  const start = text.indexOf('"value":');
  const end = text.lastIndexOf(',"writerGeneration":');
  if (start < 0 || end < start) throw new Error('Fixture envelope has no value field');
  return Buffer.from(`${text.slice(0, start)}"value":${valueJson}${text.slice(end)}`);
}

const GOLDEN_PREIMAGE: Omit<AuthorityEnvelope<unknown>, 'checksum'> = {
  format: CONTROLLER_AUTHORITY_FORMAT,
  schemaMajor: 1,
  recordType: 'value',
  storeId: 'store:golden',
  key: 'checkpoint/run:1',
  generation: 1,
  writerGeneration: 1,
  previousChecksum: null,
  value: { a: 1, b: 'two' }
};

describe('controller authority codec', () => {
  test('has literal golden checksum and deterministic key order', () => {
    expect(computeAuthorityChecksum(GOLDEN_PREIMAGE)).toBe(
      'sha256:8e081932825545b3988d4e0f05988888f15fc4b475ef795d3cfd70f814dd8445'
    );
    expect(computeAuthorityChecksum({
      ...GOLDEN_PREIMAGE,
      value: { b: 'two', a: 1 }
    })).toBe(computeAuthorityChecksum(GOLDEN_PREIMAGE));
  });

  test.each([
    ['key', { key: 'checkpoint/run:2' }],
    ['store', { storeId: 'store:other' }],
    ['generation', { generation: 2 }],
    ['writer', { writerGeneration: 2 }],
    ['type', { recordType: 'recovery-pending' as const }],
    ['previous checksum', { previousChecksum: `sha256:${'1'.repeat(64)}` }],
    ['value', { value: { a: 2, b: 'two' } }]
  ])('checksum commits %s', (_label, change) => {
    expect(computeAuthorityChecksum({ ...GOLDEN_PREIMAGE, ...change }))
      .not.toBe(computeAuthorityChecksum(GOLDEN_PREIMAGE));
  });

  test('__proto__, constructor, and prototype survive copy, checksum, and decode', async () => {
    const { adapter, store } = setup('store:prototype-keys');
    const writer = await store.openWriter();
    const value = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of [
      ['__proto__', { retained: 1 }],
      ['constructor', { retained: 2 }],
      ['prototype', { retained: 3 }]
    ] as const) {
      Object.defineProperty(value, key, {
        value: entry,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }

    const record = await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value });
    expect(Object.keys(record.value).sort()).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(Object.getPrototypeOf(record.value)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(record.value, '__proto__')).toBe(true);
    expect((record.value as any).__proto__).toEqual({ retained: 1 });
    const raw = adapter.testOnlySnapshot('checkpoint').value!.bytes;
    expect(raw.toString('utf8')).toContain('"__proto__"');
    const parsed = JSON.parse(raw.toString('utf8')) as AuthorityEnvelope<unknown>;
    const { checksum, ...preimage } = parsed;
    expect(checksum).toBe(computeAuthorityChecksum(preimage));
    const reread = await store.reader().read<Record<string, unknown>>('checkpoint');
    expect(reread.status).toBe('active');
    if (reread.status === 'active') {
      expect(Object.keys(reread.record.value).sort()).toEqual(['__proto__', 'constructor', 'prototype']);
      expect(Object.getPrototypeOf(reread.record.value)).toBeNull();
    }
  });

  test('encoder enforces final canonical envelope bytes at boundary', () => {
    const encodeWithKey = (key: string) => encodeAuthorityEnvelope({
      recordType: 'value',
      storeId: 's'.repeat(64 * 1024),
      key,
      generation: 1,
      writerGeneration: 1,
      previousChecksum: null,
      value: null
    });
    let low = 1;
    let high = STORE_VALUE_LIMITS.maxEncodedBytes;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      try {
        encodeWithKey('k'.repeat(middle));
        low = middle;
      } catch {
        high = middle - 1;
      }
    }
    const boundary = encodeWithKey('k'.repeat(low));
    expect(boundary.byteLength).toBeLessThanOrEqual(STORE_VALUE_LIMITS.maxEncodedBytes);
    expect(() => encodeWithKey('k'.repeat(low + 1))).toThrow(/final canonical record/i);
  });

  test('oversized key/store metadata rejects before per-key adapter mutation', async () => {
    expect(() => new ProtectedControllerStore({
      storeId: 's'.repeat(STORE_VALUE_LIMITS.maxCanonicalBytes + 1),
      adapter: new InMemoryProtectedStoreAdapter()
    })).toThrow(/too large/i);

    const { adapter, store } = setup('s'.repeat(700_000));
    const writer = await store.openWriter();
    const key = 'k'.repeat(500_000);
    const before = adapter.testOnlySnapshot(key);
    await expect(writer.compareAndSwap({ key, expectedGeneration: 0, value: null }))
      .rejects.toThrow(/final canonical record/i);
    const after = adapter.testOnlySnapshot(key);
    expect(after.physicalRevision).toBe(before.physicalRevision);
    expect(after.value).toBeUndefined();
    expect(after.valueHistory).toHaveLength(0);

    await expect(writer.compareAndSwap({
      key: 'k'.repeat(STORE_VALUE_LIMITS.maxCanonicalBytes + 1),
      expectedGeneration: 0,
      value: null
    })).rejects.toThrow(/too large/i);
  });
});

describe('protected controller store concurrency', () => {
  test('same-generation CAS race has exactly one winner', async () => {
    const { store } = setup();
    const writer = await store.openWriter();
    const results = await Promise.allSettled([
      writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { winner: 'a' } }),
      writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { winner: 'b' } })
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(CasConflictError);
    const read = await store.reader().read<{ winner: string }>('checkpoint');
    expect(read.status).toBe('active');
    if (read.status === 'active') expect(['a', 'b']).toContain(read.record.value.winner);
  });

  test('append race has one winner and checksum chain', async () => {
    const { store } = setup();
    const writer = await store.openWriter();
    const firstRace = await Promise.allSettled([
      writer.append({ key: 'intent/run:1', expectedSequence: 0, entry: { action: 'a' } }),
      writer.append({ key: 'intent/run:1', expectedSequence: 0, entry: { action: 'b' } })
    ]);
    const first = firstRace.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>;
    expect(firstRace.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(first.value.value.sequence).toBe(1);
    expect(first.value.previousChecksum).toBeNull();

    const second = await writer.append({
      key: 'intent/run:1', expectedSequence: 1, entry: { action: 'second' }
    });
    expect(second.value.sequence).toBe(2);
    expect(second.previousChecksum).toBe(first.value.checksum);
  });

  test('new writer fences old writer before value and generation checks', async () => {
    const { store } = setup();
    const oldWriter = await store.openWriter();
    await oldWriter.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { state: 1 } });
    await store.openWriter();
    let getterCalls = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'state', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 2;
      }
    });

    await expect(oldWriter.compareAndSwap({
      key: 'checkpoint', expectedGeneration: 1, value: hostile
    })).rejects.toThrow(StaleWriterError);
    expect(getterCalls).toBe(0);
  });

  test.each(['snapshot', 'value-commit'] as const)(
    'writer opened at %s window fences atomic commit with zero key mutation',
    async point => {
      const { adapter, store } = setup(`store:fence-${point}`);
      const oldWriter = await store.openWriter();
      const before = adapter.testOnlySnapshot('checkpoint');
      adapter.testOnlyBeforeNext(point, () => { void store.openWriter(); });

      await expect(oldWriter.compareAndSwap({
        key: 'checkpoint', expectedGeneration: 0, value: { state: point }
      })).rejects.toThrow(StaleWriterError);
      const after = adapter.testOnlySnapshot('checkpoint');
      expect(after.physicalRevision).toBe(before.physicalRevision);
      expect(after.valueGenerationHighWater).toBe(0);
      expect(after.valueHistory).toHaveLength(0);
      expect(after.value).toBeUndefined();
    }
  );

  test('CAS committed inside outer commit window wins physical revision race', async () => {
    const { adapter, store } = setup('store:commit-race');
    const writer = await store.openWriter();
    adapter.testOnlyBeforeNext('value-commit', () => {
      void writer.compareAndSwap({
        key: 'checkpoint', expectedGeneration: 0, value: { winner: 'interleaved' }
      });
    });

    await expect(writer.compareAndSwap({
      key: 'checkpoint', expectedGeneration: 0, value: { winner: 'outer' }
    })).rejects.toThrow(CasConflictError);
    const read = await store.reader().read<{ winner: string }>('checkpoint');
    expect(read.status).toBe('active');
    if (read.status === 'active') expect(read.record.value.winner).toBe('interleaved');
    expect(adapter.testOnlySnapshot('checkpoint').valueHistory).toHaveLength(1);
  });

  test('writer opened inside append commit fences old append atomically', async () => {
    const { adapter, store } = setup('store:fence-append');
    const oldWriter = await store.openWriter();
    const before = adapter.testOnlySnapshot('log');
    adapter.testOnlyBeforeNext('append-commit', () => { void store.openWriter(); });

    await expect(oldWriter.append({ key: 'log', expectedSequence: 0, entry: { action: 1 } }))
      .rejects.toThrow(StaleWriterError);
    const after = adapter.testOnlySnapshot('log');
    expect(after.physicalRevision).toBe(before.physicalRevision);
    expect(after.appendSequenceHighWater).toBe(0);
    expect(after.appendHistory).toHaveLength(0);
  });
});

describe('copy and immutability boundary', () => {
  test('input and returned mutations cannot alter deeply frozen state', async () => {
    const { store } = setup();
    const writer = await store.openWriter();
    const input = { nested: { values: [1, 2] } };
    const committed = await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: input });
    input.nested.values[0] = 99;

    expect(Object.isFrozen(committed)).toBe(true);
    expect(Object.isFrozen(committed.value)).toBe(true);
    expect(Object.isFrozen(committed.value.nested)).toBe(true);
    expect(Object.isFrozen(committed.value.nested.values)).toBe(true);
    expect(() => ((committed.value.nested.values as number[])[0] = 88)).toThrow();
    const read = await store.reader().read<typeof input>('checkpoint');
    expect(read.status).toBe('active');
    if (read.status === 'active') expect(read.record.value.nested.values).toEqual([1, 2]);
  });

  test('hostile values are rejected before mutation and accessors are not invoked', async () => {
    const cases: Array<[string, () => unknown, (() => void)?]> = [];
    let accessorCalls = 0;
    cases.push(['accessor', () => {
      const value = {};
      Object.defineProperty(value, 'secret', {
        enumerable: true,
        get: () => {
          accessorCalls += 1;
          return 'secret';
        }
      });
      return value;
    }]);
    const cycle: any = {};
    cycle.self = cycle;
    cases.push(['cycle', () => cycle]);
    cases.push(['sparse array', () => Array(2)]);
    cases.push(['extra array property', () => Object.assign([1], { extra: true })]);
    cases.push(['symbol', () => ({ ok: true, [Symbol('hidden')]: true })]);
    cases.push(['non-enumerable', () => {
      const value = { ok: true };
      Object.defineProperty(value, 'hidden', { value: true, enumerable: false });
      return value;
    }]);
    cases.push(['class', () => new (class Example { value = 1; })()]);
    cases.push(['unsafe number', () => ({ value: Number.MAX_SAFE_INTEGER + 1 })]);
    cases.push(['negative zero', () => ({ value: -0 })]);
    cases.push(['oversize', () => ({ value: 'x'.repeat(1024 * 1024 + 1) })]);
    cases.push(['too deep', () => {
      const root: any = {};
      let cursor = root;
      for (let depth = 0; depth < 66; depth += 1) cursor = cursor.next = {};
      return root;
    }]);

    for (const [label, makeValue] of cases) {
      const { adapter, store } = setup(`store:${label}`);
      const writer = await store.openWriter();
      const before = adapter.testOnlySnapshot('key');
      await expect(writer.compareAndSwap({
        key: 'key', expectedGeneration: 0, value: makeValue()
      })).rejects.toThrow(/rejected/i);
      const after = adapter.testOnlySnapshot('key');
      expect({ label, value: after.value }).toEqual({ label, value: undefined });
      expect({ label, highWater: after.valueGenerationHighWater }).toEqual({ label, highWater: 0 });
      expect({ label, history: after.valueHistory }).toEqual({ label, history: [] });
      expect({ label, mutations: after.mutationCount })
        .toEqual({ label, mutations: before.mutationCount });
    }
    expect(accessorCalls).toBe(0);
  });

  test('adapter snapshots copy raw buffers', async () => {
    const { adapter, store } = setup();
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { state: 1 } });
    const first = adapter.testOnlySnapshot('checkpoint').value!.bytes;
    first.fill(0);
    expect(adapter.testOnlySnapshot('checkpoint').value!.bytes.equals(first)).toBe(false);
  });
});

describe('corruption, quarantine, and recovery', () => {
  test('valid value bytes marked recovery-required are hidden and CAS cannot mutate them', async () => {
    const { adapter, store } = setup('store:marked-value');
    const writer = await store.openWriter();
    await writer.compareAndSwap({
      key: 'checkpoint', expectedGeneration: 0, value: { secret: 'authority' }
    });
    adapter.testOnlySetValueNeedsRecovery('checkpoint');
    const before = adapter.testOnlySnapshot('checkpoint');

    const read = await store.reader().read('checkpoint');
    expect(read.status).toBe('recovery-required');
    expect('record' in read).toBe(false);
    await expect(writer.compareAndSwap({
      key: 'checkpoint', expectedGeneration: 1, value: { secret: 'replacement' }
    })).rejects.toThrow(RecoveryRequiredError);

    const after = adapter.testOnlySnapshot('checkpoint');
    expect(after.physicalRevision).toBe(before.physicalRevision);
    expect(after.mutationCount).toBe(before.mutationCount);
    expect(after.value!.bytes.equals(before.value!.bytes)).toBe(true);
    expect(after.valueGenerationHighWater).toBe(1);
    expect(after.valueHistory).toHaveLength(1);
    expect(after.valueNeedsRecovery).toBe(true);
  });

  test.each([
    ['bit flip', (raw: Buffer) => {
      const changed = Buffer.from(raw);
      changed[changed.length - 2] ^= 1;
      return changed;
    }],
    ['malformed JSON', (_raw: Buffer) => Buffer.from('{malformed')],
    ['key swap', (raw: Buffer) => mutateRaw(raw, value => { value.key = 'other'; })],
    ['generation edit', (raw: Buffer) => mutateRaw(raw, value => { value.generation += 1; })],
    ['checksum edit', (raw: Buffer) => mutateRaw(raw, value => { value.checksum = `sha256:${'0'.repeat(64)}`; })]
  ])('%s returns recovery-required and no value', async (_label, corrupt) => {
    const { adapter, store } = setup();
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { secret: 'authority' } });
    adapter.testOnlyReplaceValueRaw('checkpoint', corrupt(adapter.testOnlySnapshot('checkpoint').value!.bytes));

    const read = await store.reader().read('checkpoint');
    expect(read.status).toBe('recovery-required');
    expect('record' in read).toBe(false);
    expect(adapter.testOnlySnapshot('checkpoint').value).toBeUndefined();
    expect(adapter.testOnlySnapshot('checkpoint').valueHistory).toHaveLength(1);
  });

  test.each([
    ['encoded bytes', (_raw: Buffer) => Buffer.alloc(STORE_VALUE_LIMITS.maxEncodedBytes + 1, 0x78)],
    ['decoded depth', (raw: Buffer) => replaceRawValue(
      raw,
      `${'['.repeat(10_000)}0${']'.repeat(10_000)}`
    )],
    ['decoded node count', (raw: Buffer) => replaceRawValue(
      raw,
      `[${new Array(STORE_VALUE_LIMITS.maxNodes).fill('0').join(',')}]`
    )],
    ['decoded array size', (raw: Buffer) => replaceRawValue(
      raw,
      `[${new Array(STORE_VALUE_LIMITS.maxCollectionEntries + 1).fill('0').join(',')}]`
    )],
    ['decoded string size', (raw: Buffer) => replaceRawValue(
      raw,
      JSON.stringify('x'.repeat(STORE_VALUE_LIMITS.maxStringBytes + 1))
    )]
  ])('%s limit fails closed and quarantines without escaping', async (_label, corrupt) => {
    const { adapter, store } = setup();
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { state: 1 } });
    const raw = adapter.testOnlySnapshot('checkpoint').value!.bytes;
    adapter.testOnlyReplaceValueRaw('checkpoint', corrupt(raw));

    await expect(store.reader().read('checkpoint')).resolves.toEqual(expect.objectContaining({
      status: 'recovery-required', generation: 1
    }));
    expect(adapter.testOnlySnapshot('checkpoint').value).toBeUndefined();
  });

  test('old replay below high-water is quarantined and generation never resets', async () => {
    const { adapter, store } = setup();
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { state: 1 } });
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 1, value: { state: 2 } });
    const history = adapter.testOnlySnapshot('checkpoint').valueHistory;
    adapter.testOnlyReplaceValueRaw('checkpoint', history[0]);

    expect((await store.reader().read('checkpoint')).status).toBe('recovery-required');
    await expect(writer.compareAndSwap({
      key: 'checkpoint', expectedGeneration: 0, value: { state: 'reset' }
    })).rejects.toThrow(RecoveryRequiredError);
    const recovery = await writer.recover<{ state: number }>({ key: 'checkpoint', incidentId: 'incident:1' });
    expect(recovery.pending.generation).toBe(3);
    expect(recovery.candidate?.generation).toBe(2);
    expect(recovery.candidate?.value).toEqual({ state: 2 });
    expect((await store.reader().read('checkpoint')).status).toBe('recovery-required');

    const currentWriter = await store.openWriter();
    await expect(writer.resolveRecovery({
      key: 'checkpoint', expectedGeneration: 3, reconciledValue: { state: 3 }
    })).rejects.toThrow(StaleWriterError);
    await expect(currentWriter.resolveRecovery({
      key: 'checkpoint', expectedGeneration: 2, reconciledValue: { state: 3 }
    })).rejects.toThrow(CasConflictError);
    const resolved = await currentWriter.resolveRecovery({
      key: 'checkpoint', expectedGeneration: 3, reconciledValue: { state: 3 }
    });
    expect(resolved.generation).toBe(4);
    const read = await store.reader().read<{ state: number }>('checkpoint');
    expect(read.status).toBe('active');
    if (read.status === 'active') expect(read.record.value).toEqual({ state: 3 });
  });

  test('older record writer remains valid after writer rotation', async () => {
    const { store } = setup();
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { state: 1 } });
    await store.openWriter();

    const read = await store.reader().read<{ state: number }>('checkpoint');
    expect(read.status).toBe('active');
    if (read.status === 'active') {
      expect(read.record.writerGeneration).toBe(1);
      expect(read.record.value.state).toBe(1);
    }
  });

  test.each([
    ['raw envelope fence', (adapter: InMemoryProtectedStoreAdapter, raw: Buffer) => {
      adapter.testOnlyReplaceValueRaw('checkpoint', mutateRawAndRechecksum(raw, value => {
        value.writerGeneration = 2;
      }));
    }],
    ['trusted per-key fence', (adapter: InMemoryProtectedStoreAdapter, _raw: Buffer) => {
      adapter.testOnlySetValueWriterGeneration('checkpoint', 0);
    }],
    ['global current fence rollback', (adapter: InMemoryProtectedStoreAdapter, _raw: Buffer) => {
      adapter.testOnlySetCurrentWriterGeneration(0);
    }]
  ])('%s never returns stale authority as active', async (_label, corruptFence) => {
    const { adapter, store } = setup();
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { secret: true } });
    const raw = adapter.testOnlySnapshot('checkpoint').value!.bytes;
    corruptFence(adapter, raw);

    const read = await store.reader().read('checkpoint');
    expect(read.status).toBe('recovery-required');
    expect('record' in read).toBe(false);
    expect(adapter.testOnlySnapshot('checkpoint').value).toBeUndefined();
  });

  test('quarantine only removes observed revision, not concurrent replacement', async () => {
    const { adapter, store } = setup();
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { state: 'fresh' } });
    const valid = adapter.testOnlySnapshot('checkpoint').value!.bytes;
    adapter.testOnlyReplaceValueRaw('checkpoint', '{malformed');
    adapter.testOnlyBeforeNextQuarantine(() => adapter.testOnlyReplaceValueRaw('checkpoint', valid));

    const read = await store.reader().read<{ state: string }>('checkpoint');
    expect(read.status).toBe('active');
    if (read.status === 'active') expect(read.record.value.state).toBe('fresh');
    expect(adapter.testOnlySnapshot('checkpoint').valueNeedsRecovery).toBe(false);
  });

  test('recover can quarantine unread corruption and still creates pending state', async () => {
    const { adapter, store } = setup();
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { state: 1 } });
    adapter.testOnlyReplaceValueRaw('checkpoint', '{malformed');

    const recovery = await writer.recover<{ state: number }>({
      key: 'checkpoint', incidentId: 'incident:direct'
    });
    expect(recovery.pending.recordType).toBe('recovery-pending');
    expect(recovery.pending.generation).toBe(2);
    expect(recovery.candidate?.value).toEqual({ state: 1 });
  });

  test('post-quarantine concurrent incident is reinspected and never overwritten', async () => {
    const { adapter, store } = setup();
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { state: 1 } });
    adapter.testOnlyReplaceValueRaw('checkpoint', '{malformed');
    adapter.testOnlyBeforeNext('post-quarantine', () => {
      void writer.recover({ key: 'checkpoint', incidentId: 'incident:concurrent' });
    });

    await expect(writer.recover({ key: 'checkpoint', incidentId: 'incident:outer' }))
      .rejects.toThrow(/different recovery incident/i);
    const read = await store.reader().read('checkpoint');
    expect(read).toEqual(expect.objectContaining({
      status: 'recovery-required',
      incidentId: 'incident:concurrent',
      generation: 2
    }));
    const snapshot = adapter.testOnlySnapshot('checkpoint');
    expect(snapshot.valueGenerationHighWater).toBe(2);
    expect(snapshot.valueHistory).toHaveLength(2);
  });

  test('unknown major preserves bytes exactly and causes zero key mutation', async () => {
    const { adapter, store } = setup();
    const writer = await store.openWriter();
    await writer.compareAndSwap({ key: 'checkpoint', expectedGeneration: 0, value: { state: 1 } });
    const unknown = mutateRaw(adapter.testOnlySnapshot('checkpoint').value!.bytes, value => {
      value.schemaMajor = 2;
      value.value = { future: { opaque: true } };
    });
    adapter.testOnlyReplaceValueRaw('checkpoint', unknown);
    const before = adapter.testOnlySnapshot('checkpoint');

    expect(await store.reader().read('checkpoint')).toEqual({
      status: 'incompatible', key: 'checkpoint', schemaMajor: 2
    });
    await expect(writer.compareAndSwap({
      key: 'checkpoint', expectedGeneration: 1, value: { state: 2 }
    })).rejects.toThrow(UnsupportedStoreSchemaError);
    const after = adapter.testOnlySnapshot('checkpoint');
    expect(after.value!.bytes.equals(unknown)).toBe(true);
    expect(after.value!.revision).toBe(before.value!.revision);
    expect(after.valueHistory).toHaveLength(before.valueHistory.length);
    expect(after.valueGenerationHighWater).toBe(before.valueGenerationHighWater);
    expect(after.mutationCount).toBe(before.mutationCount);
  });

  test('writer, value generation, and append sequence exhaustion fail closed', async () => {
    const writerExhausted = setup('store:writer-exhausted');
    writerExhausted.adapter.testOnlySetWriterGeneration(Number.MAX_SAFE_INTEGER);
    await expect(writerExhausted.store.openWriter()).rejects.toThrow(/exhausted/i);

    const valueExhausted = setup('store:value-exhausted');
    const valueWriter = await valueExhausted.store.openWriter();
    valueExhausted.adapter.testOnlySetValueGenerationHighWater('checkpoint', Number.MAX_SAFE_INTEGER);
    await expect(valueWriter.recover({
      key: 'checkpoint', incidentId: 'incident:overflow'
    })).rejects.toThrow(/exhausted/i);
    expect(valueExhausted.adapter.testOnlySnapshot('checkpoint').value).toBeUndefined();

    const appendExhausted = setup('store:append-exhausted');
    const appendWriter = await appendExhausted.store.openWriter();
    appendExhausted.adapter.testOnlySetAppendSequenceHighWater('log', Number.MAX_SAFE_INTEGER);
    await expect(appendWriter.append({
      key: 'log', expectedSequence: Number.MAX_SAFE_INTEGER, entry: { state: 1 }
    })).rejects.toThrow(/unavailable/i);
    expect(appendExhausted.adapter.testOnlySnapshot('log').append).toBeUndefined();
  });
});

describe('legacy controller store append facade', () => {
  test('opens writer lazily and memoizes an observed writer-open rejection', async () => {
    const { store } = setup('store:legacy-lazy-writer');
    const failure = new Error('writer unavailable');
    const openWriter = jest.spyOn(store, 'openWriter').mockRejectedValue(failure);
    const facade = createLegacyControllerStore(store);

    expect(openWriter).not.toHaveBeenCalled();
    await expect(facade.get('missing')).resolves.toBeUndefined();
    expect(openWriter).not.toHaveBeenCalled();

    await expect(facade.compareAndSwap('checkpoint', { state: 1 }, 0)).rejects.toBe(failure);
    await expect(facade.compareAndSwap('checkpoint', { state: 2 }, 0)).rejects.toBe(failure);
    expect(openWriter).toHaveBeenCalledTimes(1);
  });

  test('snapshots write and queued append inputs before caller mutation', async () => {
    const { adapter, store } = setup('store:legacy-input-snapshot');
    const facade = createLegacyControllerStore(store);
    const value = { nested: { state: 'original' } };

    const write = facade.compareAndSwap('checkpoint', value, 0);
    value.nested.state = 'mutated';
    await expect(write).resolves.toBe(1);

    const firstEntry = { nested: { action: 'first-original' } };
    const secondEntry = { nested: { action: 'second-original' } };
    const firstAppend = facade.append('intent/run:snapshot', firstEntry);
    const queuedAppend = facade.append('intent/run:snapshot', secondEntry);
    firstEntry.nested.action = 'first-mutated';
    secondEntry.nested.action = 'second-mutated';
    await Promise.all([firstAppend, queuedAppend]);

    const read = await facade.get<typeof value>('checkpoint');
    expect(read?.value).toEqual({ nested: { state: 'original' } });
    const entries = adapter.testOnlySnapshot('intent/run:snapshot').appendHistory.map(raw => {
      const decoded = decodeAuthorityEnvelope<{
        sequence: number;
        entry: { nested: { action: string } };
      }>(raw, 'store:legacy-input-snapshot', 'intent/run:snapshot');
      if (decoded.status !== 'compatible') throw new Error('Expected compatible append record');
      return decoded.envelope.value.entry;
    });
    expect(entries).toEqual([
      { nested: { action: 'first-original' } },
      { nested: { action: 'second-original' } }
    ]);
  });

  test('rejects accessor, proxy, and invalid inputs before writer open or queue delay', async () => {
    const { adapter, store } = setup('store:legacy-invalid-input');
    const openWriter = jest.spyOn(store, 'openWriter');
    const facade = createLegacyControllerStore(store);
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'secret';
      }
    });
    const proxyTrap = jest.fn(() => {
      throw new Error('proxy rejected');
    });
    const proxy = new Proxy({}, { getPrototypeOf: proxyTrap });

    const accessorFailure = facade.compareAndSwap('checkpoint', accessor, 0);
    const proxyFailure = facade.append('intent/run:invalid', proxy);
    const invalidFailure = facade.append('intent/run:invalid', { missing: undefined });
    expect(getterCalls).toBe(0);
    expect(proxyTrap).toHaveBeenCalledTimes(1);
    expect(openWriter).not.toHaveBeenCalled();
    await expect(accessorFailure).rejects.toThrow(/accessor/i);
    await expect(proxyFailure).rejects.toThrow('proxy rejected');
    await expect(invalidFailure).rejects.toThrow(/rejected/i);
    expect(openWriter).not.toHaveBeenCalled();
    expect(adapter.testOnlySnapshot('intent/run:invalid').appendHistory).toHaveLength(0);
  });

  test('valid append bytes marked recovery-required are hidden and append cannot mutate them', async () => {
    const { adapter, store } = setup('store:marked-append');
    const writer = await store.openWriter();
    await writer.append({ key: 'intent/run:1', expectedSequence: 0, entry: { action: 1 } });
    adapter.testOnlySetAppendNeedsRecovery('intent/run:1');
    const before = adapter.testOnlySnapshot('intent/run:1');

    expect(await store.reader().appendHead('intent/run:1')).toEqual({
      status: 'recovery-required', key: 'intent/run:1', sequence: 1
    });
    await expect(writer.append({
      key: 'intent/run:1', expectedSequence: 1, entry: { action: 2 }
    })).rejects.toThrow(RecoveryRequiredError);

    const after = adapter.testOnlySnapshot('intent/run:1');
    expect(after.physicalRevision).toBe(before.physicalRevision);
    expect(after.mutationCount).toBe(before.mutationCount);
    expect(after.append!.bytes.equals(before.append!.bytes)).toBe(true);
    expect(after.appendSequenceHighWater).toBe(1);
    expect(after.appendHistory).toHaveLength(1);
    expect(after.appendNeedsRecovery).toBe(true);
  });

  test('concurrent appends retry to unique sequences and recreated facade resumes head', async () => {
    const { adapter, store } = setup('store:legacy');
    const firstFacade = createLegacyControllerStore(store);
    await firstFacade.append('intent/run:1', { action: 'first' });

    const recreated = createLegacyControllerStore(store);
    await Promise.all([
      recreated.append('intent/run:1', { action: 'second' }),
      recreated.append('intent/run:1', { action: 'third' })
    ]);

    const snapshot = adapter.testOnlySnapshot('intent/run:1');
    expect(snapshot.appendSequenceHighWater).toBe(3);
    expect(snapshot.appendHistory).toHaveLength(3);
    expect(snapshot.appendHistory.map(raw => JSON.parse(raw.toString('utf8')).value.sequence))
      .toEqual([1, 2, 3]);
    expect(await store.reader().appendHead('intent/run:1')).toEqual(expect.objectContaining({
      status: 'active', sequence: 3
    }));
  });

  test('serializes a healthy burst per key without treating cached sequence as authority', async () => {
    const { adapter, store } = setup('store:legacy-burst');
    const facade = createLegacyControllerStore(store);
    const key = 'intent/run:burst';
    const count = 64;

    await Promise.all(Array.from({ length: count }, (_, index) =>
      facade.append(key, { index })
    ));

    const snapshot = adapter.testOnlySnapshot(key);
    expect(snapshot.appendSequenceHighWater).toBe(count);
    expect(snapshot.appendHistory).toHaveLength(count);
    const records = snapshot.appendHistory.map(raw => {
      const decoded = decodeAuthorityEnvelope<{ sequence: number; entry: { index: number } }>(
        raw,
        'store:legacy-burst',
        key
      );
      expect(decoded.status).toBe('compatible');
      if (decoded.status !== 'compatible') throw new Error('Expected compatible append record');
      return decoded.envelope;
    });
    expect(records.map(record => record.generation))
      .toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(records.map(record => record.value.sequence))
      .toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(new Set(records.map(record => record.value.entry.index)).size).toBe(count);
    expect(records.map(record => record.previousChecksum))
      .toEqual([null, ...records.slice(0, -1).map(record => record.checksum)]);
  });

  test('failed append does not poison or retain the per-key queue', async () => {
    const { adapter, store } = setup('store:legacy-queue-error');
    const facade = createLegacyControllerStore(store);
    const key = 'intent/run:error';

    const invalid = facade.append(key, undefined);
    const queued = facade.append(key, { action: 'after-error' });
    await expect(invalid).rejects.toThrow(/rejected/i);
    await expect(queued).resolves.toBeUndefined();
    await expect(facade.append(key, { action: 'after-cleanup' })).resolves.toBeUndefined();

    const snapshot = adapter.testOnlySnapshot(key);
    expect(snapshot.appendSequenceHighWater).toBe(2);
    expect(snapshot.appendHistory).toHaveLength(2);
  });

  test('append head reports incompatible and all append mutation preserves raw bytes', async () => {
    const { adapter, store } = setup('store:append-incompatible');
    const firstWriter = await store.openWriter();
    await firstWriter.append({ key: 'intent/run:1', expectedSequence: 0, entry: { action: 1 } });
    const unknown = mutateRaw(adapter.testOnlySnapshot('intent/run:1').append!.bytes, value => {
      value.schemaMajor = 2;
      value.value = { future: true };
    });
    adapter.testOnlyReplaceAppendRaw('intent/run:1', unknown);
    const currentWriter = await store.openWriter();

    expect(await store.reader().appendHead('intent/run:1')).toEqual({
      status: 'incompatible', key: 'intent/run:1', schemaMajor: 2
    });
    await expect(currentWriter.append({
      key: 'intent/run:1', expectedSequence: 1, entry: { action: 2 }
    })).rejects.toThrow(UnsupportedStoreSchemaError);
    const facade = createLegacyControllerStore(store);
    const before = adapter.testOnlySnapshot('intent/run:1');
    await expect(facade.append('intent/run:1', { action: 3 }))
      .rejects.toThrow(UnsupportedStoreSchemaError);
    const after = adapter.testOnlySnapshot('intent/run:1');
    expect(after.append!.bytes.equals(unknown)).toBe(true);
    expect(after.physicalRevision).toBe(before.physicalRevision);
    expect(after.appendHistory).toHaveLength(before.appendHistory.length);
  });
});

describe('project controller mirror', () => {
  test('is detached, deeply frozen, informational, and cannot affect authority', async () => {
    const { store } = setup();
    const writer = await store.openWriter();
    const record = await writer.compareAndSwap({
      key: 'checkpoint', expectedGeneration: 0, value: { state: { private: true } }
    });
    const summary = {
      state: 'running' as const,
      reasonCode: 'human-checkpoint' as const,
      updatedAt: '2026-09-11T12:00:00Z',
      nodeCounts: { completed: 1 },
      blockerCount: 0,
      progressPercent: 50
    };
    const mirror = createProjectControllerMirror({
      sourceStoreId: record.storeId,
      key: record.key,
      generation: record.generation,
      status: 'active',
      sourceChecksum: record.checksum,
      summary
    });
    summary.nodeCounts.completed = 99;

    expect(mirror.authority).toBe(false);
    expect(mirror.summary).toEqual({
      state: 'running',
      reasonCode: 'human-checkpoint',
      updatedAt: '2026-09-11T12:00:00Z',
      nodeCounts: { completed: 1 },
      blockerCount: 0,
      progressPercent: 50
    });
    expect(Object.isFrozen(mirror)).toBe(true);
    expect(Object.isFrozen(mirror.summary)).toBe(true);
    expect(Object.keys(mirror)).not.toEqual(expect.arrayContaining([
      'writerToken', 'ticket', 'credential', 'value', 'payload'
    ]));
    for (const unsafeSummary of [
      { state: 'running', credential: 'secret' },
      { state: 'running', token: 'secret' },
      { state: 'running', unknown: true },
      { state: 'secret-token' },
      { state: 'running', reason: 'secret text' },
      { state: 'running', reasonCode: 'credential-secret' },
      { state: 'running', updatedAt: 'not-a-time' },
      { state: 'running', nodeCounts: { credential: 1 } },
      { state: 'running', nodeCounts: { completed: -1 } },
      { state: 'running', nodeCounts: { completed: 1_000_001 } },
      { state: 'running', blockerCount: -1 },
      { state: 'running', blockerCount: 1_000_001 },
      { state: 'running', progressPercent: 101 }
    ]) {
      expect(() => createProjectControllerMirror({
        sourceStoreId: record.storeId,
        key: record.key,
        generation: record.generation,
        status: 'active',
        summary: unsafeSummary as any
      })).toThrow(/mirror summary/i);
    }
    const read = await store.reader().read<{ state: { private: boolean } }>('checkpoint');
    expect(read.status).toBe('active');
    if (read.status === 'active') expect(read.record.value.state.private).toBe(true);
  });
});
