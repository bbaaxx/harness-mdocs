import * as crypto from 'crypto';

import { canonicalizeJson } from '../../contracts';
import {
  CasConflictError,
  IndeterminateStoreCommitError,
  ProtectedControllerStoreReader,
  ProtectedControllerStoreWriter
} from '../store';
import { canonicalAuthoritySnapshot, snapshotAuthorityData, TicketAuthorityError } from './state';

export interface AuthorityRepositorySnapshot<T> {
  readonly state: Readonly<T>;
  readonly generation: number;
}

export interface AuthorityTransactionResult<T, R> extends AuthorityRepositorySnapshot<T> {
  readonly result: Readonly<R>;
}

export interface ProtectedAuthorityRepository<T> {
  readonly key: string;
  read(): Promise<AuthorityRepositorySnapshot<T> | undefined>;
  initialize(state: T): Promise<AuthorityRepositorySnapshot<T>>;
  transact<I, R>(
    input: I,
    transition: (state: Readonly<T>, input: Readonly<I>) =>
      Promise<Readonly<{ state: T; result: R }>> | Readonly<{ state: T; result: R }>
  ): Promise<AuthorityTransactionResult<T, R>>;
}

export interface CreateProtectedAuthorityRepositoryOptions<T> {
  runId: string;
  projectId: string;
  reader: ProtectedControllerStoreReader;
  writer: ProtectedControllerStoreWriter;
  parseState: (value: unknown) => Readonly<T>;
  maxCasRetries?: number;
}

function repositoryError(
  code: 'invalid-input' | 'store-unavailable' | 'commit-unknown' |
    'concurrency-exhausted' | 'already-initialized',
  message: string
): TicketAuthorityError {
  return new TicketAuthorityError(code, message);
}

function validateRunId(runId: unknown): string {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 16 * 1024) {
    throw repositoryError('invalid-input', 'runId must be a non-empty bounded string');
  }
  return runId;
}

export function authorityRunStoreKey(projectIdValue: string, runIdValue: string): string {
  const runId = validateRunId(runIdValue);
  const projectId = validateRunId(projectIdValue);
  return `run-authority/${crypto.createHash('sha256')
    .update(projectId, 'utf8').update('\0').update(runId, 'utf8').digest('hex')}`;
}

/** One protected value key is the only commit boundary for all mutable run authority. */
export function createProtectedAuthorityRepository<T>(
  options: CreateProtectedAuthorityRepositoryOptions<T>
): ProtectedAuthorityRepository<T> {
  const runId = validateRunId(options.runId);
  const projectId = validateRunId(options.projectId);
  const key = authorityRunStoreKey(projectId, runId);
  const maxCasRetries = options.maxCasRetries ?? 8;
  if (!Number.isSafeInteger(maxCasRetries) || maxCasRetries < 1 || maxCasRetries > 64) {
    throw repositoryError('invalid-input', 'maxCasRetries must be a safe integer from 1 through 64');
  }

  async function read(): Promise<AuthorityRepositorySnapshot<T> | undefined> {
    let readResult;
    try {
      readResult = await options.reader.read<unknown>(key);
    } catch (error) {
      throw repositoryError('store-unavailable', error instanceof Error ? error.message : String(error));
    }
    if (readResult.status === 'missing') return undefined;
    if (readResult.status !== 'active') {
      throw repositoryError('store-unavailable',
        `Authority store key is ${readResult.status}; protected state cannot be used`);
    }
    let state: Readonly<T>;
    try {
      state = options.parseState(readResult.record.value);
    } catch (error) {
      if (error instanceof TicketAuthorityError) {
        throw new TicketAuthorityError('recovery-required',
          `Protected authority aggregate failed semantic validation: ${error.message}`);
      }
      throw repositoryError('store-unavailable', error instanceof Error ? error.message : String(error));
    }
    const binding = state as { runId?: unknown; projectId?: unknown };
    if (binding.runId !== runId || binding.projectId !== projectId) {
      throw repositoryError('store-unavailable', 'Authority store key contains different run/project binding');
    }
    return canonicalAuthoritySnapshot({ state, generation: readResult.record.generation });
  }

  async function commit(expectedGeneration: number, state: T): Promise<AuthorityRepositorySnapshot<T>> {
    const parsed = options.parseState(state);
    try {
      const record = await options.writer.compareAndSwap({ key, expectedGeneration, value: parsed });
      return canonicalAuthoritySnapshot({ state: options.parseState(record.value), generation: record.generation });
    } catch (error) {
      if (error instanceof CasConflictError) throw error;
      if (error instanceof IndeterminateStoreCommitError) {
        throw repositoryError('commit-unknown',
          'Authority commit outcome is unknown; do not retry operation without reconciliation');
      }
      throw repositoryError('store-unavailable', error instanceof Error ? error.message : String(error));
    }
  }

  return Object.freeze({
    key,
    read,
    async initialize(stateValue: T): Promise<AuthorityRepositorySnapshot<T>> {
      const stateInput = snapshotAuthorityData(stateValue);
      const existing = await read();
      if (existing) throw repositoryError('already-initialized', `Run authority "${runId}" already exists`);
      try {
        return await commit(0, stateInput);
      } catch (error) {
        if (error instanceof CasConflictError) {
          throw repositoryError('already-initialized', `Run authority "${runId}" was initialized concurrently`);
        }
        throw error;
      }
    },
    async transact<I, R>(
      inputValue: I,
      transition: (state: Readonly<T>, input: Readonly<I>) =>
        Promise<Readonly<{ state: T; result: R }>> | Readonly<{ state: T; result: R }>
    ): Promise<AuthorityTransactionResult<T, R>> {
      const input = canonicalAuthoritySnapshot(snapshotAuthorityData(inputValue));
      for (let attempt = 0; attempt < maxCasRetries; attempt += 1) {
        const current = await read();
        if (!current) throw repositoryError('store-unavailable', 'Run authority is not initialized');
        const transitioned = await transition(current.state, input);
        const nextState = snapshotAuthorityData(transitioned.state);
        const result = canonicalAuthoritySnapshot(snapshotAuthorityData(transitioned.result));
        const parsedNext = options.parseState(nextState);
        if (canonicalizeJson(parsedNext) === canonicalizeJson(current.state)) {
          return canonicalAuthoritySnapshot({ ...current, result });
        }
        try {
          const committed = await commit(current.generation, parsedNext as T);
          return canonicalAuthoritySnapshot({ ...committed, result });
        } catch (error) {
          if (error instanceof CasConflictError) continue;
          throw error;
        }
      }
      throw repositoryError('concurrency-exhausted',
        `Authority CAS conflicted ${maxCasRetries} consecutive times`);
    }
  });
}
