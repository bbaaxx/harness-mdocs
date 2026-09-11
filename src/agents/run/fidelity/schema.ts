import { z } from 'zod';
import { isProxy } from 'util/types';

import { contractDigestSchema, rfc3339UtcSchema } from '../../contracts/envelope';
import {
  FIDELITY_AUTHENTICITY_REASON_CODES,
  FIDELITY_ASSERTION_CATALOG,
  FIDELITY_POLICY_REASON_CODES,
  FIDELITY_PROBE_IDS,
  FIDELITY_REASON_BASE,
  FIDELITY_RUNTIME_REASON_CODES,
  FidelityReasonCode,
  FidelityProbeId
} from './catalog';

const identifierSchema = z.string().min(1).max(256);
const INVALID_PROBE_RESULT = Object.freeze({});
const MAX_PROBE_ASSERTIONS = Math.max(
  ...Object.values(FIDELITY_ASSERTION_CATALOG).map(assertions => assertions.length)
);
const PROBE_REQUIRED_KEYS = Object.freeze([
  'schemaVersion', 'probeId', 'challengeId', 'subject', 'status', 'assertions', 'measuredAt'
] as const);
const SUBJECT_REQUIRED_KEYS = Object.freeze([
  'surfaceId', 'adapterId', 'adapterVersion', 'implementationDigest'
] as const);
const ASSERTION_REQUIRED_KEYS = Object.freeze(['assertionId', 'status'] as const);

export const fidelitySubjectSchema = z.object({
  surfaceId: identifierSchema,
  adapterId: identifierSchema,
  adapterVersion: identifierSchema,
  implementationDigest: contractDigestSchema
}).strict();

export const fidelityAssertionSchema = z.object({
  assertionId: identifierSchema,
  status: z.enum(['pass', 'fail', 'unknown']),
  evidenceDigest: contractDigestSchema.optional()
}).strict().superRefine((assertion, context) => {
  if (assertion.status === 'pass' && assertion.evidenceDigest === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['evidenceDigest'],
      message: 'Passing assertion requires an exact SHA-256 evidence digest'
    });
  }
  if (assertion.status !== 'pass' && assertion.evidenceDigest !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['evidenceDigest'],
      message: 'Only passing assertions may carry an evidence digest'
    });
  }
});

export const fidelityProbeDiagnosticCodeSchema = z.enum([
  'PROBE_ABORTED',
  'PROBE_CHALLENGE_MISMATCH',
  'PROBE_DUPLICATE',
  'PROBE_MALFORMED',
  'PROBE_RUNNER_POISONED',
  'PROBE_STALE_SUBJECT',
  'PROBE_THROWN',
  'PROBE_TIMEOUT'
]);

const fidelityProbeBaseSchema = z.object({
  schemaVersion: z.literal(1),
  probeId: z.enum(FIDELITY_PROBE_IDS),
  challengeId: identifierSchema,
  subject: fidelitySubjectSchema,
  status: z.enum(['pass', 'fail', 'unknown']),
  assertions: z.array(fidelityAssertionSchema),
  measuredAt: rfc3339UtcSchema,
  diagnosticCode: fidelityProbeDiagnosticCodeSchema.optional()
}).strict();

function cloneDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    return undefined;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    let enumerableKeys = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key) ||
          ++enumerableKeys > allowed.size) return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length < requiredKeys.length || keys.length > allowed.size ||
        keys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
        requiredKeys.some(key => !keys.includes(key))) return undefined;

    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        return undefined;
      }
      snapshot[key as string] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function safeScalar(value: unknown): boolean {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    if (isProxy(value)) return false;
    return false;
  }
  return true;
}

function cloneSubject(value: unknown): Record<string, unknown> | undefined {
  const subject = cloneDataRecord(value, SUBJECT_REQUIRED_KEYS);
  if (subject === undefined || !Object.values(subject).every(safeScalar)) return undefined;
  return subject;
}

function cloneAssertion(value: unknown): Record<string, unknown> | undefined {
  const assertion = cloneDataRecord(value, ASSERTION_REQUIRED_KEYS, ['evidenceDigest']);
  if (assertion === undefined || !Object.values(assertion).every(safeScalar)) return undefined;
  return assertion;
}

function cloneAssertions(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (typeof value !== 'object' || value === null || isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return undefined;
  }
  try {
    const assertions = value;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(assertions, 'length');
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_PROBE_ASSERTIONS) {
      return undefined;
    }
    const length = lengthDescriptor.value;
    let enumerableKeys = 0;
    for (const key in assertions) {
      if (!Object.prototype.hasOwnProperty.call(assertions, key) || ++enumerableKeys > length) {
        return undefined;
      }
    }
    const keys = Reflect.ownKeys(assertions);
    if (keys.length !== length + 1 || keys.some(key =>
      key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= length)
    )) return undefined;

    const snapshot: Record<string, unknown>[] = [];
    for (let index = 0; index < length; index += 1) {
      const element = Object.getOwnPropertyDescriptor(assertions, String(index));
      if (element === undefined || !('value' in element) || !element.enumerable) return undefined;
      const assertion = cloneAssertion(element.value);
      if (assertion === undefined) return undefined;
      snapshot.push(assertion);
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function boundedProbeResultInput(value: unknown): unknown {
  const probe = cloneDataRecord(value, PROBE_REQUIRED_KEYS, ['diagnosticCode']);
  if (probe === undefined) return INVALID_PROBE_RESULT;
  const subject = cloneSubject(probe.subject);
  const assertions = cloneAssertions(probe.assertions);
  if (subject === undefined || assertions === undefined) return INVALID_PROBE_RESULT;
  for (const key of ['schemaVersion', 'probeId', 'challengeId', 'status', 'measuredAt', 'diagnosticCode']) {
    if (key in probe && !safeScalar(probe[key])) return INVALID_PROBE_RESULT;
  }
  return { ...probe, subject, assertions };
}

/** Strict probe transcript. Assertion IDs and aggregate status are probe-aware invariants. */
export const fidelityProbeResultSchema = z.preprocess(
  boundedProbeResultInput,
  fidelityProbeBaseSchema.superRefine((probe, context) => {
    const expected = FIDELITY_ASSERTION_CATALOG[probe.probeId];
    const expectedSet = new Set<string>(expected);
    const seen = new Set<string>();

    for (const [index, assertion] of probe.assertions.entries()) {
      if (seen.has(assertion.assertionId)) {
        context.addIssue({
          code: 'custom',
          path: ['assertions', index, 'assertionId'],
          message: `Duplicate assertion "${assertion.assertionId}"`
        });
      }
      if (!expectedSet.has(assertion.assertionId)) {
        context.addIssue({
          code: 'custom',
          path: ['assertions', index, 'assertionId'],
          message: `Unknown assertion "${assertion.assertionId}" for probe "${probe.probeId}"`
        });
      }
      seen.add(assertion.assertionId);
    }

    for (const assertionId of expected) {
      if (!seen.has(assertionId)) {
        context.addIssue({
          code: 'custom',
          path: ['assertions'],
          message: `Missing assertion "${assertionId}" for probe "${probe.probeId}"`
        });
      }
    }

    const allPass = probe.assertions.length === expected.length &&
      probe.assertions.every(assertion =>
        assertion.status === 'pass' && assertion.evidenceDigest !== undefined
      );
    const anyFail = probe.assertions.some(assertion => assertion.status === 'fail');
    const expectedStatus = allPass ? 'pass' : anyFail ? 'fail' : 'unknown';
    if (probe.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `Probe status must be "${expectedStatus}" for its assertion results`
      });
    }
    if (probe.status !== 'unknown' && probe.diagnosticCode !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['diagnosticCode'],
        message: 'Only unknown probes may carry a diagnostic code'
      });
    }
  })
);

const probeReasonCodes = Object.values(FIDELITY_REASON_BASE).flatMap(base => [
  `${base}_NOT_MEASURED`,
  `${base}_FAILED`,
  `${base}_INCONCLUSIVE`
]);
const fidelityReasonCodes = new Set<string>([
  ...FIDELITY_AUTHENTICITY_REASON_CODES,
  ...FIDELITY_POLICY_REASON_CODES,
  ...FIDELITY_RUNTIME_REASON_CODES,
  ...probeReasonCodes
]);

/** Canonical evidence, authenticity, and informational policy reason codes. */
export const fidelityReasonCodeSchema = z.string().refine(
  (value): value is FidelityReasonCode => fidelityReasonCodes.has(value),
  'Unknown fidelity reason code'
);

export const fidelityPolicyReasonCodeSchema = z.enum(FIDELITY_POLICY_REASON_CODES);

export type FidelitySubject = z.infer<typeof fidelitySubjectSchema>;
export type FidelityAssertion = z.infer<typeof fidelityAssertionSchema>;
export type FidelityProbeDiagnosticCode = z.infer<typeof fidelityProbeDiagnosticCodeSchema>;
export type FidelityProbeResult = z.infer<typeof fidelityProbeResultSchema>;

export function subjectMatches(left: FidelitySubject, right: FidelitySubject): boolean {
  return left.surfaceId === right.surfaceId &&
    left.adapterId === right.adapterId &&
    left.adapterVersion === right.adapterVersion &&
    left.implementationDigest === right.implementationDigest;
}

export function unknownProbeResult(
  probeId: FidelityProbeId,
  subject: FidelitySubject,
  challengeId: string,
  measuredAt: string,
  diagnosticCode: FidelityProbeDiagnosticCode
): FidelityProbeResult {
  return fidelityProbeResultSchema.parse({
    schemaVersion: 1,
    probeId,
    challengeId,
    subject,
    status: 'unknown',
    assertions: FIDELITY_ASSERTION_CATALOG[probeId].map(assertionId => ({
      assertionId,
      status: 'unknown' as const
    })),
    measuredAt,
    diagnosticCode
  });
}
