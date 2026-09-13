import { z } from 'zod';

import {
  contractDigestSchema,
  delegationTicketPayloadSchema,
  rfc3339UtcSchema,
  semanticRoleSchema
} from '../../contracts';
import { writeSelectorSchema } from '../compiler/schema';

export const TICKET_AUTHORITY_LIMITS = Object.freeze({
  stringBytes: 16 * 1024,
  setEntries: 1024,
  budgetEntries: 128,
  tickets: 4096,
  dataDepth: 48,
  dataNodes: 250_000
} as const);

const boundedStringSchema = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= TICKET_AUTHORITY_LIMITS.stringBytes,
  `String exceeds ${TICKET_AUTHORITY_LIMITS.stringBytes} UTF-8 bytes`
);
const safeNonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const safePositiveIntegerSchema = z.number().int().positive().safe();
const positiveFiniteBudgetSchema = z.number().positive().finite().max(Number.MAX_SAFE_INTEGER);

function isCanonicalSet(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

export const canonicalStringSetSchema = z.array(boundedStringSchema)
  .max(TICKET_AUTHORITY_LIMITS.setEntries)
  .refine(isCanonicalSet, 'Expected sorted unique set values');

export const canonicalWriteSelectorSetSchema = z.array(writeSelectorSchema)
  .max(TICKET_AUTHORITY_LIMITS.setEntries)
  .refine(isCanonicalSet, 'Expected sorted unique write selectors');

export const authorityBudgetSchema = z.record(boundedStringSchema, positiveFiniteBudgetSchema)
  .superRefine((budgets, context) => {
    if (Object.keys(budgets).length > TICKET_AUTHORITY_LIMITS.budgetEntries) {
      context.addIssue({
        code: 'custom',
        message: `Budget entries exceed ${TICKET_AUTHORITY_LIMITS.budgetEntries}`
      });
    }
  });

export const canonicalAuthorityBudgetSchema = authorityBudgetSchema.superRefine((budgets, context) => {
  const keys = Object.keys(budgets);
  if (keys.some((key, index) => index > 0 && keys[index - 1] >= key)) {
    context.addIssue({ code: 'custom', message: 'Expected budgets in canonical key order' });
  }
});

export const strictRfc3339UtcSchema = rfc3339UtcSchema.refine(
  value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  'Expected a valid canonical RFC3339 UTC timestamp'
);

export const hostIdentitySnapshotSchema = z.object({
  providerId: boundedStringSchema,
  sessionRef: boundedStringSchema,
  principalRef: boundedStringSchema
}).strict();

export const ticketLeasePlaceholderSchema = z.object({
  ref: boundedStringSchema.nullable(),
  generation: safeNonNegativeIntegerSchema,
  fence: safeNonNegativeIntegerSchema
}).strict();

export const rootAuthoritySchema = z.object({
  roots: canonicalWriteSelectorSetSchema,
  operationClasses: canonicalStringSetSchema,
  toolClasses: canonicalStringSetSchema,
  credentialClasses: canonicalStringSetSchema,
  approvalRefs: canonicalStringSetSchema,
  budgets: canonicalAuthorityBudgetSchema,
  expiresAt: strictRfc3339UtcSchema,
  maxChildDepth: z.number().int().min(1).max(2).safe(),
  maxFanout: safePositiveIntegerSchema
}).strict();

export const rootAuthorityInputSchema = z.object({
  roots: z.array(writeSelectorSchema).max(TICKET_AUTHORITY_LIMITS.setEntries),
  operationClasses: z.array(boundedStringSchema).max(TICKET_AUTHORITY_LIMITS.setEntries).optional(),
  toolClasses: z.array(boundedStringSchema).max(TICKET_AUTHORITY_LIMITS.setEntries).optional(),
  credentialClasses: z.array(boundedStringSchema).max(TICKET_AUTHORITY_LIMITS.setEntries).optional(),
  approvalRefs: z.array(boundedStringSchema).max(TICKET_AUTHORITY_LIMITS.setEntries).optional(),
  budgets: authorityBudgetSchema.optional(),
  expiresAt: strictRfc3339UtcSchema,
  maxChildDepth: z.number().int().min(1).max(2).safe(),
  maxFanout: safePositiveIntegerSchema
}).strict();

export const ticketGrantInputSchema = z.object({
  roots: z.array(writeSelectorSchema).max(TICKET_AUTHORITY_LIMITS.setEntries),
  operationClasses: z.array(boundedStringSchema).max(TICKET_AUTHORITY_LIMITS.setEntries).optional(),
  toolClasses: z.array(boundedStringSchema).max(TICKET_AUTHORITY_LIMITS.setEntries).optional(),
  credentialClasses: z.array(boundedStringSchema).max(TICKET_AUTHORITY_LIMITS.setEntries).optional(),
  approvalRefs: z.array(boundedStringSchema).max(TICKET_AUTHORITY_LIMITS.setEntries).optional(),
  budgets: authorityBudgetSchema.optional(),
  expiresAt: strictRfc3339UtcSchema,
  maxChildDepth: safeNonNegativeIntegerSchema,
  maxFanout: safePositiveIntegerSchema
}).strict();

export const issueRootTicketInputSchema = ticketGrantInputSchema.extend({
  nodeId: boundedStringSchema,
  scope: boundedStringSchema,
  lease: ticketLeasePlaceholderSchema.optional()
}).strict();

export const delegateTicketInputSchema = ticketGrantInputSchema.extend({
  parentHandle: boundedStringSchema,
  nodeId: boundedStringSchema,
  scope: boundedStringSchema,
  lease: ticketLeasePlaceholderSchema.optional()
}).strict();

export const resolveTicketInputSchema = z.object({
  handle: boundedStringSchema,
  runId: boundedStringSchema,
  projectId: boundedStringSchema,
  approvedPlanDigest: contractDigestSchema,
  approvedGraphDigest: contractDigestSchema,
  graphId: boundedStringSchema,
  graphRevision: safePositiveIntegerSchema,
  graphEpoch: safeNonNegativeIntegerSchema,
  cancellationGeneration: safeNonNegativeIntegerSchema
}).strict();

export const resolveTicketForAuthorityInputSchema = resolveTicketInputSchema.extend({
  lease: ticketLeasePlaceholderSchema.optional()
}).strict();

export const revokeTicketInputSchema = z.object({
  handle: boundedStringSchema
}).strict();

export const boundedDelegationTicketPayloadSchema = delegationTicketPayloadSchema.pipe(z.object({
  ticketHandleId: boundedStringSchema,
  runId: boundedStringSchema,
  graphId: boundedStringSchema,
  nodeId: boundedStringSchema,
  parentNodeId: boundedStringSchema,
  generation: safePositiveIntegerSchema,
  issuerRole: semanticRoleSchema,
  recipientRole: semanticRoleSchema,
  hostIdentityRef: boundedStringSchema,
  scope: boundedStringSchema,
  writeSet: canonicalWriteSelectorSetSchema,
  criteria: canonicalStringSetSchema,
  operationClasses: canonicalStringSetSchema,
  toolClasses: canonicalStringSetSchema,
  credentialClasses: canonicalStringSetSchema,
  approvalRefs: canonicalStringSetSchema,
  budgets: canonicalAuthorityBudgetSchema,
  allowedChildRole: semanticRoleSchema.optional(),
  maxChildDepth: safeNonNegativeIntegerSchema,
  maxFanout: safePositiveIntegerSchema,
  nonce: boundedStringSchema,
  expiresAt: strictRfc3339UtcSchema,
  cancellationGeneration: safeNonNegativeIntegerSchema,
  reportDestination: boundedStringSchema,
  reportSchemaRef: boundedStringSchema
}).strict());

export const storedTicketRecordSchema = z.object({
  projectId: boundedStringSchema,
  approvedPlanDigest: contractDigestSchema,
  approvedGraphDigest: contractDigestSchema,
  graphId: boundedStringSchema,
  graphRevision: safePositiveIntegerSchema,
  graphEpoch: safeNonNegativeIntegerSchema,
  cancellationGeneration: safeNonNegativeIntegerSchema,
  lease: ticketLeasePlaceholderSchema,
  roots: canonicalWriteSelectorSetSchema,
  hostIdentity: hostIdentitySnapshotSchema,
  parentTicketHandleId: boundedStringSchema.nullable(),
  nonceStatus: z.enum(['issued', 'claimed']),
  lifecycle: z.enum(['active', 'revoked']),
  ticket: boundedDelegationTicketPayloadSchema
}).strict();

export const ticketAuthorityStateSchema = z.object({
  format: z.literal('harness-mdocs/ticket-authority'),
  schemaVersion: z.literal(1),
  runId: boundedStringSchema,
  projectId: boundedStringSchema,
  approvedPlanDigest: contractDigestSchema,
  approvedGraphDigest: contractDigestSchema,
  graphId: boundedStringSchema,
  graphRevision: safePositiveIntegerSchema,
  graphEpoch: safeNonNegativeIntegerSchema,
  cancellationGeneration: safeNonNegativeIntegerSchema,
  rootAuthority: rootAuthoritySchema,
  lastTicketGeneration: safeNonNegativeIntegerSchema,
  tickets: z.array(storedTicketRecordSchema).max(TICKET_AUTHORITY_LIMITS.tickets)
}).strict();

export type HostIdentitySnapshot = z.infer<typeof hostIdentitySnapshotSchema>;
export type TicketLeasePlaceholder = z.infer<typeof ticketLeasePlaceholderSchema>;
export type RootAuthority = z.infer<typeof rootAuthoritySchema>;
export type RootAuthorityInput = z.input<typeof rootAuthorityInputSchema>;
export type TicketGrantInput = z.input<typeof ticketGrantInputSchema>;
export type IssueRootTicketInput = z.input<typeof issueRootTicketInputSchema>;
export type DelegateTicketInput = z.input<typeof delegateTicketInputSchema>;
export type ResolveTicketInput = z.input<typeof resolveTicketInputSchema>;
export type ResolveTicketForAuthorityInput = z.input<typeof resolveTicketForAuthorityInputSchema>;
export type StoredTicketRecord = z.infer<typeof storedTicketRecordSchema>;
export type TicketAuthorityState = z.infer<typeof ticketAuthorityStateSchema>;
