import * as crypto from 'crypto';
import { z } from 'zod';

import { Digest } from '../run/trust/attestation';
import { canonicalizeJson, CanonicalizationError } from './canonicalize';

/** The 11 contract kinds shared by Route and Run. */
export const CONTRACT_KINDS = Object.freeze([
  'execution-blueprint/v1',
  'execution-plan/v1',
  'orchestration-artifact/v1',
  'plan-approval/v1',
  'execution-mode-selection/v1',
  'run-record/v1',
  'delegation-ticket/v1',
  'action-receipt/v1',
  'execution-report/v1',
  'run-checkpoint/v1',
  'goal-verdict/v1'
] as const);

export const contractKindSchema = z.enum(CONTRACT_KINDS);
export type ContractKind = z.infer<typeof contractKindSchema>;

export const CONTRACT_SCHEMA_VERSION = 1 as const;

/** `sha256:` + exactly 64 lowercase hex characters. */
export const contractDigestSchema = z.string().regex(
  /^sha256:[0-9a-f]{64}$/,
  'Expected "sha256:" followed by 64 lowercase hex characters'
);

/** RFC3339 UTC timestamp with `Z` suffix. */
export const rfc3339UtcSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
  'Expected an RFC3339 UTC timestamp with a "Z" suffix'
);

/**
 * Canonical contract envelope. The `digest` commits to (kind, schemaVersion,
 * id, payload) and is itself EXCLUDED from the preimage.
 *
 * A material change is any payload change affecting objective, scope,
 * milestones, graph, criteria, verification, write sets, side effects,
 * policy, budgets, adapter requirements, or completion/pause rules — i.e.
 * ANY payload change changes the digest. Display-only exclusions must be
 * encoded by schema, never by convention.
 */
export const contractEnvelopeSchema = z.object({
  kind: contractKindSchema,
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  id: z.string().min(1),
  payload: z.unknown(),
  digest: contractDigestSchema
}).strict();

export type ContractEnvelope = z.infer<typeof contractEnvelopeSchema>;

/**
 * Computes the domain-separated contract digest. The preimage is
 * UTF8(kind) || 0x00 || RFC8785({schemaVersion, id, payload}); `kind` is in
 * the preimage, so digests of different kinds never collide. Throws
 * CanonicalizationError on non-I-JSON payload content.
 */
export function computeContractDigest(
  kind: ContractKind,
  schemaVersion: number,
  id: string,
  payload: unknown
): Digest {
  const canonical = canonicalizeJson({ schemaVersion, id, payload });
  const preimage = Buffer.concat([
    Buffer.from(kind, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(canonical, 'utf8')
  ]);
  const hex = crypto.createHash('sha256').update(preimage).digest('hex');
  return `sha256:${hex}` as Digest;
}

/** Seals a contract: builds the envelope with its computed digest. */
export function sealContract(
  kind: ContractKind,
  id: string,
  payload: unknown
): ContractEnvelope {
  return {
    kind,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    id,
    payload,
    digest: computeContractDigest(kind, CONTRACT_SCHEMA_VERSION, id, payload)
  };
}

export type ContractVerification = { ok: true } | { ok: false; reason: string };

/**
 * Recomputes the envelope digest and compares with a constant-time
 * comparison (lengths equal). FAIL-CLOSED: a payload that cannot be
 * canonicalized or a mismatched digest both verify false with a reason.
 */
export function verifyContractEnvelope(envelope: ContractEnvelope): ContractVerification {
  let expected: Digest;
  try {
    expected = computeContractDigest(
      envelope.kind,
      envelope.schemaVersion,
      envelope.id,
      envelope.payload
    );
  } catch (error) {
    if (error instanceof CanonicalizationError) {
      return { ok: false, reason: `payload not canonicalizable: ${error.reason}` };
    }
    throw error;
  }

  const actualBuffer = Buffer.from(envelope.digest, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) {
    return { ok: false, reason: 'digest length mismatch' };
  }
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return { ok: false, reason: 'digest mismatch: payload or identity changed after sealing' };
  }
  return { ok: true };
}
