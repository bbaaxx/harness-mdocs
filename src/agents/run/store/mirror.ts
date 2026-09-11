import { copyStoreJson, deepFreezeStoreValue } from './codec';
import { JsonValue } from './types';

export interface ProjectControllerMirrorSummary {
  readonly state: ProjectControllerMirrorState;
  readonly reasonCode?: ProjectControllerMirrorReasonCode;
  readonly updatedAt?: string;
  readonly nodeCounts?: Readonly<Partial<Record<ProjectControllerMirrorNodeState, number>>>;
  readonly blockerCount?: number;
  readonly progressPercent?: number;
}

export type ProjectControllerMirrorState =
  | 'preparing'
  | 'awaiting-approval'
  | 'running'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recovery-required'
  | 'incompatible';

export type ProjectControllerMirrorReasonCode =
  | 'awaiting-approval'
  | 'human-checkpoint'
  | 'policy-blocked'
  | 'budget-exhausted'
  | 'cancel-requested'
  | 'execution-failed'
  | 'store-recovery-required'
  | 'schema-incompatible';

export type ProjectControllerMirrorNodeState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ProjectControllerMirrorInput {
  sourceStoreId: string;
  key: string;
  generation: number;
  status: 'missing' | 'active' | 'recovery-required' | 'incompatible';
  sourceChecksum?: string;
  summary: ProjectControllerMirrorSummary;
}

export interface ProjectControllerMirror {
  readonly authority: false;
  readonly sourceStoreId: string;
  readonly key: string;
  readonly generation: number;
  readonly status: ProjectControllerMirrorInput['status'];
  readonly sourceChecksum?: string;
  readonly summary: ProjectControllerMirrorSummary;
}

const SUMMARY_KEYS = Object.freeze([
  'blockerCount',
  'nodeCounts',
  'progressPercent',
  'reasonCode',
  'state',
  'updatedAt'
]);
const MIRROR_STATES: readonly ProjectControllerMirrorState[] = Object.freeze([
  'preparing', 'awaiting-approval', 'running', 'paused', 'cancelling',
  'completed', 'failed', 'cancelled', 'recovery-required', 'incompatible'
]);
const REASON_CODES: readonly ProjectControllerMirrorReasonCode[] = Object.freeze([
  'awaiting-approval', 'human-checkpoint', 'policy-blocked', 'budget-exhausted',
  'cancel-requested', 'execution-failed', 'store-recovery-required', 'schema-incompatible'
]);
const NODE_COUNT_KEYS: readonly ProjectControllerMirrorNodeState[] = Object.freeze([
  'pending', 'running', 'completed', 'failed', 'cancelled'
]);
const MAX_NODE_COUNT = 1_000_000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function nonNegativeSafeInteger(value: JsonValue | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Mirror summary ${name} is invalid`);
  }
  return value as number;
}

function sanitizeSummary(input: ProjectControllerMirrorSummary): ProjectControllerMirrorSummary {
  const copied = copyStoreJson(input);
  if (!copied || typeof copied !== 'object' || Array.isArray(copied)) {
    throw new TypeError('Mirror summary must be an object');
  }
  const keys = Object.keys(copied).sort();
  if (keys.some(key => !SUMMARY_KEYS.includes(key))) {
    throw new TypeError('Mirror summary contains an unknown field');
  }
  if (typeof copied.state !== 'string' ||
      !MIRROR_STATES.includes(copied.state as ProjectControllerMirrorState)) {
    throw new TypeError('Mirror summary state is invalid');
  }
  const state = copied.state as ProjectControllerMirrorState;
  let reasonCode: ProjectControllerMirrorReasonCode | undefined;
  if (copied.reasonCode !== undefined) {
    if (typeof copied.reasonCode !== 'string' ||
        !REASON_CODES.includes(copied.reasonCode as ProjectControllerMirrorReasonCode)) {
      throw new TypeError('Mirror summary reasonCode is invalid');
    }
    reasonCode = copied.reasonCode as ProjectControllerMirrorReasonCode;
  }
  const updatedAt = copied.updatedAt;
  if (updatedAt !== undefined &&
      (typeof updatedAt !== 'string' || CONTROL_CHARACTER.test(updatedAt) ||
        Buffer.byteLength(updatedAt, 'utf8') > 64 ||
        !RFC3339.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt)))) {
    throw new TypeError('Mirror summary updatedAt is invalid');
  }
  const blockerCount = nonNegativeSafeInteger(copied.blockerCount, 'blockerCount');
  if (blockerCount !== undefined && blockerCount > MAX_NODE_COUNT) {
    throw new TypeError('Mirror summary blockerCount is invalid');
  }
  const progressPercent = nonNegativeSafeInteger(copied.progressPercent, 'progressPercent');
  if (progressPercent !== undefined && progressPercent > 100) {
    throw new TypeError('Mirror summary progressPercent is invalid');
  }

  let nodeCounts: Record<string, number> | undefined;
  if (copied.nodeCounts !== undefined) {
    if (!copied.nodeCounts || typeof copied.nodeCounts !== 'object' || Array.isArray(copied.nodeCounts)) {
      throw new TypeError('Mirror summary nodeCounts is invalid');
    }
    const entries = Object.entries(copied.nodeCounts);
    if (entries.length > NODE_COUNT_KEYS.length) throw new TypeError('Mirror summary nodeCounts is too large');
    nodeCounts = Object.create(null) as Record<string, number>;
    for (const [key, value] of entries) {
      if (!NODE_COUNT_KEYS.includes(key as ProjectControllerMirrorNodeState)) {
        throw new TypeError(`Mirror summary nodeCounts key "${key}" is invalid`);
      }
      const count = nonNegativeSafeInteger(value, `nodeCounts.${key}`);
      if (count === undefined || count > MAX_NODE_COUNT) {
        throw new TypeError(`Mirror summary nodeCounts.${key} is invalid`);
      }
      Object.defineProperty(nodeCounts, key, {
        value: count,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }

  const summary = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries({
    state,
    reasonCode,
    updatedAt,
    nodeCounts,
    blockerCount,
    progressPercent
  })) {
    if (value !== undefined) Object.defineProperty(summary, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return summary as unknown as ProjectControllerMirrorSummary;
}

/**
 * Creates informational project data only. No reverse import, hydration,
 * reconciliation, fallback, or authority-enabling operation exists.
 */
export function createProjectControllerMirror(input: ProjectControllerMirrorInput): ProjectControllerMirror {
  if (!['missing', 'active', 'recovery-required', 'incompatible'].includes(input.status)) {
    throw new TypeError('Mirror status is invalid');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new TypeError('Mirror generation must be a safe non-negative integer');
  }
  if (typeof input.sourceStoreId !== 'string' || input.sourceStoreId.length === 0 ||
      typeof input.key !== 'string' || input.key.length === 0) {
    throw new TypeError('Mirror sourceStoreId and key are required strings');
  }
  if (input.sourceChecksum !== undefined &&
      (typeof input.sourceChecksum !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.sourceChecksum))) {
    throw new TypeError('Mirror sourceChecksum is invalid');
  }
  const mirror: ProjectControllerMirror = {
    authority: false,
    sourceStoreId: copyStoreJson(input.sourceStoreId) as string,
    key: copyStoreJson(input.key) as string,
    generation: input.generation,
    status: input.status,
    ...(input.sourceChecksum === undefined
      ? {}
      : { sourceChecksum: copyStoreJson(input.sourceChecksum) as string }),
    summary: sanitizeSummary(input.summary)
  };
  return deepFreezeStoreValue(mirror) as ProjectControllerMirror;
}
