import * as crypto from 'crypto';
import { TextDecoder } from 'util';

import { canonicalizeJson, parseCanonicalJson } from '../../contracts/canonicalize';
import {
  AuthorityEnvelope,
  AuthorityRecordType,
  CONTROLLER_AUTHORITY_CHECKSUM_DOMAIN,
  CONTROLLER_AUTHORITY_FORMAT,
  CONTROLLER_AUTHORITY_SCHEMA_MAJOR,
  JsonValue,
  StoreCorruptionError
} from './types';

export const STORE_VALUE_LIMITS = Object.freeze({
  maxCanonicalBytes: 1024 * 1024,
  maxEncodedBytes: 1024 * 1024 + 64 * 1024,
  maxDepth: 64,
  maxNodes: 100_000,
  maxCollectionEntries: 100_000,
  maxStringBytes: 1024 * 1024
});

const CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ENVELOPE_KEYS = Object.freeze([
  'checksum',
  'format',
  'generation',
  'key',
  'previousChecksum',
  'recordType',
  'schemaMajor',
  'storeId',
  'value',
  'writerGeneration'
]);

function fail(reason: string): never {
  throw new StoreCorruptionError(`Controller authority record is corrupt: ${reason}`);
}

function assertDataProperty(descriptor: PropertyDescriptor | undefined, path: string): PropertyDescriptor {
  if (!descriptor) throw new TypeError(`Store value rejected: sparse array element at ${path}`);
  if ('get' in descriptor || 'set' in descriptor) {
    throw new TypeError(`Store value rejected: accessor at ${path}`);
  }
  if (!descriptor.enumerable) {
    throw new TypeError(`Store value rejected: non-enumerable property at ${path}`);
  }
  return descriptor;
}

/** Copies strict JSON data without invoking caller-owned accessors. */
export function copyStoreJson(value: unknown): JsonValue {
  const active = new Set<object>();
  let nodes = 0;

  const visit = (input: unknown, path: string, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > STORE_VALUE_LIMITS.maxNodes) throw new TypeError('Store value rejected: too many nodes');
    if (depth > STORE_VALUE_LIMITS.maxDepth) throw new TypeError('Store value rejected: nesting too deep');
    if (input === null || typeof input === 'boolean' || typeof input === 'number') {
      return input as JsonValue;
    }
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > STORE_VALUE_LIMITS.maxStringBytes) {
        throw new TypeError(`Store value rejected: string at ${path} is too large`);
      }
      return input;
    }
    if (typeof input !== 'object') {
      throw new TypeError(`Store value rejected: ${typeof input} at ${path} is not JSON`);
    }
    if (active.has(input)) throw new TypeError(`Store value rejected: cycle at ${path}`);
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype) {
          throw new TypeError(`Store value rejected: custom array prototype at ${path}`);
        }
        const descriptors = Object.getOwnPropertyDescriptors(input);
        const ownKeys = Reflect.ownKeys(input);
        if (ownKeys.some(key => typeof key === 'symbol')) {
          throw new TypeError(`Store value rejected: symbol property at ${path}`);
        }
        if (input.length > STORE_VALUE_LIMITS.maxCollectionEntries) {
          throw new TypeError(`Store value rejected: array at ${path} is too large`);
        }
        const allowed = new Set(['length', ...Array.from({ length: input.length }, (_, index) => String(index))]);
        if (ownKeys.some(key => typeof key === 'string' && !allowed.has(key))) {
          throw new TypeError(`Store value rejected: extra array property at ${path}`);
        }
        const output: JsonValue[] = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = assertDataProperty(descriptors[String(index)], `${path}[${index}]`);
          output.push(visit(descriptor.value, `${path}[${index}]`, depth + 1));
        }
        return output;
      }

      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`Store value rejected: custom prototype at ${path}`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const ownKeys = Reflect.ownKeys(input);
      if (ownKeys.some(key => typeof key === 'symbol')) {
        throw new TypeError(`Store value rejected: symbol property at ${path}`);
      }
      if (ownKeys.length > STORE_VALUE_LIMITS.maxCollectionEntries) {
        throw new TypeError(`Store value rejected: object at ${path} has too many properties`);
      }
      const output = Object.create(null) as Record<string, JsonValue>;
      for (const key of ownKeys as string[]) {
        const descriptor = assertDataProperty(descriptors[key], `${path}.${key}`);
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

  const copied = visit(value, '$', 0);
  let canonical: string;
  try {
    canonical = canonicalizeJson(copied);
  } catch (error) {
    throw new TypeError(`Store value rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Buffer.byteLength(canonical, 'utf8') > STORE_VALUE_LIMITS.maxCanonicalBytes) {
    throw new TypeError('Store value rejected: canonical JSON is too large');
  }
  return copied;
}

export function deepFreezeStoreValue<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeStoreValue(child);
    Object.freeze(value);
  }
  return value;
}

export function computeAuthorityChecksum(
  envelope: Omit<AuthorityEnvelope<unknown>, 'checksum'>
): string {
  const canonical = canonicalizeJson(envelope);
  const preimage = Buffer.concat([
    Buffer.from(CONTROLLER_AUTHORITY_CHECKSUM_DOMAIN, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonical, 'utf8')
  ]);
  return `sha256:${crypto.createHash('sha256').update(preimage).digest('hex')}`;
}

export function encodeAuthorityEnvelope<T>(input: {
  recordType: AuthorityRecordType;
  storeId: string;
  key: string;
  generation: number;
  writerGeneration: number;
  previousChecksum: string | null;
  value: T;
}): Buffer {
  const withoutChecksum: Omit<AuthorityEnvelope<unknown>, 'checksum'> = {
    format: CONTROLLER_AUTHORITY_FORMAT,
    schemaMajor: CONTROLLER_AUTHORITY_SCHEMA_MAJOR,
    recordType: input.recordType,
    storeId: input.storeId,
    key: input.key,
    generation: input.generation,
    writerGeneration: input.writerGeneration,
    previousChecksum: input.previousChecksum,
    value: input.value
  };
  const encoded = Buffer.from(canonicalizeJson({
    ...withoutChecksum,
    checksum: computeAuthorityChecksum(withoutChecksum)
  }), 'utf8');
  if (encoded.byteLength > STORE_VALUE_LIMITS.maxEncodedBytes) {
    throw new TypeError(
      `Store envelope rejected: final canonical record exceeds ${STORE_VALUE_LIMITS.maxEncodedBytes} bytes`
    );
  }
  return encoded;
}

function decodeUtf8(raw: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return fail('bytes are not valid UTF-8');
  }
}

function peekSchemaMajor(text: string): number | undefined {
  let offset = 0;
  const whitespace = (): void => {
    while (/\s/.test(text[offset] ?? '')) offset += 1;
  };
  const stringToken = (): string => {
    const start = offset;
    if (text[offset] !== '"') return fail('outer record is not a JSON object');
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === '\\') {
        offset += 2;
        continue;
      }
      if (text[offset] === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          return fail('invalid JSON string');
        }
      }
      offset += 1;
    }
    return fail('unterminated JSON string');
  };
  const skipValue = (): void => {
    whitespace();
    if (text[offset] === '"') {
      stringToken();
      return;
    }
    if (text[offset] === '{' || text[offset] === '[') {
      const opening = text[offset];
      const closing = opening === '{' ? '}' : ']';
      let depth = 0;
      let inString = false;
      for (; offset < text.length; offset += 1) {
        const char = text[offset];
        if (inString) {
          if (char === '\\') offset += 1;
          else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === opening) depth += 1;
        else if (char === closing && --depth === 0) {
          offset += 1;
          return;
        }
      }
      return fail('unterminated JSON value');
    }
    while (offset < text.length && text[offset] !== ',' && text[offset] !== '}') offset += 1;
  };

  whitespace();
  if (text[offset] !== '{') return undefined;
  offset += 1;
  for (;;) {
    whitespace();
    if (text[offset] === '}') return undefined;
    const key = stringToken();
    whitespace();
    if (text[offset] !== ':') return fail('missing outer property separator');
    offset += 1;
    whitespace();
    if (key === 'schemaMajor') {
      const match = /^(?:0|[1-9]\d*)/.exec(text.slice(offset));
      if (!match) return fail('schemaMajor is not a non-negative integer');
      const value = Number(match[0]);
      if (!Number.isSafeInteger(value)) return fail('schemaMajor is outside safe integer range');
      return value;
    }
    skipValue();
    whitespace();
    if (text[offset] === ',') {
      offset += 1;
      continue;
    }
    if (text[offset] === '}') return undefined;
    return fail('malformed outer JSON object');
  }
}

function safePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail(`${field} is invalid`);
  return value as number;
}

export type DecodedAuthorityEnvelope<T = JsonValue> =
  | { status: 'compatible'; envelope: AuthorityEnvelope<T> }
  | { status: 'incompatible'; schemaMajor: number };

export function decodeAuthorityEnvelope<T = JsonValue>(
  raw: Buffer,
  expectedStoreId: string,
  expectedKey: string
): DecodedAuthorityEnvelope<T> {
  if (!Buffer.isBuffer(raw)) return fail('record is not a byte buffer');
  if (raw.byteLength > STORE_VALUE_LIMITS.maxEncodedBytes) {
    return fail(`encoded record exceeds ${STORE_VALUE_LIMITS.maxEncodedBytes} bytes`);
  }
  const text = decodeUtf8(Buffer.from(raw));
  const schemaMajor = peekSchemaMajor(text);
  if (schemaMajor !== undefined && schemaMajor !== CONTROLLER_AUTHORITY_SCHEMA_MAJOR) {
    return { status: 'incompatible', schemaMajor };
  }

  let parsed: unknown;
  try {
    parsed = parseCanonicalJson(text);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('envelope is not an object');
  const object = parsed as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key, index) => key !== ENVELOPE_KEYS[index])) {
    return fail('envelope fields are not exact');
  }
  if (object.format !== CONTROLLER_AUTHORITY_FORMAT) return fail('format mismatch');
  if (object.schemaMajor !== CONTROLLER_AUTHORITY_SCHEMA_MAJOR) return fail('schemaMajor is missing');
  let safeValue: JsonValue;
  try {
    safeValue = copyStoreJson(object.value);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  Object.defineProperty(object, 'value', {
    value: safeValue,
    enumerable: true,
    configurable: true,
    writable: true
  });
  if (canonicalizeJson(object) !== text) return fail('envelope bytes are not canonical JSON');
  if (!['value', 'log-entry', 'recovery-pending'].includes(String(object.recordType))) {
    return fail('recordType is invalid');
  }
  if (object.storeId !== expectedStoreId) return fail('storeId mismatch');
  if (object.key !== expectedKey) return fail('key mismatch');
  safePositiveInteger(object.generation, 'generation');
  safePositiveInteger(object.writerGeneration, 'writerGeneration');
  if (object.previousChecksum !== null &&
      (typeof object.previousChecksum !== 'string' || !CHECKSUM_PATTERN.test(object.previousChecksum))) {
    return fail('previousChecksum is invalid');
  }
  if (typeof object.checksum !== 'string' || !CHECKSUM_PATTERN.test(object.checksum)) {
    return fail('checksum is invalid');
  }
  const { checksum, ...withoutChecksum } = object;
  const expectedChecksum = computeAuthorityChecksum(
    withoutChecksum as unknown as Omit<AuthorityEnvelope<unknown>, 'checksum'>
  );
  const actualBytes = Buffer.from(checksum, 'utf8');
  const expectedBytes = Buffer.from(expectedChecksum, 'utf8');
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
    return fail('checksum mismatch');
  }
  return { status: 'compatible', envelope: object as unknown as AuthorityEnvelope<T> };
}

export function materializeAuthorityEnvelope<T>(raw: Buffer, storeId: string, key: string): AuthorityEnvelope<T> {
  const decoded = decodeAuthorityEnvelope<T>(raw, storeId, key);
  if (decoded.status === 'incompatible') {
    throw new StoreCorruptionError('Cannot materialize an unsupported authority envelope');
  }
  return deepFreezeStoreValue(decoded.envelope) as AuthorityEnvelope<T>;
}
