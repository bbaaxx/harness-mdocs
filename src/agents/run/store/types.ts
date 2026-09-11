export const CONTROLLER_AUTHORITY_FORMAT = 'harness-mdocs/controller-authority' as const;
export const CONTROLLER_AUTHORITY_SCHEMA_MAJOR = 1 as const;
export const CONTROLLER_AUTHORITY_CHECKSUM_DOMAIN =
  'harness-mdocs/controller-authority/v1' as const;

export type AuthorityRecordType = 'value' | 'log-entry' | 'recovery-pending';
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface AuthorityEnvelope<T = JsonValue> {
  format: typeof CONTROLLER_AUTHORITY_FORMAT;
  schemaMajor: typeof CONTROLLER_AUTHORITY_SCHEMA_MAJOR;
  recordType: AuthorityRecordType;
  storeId: string;
  key: string;
  generation: number;
  writerGeneration: number;
  previousChecksum: string | null;
  value: T;
  checksum: string;
}

export interface RecoveryPendingValue {
  incidentId: string;
  candidateGeneration: number | null;
  candidateChecksum: string | null;
}

export interface AppendValue<T = JsonValue> {
  sequence: number;
  entry: T;
}

export type AuthorityRecord<T> = Readonly<AuthorityEnvelope<T>>;
export type AppendRecord<T> = Readonly<AuthorityEnvelope<Readonly<AppendValue<T>>>>;

export type StoreReadResult<T> =
  | Readonly<{ status: 'missing'; key: string }>
  | Readonly<{ status: 'active'; record: AuthorityRecord<T> }>
  | Readonly<{
      status: 'recovery-required';
      key: string;
      generation: number;
      reason: string;
      incidentId?: string;
      candidateGeneration?: number | null;
      candidateChecksum?: string | null;
    }>
  | Readonly<{ status: 'incompatible'; key: string; schemaMajor: number }>;

export interface RecoveryResult<T> {
  pending: AuthorityRecord<RecoveryPendingValue>;
  candidate?: AuthorityRecord<T>;
}

export interface CompareAndSwapInput<T> {
  key: string;
  expectedGeneration: number;
  value: T;
}

export interface AppendInput<T> {
  key: string;
  expectedSequence: number;
  entry: T;
}

export interface RecoverInput {
  key: string;
  incidentId: string;
}

export interface ResolveRecoveryInput<T> {
  key: string;
  expectedGeneration: number;
  reconciledValue: T;
}

export interface ProtectedControllerStoreReader {
  read<T>(key: string): Promise<StoreReadResult<T>>;
  appendHead(key: string): Promise<AppendHeadResult>;
  list(prefix: string): Promise<readonly string[]>;
}

export type AppendHeadResult =
  | Readonly<{ status: 'missing'; key: string; sequence: 0 }>
  | Readonly<{ status: 'active'; key: string; sequence: number; checksum: string }>
  | Readonly<{ status: 'recovery-required'; key: string; sequence: number }>
  | Readonly<{ status: 'incompatible'; key: string; schemaMajor: number }>;

export interface ProtectedControllerStoreWriter {
  readonly writerGeneration: number;
  compareAndSwap<T>(input: CompareAndSwapInput<T>): Promise<AuthorityRecord<T>>;
  append<T>(input: AppendInput<T>): Promise<AppendRecord<T>>;
  recover<T>(input: RecoverInput): Promise<Readonly<RecoveryResult<T>>>;
  resolveRecovery<T>(input: ResolveRecoveryInput<T>): Promise<AuthorityRecord<T>>;
}

export class CasConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CasConflictError';
  }
}

export class StaleWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleWriterError';
  }
}

export class StoreCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreCorruptionError';
  }
}

export class RecoveryRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryRequiredError';
  }
}

export class UnsupportedStoreSchemaError extends Error {
  readonly schemaMajor: number;

  constructor(schemaMajor: number) {
    super(`Controller authority schema major ${schemaMajor} is unsupported`);
    this.name = 'UnsupportedStoreSchemaError';
    this.schemaMajor = schemaMajor;
  }
}

export class IndeterminateStoreCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndeterminateStoreCommitError';
  }
}

export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

export interface StoredRevision {
  readonly revision: number;
  readonly bytes: Buffer;
}

export interface ProtectedKeySnapshot {
  readonly physicalRevision: number;
  readonly writerGeneration: number;
  readonly writerGenerationHighWater: number;
  readonly value?: StoredRevision;
  readonly valueGeneration: number;
  readonly valueGenerationHighWater: number;
  readonly valueWriterGeneration: number;
  readonly valueWriterGenerationHighWater: number;
  readonly valueNeedsRecovery: boolean;
  readonly valueHistory: readonly Buffer[];
  readonly append?: StoredRevision;
  readonly appendSequence: number;
  readonly appendSequenceHighWater: number;
  readonly appendWriterGeneration: number;
  readonly appendWriterGenerationHighWater: number;
  readonly appendNeedsRecovery: boolean;
  readonly appendHistory: readonly Buffer[];
}

export type AdapterCommitResult = 'committed' | 'conflict' | 'stale-writer';

export interface ValueCommitRequest {
  key: string;
  writerGeneration: number;
  expectedPhysicalRevision: number;
  expectedValueGeneration: number;
  expectedGenerationHighWater: number;
  expectedValueWriterGeneration: number;
  expectedValueWriterGenerationHighWater: number;
  bytes: Buffer;
  generation: number;
}

export interface AppendCommitRequest {
  key: string;
  writerGeneration: number;
  expectedPhysicalRevision: number;
  expectedAppendSequence: number;
  expectedSequenceHighWater: number;
  expectedAppendWriterGeneration: number;
  expectedAppendWriterGenerationHighWater: number;
  bytes: Buffer;
  sequence: number;
}

export interface ProtectedStoreAdapter {
  /** Atomically increments and durably persists the store-wide fencing generation. */
  openWriterGeneration(): number;
  currentWriterGeneration(): number;
  /** One atomic read of all rollback-sensitive metadata for one logical key. */
  snapshotKey(key: string): ProtectedKeySnapshot;
  commitValue(request: ValueCommitRequest): AdapterCommitResult;
  quarantineValue(key: string, observedPhysicalRevision: number): boolean;
  commitAppend(request: AppendCommitRequest): AdapterCommitResult;
  listKeys(prefix: string): readonly string[];
}

export interface ProtectedControllerStoreOptions {
  storeId: string;
  adapter: ProtectedStoreAdapter;
}
