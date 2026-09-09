/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), implemented in-repo with no
 * new dependencies. Canonicalization is the preimage for every contract
 * digest, so it is FAIL-CLOSED: any value that cannot be represented as
 * I-JSON (non-finite numbers, negative zero, unsafe-precision integers,
 * lone surrogates, non-plain objects, undefined/function/symbol/bigint)
 * is REJECTED before serialization, never coerced.
 */

export class CanonicalizationError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Canonicalization rejected: ${reason}`);
    this.name = 'CanonicalizationError';
    this.reason = reason;
  }
}

const MAX_SAFE_INTEGRAL = 2 ** 53; // I-JSON safe integer bound: |n| must stay below 2^53.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function assertCanonicalNumber(value: number): void {
  if (Number.isNaN(value)) throw new CanonicalizationError('NaN is not I-JSON');
  if (!Number.isFinite(value)) throw new CanonicalizationError('non-finite number is not I-JSON');
  if (Object.is(value, -0)) throw new CanonicalizationError('negative zero is not I-JSON');
  // >= 2^53: at and above this magnitude adjacent integers are no longer
  // distinguishable, so the JSON text round-trip loses precision silently.
  if (Number.isInteger(value) && Math.abs(value) >= MAX_SAFE_INTEGRAL) {
    throw new CanonicalizationError(`integer ${value} exceeds the I-JSON safe range (< 2^53)`);
  }
}

function assertCanonicalString(value: string): void {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalizationError('string contains an invalid Unicode lone surrogate');
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Recursive rejection pass shared by canonicalization and raw-JSON validation. */
function assertCanonicalizable(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case 'boolean':
      return;
    case 'number':
      assertCanonicalNumber(value);
      return;
    case 'string':
      assertCanonicalString(value);
      return;
    case 'undefined':
      throw new CanonicalizationError(`undefined at ${path} has no JSON representation`);
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new CanonicalizationError(`${typeof value} at ${path} has no JSON representation`);
    case 'object': {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => assertCanonicalizable(entry, `${path}[${index}]`));
        return;
      }
      if (!isPlainObject(value)) {
        throw new CanonicalizationError(
          `non-plain object (class instance) at ${path} is not canonicalizable`
        );
      }
      for (const key of Object.keys(value)) {
        assertCanonicalString(key);
        assertCanonicalizable((value as Record<string, unknown>)[key], `${path}.${key}`);
      }
      return;
    }
  }
}

/**
 * Serializes a value to its RFC 8785 canonical form: object keys sorted by
 * UTF-16 code units (the default JS string sort), arrays in order, numbers
 * via ECMAScript Number::toString shortest-round-trip semantics
 * (JSON.stringify number formatting), strings via JSON string escaping.
 * Throws CanonicalizationError on any non-I-JSON input.
 */
export function canonicalizeJson(value: unknown): string {
  assertCanonicalizable(value, '$');
  return writeCanonical(value);
}

function writeCanonical(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map(writeCanonical).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(); // UTF-16 code-unit order.
      const entries = keys.map(key => `${JSON.stringify(key)}:${writeCanonical(record[key])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      throw new CanonicalizationError(`${typeof value} has no JSON representation`);
  }
}

/**
 * Scans raw JSON text and rejects duplicate object keys. JSON.parse cannot
 * see duplicates (last write wins), so this runs a small recursive-descent
 * structural scan over the raw text before parsing. FAIL-CLOSED: malformed
 * JSON and duplicate keys both throw CanonicalizationError.
 */
export function assertNoDuplicateKeys(rawJson: string): void {
  let position = 0;

  const fail = (reason: string): never => {
    throw new CanonicalizationError(`${reason} at offset ${position}`);
  };

  const skipWhitespace = (): void => {
    while (position < rawJson.length && /[\t\n\r ]/.test(rawJson[position])) position += 1;
  };

  const scanString = (): string => {
    if (rawJson[position] !== '"') fail('expected string');
    position += 1;
    let result = '';
    while (position < rawJson.length) {
      const char = rawJson[position];
      if (char === '"') {
        position += 1;
        return result;
      }
      if (char === '\\') {
        const escape = rawJson[position + 1];
        if (escape === undefined || !'"\\/bfnrtu'.includes(escape)) fail('invalid string escape');
        if (escape === 'u') {
          const hex = rawJson.slice(position + 2, position + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid unicode escape');
          result += String.fromCharCode(parseInt(hex, 16));
          position += 6;
          continue;
        }
        result += { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[escape as 'b'] ?? escape;
        position += 2;
        continue;
      }
      if (char < ' ') fail('unescaped control character in string');
      result += char;
      position += 1;
    }
    return fail('unterminated string');
  };

  const scanNumber = (): void => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rawJson.slice(position));
    if (!match) return fail('invalid number');
    position += match[0].length;
  };

  const scanLiteral = (literal: string): void => {
    if (!rawJson.startsWith(literal, position)) fail(`invalid literal, expected ${literal}`);
    position += literal.length;
  };

  const scanValue = (): void => {
    skipWhitespace();
    const char = rawJson[position];
    if (char === '{') return scanObject();
    if (char === '[') return scanArray();
    if (char === '"') {
      scanString();
      return;
    }
    if (char === '-' || (char >= '0' && char <= '9')) return scanNumber();
    if (char === 't') return scanLiteral('true');
    if (char === 'f') return scanLiteral('false');
    if (char === 'n') return scanLiteral('null');
    fail('unexpected token');
  };

  const scanObject = (): void => {
    position += 1; // consume '{'
    const seenKeys = new Set<string>();
    skipWhitespace();
    if (rawJson[position] === '}') {
      position += 1;
      return;
    }
    for (;;) {
      skipWhitespace();
      // Decode escapes so keys differing only by escape spelling still collide.
      const key = scanString();
      if (seenKeys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
      seenKeys.add(key);
      skipWhitespace();
      if (rawJson[position] !== ':') fail('expected ":" after object key');
      position += 1;
      scanValue();
      skipWhitespace();
      const next = rawJson[position];
      if (next === ',') {
        position += 1;
        continue;
      }
      if (next === '}') {
        position += 1;
        return;
      }
      fail('expected "," or "}" in object');
    }
  };

  const scanArray = (): void => {
    position += 1; // consume '['
    skipWhitespace();
    if (rawJson[position] === ']') {
      position += 1;
      return;
    }
    for (;;) {
      scanValue();
      skipWhitespace();
      const next = rawJson[position];
      if (next === ',') {
        position += 1;
        continue;
      }
      if (next === ']') {
        position += 1;
        return;
      }
      fail('expected "," or "]" in array');
    }
  };

  scanValue();
  skipWhitespace();
  if (position !== rawJson.length) fail('trailing content after JSON value');
}

/**
 * Parses raw JSON text the fail-closed way: duplicate keys rejected by
 * structural scan, then JSON.parse, then the parsed value is re-validated
 * against the I-JSON rejection rules (catches 1e400 -> Infinity and unsafe
 * integers that JSON.parse silently produces).
 */
export function parseCanonicalJson(rawJson: string): unknown {
  assertNoDuplicateKeys(rawJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new CanonicalizationError(
      `malformed JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  assertCanonicalizable(parsed, '$');
  return parsed;
}
