import { isProxy } from 'util/types';

import { z } from 'zod';

import {
  TICKET_AUTHORITY_LIMITS,
  TicketAuthorityState,
  ticketAuthorityStateSchema
} from './schema';

export class TicketAuthorityError extends Error {
  constructor(
    readonly code: TicketAuthorityErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TicketAuthorityError';
  }
}

export type TicketAuthorityErrorCode =
  | 'invalid-input'
  | 'invalid-state'
  | 'invalid-graph'
  | 'binding-mismatch'
  | 'topology-denied'
  | 'attenuation-denied'
  | 'unknown-handle'
  | 'host-identity-mismatch'
  | 'run-mismatch'
  | 'project-mismatch'
  | 'plan-mismatch'
  | 'graph-mismatch'
  | 'graph-revision-mismatch'
  | 'graph-epoch-mismatch'
  | 'cancellation-generation-mismatch'
  | 'inactive-ticket'
  | 'expired-ticket'
  | 'replayed-ticket'
  | 'random-source-invalid'
  | 'clock-invalid'
  | 'clock-regression'
  | 'generation-exhausted'
  | 'lease-held'
  | 'stale-lease'
  | 'holder-mismatch'
  | 'inactive-lease'
  | 'expired-lease'
  | 'lease-required'
  | 'heartbeat-too-early'
  | 'budget-exceeded'
  | 'reservation-conflict'
  | 'reservation-unresolved'
  | 'unknown-reservation'
  | 'store-unavailable'
  | 'commit-unknown'
  | 'concurrency-exhausted'
  | 'already-initialized'
  | 'initialization-recovery-required'
  | 'recovery-required'
  | 'cancelled'
  | 'wrong-role';

function failInput(message: string): never {
  throw new TicketAuthorityError('invalid-input', message);
}

/** Descriptor-only strict-data snapshot. Accessors and proxies are rejected without invocation. */
export function snapshotAuthorityData<T>(value: T): T {
  const active = new Set<object>();
  let nodes = 0;

  const visit = (input: unknown, path: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > TICKET_AUTHORITY_LIMITS.dataNodes) failInput('Authority data exceeds node limit');
    if (depth > TICKET_AUTHORITY_LIMITS.dataDepth) failInput(`Authority data exceeds depth limit at ${path}`);
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > TICKET_AUTHORITY_LIMITS.stringBytes) {
        failInput(`Authority string exceeds byte limit at ${path}`);
      }
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0) ||
          (Number.isInteger(input) && !Number.isSafeInteger(input))) {
        failInput(`Authority data contains invalid number at ${path}`);
      }
      return input;
    }
    if (typeof input !== 'object') failInput(`Authority data contains non-JSON ${typeof input} at ${path}`);
    if (isProxy(input)) failInput(`Authority data contains proxy at ${path}`);
    if (active.has(input)) failInput(`Authority data contains cycle at ${path}`);

    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if ((array && prototype !== Array.prototype) ||
        (!array && prototype !== Object.prototype && prototype !== null)) {
      failInput(`Authority data contains custom prototype at ${path}`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key === 'symbol')) failInput(`Authority data contains symbol at ${path}`);
    if (keys.length > TICKET_AUTHORITY_LIMITS.dataNodes - nodes) {
      failInput('Authority data exceeds node limit');
    }

    active.add(input);
    try {
      if (array) {
        const lengthDescriptor = descriptors.length;
        if (!lengthDescriptor || !('value' in lengthDescriptor) ||
            !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
          failInput(`Authority data contains invalid array length at ${path}`);
        }
        const length = lengthDescriptor.value as number;
        if (keys.length !== length + 1) failInput(`Authority data contains sparse or extra array fields at ${path}`);
        const output: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || !('value' in descriptor)) {
            failInput(`Authority data contains accessor, hidden, or sparse field at ${path}[${index}]`);
          }
          output.push(visit(descriptor.value, `${path}[${index}]`, depth + 1));
        }
        return output;
      }

      const output = Object.create(null) as Record<string, unknown>;
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || !('value' in descriptor)) {
          failInput(`Authority data contains accessor or hidden field at ${path}.${key}`);
        }
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, `${path}.${key}`, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      return output;
    } finally {
      active.delete(input);
    }
  };

  return visit(value, '$', 0) as T;
}

function deepFreezeAuthority<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeAuthority(child);
    Object.freeze(value);
  }
  return value;
}

export function canonicalAuthoritySnapshot<T>(value: T): Readonly<T> {
  return deepFreezeAuthority(snapshotAuthorityData(value));
}

function issues(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`)
    .sort()
    .join('; ');
}

export function parseTicketAuthorityState(value: unknown): Readonly<TicketAuthorityState> {
  let snapshot: unknown;
  try {
    snapshot = snapshotAuthorityData(value);
  } catch (error) {
    if (error instanceof TicketAuthorityError) {
      throw new TicketAuthorityError('invalid-state', error.message);
    }
    throw error;
  }
  const result = ticketAuthorityStateSchema.safeParse(snapshot);
  if (!result.success) {
    throw new TicketAuthorityError('invalid-state', `Invalid ticket authority state: ${issues(result.error)}`);
  }
  return canonicalAuthoritySnapshot(result.data);
}

export function canonicalSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function canonicalBudgets(values: Readonly<Record<string, number>>): Record<string, number> {
  const output = Object.create(null) as Record<string, number>;
  for (const key of Object.keys(values).sort()) output[key] = values[key];
  return output;
}
