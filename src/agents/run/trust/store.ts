export interface CasRecord<T> {
  value: T;
  generation: number;
  checksum: string;
}

import {
  CasConflictError,
  copyStoreJson,
  ProtectedControllerStore,
  ProtectedControllerStoreWriter,
  RecoveryRequiredError,
  UnsupportedStoreSchemaError
} from '../store';

export { CasConflictError } from '../store';

/**
 * PROTECTION CONTRACT. The ControllerStore is host-owned authority storage for
 * checkpoint, lease, budget, approval, ticket, cancellation, and receipt
 * state. Workers MUST NOT reach authority records through the filesystem,
 * Bash, MCP, custom tools, or child processes; any such reach is out of
 * authority. Project-local artifacts are non-authoritative mirrors and can
 * never enable effects. Records written under an unknown newer schema major
 * fail closed: they are preserved untouched and never interpreted by an older
 * binary.
 */
export interface ControllerStore {
  get<T>(key: string): Promise<CasRecord<T> | undefined>;
  /**
   * Atomic compare-and-swap. Returns the new generation. Throws
   * `CasConflictError` when the stored generation differs from
   * `expectedGeneration`.
   */
  compareAndSwap<T>(key: string, value: T, expectedGeneration: number): Promise<number>;
  /** Appends to an append-only log under `key`. */
  append<T>(key: string, entry: T): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
}

/** Compatibility facade for trust components still using the WP-090 API. */
export function createLegacyControllerStore(store: ProtectedControllerStore): ControllerStore {
  let writer: Promise<ProtectedControllerStoreWriter> | undefined;
  const appendQueues = new Map<string, Promise<void>>();
  const getWriter = (): Promise<ProtectedControllerStoreWriter> => {
    if (!writer) {
      writer = store.openWriter();
      void writer.catch(() => undefined);
    }
    return writer;
  };
  return Object.freeze({
    get: async <T>(key: string): Promise<CasRecord<T> | undefined> => {
      const result = await store.reader().read<T>(key);
      if (result.status === 'missing') return undefined;
      if (result.status === 'incompatible') throw new UnsupportedStoreSchemaError(result.schemaMajor);
      if (result.status === 'recovery-required') throw new RecoveryRequiredError(result.reason);
      const { value, generation, checksum } = result.record;
      return Object.freeze({ value, generation, checksum });
    },
    compareAndSwap: async <T>(key: string, value: T, expectedGeneration: number): Promise<number> => {
      if (typeof key !== 'string' || key.length === 0) throw new TypeError('key must be a non-empty string');
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
        throw new RangeError('expectedGeneration must be a safe non-negative integer');
      }
      const valueSnapshot = copyStoreJson(value) as T;
      const record = await (await getWriter()).compareAndSwap({
        key,
        value: valueSnapshot,
        expectedGeneration
      });
      return record.generation;
    },
    append: async <T>(key: string, entry: T): Promise<void> => {
      if (typeof key !== 'string' || key.length === 0) throw new TypeError('key must be a non-empty string');
      const entrySnapshot = copyStoreJson(entry) as T;
      const previous = appendQueues.get(key) ?? Promise.resolve();
      const operation = previous.then(async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const head = await store.reader().appendHead(key);
          if (head.status === 'incompatible') {
            throw new UnsupportedStoreSchemaError(head.schemaMajor);
          }
          try {
            await (await getWriter()).append({ key, entry: entrySnapshot, expectedSequence: head.sequence });
            return;
          } catch (error) {
            if (!(error instanceof CasConflictError) || attempt === 7) throw error;
          }
        }
      });
      const tail = operation.then(() => undefined, () => undefined);
      appendQueues.set(key, tail);
      return operation.finally(() => {
        if (appendQueues.get(key) === tail) appendQueues.delete(key);
      });
    },
    list: (prefix: string) => store.reader().list(prefix)
  });
}
