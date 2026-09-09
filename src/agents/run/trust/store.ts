export interface CasRecord<T> {
  value: T;
  generation: number;
  checksum: string;
}

export class CasConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CasConflictError';
  }
}

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
