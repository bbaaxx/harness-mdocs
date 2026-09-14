import { canonicalProjectPathSchema } from './fingerprint';
import { canonicalEqual, domainDigest, freezeEvidenceData } from './internal';
import { StructuredAction } from '../trust';

type MetadataSide = 'input' | 'result';

const POLICY: Readonly<Record<string, Readonly<Record<MetadataSide, readonly string[]>>>> = Object.freeze({
  'fs.write': Object.freeze({
    input: Object.freeze(['contentDigest', 'declaredBytes', 'path', 'pathDigest']),
    result: Object.freeze(['artifactHash', 'bytesWritten', 'changed', 'errorCode'])
  }),
  'fs.delete': Object.freeze({
    input: Object.freeze(['path', 'pathDigest']),
    result: Object.freeze(['changed', 'deleted', 'errorCode'])
  }),
  'process.exec': Object.freeze({
    input: Object.freeze(['argvDigest', 'executableRef']),
    result: Object.freeze(['durationMs', 'errorCode', 'exitCode', 'signal'])
  }),
  'network.request': Object.freeze({
    input: Object.freeze(['method', 'payloadDigest', 'requestDigest', 'urlDigest']),
    result: Object.freeze(['durationMs', 'errorCode', 'responseDigest', 'statusCode'])
  }),
  'git.mutate': Object.freeze({
    input: Object.freeze(['argsDigest']),
    result: Object.freeze(['changedPathsDigest', 'commitRef', 'errorCode'])
  }),
  'package.hook': Object.freeze({
    input: Object.freeze(['hook']),
    result: Object.freeze(['durationMs', 'errorCode', 'exitCode'])
  }),
  'agent.spawn': Object.freeze({
    input: Object.freeze(['agentRef', 'requestDigest']),
    result: Object.freeze(['childTicketRef', 'errorCode'])
  }),
  'tool.invoke': Object.freeze({
    input: Object.freeze(['argumentsDigest', 'toolRef']),
    result: Object.freeze(['errorCode', 'resultDigest'])
  })
});

const SENSITIVE_KEY = /(?:apikey|authorization|bearer|body|cookie|credential|environment|header|nonce|password|privatekey|rawcontent|requestbody|responsebody|secret|stderr|stdout|token)|^(?:content|env)$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REFERENCE = /^[^\s\u0000-\u001F\u007F-\u009F]+$/;
const INVALID_UNICODE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type MetadataValidation =
  | { ok: true }
  | { ok: false; reason: 'sensitive-metadata' | 'unknown-metadata-field' | 'metadata-value-invalid' };

function normalizedKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '');
}

function scalar(value: unknown): boolean {
  return value === null || (typeof value === 'string' && !INVALID_UNICODE.test(value) &&
      Buffer.byteLength(value, 'utf8') <= 16 * 1024) || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value)));
}

function validFieldValue(key: string, value: unknown): boolean {
  if (!scalar(value)) return false;
  if (key.endsWith('Digest') || key.endsWith('Hash')) return typeof value === 'string' && DIGEST.test(value);
  if (key === 'executableRef') return typeof value === 'string';
  if (key === 'childTicketRef') return value === null || typeof value === 'string' && REFERENCE.test(value);
  if (key.endsWith('Ref')) return typeof value === 'string' && REFERENCE.test(value);
  if (key === 'path') return canonicalProjectPathSchema.safeParse(value).success;
  if (['bytesWritten', 'declaredBytes', 'durationMs', 'exitCode', 'statusCode'].includes(key)) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
  if (key === 'changed' || key === 'deleted') return typeof value === 'boolean';
  if (key === 'method') return typeof value === 'string' && /^[A-Z]+$/.test(value);
  if (key === 'errorCode' || key === 'hook' || key === 'signal') {
    return typeof value === 'string' && REFERENCE.test(value);
  }
  return true;
}

export function validateMetadata(
  operation: string,
  side: MetadataSide,
  metadata: Record<string, unknown>
): MetadataValidation {
  const allowed = new Set(POLICY[operation]?.[side] ?? []);
  for (const key of Object.keys(metadata).sort()) {
    if (SENSITIVE_KEY.test(normalizedKey(key))) return { ok: false, reason: 'sensitive-metadata' };
    if (!allowed.has(key)) return { ok: false, reason: 'unknown-metadata-field' };
    if (!validFieldValue(key, metadata[key])) return { ok: false, reason: 'metadata-value-invalid' };
  }
  return { ok: true };
}

export function metadataMatches(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  return canonicalEqual(actual, expected);
}

/** Deterministic operation-bound metadata values. */
export function deriveOperationMetadataBindings(
  action: StructuredAction
): Readonly<Record<string, string | number>> {
  let bindings: Record<string, string | number>;
  switch (action.operation) {
    case 'fs.write':
      bindings = {
        path: action.path,
        pathDigest: domainDigest('harness-mdocs/metadata/path/v1', action.path),
        contentDigest: action.contentDigest,
        declaredBytes: action.declaredBytes
      };
      break;
    case 'fs.delete':
      bindings = {
        path: action.path,
        pathDigest: domainDigest('harness-mdocs/metadata/path/v1', action.path)
      };
      break;
    case 'process.exec':
      bindings = {
        argvDigest: domainDigest('harness-mdocs/metadata/argv/v1', action.argv),
        executableRef: action.argv[0]
      };
      break;
    case 'network.request':
      bindings = {
        method: action.method,
        payloadDigest: action.payloadDigest,
        urlDigest: domainDigest('harness-mdocs/metadata/url/v1', action.url),
        requestDigest: domainDigest('harness-mdocs/metadata/network-request/v1', {
          method: action.method,
          url: action.url,
          payloadDigest: action.payloadDigest
        })
      };
      break;
    case 'git.mutate':
      bindings = { argsDigest: domainDigest('harness-mdocs/metadata/git-args/v1', action.args) };
      break;
    case 'package.hook':
      bindings = { hook: action.hook };
      break;
    case 'agent.spawn':
      bindings = {
        agentRef: action.agentRef,
        requestDigest: action.requestDigest
      };
      break;
    case 'tool.invoke':
      bindings = {
        toolRef: action.tool,
        argumentsDigest: action.argumentsDigest
      };
      break;
  }
  return freezeEvidenceData(bindings);
}

export function operationMetadataMatches(
  action: StructuredAction,
  metadata: Record<string, unknown>
): boolean {
  const bindings = deriveOperationMetadataBindings(action);
  const payloadBindings: Partial<Record<StructuredAction['operation'], readonly string[]>> = {
    'fs.write': ['contentDigest', 'declaredBytes'],
    'network.request': ['payloadDigest'],
    'agent.spawn': ['requestDigest'],
    'tool.invoke': ['argumentsDigest']
  };
  const required = new Set(payloadBindings[action.operation] ?? []);
  return Object.entries(bindings).every(([key, value]) =>
    required.has(key) ? metadata[key] === value : metadata[key] === undefined || metadata[key] === value);
}
