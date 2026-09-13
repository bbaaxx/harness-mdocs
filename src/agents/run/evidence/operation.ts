import { z } from 'zod';

import { contractDigestSchema } from '../../contracts';
import { writeSelectorSchema } from '../compiler/schema';
import { StructuredAction } from '../trust';
import { canonicalProjectPathSchema } from './fingerprint';
import { domainDigest, snapshotEvidenceData, sortedUnique } from './internal';

const boundedString = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= 16 * 1024,
  'String exceeds 16384 UTF-8 bytes'
);
const stringArray = z.array(boundedString).max(1024);
const actionBase = {
  writeSet: z.array(writeSelectorSchema).max(1024),
  sideEffectClass: z.enum(['none', 'workspace', 'external', 'credential'])
} as const;

export const structuredActionSchema = z.discriminatedUnion('operation', [
  z.object({ ...actionBase, operation: z.literal('fs.write'), path: canonicalProjectPathSchema }).strict(),
  z.object({ ...actionBase, operation: z.literal('fs.delete'), path: canonicalProjectPathSchema }).strict(),
  z.object({ ...actionBase, operation: z.literal('process.exec'), argv: stringArray.min(1) }).strict(),
  z.object({
    ...actionBase,
    operation: z.literal('network.request'),
    url: boundedString,
    method: z.string().regex(/^[A-Z]+$/).max(32)
  }).strict(),
  z.object({ ...actionBase, operation: z.literal('git.mutate'), args: stringArray }).strict(),
  z.object({ ...actionBase, operation: z.literal('package.hook'), hook: boundedString }).strict(),
  z.object({ ...actionBase, operation: z.literal('agent.spawn'), agentRef: boundedString }).strict(),
  z.object({
    ...actionBase,
    operation: z.literal('tool.invoke'),
    tool: boundedString,
    argumentsDigest: contractDigestSchema.optional()
  }).strict()
]);

function canonicalAction(value: unknown): StructuredAction {
  const snapshot = snapshotEvidenceData(value);
  const action = structuredActionSchema.parse(snapshot);
  return { ...action, writeSet: sortedUnique(action.writeSet) } as StructuredAction;
}

/** Domain-separated digest of normalized structured operation. Raw operation data is not returned. */
export function computeNormalizedOperationDigest(value: unknown): `sha256:${string}` {
  return domainDigest('harness-mdocs/structured-action/v1', canonicalAction(value));
}
