import {
  copyStoreJson,
  decodeAuthorityEnvelope,
  deepFreezeStoreValue,
  encodeAuthorityEnvelope,
  materializeAuthorityEnvelope
} from './codec';
import {
  AdapterCommitResult,
  AppendHeadResult,
  AppendInput,
  AppendRecord,
  AppendValue,
  AuthorityEnvelope,
  AuthorityRecord,
  CasConflictError,
  CompareAndSwapInput,
  JsonValue,
  ProtectedControllerStoreOptions,
  ProtectedControllerStoreReader,
  ProtectedControllerStoreWriter,
  ProtectedKeySnapshot,
  RecoverInput,
  RecoveryPendingValue,
  RecoveryRequiredError,
  RecoveryResult,
  ResolveRecoveryInput,
  StaleWriterError,
  StoreCorruptionError,
  StoreReadResult,
  StoreUnavailableError,
  UnsupportedStoreSchemaError
} from './types';

const MAX_INTERLEAVING_RETRIES = 8;

interface ValueInspection<T> {
  snapshot: ProtectedKeySnapshot;
  envelope?: AuthorityEnvelope<T | RecoveryPendingValue>;
  quarantined: boolean;
}

interface AppendInspection {
  snapshot: ProtectedKeySnapshot;
  envelope?: AuthorityEnvelope<AppendValue<JsonValue>>;
  incompatibleSchemaMajor?: number;
  recoveryRequired?: boolean;
}

function assertSafeNonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a safe non-negative integer`);
}

function nextGeneration(current: number, name: string): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new StoreCorruptionError(`${name} generation exhausted or invalid`);
  }
  return current + 1;
}

function validateIdentifier(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return copyStoreJson(value) as string;
}

/**
 * Protected authority semantics over host-provided atomic storage primitives.
 * Protection is a deployment property, not a property of this TypeScript class.
 * A production adapter must durably CAS physical revision, writer generation,
 * logical generation, and high-waters in one nonrollback host transaction.
 */
export class ProtectedControllerStore {
  readonly storeId: string;
  private readonly adapter: ProtectedControllerStoreOptions['adapter'];

  constructor(options: ProtectedControllerStoreOptions) {
    this.storeId = validateIdentifier(options.storeId, 'storeId');
    this.adapter = options.adapter;
  }

  reader(): ProtectedControllerStoreReader {
    return Object.freeze({
      read: <T>(key: string) => this.read<T>(key),
      appendHead: (key: string) => this.appendHead(key),
      list: (prefix: string) => this.list(prefix)
    });
  }

  async openWriter(): Promise<ProtectedControllerStoreWriter> {
    let writerGeneration: number;
    try {
      writerGeneration = this.adapter.openWriterGeneration();
    } catch (error) {
      throw new StoreCorruptionError(
        `Cannot open controller store writer: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!Number.isSafeInteger(writerGeneration) || writerGeneration < 1) {
      throw new StoreCorruptionError('Adapter returned invalid writer generation');
    }
    return Object.freeze({
      writerGeneration,
      compareAndSwap: <T>(input: CompareAndSwapInput<T>) =>
        this.compareAndSwap(writerGeneration, input),
      append: <T>(input: AppendInput<T>) => this.append(writerGeneration, input),
      recover: <T>(input: RecoverInput) => this.recover<T>(writerGeneration, input),
      resolveRecovery: <T>(input: ResolveRecoveryInput<T>) =>
        this.resolveRecovery(writerGeneration, input)
    });
  }

  private async read<T>(rawKey: string): Promise<StoreReadResult<T>> {
    const key = validateIdentifier(rawKey, 'key');
    for (let attempt = 0; attempt < MAX_INTERLEAVING_RETRIES; attempt += 1) {
      const snapshot = this.adapter.snapshotKey(key);
      try {
        this.assertSnapshotBounds(snapshot);
      } catch (error) {
        if (snapshot.value) {
          if (!this.adapter.quarantineValue(key, snapshot.physicalRevision)) continue;
          continue;
        }
        return this.recoveryRead<T>(key, snapshot.valueGenerationHighWater, error);
      }
      if (snapshot.valueNeedsRecovery) {
        return this.recoveryRead<T>(
          key,
          snapshot.valueGenerationHighWater,
          'authority is marked recovery-required'
        );
      }
      if (!snapshot.value) {
        try {
          this.assertStoreFenceMetadata(snapshot);
        } catch (error) {
          return this.recoveryRead<T>(key, snapshot.valueGenerationHighWater, error);
        }
        if (snapshot.valueGeneration !== 0 || snapshot.valueGenerationHighWater > 0 ||
            snapshot.valueNeedsRecovery) {
          return deepFreezeStoreValue({
            status: 'recovery-required',
            key,
            generation: snapshot.valueGenerationHighWater,
            reason: 'authority record unavailable'
          }) as StoreReadResult<T>;
        }
        return Object.freeze({ status: 'missing', key });
      }

      let decoded;
      try {
        decoded = decodeAuthorityEnvelope<T | RecoveryPendingValue>(
          snapshot.value.bytes,
          this.storeId,
          key
        );
      } catch (error) {
        if (!this.adapter.quarantineValue(key, snapshot.physicalRevision)) continue;
        continue;
      }
      if (decoded.status === 'incompatible') {
        return Object.freeze({ status: 'incompatible', key, schemaMajor: decoded.schemaMajor });
      }
      const envelope = decoded.envelope;
      try {
        this.assertStoreFenceMetadata(snapshot);
        this.assertValueFenceMetadata(snapshot, envelope);
      } catch {
        if (!this.adapter.quarantineValue(key, snapshot.physicalRevision)) continue;
        continue;
      }
      if (envelope.recordType === 'value') {
        return deepFreezeStoreValue({ status: 'active', record: envelope }) as StoreReadResult<T>;
      }
      if (envelope.recordType === 'recovery-pending') {
        let pending;
        try {
          pending = this.validatePending(envelope as AuthorityEnvelope<RecoveryPendingValue>);
        } catch (error) {
          if (!this.adapter.quarantineValue(key, snapshot.physicalRevision)) continue;
          continue;
        }
        return deepFreezeStoreValue({
          status: 'recovery-required',
          key,
          generation: pending.generation,
          reason: 'recovery reconciliation is pending',
          incidentId: pending.value.incidentId,
          candidateGeneration: pending.value.candidateGeneration,
          candidateChecksum: pending.value.candidateChecksum
        }) as StoreReadResult<T>;
      }
      if (!this.adapter.quarantineValue(key, snapshot.physicalRevision)) continue;
      continue;
    }
    throw new StoreUnavailableError(`Authority for "${key}" changed during every read attempt`);
  }

  private recoveryRead<T>(key: string, generation: number, reason: unknown): StoreReadResult<T> {
    return deepFreezeStoreValue({
      status: 'recovery-required',
      key,
      generation,
      reason: reason instanceof Error ? reason.message : String(reason)
    }) as StoreReadResult<T>;
  }

  private async appendHead(rawKey: string): Promise<AppendHeadResult> {
    const key = validateIdentifier(rawKey, 'key');
    const { snapshot, envelope, incompatibleSchemaMajor, recoveryRequired } = this.inspectAppend(key);
    if (recoveryRequired) {
      return Object.freeze({
        status: 'recovery-required',
        key,
        sequence: snapshot.appendSequenceHighWater
      });
    }
    if (incompatibleSchemaMajor !== undefined) {
      return Object.freeze({ status: 'incompatible', key, schemaMajor: incompatibleSchemaMajor });
    }
    if (!envelope) return Object.freeze({ status: 'missing', key, sequence: 0 });
    return Object.freeze({
      status: 'active',
      key,
      sequence: snapshot.appendSequenceHighWater,
      checksum: envelope.checksum
    });
  }

  private async list(prefix: string): Promise<readonly string[]> {
    validateIdentifier(prefix || ' ', 'prefix');
    return Object.freeze([...this.adapter.listKeys(prefix)]);
  }

  private assertCurrentWriter(writerGeneration: number): void {
    if (this.adapter.currentWriterGeneration() !== writerGeneration) {
      throw new StaleWriterError(`Writer generation ${writerGeneration} has been fenced`);
    }
  }

  private assertSnapshotBounds(snapshot: ProtectedKeySnapshot): void {
    assertSafeNonNegative(snapshot.physicalRevision, 'physicalRevision');
    assertSafeNonNegative(snapshot.writerGeneration, 'writerGeneration');
    assertSafeNonNegative(snapshot.writerGenerationHighWater, 'writerGenerationHighWater');
    assertSafeNonNegative(snapshot.valueGeneration, 'valueGeneration');
    assertSafeNonNegative(snapshot.valueGenerationHighWater, 'valueGenerationHighWater');
    assertSafeNonNegative(snapshot.valueWriterGeneration, 'valueWriterGeneration');
    assertSafeNonNegative(snapshot.valueWriterGenerationHighWater, 'valueWriterGenerationHighWater');
    assertSafeNonNegative(snapshot.appendSequence, 'appendSequence');
    assertSafeNonNegative(snapshot.appendSequenceHighWater, 'appendSequenceHighWater');
    assertSafeNonNegative(snapshot.appendWriterGeneration, 'appendWriterGeneration');
    assertSafeNonNegative(snapshot.appendWriterGenerationHighWater, 'appendWriterGenerationHighWater');
  }

  private assertStoreFenceMetadata(snapshot: ProtectedKeySnapshot): void {
    if (snapshot.writerGeneration !== snapshot.writerGenerationHighWater ||
        snapshot.valueWriterGenerationHighWater > snapshot.writerGenerationHighWater ||
        snapshot.appendWriterGenerationHighWater > snapshot.writerGenerationHighWater ||
        (!snapshot.value && snapshot.valueWriterGeneration !== 0) ||
        (!snapshot.append && snapshot.appendWriterGeneration !== 0)) {
      throw new StoreCorruptionError('Trusted writer-generation metadata is rolled back or inconsistent');
    }
  }

  private assertValueFenceMetadata(
    snapshot: ProtectedKeySnapshot,
    envelope: AuthorityEnvelope<unknown>
  ): void {
    if (envelope.generation !== snapshot.valueGeneration ||
        envelope.generation !== snapshot.valueGenerationHighWater ||
        envelope.writerGeneration !== snapshot.valueWriterGeneration ||
        snapshot.valueWriterGeneration !== snapshot.valueWriterGenerationHighWater ||
        envelope.writerGeneration > snapshot.writerGeneration) {
      throw new StoreCorruptionError('Value generation or writer fence metadata mismatch');
    }
  }

  private assertAppendFenceMetadata(
    snapshot: ProtectedKeySnapshot,
    envelope: AuthorityEnvelope<unknown>
  ): void {
    if (envelope.generation !== snapshot.appendSequence ||
        envelope.generation !== snapshot.appendSequenceHighWater ||
        envelope.writerGeneration !== snapshot.appendWriterGeneration ||
        snapshot.appendWriterGeneration !== snapshot.appendWriterGenerationHighWater ||
        envelope.writerGeneration > snapshot.writerGeneration) {
      throw new StoreCorruptionError('Append sequence or writer fence metadata mismatch');
    }
  }

  private inspectValue<T>(key: string): ValueInspection<T> {
    let quarantined = false;
    for (let attempt = 0; attempt < MAX_INTERLEAVING_RETRIES; attempt += 1) {
      const snapshot = this.adapter.snapshotKey(key);
      this.assertSnapshotBounds(snapshot);
      if (snapshot.valueNeedsRecovery) return { snapshot, quarantined };
      if (!snapshot.value) {
        this.assertStoreFenceMetadata(snapshot);
        return { snapshot, quarantined };
      }
      let decoded;
      try {
        decoded = decodeAuthorityEnvelope<T | RecoveryPendingValue>(
          snapshot.value.bytes,
          this.storeId,
          key
        );
        if (decoded.status === 'incompatible') throw new UnsupportedStoreSchemaError(decoded.schemaMajor);
        this.assertStoreFenceMetadata(snapshot);
        this.assertValueFenceMetadata(snapshot, decoded.envelope);
        if (decoded.envelope.recordType === 'log-entry') {
          throw new StoreCorruptionError(`Log record found in value slot for "${key}"`);
        }
        if (decoded.envelope.recordType === 'recovery-pending') {
          this.validatePending(decoded.envelope as AuthorityEnvelope<RecoveryPendingValue>);
        }
        return { snapshot, envelope: decoded.envelope, quarantined };
      } catch (error) {
        if (error instanceof UnsupportedStoreSchemaError) throw error;
        if (!this.adapter.quarantineValue(key, snapshot.physicalRevision)) continue;
        quarantined = true;
      }
    }
    throw new StoreUnavailableError(`Authority for "${key}" changed during every inspection attempt`);
  }

  private inspectAppend(key: string): AppendInspection {
    const snapshot = this.adapter.snapshotKey(key);
    this.assertSnapshotBounds(snapshot);
    if (snapshot.appendNeedsRecovery) return { snapshot, recoveryRequired: true };
    this.assertStoreFenceMetadata(snapshot);
    if (!snapshot.append) {
      if (snapshot.appendSequence !== 0 || snapshot.appendSequenceHighWater > 0) {
        throw new StoreCorruptionError(`Append head unavailable for "${key}"`);
      }
      return { snapshot };
    }
    let decoded;
    try {
      decoded = decodeAuthorityEnvelope<AppendValue<JsonValue>>(snapshot.append.bytes, this.storeId, key);
    } catch (error) {
      throw new StoreCorruptionError(error instanceof Error ? error.message : `Append log "${key}" is corrupt`);
    }
    if (decoded.status === 'incompatible') {
      return { snapshot, incompatibleSchemaMajor: decoded.schemaMajor };
    }
    const envelope = decoded.envelope;
    if (envelope.recordType !== 'log-entry') {
      throw new StoreCorruptionError(`Append high-water mismatch for "${key}"`);
    }
    this.assertAppendFenceMetadata(snapshot, envelope);
    this.validateAppendValue(envelope.value, envelope.generation);
    return { snapshot, envelope };
  }

  private commitResult(result: AdapterCommitResult, writerGeneration: number, conflict: string): void {
    if (result === 'committed') return;
    if (result === 'stale-writer') {
      throw new StaleWriterError(`Writer generation ${writerGeneration} was fenced before commit`);
    }
    throw new CasConflictError(conflict);
  }

  private async compareAndSwap<T>(
    writerGeneration: number,
    input: CompareAndSwapInput<T>
  ): Promise<AuthorityRecord<T>> {
    this.assertCurrentWriter(writerGeneration);
    const key = validateIdentifier(input.key, 'key');
    assertSafeNonNegative(input.expectedGeneration, 'expectedGeneration');
    const value = copyStoreJson(input.value);
    const current = this.inspectValue<JsonValue>(key);
    if (current.quarantined ||
        (!current.envelope &&
          (current.snapshot.valueGeneration !== 0 || current.snapshot.valueGenerationHighWater > 0 ||
            current.snapshot.valueNeedsRecovery))) {
      throw new RecoveryRequiredError(`Recovery required for "${key}"`);
    }
    if (current.envelope?.recordType === 'recovery-pending') {
      throw new RecoveryRequiredError(`Recovery reconciliation pending for "${key}"`);
    }
    const generation = current.envelope?.generation ?? 0;
    if (generation !== input.expectedGeneration) {
      throw new CasConflictError(
        `CAS conflict on "${key}": expected generation ${input.expectedGeneration}, found ${generation}`
      );
    }
    const next = nextGeneration(current.snapshot.valueGenerationHighWater, 'Value');
    const bytes = encodeAuthorityEnvelope({
      recordType: 'value',
      storeId: this.storeId,
      key,
      generation: next,
      writerGeneration,
      previousChecksum: current.envelope?.checksum ?? null,
      value
    });
    const result = this.adapter.commitValue({
      key,
      writerGeneration,
      expectedPhysicalRevision: current.snapshot.physicalRevision,
      expectedValueGeneration: current.snapshot.valueGeneration,
      expectedGenerationHighWater: current.snapshot.valueGenerationHighWater,
      expectedValueWriterGeneration: current.snapshot.valueWriterGeneration,
      expectedValueWriterGenerationHighWater: current.snapshot.valueWriterGenerationHighWater,
      bytes,
      generation: next
    });
    this.commitResult(result, writerGeneration, `Atomic CAS conflict on "${key}"`);
    return materializeAuthorityEnvelope<T>(bytes, this.storeId, key);
  }

  private async append<T>(writerGeneration: number, input: AppendInput<T>): Promise<AppendRecord<T>> {
    this.assertCurrentWriter(writerGeneration);
    const key = validateIdentifier(input.key, 'key');
    assertSafeNonNegative(input.expectedSequence, 'expectedSequence');
    const entry = copyStoreJson(input.entry);
    const {
      snapshot,
      envelope: previous,
      incompatibleSchemaMajor,
      recoveryRequired
    } = this.inspectAppend(key);
    if (recoveryRequired) {
      throw new RecoveryRequiredError(`Append log recovery required for "${key}"`);
    }
    if (incompatibleSchemaMajor !== undefined) {
      throw new UnsupportedStoreSchemaError(incompatibleSchemaMajor);
    }
    const sequence = previous?.generation ?? 0;
    if (sequence !== input.expectedSequence) {
      throw new CasConflictError(
        `Append conflict on "${key}": expected sequence ${input.expectedSequence}, found ${sequence}`
      );
    }
    const next = nextGeneration(snapshot.appendSequenceHighWater, 'Append sequence');
    const bytes = encodeAuthorityEnvelope({
      recordType: 'log-entry',
      storeId: this.storeId,
      key,
      generation: next,
      writerGeneration,
      previousChecksum: previous?.checksum ?? null,
      value: { sequence: next, entry }
    });
    const result = this.adapter.commitAppend({
      key,
      writerGeneration,
      expectedPhysicalRevision: snapshot.physicalRevision,
      expectedAppendSequence: snapshot.appendSequence,
      expectedSequenceHighWater: snapshot.appendSequenceHighWater,
      expectedAppendWriterGeneration: snapshot.appendWriterGeneration,
      expectedAppendWriterGenerationHighWater: snapshot.appendWriterGenerationHighWater,
      bytes,
      sequence: next
    });
    this.commitResult(result, writerGeneration, `Atomic append conflict on "${key}"`);
    return materializeAuthorityEnvelope<AppendValue<T>>(bytes, this.storeId, key) as AppendRecord<T>;
  }

  private async recover<T>(
    writerGeneration: number,
    input: RecoverInput
  ): Promise<Readonly<RecoveryResult<T>>> {
    this.assertCurrentWriter(writerGeneration);
    const key = validateIdentifier(input.key, 'key');
    const incidentId = validateIdentifier(input.incidentId, 'incidentId');
    const current = this.inspectValue<JsonValue>(key);
    if (current.envelope?.recordType === 'value' && !current.snapshot.valueNeedsRecovery) {
      throw new RecoveryRequiredError(`Active authority record for "${key}" does not require recovery`);
    }
    if (current.envelope?.recordType === 'recovery-pending') {
      const pending = this.validatePending(current.envelope as AuthorityEnvelope<RecoveryPendingValue>);
      if (pending.value.incidentId !== incidentId) {
        throw new RecoveryRequiredError(`Different recovery incident is already pending for "${key}"`);
      }
      return deepFreezeStoreValue({
        pending,
        candidate: this.findRecoveryCandidate<T>(key, current.snapshot)
      });
    }
    if (current.snapshot.valueGenerationHighWater === 0 && !current.snapshot.valueNeedsRecovery) {
      throw new RecoveryRequiredError(`No recovery incident exists for "${key}"`);
    }
    const candidate = this.findRecoveryCandidate<T>(key, current.snapshot);
    const generation = nextGeneration(current.snapshot.valueGenerationHighWater, 'Recovery');
    const pendingValue: RecoveryPendingValue = {
      incidentId,
      candidateGeneration: candidate?.generation ?? null,
      candidateChecksum: candidate?.checksum ?? null
    };
    const bytes = encodeAuthorityEnvelope({
      recordType: 'recovery-pending',
      storeId: this.storeId,
      key,
      generation,
      writerGeneration,
      previousChecksum: candidate?.checksum ?? null,
      value: pendingValue
    });
    const result = this.adapter.commitValue({
      key,
      writerGeneration,
      expectedPhysicalRevision: current.snapshot.physicalRevision,
      expectedValueGeneration: current.snapshot.valueGeneration,
      expectedGenerationHighWater: current.snapshot.valueGenerationHighWater,
      expectedValueWriterGeneration: current.snapshot.valueWriterGeneration,
      expectedValueWriterGenerationHighWater: current.snapshot.valueWriterGenerationHighWater,
      bytes,
      generation
    });
    this.commitResult(result, writerGeneration, `Atomic recovery conflict on "${key}"`);
    return deepFreezeStoreValue({
      pending: materializeAuthorityEnvelope<RecoveryPendingValue>(bytes, this.storeId, key),
      candidate
    });
  }

  private async resolveRecovery<T>(
    writerGeneration: number,
    input: ResolveRecoveryInput<T>
  ): Promise<AuthorityRecord<T>> {
    this.assertCurrentWriter(writerGeneration);
    const key = validateIdentifier(input.key, 'key');
    assertSafeNonNegative(input.expectedGeneration, 'expectedGeneration');
    const reconciledValue = copyStoreJson(input.reconciledValue);
    const current = this.inspectValue<JsonValue>(key);
    if (!current.envelope || current.envelope.recordType !== 'recovery-pending') {
      throw new RecoveryRequiredError(`No recovery reconciliation pending for "${key}"`);
    }
    this.validatePending(current.envelope as AuthorityEnvelope<RecoveryPendingValue>);
    if (current.envelope.generation !== input.expectedGeneration) {
      throw new CasConflictError(
        `Recovery conflict on "${key}": expected generation ${input.expectedGeneration}, ` +
        `found ${current.envelope.generation}`
      );
    }
    const generation = nextGeneration(current.snapshot.valueGenerationHighWater, 'Recovery resolution');
    const bytes = encodeAuthorityEnvelope({
      recordType: 'value',
      storeId: this.storeId,
      key,
      generation,
      writerGeneration,
      previousChecksum: current.envelope.checksum,
      value: reconciledValue
    });
    const result = this.adapter.commitValue({
      key,
      writerGeneration,
      expectedPhysicalRevision: current.snapshot.physicalRevision,
      expectedValueGeneration: current.snapshot.valueGeneration,
      expectedGenerationHighWater: current.snapshot.valueGenerationHighWater,
      expectedValueWriterGeneration: current.snapshot.valueWriterGeneration,
      expectedValueWriterGenerationHighWater: current.snapshot.valueWriterGenerationHighWater,
      bytes,
      generation
    });
    this.commitResult(result, writerGeneration, `Atomic recovery resolution conflict on "${key}"`);
    return materializeAuthorityEnvelope<T>(bytes, this.storeId, key);
  }

  private findRecoveryCandidate<T>(
    key: string,
    snapshot: ProtectedKeySnapshot
  ): AuthorityRecord<T> | undefined {
    let candidate: AuthorityEnvelope<T> | undefined;
    for (const raw of snapshot.valueHistory) {
      try {
        const decoded = decodeAuthorityEnvelope<T>(raw, this.storeId, key);
        if (decoded.status === 'compatible' && decoded.envelope.recordType === 'value' &&
            decoded.envelope.generation <= snapshot.valueGenerationHighWater &&
            decoded.envelope.writerGeneration <= snapshot.writerGenerationHighWater &&
            (!candidate || decoded.envelope.generation > candidate.generation)) {
          candidate = decoded.envelope;
        }
      } catch {
        // Corrupt immutable-history entries are ignored; they are never rewritten.
      }
    }
    return candidate && deepFreezeStoreValue(candidate) as AuthorityRecord<T>;
  }

  private validatePending(
    envelope: AuthorityEnvelope<RecoveryPendingValue>
  ): AuthorityEnvelope<RecoveryPendingValue> {
    const value = envelope.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'candidateChecksum,candidateGeneration,incidentId' ||
        typeof value.incidentId !== 'string' || value.incidentId.length === 0 ||
        (value.candidateGeneration !== null &&
          (!Number.isSafeInteger(value.candidateGeneration) || value.candidateGeneration < 1)) ||
        (value.candidateChecksum !== null &&
          (typeof value.candidateChecksum !== 'string' ||
            !/^sha256:[0-9a-f]{64}$/.test(value.candidateChecksum)))) {
      throw new StoreCorruptionError('Recovery-pending value is invalid');
    }
    return envelope;
  }

  private validateAppendValue(value: AppendValue<JsonValue>, generation: number): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'entry,sequence' || value.sequence !== generation) {
      throw new StoreCorruptionError('Append value or sequence is invalid');
    }
  }
}
