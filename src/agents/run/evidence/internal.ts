import * as crypto from 'crypto';
import { isProxy } from 'util/types';

import { canonicalizeJson } from '../../contracts';
import { canonicalAuthoritySnapshot } from '../authority/state';

export const EVIDENCE_DATA_LIMITS = Object.freeze({
  nodes: 50_000,
  depth: 48,
  collectionEntries: 4096,
  objectKeys: 128,
  stringBytes: 16 * 1024,
  keyBytes: 4096,
  aggregateStringAndKeyBytes: 4 * 1024 * 1024
} as const);

export class EvidenceDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceDataError';
  }
}

export function snapshotEvidenceData<T>(value: T): T {
  const active = new Set<object>();
  let nodes = 0;
  let aggregateBytes = 0;

  const addBytes = (bytes: number, path: string): void => {
    aggregateBytes += bytes;
    if (!Number.isSafeInteger(aggregateBytes) ||
        aggregateBytes > EVIDENCE_DATA_LIMITS.aggregateStringAndKeyBytes) {
      throw new EvidenceDataError(`Evidence aggregate string/key bytes exceed limit at ${path}`);
    }
  };

  const visit = (input: unknown, path: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > EVIDENCE_DATA_LIMITS.nodes) throw new EvidenceDataError('Evidence node limit exceeded');
    if (depth > EVIDENCE_DATA_LIMITS.depth) {
      throw new EvidenceDataError(`Evidence depth limit exceeded at ${path}`);
    }
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      const bytes = Buffer.byteLength(input, 'utf8');
      if (bytes > EVIDENCE_DATA_LIMITS.stringBytes) {
        throw new EvidenceDataError(`Evidence string byte limit exceeded at ${path}`);
      }
      addBytes(bytes, path);
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0) ||
          (Number.isInteger(input) && !Number.isSafeInteger(input))) {
        throw new EvidenceDataError(`Evidence contains invalid number at ${path}`);
      }
      return input;
    }
    if (typeof input !== 'object') {
      throw new EvidenceDataError(`Evidence contains non-JSON ${typeof input} at ${path}`);
    }
    if (isProxy(input)) throw new EvidenceDataError(`Evidence contains proxy at ${path}`);
    if (active.has(input)) throw new EvidenceDataError(`Evidence contains cycle at ${path}`);

    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if ((array && prototype !== Array.prototype) ||
        (!array && prototype !== Object.prototype && prototype !== null)) {
      throw new EvidenceDataError(`Evidence contains custom prototype at ${path}`);
    }
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key === 'symbol')) {
      throw new EvidenceDataError(`Evidence contains symbol key at ${path}`);
    }

    active.add(input);
    try {
      if (array) {
        const lengthDescriptor = Reflect.getOwnPropertyDescriptor(input, 'length');
        const lengthValue = lengthDescriptor && 'value' in lengthDescriptor
          ? lengthDescriptor.value
          : undefined;
        if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0) {
          throw new EvidenceDataError(`Evidence contains invalid array length at ${path}`);
        }
        const length = lengthValue as number;
        if (length > EVIDENCE_DATA_LIMITS.collectionEntries) {
          throw new EvidenceDataError(`Evidence collection entry limit exceeded at ${path}`);
        }
        if (keys.length !== length + 1) {
          throw new EvidenceDataError(`Evidence contains sparse or extra array fields at ${path}`);
        }
        const output: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Reflect.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable ||
              !('value' in descriptor)) {
            throw new EvidenceDataError(`Evidence contains accessor or sparse field at ${path}[${index}]`);
          }
          output.push(visit(descriptor.value, `${path}[${index}]`, depth + 1));
        }
        return output;
      }

      if (keys.length > EVIDENCE_DATA_LIMITS.objectKeys) {
        throw new EvidenceDataError(`Evidence object key count exceeds limit at ${path}`);
      }
      const output = Object.create(null) as Record<string, unknown>;
      for (const key of keys as string[]) {
        const keyBytes = Buffer.byteLength(key, 'utf8');
        if (keyBytes > EVIDENCE_DATA_LIMITS.keyBytes) {
          throw new EvidenceDataError(`Evidence object key byte limit exceeded at ${path}`);
        }
        addBytes(keyBytes, path);
        const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable ||
            !('value' in descriptor)) {
          throw new EvidenceDataError(`Evidence contains accessor or hidden field at ${path}.${key}`);
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

export function freezeEvidenceData<T>(value: T): Readonly<T> {
  return canonicalAuthoritySnapshot(value);
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

export function domainDigest(domain: string, value: unknown): `sha256:${string}` {
  const preimage = Buffer.concat([
    Buffer.from(domain, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalizeJson(value), 'utf8')
  ]);
  return `sha256:${crypto.createHash('sha256').update(preimage).digest('hex')}`;
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
