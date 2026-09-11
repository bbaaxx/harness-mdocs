import {
  AdapterCommitResult,
  AppendCommitRequest,
  ProtectedKeySnapshot,
  ProtectedStoreAdapter,
  StoredRevision,
  ValueCommitRequest
} from './types';

interface KeyState {
  physicalRevision: number;
  value?: Buffer;
  valueGeneration: number;
  valueGenerationHighWater: number;
  valueWriterGeneration: number;
  valueWriterGenerationHighWater: number;
  valueNeedsRecovery: boolean;
  valueHistory: Buffer[];
  append?: Buffer;
  appendSequence: number;
  appendSequenceHighWater: number;
  appendWriterGeneration: number;
  appendWriterGenerationHighWater: number;
  appendNeedsRecovery: boolean;
  appendHistory: Buffer[];
}

export interface InMemoryStoreSnapshot extends ProtectedKeySnapshot {
  mutationCount: number;
}

type InterleavingPoint =
  | 'snapshot'
  | 'fence-check'
  | 'value-commit'
  | 'append-commit'
  | 'quarantine'
  | 'post-quarantine';

/**
 * TEST-ONLY process-local adapter. It models linearizable atomic primitives but
 * provides no durability, process isolation, rollback protection, or production
 * fidelity evidence. Production adapters need durable atomic revision CAS plus
 * nonrollback writer and per-key high-water metadata outside worker authority.
 */
export class InMemoryProtectedStoreAdapter implements ProtectedStoreAdapter {
  private writerGeneration = 0;
  private writerGenerationHighWater = 0;
  private nextPhysicalRevision = 0;
  private mutationCount = 0;
  private readonly keys = new Map<string, KeyState>();
  private readonly hooks = new Map<InterleavingPoint, () => void>();

  openWriterGeneration(): number {
    if (this.writerGenerationHighWater >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Store writer generation exhausted');
    }
    this.writerGeneration = this.writerGenerationHighWater + 1;
    this.writerGenerationHighWater = this.writerGeneration;
    this.mutationCount += 1;
    return this.writerGeneration;
  }

  currentWriterGeneration(): number {
    this.runHook('fence-check');
    return this.writerGeneration;
  }

  snapshotKey(key: string): ProtectedKeySnapshot {
    this.runHook('snapshot');
    return this.copySnapshot(this.keys.get(key) ?? this.emptyState());
  }

  commitValue(request: ValueCommitRequest): AdapterCommitResult {
    this.runHook('value-commit');
    if (request.writerGeneration !== this.writerGeneration ||
        request.writerGeneration !== this.writerGenerationHighWater) return 'stale-writer';
    const existing = this.keys.get(request.key);
    const state = existing ?? this.emptyState();
    if (state.physicalRevision !== request.expectedPhysicalRevision ||
        state.valueGeneration !== request.expectedValueGeneration ||
        state.valueGenerationHighWater !== request.expectedGenerationHighWater ||
        state.valueWriterGeneration !== request.expectedValueWriterGeneration ||
        state.valueWriterGenerationHighWater !== request.expectedValueWriterGenerationHighWater ||
        request.writerGeneration < state.valueWriterGenerationHighWater ||
        request.generation !== state.valueGenerationHighWater + 1) {
      return 'conflict';
    }
    if (!existing) this.keys.set(request.key, state);
    const stored = Buffer.from(request.bytes);
    state.physicalRevision = ++this.nextPhysicalRevision;
    state.value = stored;
    state.valueGeneration = request.generation;
    state.valueGenerationHighWater = request.generation;
    state.valueWriterGeneration = request.writerGeneration;
    state.valueWriterGenerationHighWater = request.writerGeneration;
    state.valueNeedsRecovery = false;
    state.valueHistory.push(Buffer.from(stored));
    this.mutationCount += 1;
    return 'committed';
  }

  quarantineValue(key: string, observedPhysicalRevision: number): boolean {
    this.runHook('quarantine');
    const state = this.keys.get(key);
    if (!state || !state.value || state.physicalRevision !== observedPhysicalRevision) return false;
    state.physicalRevision = ++this.nextPhysicalRevision;
    state.value = undefined;
    state.valueGeneration = 0;
    state.valueWriterGeneration = 0;
    state.valueNeedsRecovery = true;
    this.mutationCount += 1;
    this.runHook('post-quarantine');
    return true;
  }

  commitAppend(request: AppendCommitRequest): AdapterCommitResult {
    this.runHook('append-commit');
    if (request.writerGeneration !== this.writerGeneration ||
        request.writerGeneration !== this.writerGenerationHighWater) return 'stale-writer';
    const existing = this.keys.get(request.key);
    const state = existing ?? this.emptyState();
    if (state.physicalRevision !== request.expectedPhysicalRevision ||
        state.appendSequence !== request.expectedAppendSequence ||
        state.appendSequenceHighWater !== request.expectedSequenceHighWater ||
        state.appendWriterGeneration !== request.expectedAppendWriterGeneration ||
        state.appendWriterGenerationHighWater !== request.expectedAppendWriterGenerationHighWater ||
        state.appendNeedsRecovery ||
        request.writerGeneration < state.appendWriterGenerationHighWater ||
        request.sequence !== state.appendSequenceHighWater + 1) {
      return 'conflict';
    }
    if (!existing) this.keys.set(request.key, state);
    const stored = Buffer.from(request.bytes);
    state.physicalRevision = ++this.nextPhysicalRevision;
    state.append = stored;
    state.appendSequence = request.sequence;
    state.appendSequenceHighWater = request.sequence;
    state.appendWriterGeneration = request.writerGeneration;
    state.appendWriterGenerationHighWater = request.writerGeneration;
    state.appendNeedsRecovery = false;
    state.appendHistory.push(Buffer.from(stored));
    this.mutationCount += 1;
    return 'committed';
  }

  listKeys(prefix: string): readonly string[] {
    return Object.freeze([...this.keys.entries()]
      .filter(([key, state]) => key.startsWith(prefix) && (state.value || state.append))
      .map(([key]) => key)
      .sort());
  }

  /** TEST-ONLY fault injection. Copies bytes and leaves logical metadata unchanged. */
  testOnlyReplaceValueRaw(key: string, raw: Buffer | string): void {
    const state = this.mutableState(key);
    state.physicalRevision = ++this.nextPhysicalRevision;
    state.value = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(raw, 'utf8');
    this.mutationCount += 1;
  }

  /** TEST-ONLY append fault injection. Copies bytes and leaves logical metadata unchanged. */
  testOnlyReplaceAppendRaw(key: string, raw: Buffer | string): void {
    const state = this.mutableState(key);
    state.physicalRevision = ++this.nextPhysicalRevision;
    state.append = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(raw, 'utf8');
    this.mutationCount += 1;
  }

  /** TEST-ONLY one-shot interleaving hook at an adapter atomic-operation boundary. */
  testOnlyBeforeNext(point: InterleavingPoint, hook: () => void): void {
    this.hooks.set(point, hook);
  }

  /** TEST-ONLY compatibility alias for quarantine race tests. */
  testOnlyBeforeNextQuarantine(hook: () => void): void {
    this.testOnlyBeforeNext('quarantine', hook);
  }

  /** TEST-ONLY detached physical-state snapshot. Returned buffers cannot mutate storage. */
  testOnlySnapshot(key: string): Readonly<InMemoryStoreSnapshot> {
    return Object.freeze({
      ...this.copySnapshot(this.keys.get(key) ?? this.emptyState()),
      mutationCount: this.mutationCount
    });
  }

  /** TEST-ONLY metadata exhaustion setup. */
  testOnlySetWriterGeneration(generation: number): void {
    this.writerGeneration = generation;
    this.writerGenerationHighWater = generation;
  }

  /** TEST-ONLY global current-writer rollback setup; high-water stays unchanged. */
  testOnlySetCurrentWriterGeneration(generation: number): void {
    this.writerGeneration = generation;
  }

  /** TEST-ONLY current value-writer metadata tampering setup. */
  testOnlySetValueWriterGeneration(key: string, generation: number): void {
    const state = this.mutableState(key);
    state.physicalRevision = ++this.nextPhysicalRevision;
    state.valueWriterGeneration = generation;
  }

  /** TEST-ONLY recovery marker setup; current authority bytes remain untouched. */
  testOnlySetValueNeedsRecovery(key: string, required = true): void {
    const state = this.mutableState(key);
    state.physicalRevision = ++this.nextPhysicalRevision;
    state.valueNeedsRecovery = required;
  }

  /** TEST-ONLY append recovery marker setup; current log bytes remain untouched. */
  testOnlySetAppendNeedsRecovery(key: string, required = true): void {
    const state = this.mutableState(key);
    state.physicalRevision = ++this.nextPhysicalRevision;
    state.appendNeedsRecovery = required;
  }

  /** TEST-ONLY protected value metadata exhaustion/corruption setup. */
  testOnlySetValueGenerationHighWater(key: string, generation: number): void {
    const state = this.mutableState(key);
    state.physicalRevision = ++this.nextPhysicalRevision;
    state.valueGenerationHighWater = generation;
    state.valueNeedsRecovery = true;
  }

  /** TEST-ONLY protected append metadata exhaustion/corruption setup. */
  testOnlySetAppendSequenceHighWater(key: string, sequence: number): void {
    const state = this.mutableState(key);
    state.physicalRevision = ++this.nextPhysicalRevision;
    state.appendSequenceHighWater = sequence;
  }

  private mutableState(key: string): KeyState {
    let state = this.keys.get(key);
    if (!state) {
      state = this.emptyState();
      this.keys.set(key, state);
    }
    return state;
  }

  private emptyState(): KeyState {
    return {
      physicalRevision: 0,
      valueGeneration: 0,
      valueGenerationHighWater: 0,
      valueWriterGeneration: 0,
      valueWriterGenerationHighWater: 0,
      valueNeedsRecovery: false,
      valueHistory: [],
      appendSequence: 0,
      appendSequenceHighWater: 0,
      appendWriterGeneration: 0,
      appendWriterGenerationHighWater: 0,
      appendNeedsRecovery: false,
      appendHistory: []
    };
  }

  private copySnapshot(state: KeyState): ProtectedKeySnapshot {
    const revision = state.physicalRevision;
    const value: StoredRevision | undefined = state.value && Object.freeze({
      revision,
      bytes: Buffer.from(state.value)
    });
    const append: StoredRevision | undefined = state.append && Object.freeze({
      revision,
      bytes: Buffer.from(state.append)
    });
    return Object.freeze({
      physicalRevision: revision,
      writerGeneration: this.writerGeneration,
      writerGenerationHighWater: this.writerGenerationHighWater,
      value,
      valueGeneration: state.valueGeneration,
      valueGenerationHighWater: state.valueGenerationHighWater,
      valueWriterGeneration: state.valueWriterGeneration,
      valueWriterGenerationHighWater: state.valueWriterGenerationHighWater,
      valueNeedsRecovery: state.valueNeedsRecovery,
      valueHistory: Object.freeze(state.valueHistory.map(bytes => Buffer.from(bytes))),
      append,
      appendSequence: state.appendSequence,
      appendSequenceHighWater: state.appendSequenceHighWater,
      appendWriterGeneration: state.appendWriterGeneration,
      appendWriterGenerationHighWater: state.appendWriterGenerationHighWater,
      appendNeedsRecovery: state.appendNeedsRecovery,
      appendHistory: Object.freeze(state.appendHistory.map(bytes => Buffer.from(bytes)))
    });
  }

  private runHook(point: InterleavingPoint): void {
    const hook = this.hooks.get(point);
    if (!hook) return;
    this.hooks.delete(point);
    hook();
  }
}
