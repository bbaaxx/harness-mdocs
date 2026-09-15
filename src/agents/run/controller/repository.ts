import * as crypto from 'crypto';

import {
  CasConflictError,
  IndeterminateStoreCommitError,
  ProtectedControllerStoreReader,
  ProtectedControllerStoreWriter,
  RecoveryRequiredError,
  UnsupportedStoreSchemaError
} from '../store';
import {
  computeRunControllerEventDigest,
  RunControllerEvent,
  RunControllerState,
  RunControllerTransitionResult
} from './algebra';
import { reduceRunController } from './reducer';
import { parseRunControllerEvent, parseRunControllerState } from './schema';

const DEFAULT_CAS_RETRIES = 8;

export interface RunControllerRepositorySnapshot {
  readonly state: Readonly<RunControllerState>;
  readonly generation: number;
}

export type RunControllerRepositoryReadResult =
  | Readonly<{ status: 'missing'; key: string }>
  | Readonly<{ status: 'active'; key: string; snapshot: RunControllerRepositorySnapshot }>
  | Readonly<{ status: 'recovery-required'; key: string; reason: string }>
  | Readonly<{ status: 'incompatible'; key: string; schemaMajor: number }>
  | Readonly<{ status: 'unavailable'; key: string; reason: string }>;

export type RunControllerRepositoryWriteResult =
  | Readonly<{
      status: 'committed' | 'unchanged';
      key: string;
      snapshot: RunControllerRepositorySnapshot;
      transition: RunControllerTransitionResult;
    }>
  | Readonly<{
      status: 'unknown';
      key: string;
      expectedGeneration: number;
      eventId: string;
      eventDigest: string;
      reason: string;
    }>
  | Readonly<{
      status: 'rejected';
      key: string;
      transition: RunControllerTransitionResult;
      snapshot?: RunControllerRepositorySnapshot;
    }>
  | Exclude<RunControllerRepositoryReadResult, { status: 'active' }>
  | Readonly<{
      status: 'generation-conflict';
      key: string;
      expectedGeneration: number;
      actualGeneration: number;
    }>
  | Readonly<{ status: 'concurrency-exhausted'; key: string; attempts: number }>;

export interface ProtectedRunControllerRepository {
  readonly key: string;
  read(): Promise<RunControllerRepositoryReadResult>;
  initialize(event: unknown): Promise<RunControllerRepositoryWriteResult>;
  transact(event: unknown): Promise<RunControllerRepositoryWriteResult>;
  transactExpected(event: unknown, expectedGeneration: number): Promise<RunControllerRepositoryWriteResult>;
}

export interface CreateProtectedRunControllerRepositoryOptions {
  runId: string;
  projectId: string;
  reader: ProtectedControllerStoreReader;
  writer: ProtectedControllerStoreWriter;
  maxCasRetries?: number;
}

function validateId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 1024) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

export function runControllerStoreKey(projectIdValue: string, runIdValue: string): string {
  const projectId = validateId(projectIdValue, 'projectId');
  const runId = validateId(runIdValue, 'runId');
  const digest = crypto.createHash('sha256')
    .update('harness-mdocs/run-controller/store-key/v1', 'utf8')
    .update(Buffer.from([0]))
    .update(projectId, 'utf8')
    .update(Buffer.from([0]))
    .update(runId, 'utf8')
    .digest('hex');
  return `run-controller/${digest}`;
}

function frozen<T>(value: T): Readonly<T> {
  const freeze = (input: unknown): void => {
    if (input && typeof input === 'object' && !Object.isFrozen(input)) {
      for (const child of Object.values(input as Record<string, unknown>)) freeze(child);
      Object.freeze(input);
    }
  };
  freeze(value);
  return value as Readonly<T>;
}

/** Protected CAS boundary only. Commands returned by transitions are never executed here. */
export function createProtectedRunControllerRepository(
  options: CreateProtectedRunControllerRepositoryOptions
): ProtectedRunControllerRepository {
  const runId = validateId(options.runId, 'runId');
  const projectId = validateId(options.projectId, 'projectId');
  const key = runControllerStoreKey(projectId, runId);
  const maxCasRetries = options.maxCasRetries ?? DEFAULT_CAS_RETRIES;
  if (!Number.isSafeInteger(maxCasRetries) || maxCasRetries < 1 || maxCasRetries > 64) {
    throw new RangeError('maxCasRetries must be a safe integer from 1 through 64');
  }

  async function read(): Promise<RunControllerRepositoryReadResult> {
    let result;
    try {
      result = await options.reader.read<unknown>(key);
    } catch (error) {
      if (error instanceof RecoveryRequiredError) {
        return frozen({ status: 'recovery-required' as const, key, reason: error.message });
      }
      if (error instanceof UnsupportedStoreSchemaError) {
        return frozen({ status: 'incompatible' as const, key, schemaMajor: error.schemaMajor });
      }
      return frozen({ status: 'unavailable' as const, key,
        reason: error instanceof Error ? error.message : String(error) });
    }
    if (result.status === 'missing') return frozen({ status: 'missing' as const, key });
    if (result.status === 'incompatible') {
      return frozen({ status: 'incompatible' as const, key, schemaMajor: result.schemaMajor });
    }
    if (result.status === 'recovery-required') {
      return frozen({ status: 'recovery-required' as const, key, reason: result.reason });
    }
    let state: Readonly<RunControllerState>;
    try {
      state = parseRunControllerState(result.record.value);
    } catch (error) {
      return frozen({ status: 'recovery-required' as const, key,
        reason: `Protected RunController aggregate is invalid: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (state.runId !== runId || state.projectId !== projectId) {
      return frozen({ status: 'recovery-required' as const, key,
        reason: 'Protected RunController aggregate has different run/project binding' });
    }
    return frozen({
      status: 'active' as const,
      key,
      snapshot: { state, generation: result.record.generation }
    });
  }

  async function commit(
    expectedGeneration: number,
    state: Readonly<RunControllerState>,
    event: Readonly<RunControllerEvent>,
    transition: RunControllerTransitionResult
  ): Promise<RunControllerRepositoryWriteResult | 'conflict'> {
    try {
      const record = await options.writer.compareAndSwap({ key, expectedGeneration, value: state });
      const parsed = parseRunControllerState(record.value);
      return frozen({
        status: 'committed' as const,
        key,
        snapshot: { state: parsed, generation: record.generation },
        transition: { ...transition, state: parsed }
      });
    } catch (error) {
      if (error instanceof CasConflictError) return 'conflict';
      if (error instanceof IndeterminateStoreCommitError) {
        return frozen({
          status: 'unknown' as const,
          key,
          expectedGeneration,
          eventId: event.eventId,
          eventDigest: computeRunControllerEventDigest(event),
          reason: 'Commit outcome unknown; reread and reconcile event before retrying'
        });
      }
      if (error instanceof RecoveryRequiredError) {
        return frozen({ status: 'recovery-required' as const, key, reason: error.message });
      }
      if (error instanceof UnsupportedStoreSchemaError) {
        return frozen({ status: 'incompatible' as const, key, schemaMajor: error.schemaMajor });
      }
      return frozen({ status: 'unavailable' as const, key,
        reason: error instanceof Error ? error.message : String(error) });
    }
  }

  async function initialize(eventValue: unknown): Promise<RunControllerRepositoryWriteResult> {
    let event: Readonly<RunControllerEvent>;
    try {
      event = parseRunControllerEvent(eventValue);
    } catch {
      const transition = reduceRunController(undefined, eventValue);
      return frozen({ status: 'rejected' as const, key, transition });
    }
    if (event.type !== 'create') {
      const transition = reduceRunController(undefined, event);
      return frozen({ status: 'rejected' as const, key, transition });
    }
    if (event.runId !== runId || event.projectId !== projectId) {
      const transition: RunControllerTransitionResult = Object.freeze({
        ok: false,
        code: 'invalid-event',
        reason: 'Create event run/project binding does not match repository',
        state: undefined,
        commands: Object.freeze([]) as readonly []
      });
      return frozen({ status: 'rejected' as const, key, transition });
    }
    const initialTransition = reduceRunController(undefined, event);
    if (!initialTransition.ok || !initialTransition.state) {
      return frozen({ status: 'rejected' as const, key, transition: initialTransition });
    }
    for (let attempt = 0; attempt < maxCasRetries; attempt += 1) {
      const current = await read();
      if (current.status !== 'active' && current.status !== 'missing') return current;
      if (current.status === 'active') {
        const replay = reduceRunController(current.snapshot.state, event);
        if (replay.ok) {
          if (replay.state.auditHashHead === current.snapshot.state.auditHashHead) {
            return frozen({
              status: 'unchanged' as const,
              key,
              snapshot: current.snapshot,
              transition: { ...replay, state: current.snapshot.state }
            });
          }
          const transition: RunControllerTransitionResult = Object.freeze({
            ok: false,
            code: 'invalid-state',
            reason: 'Create replay unexpectedly advanced active aggregate',
            state: current.snapshot.state,
            commands: Object.freeze([]) as readonly []
          });
          return frozen({ status: 'rejected' as const, key, snapshot: current.snapshot, transition });
        }
        return frozen({ status: 'rejected' as const, key, snapshot: current.snapshot, transition: replay });
      }
      const committed = await commit(0, initialTransition.state, event, initialTransition);
      if (committed !== 'conflict') return committed;
    }
    return frozen({ status: 'concurrency-exhausted' as const, key, attempts: maxCasRetries });
  }

  async function transact(eventValue: unknown): Promise<RunControllerRepositoryWriteResult> {
    let event: Readonly<RunControllerEvent>;
    try {
      event = parseRunControllerEvent(eventValue);
    } catch {
      const current = await read();
      if (current.status !== 'active') return current;
      const transition = reduceRunController(
        current.snapshot.state, eventValue
      );
      return frozen({
        status: 'rejected' as const,
        key,
        snapshot: current.snapshot,
        transition
      });
    }
    for (let attempt = 0; attempt < maxCasRetries; attempt += 1) {
      const current = await read();
      if (current.status !== 'active') return current;
      const transition = reduceRunController(current.snapshot.state, event);
      if (!transition.ok) {
        return frozen({ status: 'rejected' as const, key, snapshot: current.snapshot, transition });
      }
      if (transition.state === current.snapshot.state ||
          transition.state.auditHashHead === current.snapshot.state.auditHashHead) {
        return frozen({ status: 'unchanged' as const, key, snapshot: current.snapshot, transition });
      }
      const committed = await commit(current.snapshot.generation, transition.state, event, transition);
      if (committed !== 'conflict') return committed;
    }
    return frozen({ status: 'concurrency-exhausted' as const, key, attempts: maxCasRetries });
  }

  async function transactExpected(
    eventValue: unknown,
    expectedGeneration: number
  ): Promise<RunControllerRepositoryWriteResult> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new RangeError('expectedGeneration must be a positive safe integer');
    }
    let event: Readonly<RunControllerEvent>;
    try {
      event = parseRunControllerEvent(eventValue);
    } catch {
      const current = await read();
      if (current.status !== 'active') return current;
      return frozen({
        status: 'rejected' as const,
        key,
        snapshot: current.snapshot,
        transition: reduceRunController(current.snapshot.state, eventValue)
      });
    }
    const current = await read();
    if (current.status !== 'active') return current;
    if (current.snapshot.generation !== expectedGeneration) {
      return frozen({
        status: 'generation-conflict' as const,
        key,
        expectedGeneration,
        actualGeneration: current.snapshot.generation
      });
    }
    const transition = reduceRunController(current.snapshot.state, event);
    if (!transition.ok) {
      return frozen({ status: 'rejected' as const, key, snapshot: current.snapshot, transition });
    }
    if (transition.state === current.snapshot.state ||
        transition.state.auditHashHead === current.snapshot.state.auditHashHead) {
      return frozen({ status: 'unchanged' as const, key, snapshot: current.snapshot, transition });
    }
    const committed = await commit(expectedGeneration, transition.state, event, transition);
    if (committed !== 'conflict') return committed;
    const reread = await read();
    if (reread.status !== 'active') return reread;
    return frozen({
      status: 'generation-conflict' as const,
      key,
      expectedGeneration,
      actualGeneration: reread.snapshot.generation
    });
  }

  return Object.freeze({ key, read, initialize, transact, transactExpected });
}
