import { z } from 'zod';

import {
  actionReceiptPayloadSchema,
  CONTRACT_SCHEMA_VERSION,
  contractDigestSchema,
  executionReportPayloadSchema,
  rfc3339UtcSchema,
  semanticRoleSchema
} from '../../contracts';
import { writeSelectorSchema } from '../compiler/schema';
import { BUDGET_DIMENSIONS } from '../authority/budgets';
import { authorityUsageSampleSchema } from '../authority/usage-accounting';
import { canonicalProjectPathSchema, workspaceSnapshotInputSchema } from './fingerprint';
import { structuredActionSchema } from './operation';

export const EVIDENCE_VALIDATION_LIMITS = Object.freeze({
  collectionEntries: 4096,
  metadataFields: 32,
  evidenceEntries: 4096,
  stringBytes: 16 * 1024
} as const);

const boundedString = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= EVIDENCE_VALIDATION_LIMITS.stringBytes,
  `String exceeds ${EVIDENCE_VALIDATION_LIMITS.stringBytes} UTF-8 bytes`
);
const ledgerCurrency = z.string().min(1).max(16);
const safePositive = z.number().int().positive().safe();
const safeNonNegative = z.number().int().nonnegative().safe();
const canonicalTimestamp = rfc3339UtcSchema.refine(
  value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  'Expected canonical RFC3339 timestamp'
);
const canonicalSet = <T extends z.ZodType<string>>(item: T) => z.array(item)
  .max(EVIDENCE_VALIDATION_LIMITS.collectionEntries)
  .refine(values => values.every((value, index) => index === 0 || values[index - 1] < value),
    'Expected sorted unique values');
const uniqueSequence = <T extends z.ZodType<string>>(item: T) => z.array(item)
  .max(EVIDENCE_VALIDATION_LIMITS.collectionEntries)
  .refine(values => new Set(values).size === values.length, 'Expected unique values');
const metadataSchema = z.record(z.string(), z.unknown()).superRefine((metadata, context) => {
  if (Object.keys(metadata).length > EVIDENCE_VALIDATION_LIMITS.metadataFields) {
    context.addIssue({ code: 'custom', message: 'Metadata field count exceeds limit' });
  }
});
const operationClassSchema = z.enum([
  'fs.write', 'fs.delete', 'process.exec', 'network.request', 'git.mutate',
  'package.hook', 'agent.spawn', 'tool.invoke'
]);
const evidenceRecordSchema = z.object({
  ref: boundedString,
  digest: contractDigestSchema,
  nodeId: boundedString,
  kind: z.enum(['artifact', 'test', 'review', 'receipt', 'other'])
}).strict();
const reportCriterionResultSchema = z.object({
  nodeId: boundedString,
  criterionId: boundedString,
  outcome: z.enum(['met', 'unmet', 'uncertain']),
  evidenceRef: boundedString.optional()
}).strict();

export const evidenceUsageSampleSchema = authorityUsageSampleSchema;

const amountSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
  .refine(value => !Object.is(value, -0), 'Negative zero is forbidden');
const COUNT_BUDGET_DIMENSIONS = new Set([
  'maxActiveExecutionOrchestrators', 'maxLeavesPerEO', 'maxGlobalDescendants',
  'maxCumulativeSpawns', 'retryPerNode', 'globalRetries', 'localFixLoops',
  'toolActionsGlobal', 'toolActionsEo', 'toolActionsLeaf',
  'tokensGlobal', 'tokensEo', 'tokensLeaf'
]);
const budgetAmountsSchema = z.record(z.string(), amountSchema).superRefine((amounts, context) => {
  for (const [key, amount] of Object.entries(amounts)) {
    if (!(BUDGET_DIMENSIONS as readonly string[]).includes(key)) {
      context.addIssue({ code: 'custom', path: [key], message: 'Unknown budget dimension' });
    }
    if (COUNT_BUDGET_DIMENSIONS.has(key) && !Number.isSafeInteger(amount)) {
      context.addIssue({ code: 'custom', path: [key], message: 'Count budget must be a safe integer' });
    }
  }
});

export const evidenceBudgetReconciliationSchema = z.object({
  reservationId: boundedString,
  status: z.enum(['pending', 'committed', 'released']),
  amounts: budgetAmountsSchema,
  actual: budgetAmountsSchema,
  sampleDigest: contractDigestSchema.nullable()
}).strict().superRefine((reconciliation, context) => {
  const amountKeys = Object.keys(reconciliation.amounts).sort();
  const actualKeys = Object.keys(reconciliation.actual);
  if (reconciliation.status === 'committed' && reconciliation.sampleDigest === null) {
    context.addIssue({ code: 'custom', path: ['sampleDigest'], message: 'Committed usage requires sample digest' });
  }
  if (reconciliation.status === 'committed' &&
      amountKeys.join('\0') !== [...actualKeys].sort().join('\0')) {
    context.addIssue({ code: 'custom', path: ['actual'], message: 'Committed actuals must cover exact reserved dimensions' });
  }
  for (const [key, actual] of Object.entries(reconciliation.actual)) {
    if (reconciliation.amounts[key] === undefined || actual > reconciliation.amounts[key]) {
      context.addIssue({ code: 'custom', path: ['actual', key], message: 'Actual exceeds or lacks reservation amount' });
    }
  }
  if (reconciliation.status !== 'committed' &&
      (reconciliation.sampleDigest !== null || actualKeys.length !== 0)) {
    context.addIssue({ code: 'custom', message: 'Pending/released usage cannot carry committed actuals' });
  }
});

export const childReportBindingSchema = z.object({
  ticketRef: boundedString,
  reportRef: boundedString,
  reportEnvelopeDigest: contractDigestSchema,
  parentTicketRef: boundedString.nullable(),
  handleLineage: z.array(boundedString).min(1).max(2),
  generation: safePositive,
  nodeId: boundedString,
  parentNodeId: boundedString,
  issuerRole: semanticRoleSchema,
  role: semanticRoleSchema,
  status: z.enum(['active', 'revoked', 'expired', 'unresolved']),
  expiresAt: canonicalTimestamp,
  graphRevision: safePositive,
  graphEpoch: safeNonNegative,
  cancellationGeneration: safeNonNegative,
  leaseKind: z.literal('workstream'),
  leaseRef: boundedString,
  leaseGeneration: safePositive,
  leaseFence: safePositive,
  leaseNodeId: boundedString,
  leaseTicketRef: boundedString,
  leaseStatus: z.enum(['active', 'released', 'invalidated', 'expired', 'unresolved']),
  leaseAcquiredAt: canonicalTimestamp,
  leaseExpiresAt: canonicalTimestamp,
  budgetReservationId: boundedString,
  budgetReconciliation: evidenceBudgetReconciliationSchema,
  subtreeActual: budgetAmountsSchema,
  reportDestination: boundedString,
  reportSchemaRef: z.literal('execution-report/v1'),
  criteria: canonicalSet(boundedString)
}).strict().superRefine((child, context) => {
  if (Date.parse(child.leaseAcquiredAt) >= Date.parse(child.leaseExpiresAt)) {
    context.addIssue({ code: 'custom', message: 'Child lease expiry must follow acquisition' });
  }
});

const childReportBindingsSchema = z.array(childReportBindingSchema)
  .max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries)
  .refine(values => values.every((value, index) => index === 0 ||
    values[index - 1].ticketRef < value.ticketRef), 'Expected child report bindings in sorted unique ticket order');

const evidenceBindingFields = {
  runId: boundedString,
  projectId: boundedString,
  approvedPlanDigest: contractDigestSchema,
  approvedGraphDigest: contractDigestSchema,
  graphId: boundedString,
  graphRevision: safePositive,
  graphEpoch: safeNonNegative,
  cancellationGeneration: safeNonNegative,
  authorityKind: z.enum(['controller-root', 'delegation-ticket']),
  ticketRef: boundedString.nullable(),
  parentTicketRef: boundedString.nullable(),
  ticketBudgetReservationId: boundedString,
  ticketGeneration: safePositive.nullable(),
  nodeId: boundedString,
  parentNodeId: boundedString.nullable(),
  issuerRole: semanticRoleSchema.nullable(),
  recipientRole: semanticRoleSchema,
  reportDestination: boundedString,
  reportSchemaRef: z.literal('execution-report/v1'),
  leaseKind: z.enum(['controller', 'workstream']),
  leaseRef: boundedString,
  leaseGeneration: safePositive,
  leaseFence: safePositive
} as const;

export const evidenceActionReceiptPayloadSchema = actionReceiptPayloadSchema.extend({
  ...evidenceBindingFields,
  operation: operationClassSchema,
  childTicketRef: boundedString.nullable(),
  handleLineage: z.array(boundedString).max(3),
  mutations: canonicalSet(canonicalProjectPathSchema),
  inputMetadata: metadataSchema,
  resultMetadata: metadataSchema,
  workspaceScope: canonicalSet(writeSelectorSchema),
  workspaceBefore: workspaceSnapshotInputSchema,
  workspaceAfter: workspaceSnapshotInputSchema,
  beforeFingerprint: contractDigestSchema,
  afterFingerprint: contractDigestSchema,
  executorCompletionDigest: contractDigestSchema,
  preliminaryReceiptDigest: contractDigestSchema.nullable(),
  usageFinal: evidenceUsageSampleSchema.optional(),
  usageStatus: z.enum(['pending', 'committed', 'released', 'unresolved']),
  usageSampleDigest: contractDigestSchema.nullable(),
  usageAmounts: budgetAmountsSchema,
  usageCurrency: ledgerCurrency,
  usageDescendantCommitted: budgetAmountsSchema,
  usageActual: budgetAmountsSchema,
  artifactHashes: canonicalSet(contractDigestSchema)
}).strict().superRefine((receipt, context) => {
  if (receipt.authorityKind === 'controller-root') {
    if (receipt.ticketRef !== null || receipt.parentTicketRef !== null || receipt.ticketGeneration !== null ||
        receipt.parentNodeId !== null || receipt.issuerRole !== null || receipt.recipientRole !== 'PLAN_ROOT' ||
        receipt.handleLineage.length !== 0 || receipt.leaseKind !== 'controller') {
      context.addIssue({ code: 'custom', message: 'Controller-root receipt has delegation fields' });
    }
  } else if (receipt.ticketRef === null || receipt.ticketGeneration === null || receipt.parentNodeId === null ||
      receipt.issuerRole === null || receipt.recipientRole === 'PLAN_ROOT' || receipt.handleLineage.length === 0 ||
      receipt.leaseKind !== 'workstream') {
    context.addIssue({ code: 'custom', message: 'Delegation receipt lacks ticket/workstream fields' });
  }
  if (receipt.usageStatus === 'committed') {
    if (receipt.usageFinal === undefined || receipt.usageFinal.confidence !== 'authoritative' ||
        receipt.usageSampleDigest === null || receipt.preliminaryReceiptDigest === null) {
      context.addIssue({ code: 'custom', message: 'Committed receipt requires authoritative final usage and provenance' });
    }
  } else if (receipt.usageFinal !== undefined || receipt.usageSampleDigest !== null ||
      receipt.preliminaryReceiptDigest !== null || Object.keys(receipt.usageActual).length !== 0) {
    context.addIssue({ code: 'custom', message: 'Noncommitted receipt cannot carry final usage, provenance, or actuals' });
  }
  if (receipt.operation !== 'agent.spawn' && receipt.childTicketRef !== null) {
    context.addIssue({ code: 'custom', message: 'Spawn child ticket closure is inconsistent' });
  }
});

const evidenceExecutionReportFields = {
  ...evidenceBindingFields,
  childLineage: canonicalSet(boundedString),
  mutations: canonicalSet(canonicalProjectPathSchema),
  actions: canonicalSet(boundedString),
  criterionResults: z.array(z.object({
    criterionId: boundedString,
    outcome: z.enum(['met', 'unmet', 'uncertain']),
    evidenceRef: boundedString.optional()
  }).strict()).max(EVIDENCE_VALIDATION_LIMITS.collectionEntries)
    .refine(values => values.every((value, index) => index === 0 ||
      values[index - 1].criterionId < value.criterionId), 'Expected criterion results in sorted unique order'),
  receiptRefs: canonicalSet(boundedString),
  childReportRefs: canonicalSet(boundedString),
  evidenceOrder: uniqueSequence(boundedString),
  evidenceRefs: canonicalSet(boundedString),
  budgetReconciliation: evidenceBudgetReconciliationSchema,
  subtreeActual: budgetAmountsSchema,
  assumptions: canonicalSet(boundedString),
  unresolvedItems: canonicalSet(boundedString),
  uncertainOutcomes: canonicalSet(boundedString),
  startedAt: canonicalTimestamp,
  endedAt: canonicalTimestamp,
  beforeFingerprint: contractDigestSchema,
  afterFingerprint: contractDigestSchema
} as const;

const delegationAuthorityContextSchema = z.object({
  kind: z.literal('delegation-ticket'),
  ref: boundedString,
  handleLineage: z.array(boundedString).min(1).max(2),
  generation: safePositive,
  status: z.enum(['active', 'revoked', 'expired', 'unresolved']),
  expiresAt: canonicalTimestamp,
  nodeId: boundedString,
  parentNodeId: boundedString,
  issuerRole: semanticRoleSchema,
  recipientRole: semanticRoleSchema,
  reportDestination: boundedString,
  reportSchemaRef: z.literal('execution-report/v1'),
  parentTicketRef: boundedString.nullable(),
  budgetReservationId: boundedString,
  writeSet: canonicalSet(writeSelectorSchema),
  criteria: canonicalSet(boundedString)
}).strict();

const controllerRootAuthorityContextSchema = z.object({
  kind: z.literal('controller-root'),
  nodeId: boundedString,
  parentNodeId: z.null(),
  role: semanticRoleSchema.pipe(z.literal('PLAN_ROOT')),
  reportDestination: boundedString,
  reportSchemaRef: z.literal('execution-report/v1'),
  budgetReservationId: boundedString,
  writeSet: canonicalSet(writeSelectorSchema),
  criteria: canonicalSet(boundedString)
}).strict();

const authorityContextSchema = z.discriminatedUnion('kind', [
  delegationAuthorityContextSchema,
  controllerRootAuthorityContextSchema
]);

const commonLeaseContextFields = {
  ref: boundedString,
  generation: safePositive,
  fence: safePositive,
  status: z.enum(['active', 'released', 'invalidated', 'expired', 'unresolved']),
  acquiredAt: canonicalTimestamp,
  expiresAt: canonicalTimestamp
} as const;

const controllerLeaseContextSchema = z.object({
  kind: z.literal('controller'),
  ...commonLeaseContextFields
}).strict();

const workstreamLeaseContextSchema = z.object({
  kind: z.literal('workstream'),
  ...commonLeaseContextFields,
  nodeId: boundedString,
  ticketRef: boundedString
}).strict();

const leaseContextSchema = z.discriminatedUnion('kind', [
  controllerLeaseContextSchema,
  workstreamLeaseContextSchema
]).refine(lease => Date.parse(lease.acquiredAt) < Date.parse(lease.expiresAt),
  'Lease expiry must follow acquisition');

const contextBindingFields = {
  runId: boundedString,
  projectId: boundedString,
  approvedPlanDigest: contractDigestSchema,
  approvedGraphDigest: contractDigestSchema,
  graphId: boundedString,
  graphRevision: safePositive,
  graphEpoch: safeNonNegative,
  cancellationGeneration: safeNonNegative,
  runStatus: z.enum(['active', 'cancelled', 'unresolved']),
  receivedAt: canonicalTimestamp,
  authority: authorityContextSchema,
  lease: leaseContextSchema
} as const;

const workspaceContextSchema = z.object({
  before: workspaceSnapshotInputSchema,
  after: workspaceSnapshotInputSchema,
  mutations: canonicalSet(canonicalProjectPathSchema)
}).strict();

const priorClaimSchema = z.object({
  id: boundedString,
  digest: contractDigestSchema
}).strict();

export const actionReceiptValidationContextSchema = z.object({
  ...contextBindingFields,
  receiptId: boundedString,
  actionId: boundedString,
  idempotencyId: boundedString,
  action: structuredActionSchema,
  resultClass: z.enum(['success', 'failure', 'uncertain']),
  uncertaintyStatus: boundedString.nullable(),
  intentTimestamp: canonicalTimestamp,
  startedAt: canonicalTimestamp,
  endedAt: canonicalTimestamp,
  metadata: z.object({ input: metadataSchema, result: metadataSchema }).strict(),
  workspace: workspaceContextSchema,
  executorCompletionDigest: contractDigestSchema,
  preliminaryReceiptDigest: contractDigestSchema.nullable(),
  usage: z.object({
    reservationId: boundedString,
    status: z.enum(['pending', 'committed', 'released', 'unresolved']),
    startedAt: canonicalTimestamp,
    deadlineAt: canonicalTimestamp,
    final: evidenceUsageSampleSchema.nullable(),
    sampleDigest: contractDigestSchema.nullable(),
    amounts: budgetAmountsSchema,
    currency: ledgerCurrency,
    descendantCommitted: budgetAmountsSchema,
    actual: budgetAmountsSchema
  }).strict().superRefine((usage, context) => {
    if (Date.parse(usage.startedAt) >= Date.parse(usage.deadlineAt)) {
      context.addIssue({ code: 'custom', message: 'Usage deadline must follow start' });
    }
    if (usage.status === 'committed') {
      if (usage.final === null || usage.final.confidence !== 'authoritative' || usage.sampleDigest === null) {
        context.addIssue({ code: 'custom', message: 'Committed usage requires authoritative final and digest' });
      }
    } else if (usage.final !== null || usage.sampleDigest !== null || Object.keys(usage.actual).length !== 0) {
      context.addIssue({ code: 'custom', message: 'Noncommitted usage cannot carry final, digest, or actuals' });
    }
  }),
  artifactHashes: canonicalSet(contractDigestSchema),
  priorClaim: priorClaimSchema.optional()
}).strict();

const actionReceiptEvidenceEnvelopeSchema = z.object({
  kind: z.literal('action-receipt/v1'),
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  id: boundedString,
  payload: evidenceActionReceiptPayloadSchema,
  digest: contractDigestSchema
}).strict();

export const receiptEvidenceRecordSchema = z.object({
  validation: z.literal('valid'),
  authority: z.literal(false),
  ref: boundedString,
  envelopeDigest: contractDigestSchema,
  envelope: actionReceiptEvidenceEnvelopeSchema,
  runId: boundedString,
  projectId: boundedString,
  approvedPlanDigest: contractDigestSchema,
  approvedGraphDigest: contractDigestSchema,
  graphId: boundedString,
  graphRevision: safePositive,
  graphEpoch: safeNonNegative,
  cancellationGeneration: safeNonNegative,
  actionId: boundedString,
  idempotencyId: boundedString,
  operation: operationClassSchema,
  childTicketRef: boundedString.nullable(),
  normalizedOperationDigest: contractDigestSchema,
  intentTimestamp: canonicalTimestamp,
  uncertaintyStatus: boundedString.nullable(),
  inputMetadata: metadataSchema,
  resultMetadata: metadataSchema,
  authorityKind: z.enum(['controller-root', 'delegation-ticket']),
  ticketRef: boundedString.nullable(),
  parentTicketRef: boundedString.nullable(),
  ticketBudgetReservationId: boundedString,
  ticketGeneration: safePositive.nullable(),
  nodeId: boundedString,
  parentNodeId: boundedString.nullable(),
  issuerRole: semanticRoleSchema.nullable(),
  recipientRole: semanticRoleSchema,
  handleLineage: z.array(boundedString).max(2),
  reportDestination: boundedString,
  reportSchemaRef: z.literal('execution-report/v1'),
  leaseKind: z.enum(['controller', 'workstream']),
  leaseRef: boundedString,
  leaseGeneration: safePositive,
  leaseFence: safePositive,
  workspaceScope: canonicalSet(writeSelectorSchema),
  workspaceBefore: workspaceSnapshotInputSchema,
  workspaceAfter: workspaceSnapshotInputSchema,
  mutations: canonicalSet(canonicalProjectPathSchema),
  beforeFingerprint: contractDigestSchema,
  afterFingerprint: contractDigestSchema,
  executorCompletionDigest: contractDigestSchema,
  startedAt: canonicalTimestamp,
  endedAt: canonicalTimestamp,
  resultClass: z.enum(['success', 'failure', 'uncertain']),
  preliminaryReceiptDigest: contractDigestSchema.nullable(),
  usageReservationId: boundedString,
  usageStatus: z.enum(['pending', 'committed', 'released', 'unresolved']),
  usageFinal: evidenceUsageSampleSchema.nullable(),
  usageSampleDigest: contractDigestSchema.nullable(),
  usageAmounts: budgetAmountsSchema,
  usageCurrency: ledgerCurrency,
  usageDescendantCommitted: budgetAmountsSchema,
  usageActual: budgetAmountsSchema,
  artifactHashes: canonicalSet(contractDigestSchema)
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.startedAt) > Date.parse(receipt.endedAt)) {
    context.addIssue({ code: 'custom', message: 'Receipt end must not precede start' });
  }
  if (receipt.usageStatus === 'committed') {
    if (receipt.usageSampleDigest === null || receipt.preliminaryReceiptDigest === null) {
      context.addIssue({ code: 'custom', message: 'Committed receipt usage requires sample and preliminary digests' });
    }
    const amountKeys = Object.keys(receipt.usageAmounts).sort();
    const actualKeys = Object.keys(receipt.usageActual).sort();
    if (amountKeys.join('\0') !== actualKeys.join('\0') || actualKeys.some(key =>
      receipt.usageActual[key] > receipt.usageAmounts[key])) {
      context.addIssue({ code: 'custom', message: 'Receipt usage actuals must fit exact reservation dimensions' });
    }
  } else if (receipt.usageSampleDigest !== null || receipt.preliminaryReceiptDigest !== null ||
      Object.keys(receipt.usageActual).length !== 0) {
    context.addIssue({ code: 'custom', message: 'Noncommitted receipt usage cannot carry provenance or actuals' });
  }
  if ((receipt.operation !== 'agent.spawn' && receipt.childTicketRef !== null) ||
      (receipt.operation === 'agent.spawn' &&
        (receipt.resultClass === 'success') !== (receipt.childTicketRef !== null))) {
    context.addIssue({ code: 'custom', message: 'Spawn child ticket closure is inconsistent' });
  }
});

export const evidenceExecutionReportPayloadSchema = executionReportPayloadSchema.extend({
  ...evidenceExecutionReportFields,
  handleLineage: z.array(boundedString).max(2),
  workspaceScope: canonicalSet(writeSelectorSchema),
  workspaceBefore: workspaceSnapshotInputSchema,
  workspaceAfter: workspaceSnapshotInputSchema,
  actionReceipts: z.array(receiptEvidenceRecordSchema).max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries),
  childBindings: childReportBindingsSchema,
  closureChildLineage: canonicalSet(boundedString),
  closureChildReportRefs: canonicalSet(boundedString),
  closureCriterionResults: z.array(reportCriterionResultSchema)
    .max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries),
  evidenceRecords: z.array(evidenceRecordSchema).max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries),
  completionBlocked: z.boolean()
}).strict().superRefine((report, context) => {
  if (report.authorityKind === 'controller-root') {
    if (report.ticketRef !== null || report.parentTicketRef !== null || report.ticketGeneration !== null ||
        report.parentNodeId !== null || report.issuerRole !== null || report.recipientRole !== 'PLAN_ROOT' ||
        report.handleLineage.length !== 0 || report.leaseKind !== 'controller') {
      context.addIssue({ code: 'custom', message: 'Controller-root report has delegation fields' });
    }
  } else if (report.ticketRef === null || report.ticketGeneration === null || report.parentNodeId === null ||
      report.issuerRole === null || report.recipientRole === 'PLAN_ROOT' || report.handleLineage.length === 0 ||
      report.leaseKind !== 'workstream') {
    context.addIssue({ code: 'custom', message: 'Delegation report lacks ticket/workstream fields' });
  }
});

const executionReportEvidenceEnvelopeSchema = z.object({
  kind: z.literal('execution-report/v1'),
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  id: boundedString,
  payload: evidenceExecutionReportPayloadSchema,
  digest: contractDigestSchema
}).strict();

export const reportEvidenceRecordSchema = z.object({
  validation: z.literal('valid'),
  authority: z.literal(false),
  ref: boundedString,
  envelopeDigest: contractDigestSchema,
  envelope: executionReportEvidenceEnvelopeSchema,
  runId: boundedString,
  projectId: boundedString,
  approvedPlanDigest: contractDigestSchema,
  approvedGraphDigest: contractDigestSchema,
  graphId: boundedString,
  graphRevision: safePositive,
  graphEpoch: safeNonNegative,
  cancellationGeneration: safeNonNegative,
  authorityKind: z.enum(['controller-root', 'delegation-ticket']),
  ticketRef: boundedString.nullable(),
  parentTicketRef: boundedString.nullable(),
  ticketBudgetReservationId: boundedString,
  ticketGeneration: safePositive.nullable(),
  nodeId: boundedString,
  parentNodeId: boundedString.nullable(),
  issuerRole: semanticRoleSchema.nullable(),
  recipientRole: semanticRoleSchema,
  handleLineage: z.array(boundedString).max(2),
  reportDestination: boundedString,
  reportSchemaRef: z.literal('execution-report/v1'),
  leaseKind: z.enum(['controller', 'workstream']),
  leaseRef: boundedString,
  leaseGeneration: safePositive,
  leaseFence: safePositive,
  workspaceScope: canonicalSet(writeSelectorSchema),
  workspaceBefore: workspaceSnapshotInputSchema,
  workspaceAfter: workspaceSnapshotInputSchema,
  mutations: canonicalSet(canonicalProjectPathSchema),
  actions: canonicalSet(boundedString),
  actionReceipts: z.array(receiptEvidenceRecordSchema).max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries),
  childLineage: canonicalSet(boundedString),
  childReportRefs: canonicalSet(boundedString),
  childBindings: childReportBindingsSchema,
  descendantTicketRefs: canonicalSet(boundedString),
  descendantReportRefs: canonicalSet(boundedString),
  criterionResults: z.array(reportCriterionResultSchema).max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries)
    .refine(values => values.every((value, index) => index === 0 ||
      `${values[index - 1].nodeId}\0${values[index - 1].criterionId}` <
      `${value.nodeId}\0${value.criterionId}`), 'Expected sorted unique criterion results'),
  evidenceOrder: uniqueSequence(boundedString),
  evidenceRefs: canonicalSet(boundedString),
  evidenceRecords: z.array(evidenceRecordSchema).max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries)
    .refine(values => values.every((value, index) => index === 0 ||
      values[index - 1].ref < value.ref), 'Expected evidence records in sorted unique ref order'),
  budgetReconciliation: evidenceBudgetReconciliationSchema,
  subtreeActual: budgetAmountsSchema,
  assumptions: canonicalSet(boundedString),
  unresolvedItems: canonicalSet(boundedString),
  uncertainOutcomes: canonicalSet(boundedString),
  beforeFingerprint: contractDigestSchema,
  afterFingerprint: contractDigestSchema,
  startedAt: canonicalTimestamp,
  endedAt: canonicalTimestamp,
  completionBlocked: z.boolean()
}).strict().refine(report => Date.parse(report.startedAt) <= Date.parse(report.endedAt),
  'Report end must not precede start');

export const executionReportValidationContextSchema = z.object({
  ...contextBindingFields,
  reportId: boundedString,
  workspace: z.object({
    before: workspaceSnapshotInputSchema,
    after: workspaceSnapshotInputSchema
  }).strict(),
  receipts: z.array(receiptEvidenceRecordSchema).max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries),
  children: childReportBindingsSchema,
  childReports: z.array(reportEvidenceRecordSchema).max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries),
  evidenceOrder: z.array(boundedString).max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries),
  evidence: z.array(evidenceRecordSchema).max(EVIDENCE_VALIDATION_LIMITS.evidenceEntries),
  budgetReconciliation: evidenceBudgetReconciliationSchema,
  subtreeActual: budgetAmountsSchema,
  budgetContributors: z.object({
    own: budgetAmountsSchema,
    children: budgetAmountsSchema
  }).strict(),
  requiredDisclosures: z.object({
    assumptions: canonicalSet(boundedString),
    unresolvedItems: canonicalSet(boundedString),
    uncertainOutcomes: canonicalSet(boundedString)
  }).strict(),
  priorClaim: priorClaimSchema.optional()
}).strict().superRefine((value, context) => {
  const receipts = [
    ...value.receipts,
    ...value.childReports.flatMap(report => report.actionReceipts)
  ];
  const snapshotEntries = receipts.reduce((total, receipt) =>
    total + receipt.workspaceBefore.entries.length + receipt.workspaceAfter.entries.length, 0) +
    value.childReports.reduce((total, report) =>
      total + report.workspaceBefore.entries.length + report.workspaceAfter.entries.length, 0);
  const evidenceRecords = value.evidence.length + value.childReports.reduce((total, report) =>
    total + report.evidenceRecords.length, 0);
  const childBindings = value.children.length + value.childReports.reduce((total, report) =>
    total + report.childBindings.length, 0);
  if (receipts.length > EVIDENCE_VALIDATION_LIMITS.evidenceEntries ||
      evidenceRecords > EVIDENCE_VALIDATION_LIMITS.evidenceEntries ||
      childBindings > EVIDENCE_VALIDATION_LIMITS.evidenceEntries ||
      snapshotEntries > EVIDENCE_VALIDATION_LIMITS.collectionEntries) {
    context.addIssue({ code: 'custom', message: 'Aggregate retained evidence exceeds limit' });
  }
});

export type EvidenceActionReceiptPayload = z.infer<typeof evidenceActionReceiptPayloadSchema>;
export type EvidenceExecutionReportPayload = z.infer<typeof evidenceExecutionReportPayloadSchema>;
export type ChildReportBinding = z.infer<typeof childReportBindingSchema>;
export type ActionReceiptValidationContext = z.input<typeof actionReceiptValidationContextSchema>;
export type ExecutionReportValidationContext = z.input<typeof executionReportValidationContextSchema>;
export type ReceiptEvidenceRecord = z.infer<typeof receiptEvidenceRecordSchema>;
export type ReportEvidenceRecord = z.infer<typeof reportEvidenceRecordSchema>;
