import {
  ContractEnvelope,
  contractEnvelopeSchema,
  isLegalDelegationEdge,
  SemanticRole,
  verifyContractEnvelope
} from '../../contracts';
import { writeSelectorCovers } from '../compiler/schema';
import { StructuredAction } from '../trust';
import {
  computeAuthorityUsageSampleDigest,
  deriveAuthorityUsageActual
} from '../authority/usage-accounting';
import { computeWorkspaceFingerprint, WorkspaceFingerprint } from './fingerprint';
import {
  canonicalEqual,
  freezeEvidenceData,
  sameStrings,
  snapshotEvidenceData,
  sortedUnique
} from './internal';
import {
  metadataMatches,
  operationMetadataMatches,
  validateMetadata
} from './metadata';
import { computeNormalizedOperationDigest } from './operation';
import {
  ActionReceiptValidationContext,
  actionReceiptValidationContextSchema,
  ChildReportBinding,
  EvidenceActionReceiptPayload,
  evidenceActionReceiptPayloadSchema,
  EvidenceExecutionReportPayload,
  evidenceExecutionReportPayloadSchema,
  EVIDENCE_VALIDATION_LIMITS,
  evidenceUsageSampleSchema,
  ExecutionReportValidationContext,
  executionReportValidationContextSchema,
  ReceiptEvidenceRecord,
  ReportEvidenceRecord
} from './schema';

export const EVIDENCE_REASON_CODES = Object.freeze([
  'malformed-envelope',
  'wrong-contract-kind',
  'envelope-digest-mismatch',
  'evidence-projection-mismatch',
  'malformed-payload',
  'trusted-context-invalid',
  'run-binding-mismatch',
  'project-binding-mismatch',
  'plan-binding-mismatch',
  'graph-binding-mismatch',
  'graph-revision-mismatch',
  'future-authority-claim',
  'ticket-binding-mismatch',
  'lease-binding-mismatch',
  'node-binding-mismatch',
  'role-binding-mismatch',
  'report-binding-mismatch',
  'lineage-mismatch',
  'action-binding-mismatch',
  'operation-digest-mismatch',
  'sensitive-metadata',
  'unknown-metadata-field',
  'metadata-value-invalid',
  'metadata-mismatch',
  'operation-metadata-mismatch',
  'scope-mismatch',
  'fingerprint-mismatch',
  'mutation-outside-write-set',
  'mutation-snapshot-mismatch',
  'mutation-corroboration-mismatch',
  'unexplained-workspace-drift',
  'timestamp-binding-mismatch',
  'timestamp-order-invalid',
  'timestamp-window-invalid',
  'usage-lifecycle-mismatch',
  'usage-reservation-mismatch',
  'usage-reconciliation-mismatch',
  'artifact-mismatch',
  'replay-conflict',
  'child-lineage-illegal',
  'child-spawn-mismatch',
  'child-report-missing',
  'child-report-duplicate',
  'child-report-unrelated',
  'actions-receipts-mismatch',
  'idempotency-conflict',
  'receipt-continuity-mismatch',
  'criteria-mismatch',
  'met-criterion-without-evidence',
  'evidence-reference-open',
  'budget-reconciliation-mismatch',
  'budget-contributor-mismatch',
  'disclosure-omitted',
  'unresolved-authority-reference',
  'ticket-revoked',
  'ticket-expired',
  'ticket-generation-drift',
  'lease-released',
  'lease-invalidated',
  'lease-expired',
  'lease-generation-drift',
  'graph-epoch-drift',
  'cancellation-late'
] as const);

export type EvidenceReasonCode = typeof EVIDENCE_REASON_CODES[number];
export type EvidenceClassification = 'valid' | 'rejected' | 'quarantined';

export interface InvalidEvidenceResult {
  readonly ok: false;
  readonly authority: false;
  readonly classification: 'rejected' | 'quarantined';
  readonly reasons: readonly EvidenceReasonCode[];
}

export interface ValidActionReceiptResult {
  readonly ok: true;
  readonly authority: false;
  readonly classification: 'valid';
  readonly reasons: readonly [];
  readonly envelope: Readonly<ContractEnvelope & {
    kind: 'action-receipt/v1';
    payload: EvidenceActionReceiptPayload;
  }>;
  readonly evidence: Readonly<ReceiptEvidenceRecord>;
  readonly replay: boolean;
}

export interface ValidExecutionReportResult {
  readonly ok: true;
  readonly authority: false;
  readonly classification: 'valid';
  readonly reasons: readonly [];
  readonly envelope: Readonly<ContractEnvelope & {
    kind: 'execution-report/v1';
    payload: EvidenceExecutionReportPayload;
  }>;
  readonly evidence: Readonly<ReportEvidenceRecord>;
  /** Negative-only signal. False is not acceptance; controller still owns every verdict. */
  readonly completionBlocked: boolean;
  readonly requestedDisposition: 'continue' | 'pause' | 'escalate' | 'complete';
  readonly replay: boolean;
}

export type ActionReceiptValidationResult = ValidActionReceiptResult | InvalidEvidenceResult;
export type ExecutionReportValidationResult = ValidExecutionReportResult | InvalidEvidenceResult;

const QUARANTINE = new Set<EvidenceReasonCode>([
  'unresolved-authority-reference', 'ticket-revoked', 'ticket-expired',
  'ticket-generation-drift', 'lease-released', 'lease-invalidated', 'lease-expired',
  'lease-generation-drift', 'graph-epoch-drift', 'cancellation-late'
]);
const REASON_ORDER = new Map<EvidenceReasonCode, number>(
  EVIDENCE_REASON_CODES.map((code, index) => [code, index])
);

class Reasons {
  private readonly values = new Set<EvidenceReasonCode>();

  add(code: EvidenceReasonCode): void {
    this.values.add(code);
  }

  result(): InvalidEvidenceResult | null {
    if (this.values.size === 0) return null;
    const reasons = [...this.values].sort((left, right) => REASON_ORDER.get(left)! - REASON_ORDER.get(right)!);
    const classification = reasons.every(reason => QUARANTINE.has(reason)) ? 'quarantined' : 'rejected';
    return freezeEvidenceData({
      ok: false as const,
      authority: false as const,
      classification,
      reasons
    }) as InvalidEvidenceResult;
  }
}

function parseEnvelope(
  value: unknown,
  expectedKind: 'action-receipt/v1' | 'execution-report/v1',
  reasons: Reasons
): ContractEnvelope | null {
  let snapshot: unknown;
  try {
    snapshot = snapshotEvidenceData(value);
  } catch {
    reasons.add('malformed-envelope');
    return null;
  }
  const parsed = contractEnvelopeSchema.safeParse(snapshot);
  if (!parsed.success) {
    reasons.add('malformed-envelope');
    return null;
  }
  if (parsed.data.kind !== expectedKind) reasons.add('wrong-contract-kind');
  if (!verifyContractEnvelope(parsed.data).ok) reasons.add('envelope-digest-mismatch');
  return parsed.data;
}

function parseContext<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  reasons: Reasons
): T | null {
  let snapshot: unknown;
  try {
    snapshot = snapshotEvidenceData(value);
  } catch {
    reasons.add('trusted-context-invalid');
    return null;
  }
  const parsed = schema.safeParse(snapshot);
  if (!parsed.success) {
    reasons.add('trusted-context-invalid');
    return null;
  }
  return parsed.data;
}

interface CommonPayload {
  runId: string;
  projectId: string;
  approvedPlanDigest: string;
  approvedGraphDigest: string;
  graphId: string;
  graphRevision: number;
  graphEpoch: number;
  cancellationGeneration: number;
  authorityKind: 'controller-root' | 'delegation-ticket';
  ticketRef: string | null;
  parentTicketRef: string | null;
  ticketBudgetReservationId: string;
  ticketGeneration: number | null;
  nodeId: string;
  parentNodeId: string | null;
  issuerRole: SemanticRole | null;
  recipientRole: SemanticRole;
  reportDestination: string;
  reportSchemaRef: string;
  leaseKind: 'controller' | 'workstream';
  leaseRef: string;
  leaseGeneration: number;
  leaseFence: number;
}

type ParsedReceiptContext = ReturnType<typeof actionReceiptValidationContextSchema.parse>;
type ParsedReportContext = ReturnType<typeof executionReportValidationContextSchema.parse>;
type ParsedContext = ParsedReceiptContext | ParsedReportContext;
type DelegationAuthority = Extract<ParsedContext['authority'], { kind: 'delegation-ticket' }>;

interface AuthorityBinding {
  readonly kind: 'controller-root' | 'delegation-ticket';
  readonly ref: string | null;
  readonly parentTicketRef: string | null;
  readonly budgetReservationId: string;
  readonly generation: number | null;
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly issuerRole: SemanticRole | null;
  readonly recipientRole: SemanticRole;
  readonly reportDestination: string;
  readonly reportSchemaRef: string;
  readonly handleLineage: readonly string[];
  readonly writeSet: readonly string[];
  readonly criteria: readonly string[];
}

function authorityBinding(context: ParsedContext): AuthorityBinding {
  const authority = context.authority;
  return authority.kind === 'controller-root' ? {
    kind: authority.kind,
    ref: null,
    parentTicketRef: null,
    budgetReservationId: authority.budgetReservationId,
    generation: null,
    nodeId: authority.nodeId,
    parentNodeId: authority.parentNodeId,
    issuerRole: null,
    recipientRole: authority.role,
    reportDestination: authority.reportDestination,
    reportSchemaRef: authority.reportSchemaRef,
    handleLineage: [],
    writeSet: authority.writeSet,
    criteria: authority.criteria
  } : {
    kind: authority.kind,
    ref: authority.ref,
    parentTicketRef: authority.parentTicketRef,
    budgetReservationId: authority.budgetReservationId,
    generation: authority.generation,
    nodeId: authority.nodeId,
    parentNodeId: authority.parentNodeId,
    issuerRole: authority.issuerRole,
    recipientRole: authority.recipientRole,
    reportDestination: authority.reportDestination,
    reportSchemaRef: authority.reportSchemaRef,
    handleLineage: [...authority.handleLineage],
    writeSet: authority.writeSet,
    criteria: authority.criteria
  };
}

function directionalGeneration(
  actual: number,
  expected: number,
  staleReason: EvidenceReasonCode,
  reasons: Reasons
): void {
  if (actual < expected) reasons.add(staleReason);
  else if (actual > expected) reasons.add('future-authority-claim');
}

function validTicketLineage(ticket: DelegationAuthority): boolean {
  if (ticket.recipientRole === 'EXECUTION') {
    return ticket.issuerRole === 'PLAN_ROOT' && ticket.parentTicketRef === null &&
      sameStrings(ticket.handleLineage, [ticket.ref]);
  }
  if (ticket.recipientRole === 'LEAF') {
    return ticket.issuerRole === 'EXECUTION' && ticket.parentTicketRef !== null &&
      sameStrings(ticket.handleLineage, [ticket.parentTicketRef, ticket.ref]);
  }
  return false;
}

function commonValidation(payload: CommonPayload, context: ParsedContext, reasons: Reasons): void {
  const authority = authorityBinding(context);
  if (payload.runId !== context.runId) reasons.add('run-binding-mismatch');
  if (payload.projectId !== context.projectId) reasons.add('project-binding-mismatch');
  if (payload.approvedPlanDigest !== context.approvedPlanDigest) reasons.add('plan-binding-mismatch');
  if (payload.approvedGraphDigest !== context.approvedGraphDigest || payload.graphId !== context.graphId) {
    reasons.add('graph-binding-mismatch');
  }
  if (payload.graphRevision !== context.graphRevision) reasons.add('graph-revision-mismatch');
  directionalGeneration(payload.graphEpoch, context.graphEpoch, 'graph-epoch-drift', reasons);
  directionalGeneration(
    payload.cancellationGeneration,
    context.cancellationGeneration,
    'cancellation-late',
    reasons
  );
  if (context.runStatus === 'cancelled') reasons.add('cancellation-late');
  if (context.runStatus === 'unresolved' ||
      (context.authority.kind === 'delegation-ticket' && context.authority.status === 'unresolved') ||
      context.lease.status === 'unresolved') reasons.add('unresolved-authority-reference');
  if (payload.authorityKind !== authority.kind || payload.ticketRef !== authority.ref ||
      payload.parentTicketRef !== authority.parentTicketRef ||
      payload.ticketBudgetReservationId !== authority.budgetReservationId) {
    reasons.add('ticket-binding-mismatch');
  }
  if (payload.ticketGeneration !== null && authority.generation !== null) {
    directionalGeneration(payload.ticketGeneration, authority.generation, 'ticket-generation-drift', reasons);
  } else if (payload.ticketGeneration !== authority.generation) reasons.add('ticket-binding-mismatch');
  if (payload.nodeId !== authority.nodeId || payload.parentNodeId !== authority.parentNodeId) {
    reasons.add('node-binding-mismatch');
  }
  if (payload.issuerRole !== authority.issuerRole || payload.recipientRole !== authority.recipientRole ||
      (authority.kind === 'delegation-ticket' &&
        !isLegalDelegationEdge(payload.issuerRole!, payload.recipientRole))) {
    reasons.add('role-binding-mismatch');
  }
  if (payload.reportDestination !== authority.reportDestination ||
      payload.reportSchemaRef !== authority.reportSchemaRef) reasons.add('report-binding-mismatch');
  if (payload.leaseKind !== context.lease.kind || payload.leaseRef !== context.lease.ref ||
      (authority.kind === 'controller-root' && context.lease.kind !== 'controller') ||
      (authority.kind === 'delegation-ticket' && (context.lease.kind !== 'workstream' ||
        context.lease.nodeId !== (authority.recipientRole === 'LEAF' ? authority.parentNodeId : authority.nodeId) ||
        context.lease.ticketRef !== (authority.recipientRole === 'LEAF' ? authority.parentTicketRef : authority.ref)))) {
    reasons.add('lease-binding-mismatch');
  }
  directionalGeneration(payload.leaseGeneration, context.lease.generation, 'lease-generation-drift', reasons);
  directionalGeneration(payload.leaseFence, context.lease.fence, 'lease-generation-drift', reasons);
  if (context.authority.kind === 'delegation-ticket' && context.authority.status === 'revoked') {
    reasons.add('ticket-revoked');
  }
  if (context.authority.kind === 'delegation-ticket' &&
      (context.authority.status === 'expired' ||
        Date.parse(context.receivedAt) >= Date.parse(context.authority.expiresAt))) {
    reasons.add('ticket-expired');
  }
  if (context.lease.status === 'released') reasons.add('lease-released');
  if (context.lease.status === 'invalidated') reasons.add('lease-invalidated');
  if (context.lease.status === 'expired' || Date.parse(context.receivedAt) >= Date.parse(context.lease.expiresAt)) {
    reasons.add('lease-expired');
  }
  if (context.authority.kind === 'delegation-ticket' && !validTicketLineage(context.authority)) {
    reasons.add('trusted-context-invalid');
  }
}

function timestampsWithin(timestamps: readonly string[], context: ParsedContext, reasons: Reasons): void {
  const milliseconds = timestamps.map(Date.parse);
  if (milliseconds.some((value, index) => index > 0 && milliseconds[index - 1] > value)) {
    reasons.add('timestamp-order-invalid');
  }
  const lower = Date.parse(context.lease.acquiredAt);
  const upper = context.authority.kind === 'delegation-ticket'
    ? Math.min(Date.parse(context.authority.expiresAt), Date.parse(context.lease.expiresAt))
    : Date.parse(context.lease.expiresAt);
  if (milliseconds.some(value => value < lower || value >= upper || value > Date.parse(context.receivedAt))) {
    reasons.add('timestamp-window-invalid');
  }
}

interface WorkspaceTransition {
  before: Readonly<WorkspaceFingerprint>;
  after: Readonly<WorkspaceFingerprint>;
  changedPaths: readonly string[];
}

function workspaceSnapshot(fingerprint: Readonly<WorkspaceFingerprint>): {
  scope: string[];
  entries: Array<{
    path: string;
    kind: 'file' | 'directory' | 'symlink' | 'missing';
    contentDigest: string | null;
    target: string | null;
    size: number;
  }>;
} {
  return {
    scope: [...fingerprint.scope],
    entries: fingerprint.entries.map(entry => ({ ...entry }))
  };
}

function workspaceTransition(
  beforeValue: unknown,
  afterValue: unknown,
  mutations: readonly string[],
  reasons: Reasons,
  mismatchReason: EvidenceReasonCode,
  exactMutations = true
): WorkspaceTransition | null {
  let before: Readonly<WorkspaceFingerprint>;
  let after: Readonly<WorkspaceFingerprint>;
  try {
    before = computeWorkspaceFingerprint(beforeValue);
    after = computeWorkspaceFingerprint(afterValue);
  } catch {
    reasons.add('trusted-context-invalid');
    return null;
  }
  if (!sameStrings(before.scope, after.scope)) reasons.add('scope-mismatch');
  const beforeByPath = new Map(before.entries.map(entry => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map(entry => [entry.path, entry]));
  if (mutations.some(path => !beforeByPath.has(path) || !afterByPath.has(path) ||
      !before.scope.some(selector => writeSelectorCovers(selector, path)))) {
    reasons.add('mutation-snapshot-mismatch');
  }
  const allPaths = sortedUnique([...beforeByPath.keys(), ...afterByPath.keys()]);
  const changedPaths = allPaths.filter(path =>
    !canonicalEqual(beforeByPath.get(path) ?? null, afterByPath.get(path) ?? null));
  if (exactMutations ? !sameStrings(changedPaths, mutations) :
    changedPaths.some(path => !mutations.includes(path))) reasons.add(mismatchReason);
  return { before, after, changedPaths };
}

function coveredMutations(mutations: readonly string[], writeSet: readonly string[]): boolean {
  return mutations.every(mutation => writeSet.some(selector => writeSelectorCovers(selector, mutation)));
}

function validateFilesystemMetadata(
  action: StructuredAction,
  metadata: { input: Record<string, unknown>; result: Record<string, unknown> },
  transition: WorkspaceTransition | null,
  resultClass: 'success' | 'failure' | 'uncertain',
  artifactHashes: readonly string[],
  reasons: Reasons
): void {
  if ((action.operation !== 'fs.write' && action.operation !== 'fs.delete') || !transition) return;
  const before = transition.before.entries.find(entry => entry.path === action.path);
  const after = transition.after.entries.find(entry => entry.path === action.path);
  const changed = metadata.result.changed;
  if (!before || !after || metadata.input.path !== action.path || typeof changed !== 'boolean' ||
      changed !== transition.changedPaths.includes(action.path) ||
      !sameStrings(transition.changedPaths, changed ? [action.path] : [])) {
    reasons.add('trusted-context-invalid');
    return;
  }

  if (action.operation === 'fs.write') {
    const contentDigest = metadata.input.contentDigest;
    const declaredBytes = metadata.input.declaredBytes;
    const bytesWritten = metadata.result.bytesWritten;
    const artifactHash = metadata.result.artifactHash;
    const requiresWriteResult = changed || resultClass === 'success';
    if (requiresWriteResult && (after.kind !== 'file' || contentDigest !== after.contentDigest ||
        declaredBytes !== after.size || bytesWritten !== after.size)) reasons.add('trusted-context-invalid');
    if (!changed && !canonicalEqual(before, after)) reasons.add('trusted-context-invalid');
    if (changed && (artifactHash !== after.contentDigest || typeof artifactHash !== 'string' ||
        !artifactHashes.includes(artifactHash))) reasons.add('trusted-context-invalid');
    if (artifactHash !== undefined && (after.kind !== 'file' || artifactHash !== after.contentDigest ||
        !artifactHashes.includes(artifactHash as string))) reasons.add('trusted-context-invalid');
    return;
  }

  const deleted = metadata.result.deleted;
  if (typeof deleted !== 'boolean' || deleted !== changed ||
      (changed && (before.kind === 'missing' || after.kind !== 'missing')) ||
      (!changed && !canonicalEqual(before, after)) ||
      (!changed && resultClass === 'success' && before.kind !== 'missing')) {
    reasons.add('trusted-context-invalid');
  }
}

function replay(
  envelope: ContractEnvelope,
  prior: { id: string; digest: string } | undefined,
  reasons: Reasons
): boolean {
  if (!prior) return false;
  if (prior.id !== envelope.id || prior.digest !== envelope.digest) reasons.add('replay-conflict');
  return prior.id === envelope.id && prior.digest === envelope.digest;
}

type ReceiptEnvelope = Readonly<ContractEnvelope & {
  kind: 'action-receipt/v1';
  payload: EvidenceActionReceiptPayload;
}>;
type ReportEnvelope = Readonly<ContractEnvelope & {
  kind: 'execution-report/v1';
  payload: EvidenceExecutionReportPayload;
}>;

function projectReceiptEvidence(envelope: ReceiptEnvelope): ReceiptEvidenceRecord {
  const payload = envelope.payload;
  return {
    validation: 'valid',
    authority: false,
    ref: envelope.id,
    envelopeDigest: envelope.digest,
    envelope,
    runId: payload.runId,
    projectId: payload.projectId,
    approvedPlanDigest: payload.approvedPlanDigest,
    approvedGraphDigest: payload.approvedGraphDigest,
    graphId: payload.graphId,
    graphRevision: payload.graphRevision,
    graphEpoch: payload.graphEpoch,
    cancellationGeneration: payload.cancellationGeneration,
    actionId: payload.actionId,
    idempotencyId: payload.idempotencyId,
    operation: payload.operation,
    childTicketRef: payload.childTicketRef,
    normalizedOperationDigest: payload.normalizedOperationDigest,
    intentTimestamp: payload.intentTimestamp,
    uncertaintyStatus: payload.uncertaintyStatus ?? null,
    inputMetadata: payload.inputMetadata,
    resultMetadata: payload.resultMetadata,
    authorityKind: payload.authorityKind,
    ticketRef: payload.ticketRef,
    parentTicketRef: payload.parentTicketRef,
    ticketBudgetReservationId: payload.ticketBudgetReservationId,
    ticketGeneration: payload.ticketGeneration,
    nodeId: payload.nodeId,
    parentNodeId: payload.parentNodeId,
    issuerRole: payload.issuerRole,
    recipientRole: payload.recipientRole,
    handleLineage: payload.handleLineage,
    reportDestination: payload.reportDestination,
    reportSchemaRef: payload.reportSchemaRef,
    leaseKind: payload.leaseKind,
    leaseRef: payload.leaseRef,
    leaseGeneration: payload.leaseGeneration,
    leaseFence: payload.leaseFence,
    workspaceScope: payload.workspaceScope,
    workspaceBefore: payload.workspaceBefore,
    workspaceAfter: payload.workspaceAfter,
    mutations: payload.mutations,
    beforeFingerprint: payload.beforeFingerprint,
    afterFingerprint: payload.afterFingerprint,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    resultClass: payload.resultClass,
    usageReservationId: payload.usageReservationId,
    usageStatus: payload.usageStatus,
    usageFinal: payload.usageFinal ?? null,
    usageSampleDigest: payload.usageSampleDigest,
    usageAmounts: payload.usageAmounts,
    usageCurrency: payload.usageCurrency,
    usageDescendantCommitted: payload.usageDescendantCommitted,
    usageActual: payload.usageActual,
    artifactHashes: payload.artifactHashes
  };
}

function validateRetainedReceipt(receipt: ReceiptEvidenceRecord, reasons: Reasons): void {
  if (!verifyContractEnvelope(receipt.envelope).ok) reasons.add('envelope-digest-mismatch');
  if (!canonicalEqual(receipt, projectReceiptEvidence(receipt.envelope))) {
    reasons.add('evidence-projection-mismatch');
  }
  for (const result of [
    validateMetadata(receipt.envelope.payload.operation, 'input', receipt.envelope.payload.inputMetadata),
    validateMetadata(receipt.envelope.payload.operation, 'result', receipt.envelope.payload.resultMetadata)
  ]) if (!result.ok) reasons.add(result.reason);
  if (Date.parse(receipt.intentTimestamp) > Date.parse(receipt.startedAt) ||
      Date.parse(receipt.startedAt) > Date.parse(receipt.endedAt)) reasons.add('timestamp-order-invalid');
  if (receipt.usageStatus === 'committed' && receipt.usageFinal !== null) {
    try {
      if (computeUsageSampleDigest(receipt.usageFinal) !== receipt.usageSampleDigest ||
          !canonicalEqual(deriveAuthorityUsageActual({
            amounts: receipt.usageAmounts,
            currency: receipt.usageCurrency,
            sample: receipt.usageFinal,
            descendantCommitted: receipt.usageDescendantCommitted
          }), receipt.usageActual)) reasons.add('usage-reconciliation-mismatch');
    } catch {
      reasons.add('usage-reconciliation-mismatch');
    }
  }
}

function projectReportEvidence(envelope: ReportEnvelope): ReportEvidenceRecord {
  const payload = envelope.payload;
  return {
    validation: 'valid',
    authority: false,
    ref: envelope.id,
    envelopeDigest: envelope.digest,
    envelope,
    runId: payload.runId,
    projectId: payload.projectId,
    approvedPlanDigest: payload.approvedPlanDigest,
    approvedGraphDigest: payload.approvedGraphDigest,
    graphId: payload.graphId,
    graphRevision: payload.graphRevision,
    graphEpoch: payload.graphEpoch,
    cancellationGeneration: payload.cancellationGeneration,
    authorityKind: payload.authorityKind,
    ticketRef: payload.ticketRef,
    parentTicketRef: payload.parentTicketRef,
    ticketBudgetReservationId: payload.ticketBudgetReservationId,
    ticketGeneration: payload.ticketGeneration,
    nodeId: payload.nodeId,
    parentNodeId: payload.parentNodeId,
    issuerRole: payload.issuerRole,
    recipientRole: payload.recipientRole,
    handleLineage: payload.handleLineage,
    reportDestination: payload.reportDestination,
    reportSchemaRef: payload.reportSchemaRef,
    leaseKind: payload.leaseKind,
    leaseRef: payload.leaseRef,
    leaseGeneration: payload.leaseGeneration,
    leaseFence: payload.leaseFence,
    workspaceScope: payload.workspaceScope,
    workspaceBefore: payload.workspaceBefore,
    workspaceAfter: payload.workspaceAfter,
    mutations: payload.mutations,
    actions: payload.actions,
    actionReceipts: payload.actionReceipts,
    childLineage: payload.childLineage,
    childReportRefs: payload.childReportRefs,
    childBindings: payload.childBindings,
    descendantTicketRefs: payload.closureChildLineage,
    descendantReportRefs: payload.closureChildReportRefs,
    criterionResults: payload.closureCriterionResults,
    evidenceOrder: payload.evidenceOrder,
    evidenceRefs: payload.evidenceRefs,
    evidenceRecords: payload.evidenceRecords,
    budgetReconciliation: payload.budgetReconciliation,
    subtreeActual: payload.subtreeActual,
    assumptions: payload.assumptions,
    unresolvedItems: payload.unresolvedItems,
    uncertainOutcomes: payload.uncertainOutcomes,
    beforeFingerprint: payload.beforeFingerprint,
    afterFingerprint: payload.afterFingerprint,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    completionBlocked: payload.completionBlocked
  };
}

function validateRetainedReport(report: ReportEvidenceRecord, reasons: Reasons): void {
  if (!verifyContractEnvelope(report.envelope).ok) reasons.add('envelope-digest-mismatch');
  if (!canonicalEqual(report, projectReportEvidence(report.envelope))) {
    reasons.add('evidence-projection-mismatch');
  }
  for (const receipt of report.envelope.payload.actionReceipts) validateRetainedReceipt(receipt, reasons);
}

export function computeUsageSampleDigest(value: unknown): `sha256:${string}` {
  const sample = evidenceUsageSampleSchema.parse(snapshotEvidenceData(value));
  return computeAuthorityUsageSampleDigest(sample);
}

function validateReceiptUsage(
  payload: EvidenceActionReceiptPayload,
  context: ParsedReceiptContext,
  reasons: Reasons
): void {
  const authority = authorityBinding(context);
  if (payload.usageReservationId !== context.usage.reservationId) reasons.add('usage-reservation-mismatch');
  // Manager exposes ledger reservationId for ticket usage; providerReservationId stays adapter-private.
  if (context.usage.reservationId !== authority.budgetReservationId) {
    reasons.add('trusted-context-invalid');
    reasons.add('usage-reservation-mismatch');
  }
  if (payload.usageStatus !== context.usage.status ||
      payload.usageSampleDigest !== context.usage.sampleDigest ||
      !canonicalEqual(payload.usageAmounts, context.usage.amounts) ||
      payload.usageCurrency !== context.usage.currency ||
      !canonicalEqual(payload.usageDescendantCommitted, context.usage.descendantCommitted) ||
      !canonicalEqual(payload.usageActual, context.usage.actual)) reasons.add('usage-lifecycle-mismatch');
  if (context.usage.status === 'unresolved') reasons.add('unresolved-authority-reference');
  const expectedUsage = context.usage.final ?? undefined;
  if (!((payload.usageFinal === undefined && expectedUsage === undefined) ||
      (payload.usageFinal !== undefined && expectedUsage !== undefined &&
        canonicalEqual(payload.usageFinal, expectedUsage)))) reasons.add('usage-reconciliation-mismatch');
  if (context.usage.status === 'committed' && context.usage.final !== null) {
    let digest: string;
    try {
      digest = computeUsageSampleDigest(context.usage.final);
    } catch {
      reasons.add('trusted-context-invalid');
      return;
    }
    if (digest !== context.usage.sampleDigest || payload.usageSampleDigest !== digest) {
      reasons.add('usage-reconciliation-mismatch');
    }
    try {
      const actual = deriveAuthorityUsageActual({
        amounts: context.usage.amounts,
        currency: context.usage.currency,
        sample: context.usage.final,
        descendantCommitted: context.usage.descendantCommitted
      });
      if (!canonicalEqual(actual, context.usage.actual)) reasons.add('trusted-context-invalid');
    } catch {
      reasons.add('trusted-context-invalid');
    }
    const sampleTime = Date.parse(context.usage.final.timestamp);
    if (sampleTime < Date.parse(payload.endedAt) || sampleTime > Date.parse(context.receivedAt) ||
        sampleTime > Date.parse(context.usage.deadlineAt)) reasons.add('timestamp-window-invalid');
  }
}

/** Pure receipt validation. It neither resolves authority nor persists/settles anything. */
export function validateActionReceipt(
  claim: unknown,
  expected: ActionReceiptValidationContext
): ActionReceiptValidationResult {
  const reasons = new Reasons();
  const envelope = parseEnvelope(claim, 'action-receipt/v1', reasons);
  const context = parseContext(actionReceiptValidationContextSchema, expected, reasons);
  if (!envelope || !context) return reasons.result()!;
  const payloadResult = evidenceActionReceiptPayloadSchema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    reasons.add('malformed-payload');
    return reasons.result()!;
  }
  const payload = payloadResult.data;
  const authority = authorityBinding(context);
  commonValidation(payload, context, reasons);
  if (envelope.id !== context.receiptId) reasons.add('ticket-binding-mismatch');
  if (!sameStrings(payload.handleLineage, authority.handleLineage)) reasons.add('lineage-mismatch');
  if (payload.actionId !== context.actionId || payload.idempotencyId !== context.idempotencyId) {
    reasons.add('action-binding-mismatch');
  }
  const childTicketRef = context.action.operation === 'agent.spawn' &&
    typeof context.metadata.result.childTicketRef === 'string'
    ? context.metadata.result.childTicketRef
    : null;
  if (payload.operation !== context.action.operation || payload.childTicketRef !== childTicketRef) {
    reasons.add('action-binding-mismatch');
  }
  if (context.action.operation === 'agent.spawn' &&
      (context.resultClass === 'success') !== (childTicketRef !== null)) {
    reasons.add('action-binding-mismatch');
  }
  try {
    if (payload.normalizedOperationDigest !== computeNormalizedOperationDigest(context.action)) {
      reasons.add('operation-digest-mismatch');
    }
  } catch {
    reasons.add('trusted-context-invalid');
  }

  const inputMetadata = validateMetadata(context.action.operation, 'input', payload.inputMetadata);
  const resultMetadata = validateMetadata(context.action.operation, 'result', payload.resultMetadata);
  for (const result of [inputMetadata, resultMetadata]) if (!result.ok) reasons.add(result.reason);
  const expectedInput = validateMetadata(context.action.operation, 'input', context.metadata.input);
  const expectedResult = validateMetadata(context.action.operation, 'result', context.metadata.result);
  if (!expectedInput.ok || !expectedResult.ok) reasons.add('trusted-context-invalid');
  if (!operationMetadataMatches(context.action as StructuredAction, context.metadata.input)) {
    reasons.add('trusted-context-invalid');
    reasons.add('operation-metadata-mismatch');
  }
  if (inputMetadata.ok && resultMetadata.ok && expectedInput.ok && expectedResult.ok &&
      (!metadataMatches(payload.inputMetadata, context.metadata.input) ||
        !metadataMatches(payload.resultMetadata, context.metadata.result))) reasons.add('metadata-mismatch');
  if (context.action.operation === 'agent.spawn' && context.resultClass === 'success' &&
      typeof context.metadata.result.childTicketRef !== 'string') reasons.add('operation-metadata-mismatch');

  const transition = workspaceTransition(
    context.workspace.before,
    context.workspace.after,
    context.workspace.mutations,
    reasons,
    'mutation-corroboration-mismatch'
  );
  if (transition && (payload.beforeFingerprint !== transition.before.digest ||
      payload.afterFingerprint !== transition.after.digest)) reasons.add('fingerprint-mismatch');
  if (transition && (!sameStrings(payload.workspaceScope, transition.before.scope) ||
      !canonicalEqual(payload.workspaceBefore, workspaceSnapshot(transition.before)) ||
      !canonicalEqual(payload.workspaceAfter, workspaceSnapshot(transition.after)))) {
    reasons.add('mutation-corroboration-mismatch');
  }
  if (!sameStrings(payload.mutations, context.workspace.mutations)) reasons.add('mutation-corroboration-mismatch');
  if (!coveredMutations(payload.mutations, authority.writeSet)) reasons.add('mutation-outside-write-set');
  if (!coveredMutations(payload.mutations, context.action.writeSet)) reasons.add('mutation-corroboration-mismatch');
  if (context.action.writeSet.some(selector =>
    !authority.writeSet.some(parent => writeSelectorCovers(parent, selector)))) {
    reasons.add('trusted-context-invalid');
  }
  validateFilesystemMetadata(
    context.action as StructuredAction,
    context.metadata,
    transition,
    context.resultClass,
    context.artifactHashes,
    reasons
  );

  if (payload.intentTimestamp !== context.intentTimestamp || payload.startedAt !== context.startedAt ||
      payload.endedAt !== context.endedAt) reasons.add('timestamp-binding-mismatch');
  timestampsWithin([payload.intentTimestamp, payload.startedAt, payload.endedAt], context, reasons);
  if (Date.parse(payload.intentTimestamp) < Date.parse(context.usage.startedAt) ||
      Date.parse(payload.endedAt) > Date.parse(context.usage.deadlineAt)) {
    reasons.add('timestamp-window-invalid');
  }
  validateReceiptUsage(payload, context, reasons);
  if (context.usage.status === 'released' && (context.resultClass !== 'failure' ||
      context.workspace.mutations.length !== 0 || context.artifactHashes.length !== 0 ||
      !transition || transition.before.digest !== transition.after.digest)) {
    reasons.add('usage-lifecycle-mismatch');
  }
  if (payload.resultClass !== context.resultClass ||
      (payload.uncertaintyStatus ?? null) !== context.uncertaintyStatus ||
      (payload.resultClass === 'uncertain') !== (payload.uncertaintyStatus !== undefined)) {
    reasons.add('action-binding-mismatch');
  }
  if (!sameStrings(payload.artifactHashes, context.artifactHashes)) reasons.add('artifact-mismatch');
  const isReplay = replay(envelope, context.priorClaim, reasons);

  const invalid = reasons.result();
  if (invalid) return invalid;
  const typedEnvelope = { ...envelope, kind: 'action-receipt/v1' as const, payload };
  const evidence = projectReceiptEvidence(typedEnvelope);
  return freezeEvidenceData({
    ok: true as const,
    authority: false as const,
    classification: 'valid' as const,
    reasons: [] as const,
    envelope: typedEnvelope,
    evidence,
    replay: isReplay
  }) as ValidActionReceiptResult;
}

function preserves(actual: readonly string[], required: readonly string[]): boolean {
  const values = new Set(actual);
  return required.every(value => values.has(value));
}

function decimalParts(value: number): { coefficient: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) throw new Error('Invalid canonical decimal');
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  const coefficient = BigInt(`${match[1]}${fraction}`);
  const scale = fraction.length - exponent;
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

function decimalSumEquals(target: number, values: readonly number[]): boolean {
  const targetParts = decimalParts(target);
  const parts = values.map(decimalParts);
  const scale = Math.max(targetParts.scale, ...parts.map(value => value.scale));
  const expected = targetParts.coefficient * 10n ** BigInt(scale - targetParts.scale);
  const actual = parts.reduce((sum, value) =>
    sum + value.coefficient * 10n ** BigInt(scale - value.scale), 0n);
  return expected === actual;
}

function exactBudgetAggregate(
  target: Readonly<Record<string, number>>,
  contributors: readonly Readonly<Record<string, number>>[]
): boolean {
  const contributorKeys = sortedUnique(contributors.flatMap(value => Object.keys(value)));
  const targetKeys = Object.keys(target).sort();
  return sameStrings(targetKeys, contributorKeys) && targetKeys.every(key =>
    decimalSumEquals(target[key], contributors.map(value => value[key] ?? 0)));
}

function validateEvidenceGeneration(
  evidence: ReceiptEvidenceRecord | ReportEvidenceRecord,
  context: ParsedReportContext,
  reasons: Reasons
): void {
  if (evidence.runId !== context.runId) reasons.add('run-binding-mismatch');
  if (evidence.projectId !== context.projectId) reasons.add('project-binding-mismatch');
  if (evidence.approvedPlanDigest !== context.approvedPlanDigest) reasons.add('plan-binding-mismatch');
  if (evidence.approvedGraphDigest !== context.approvedGraphDigest || evidence.graphId !== context.graphId) {
    reasons.add('graph-binding-mismatch');
  }
  if (evidence.graphRevision !== context.graphRevision) reasons.add('graph-revision-mismatch');
  directionalGeneration(evidence.graphEpoch, context.graphEpoch, 'graph-epoch-drift', reasons);
  directionalGeneration(
    evidence.cancellationGeneration,
    context.cancellationGeneration,
    'cancellation-late',
    reasons
  );
}

function validateDirectReceiptBinding(
  receipt: ReceiptEvidenceRecord,
  context: ParsedReportContext,
  reasons: Reasons
): void {
  const authority = authorityBinding(context);
  validateEvidenceGeneration(receipt, context, reasons);
  if (receipt.authorityKind !== authority.kind || receipt.ticketRef !== authority.ref ||
      receipt.parentTicketRef !== authority.parentTicketRef ||
      receipt.ticketBudgetReservationId !== authority.budgetReservationId) {
    reasons.add('ticket-binding-mismatch');
  }
  if (receipt.ticketGeneration !== null && authority.generation !== null) {
    directionalGeneration(receipt.ticketGeneration, authority.generation, 'ticket-generation-drift', reasons);
  } else if (receipt.ticketGeneration !== authority.generation) reasons.add('ticket-binding-mismatch');
  if (receipt.nodeId !== authority.nodeId || receipt.parentNodeId !== authority.parentNodeId) {
    reasons.add('node-binding-mismatch');
  }
  if (receipt.issuerRole !== authority.issuerRole || receipt.recipientRole !== authority.recipientRole ||
      !sameStrings(receipt.handleLineage, authority.handleLineage)) reasons.add('lineage-mismatch');
  if (receipt.reportDestination !== authority.reportDestination ||
      receipt.reportSchemaRef !== authority.reportSchemaRef) reasons.add('report-binding-mismatch');
  if (receipt.leaseKind !== context.lease.kind || receipt.leaseRef !== context.lease.ref) {
    reasons.add('lease-binding-mismatch');
  }
  directionalGeneration(receipt.leaseGeneration, context.lease.generation, 'lease-generation-drift', reasons);
  directionalGeneration(receipt.leaseFence, context.lease.fence, 'lease-generation-drift', reasons);
  if (receipt.usageReservationId !== receipt.ticketBudgetReservationId) {
    reasons.add('usage-reservation-mismatch');
  }
  if (receipt.usageStatus === 'unresolved') reasons.add('unresolved-authority-reference');
}

function receiptRecordTransition(receipt: ReceiptEvidenceRecord, reasons: Reasons): WorkspaceTransition | null {
  const transition = workspaceTransition(
    receipt.workspaceBefore,
    receipt.workspaceAfter,
    receipt.mutations,
    reasons,
    'receipt-continuity-mismatch'
  );
  if (transition && (!sameStrings(receipt.workspaceScope, transition.before.scope) ||
      receipt.beforeFingerprint !== transition.before.digest || receipt.afterFingerprint !== transition.after.digest)) {
    reasons.add('receipt-continuity-mismatch');
  }
  return transition;
}

function deduplicatedUsageActuals(
  receipts: readonly ReceiptEvidenceRecord[],
  reasons: Reasons
): Readonly<Record<string, number>>[] {
  const reservationTickets = new Map<string, string>();
  const ticketReservations = new Map<string, string>();
  const byTicketReservation = new Map<string, ReceiptEvidenceRecord>();
  for (const receipt of receipts) {
    if (receipt.usageStatus === 'unresolved') reasons.add('unresolved-authority-reference');
    const ticket = receipt.ticketRef ?? `controller-root:${receipt.nodeId}`;
    const receiptReservation = receipt.usageReservationId;
    const reservationTicket = reservationTickets.get(receiptReservation);
    const ticketReservation = ticketReservations.get(ticket);
    if ((reservationTicket !== undefined && reservationTicket !== ticket) ||
        (ticketReservation !== undefined && ticketReservation !== receiptReservation) ||
        receiptReservation !== receipt.ticketBudgetReservationId) {
      reasons.add('usage-reservation-mismatch');
    }
    reservationTickets.set(receiptReservation, ticket);
    ticketReservations.set(ticket, receiptReservation);
    const key = `${ticket}\0${receiptReservation}`;
    const prior = byTicketReservation.get(key);
    if (!prior) {
      byTicketReservation.set(key, receipt);
      continue;
    }
    const fields = [
      'usageStatus', 'usageSampleDigest', 'usageAmounts', 'usageCurrency',
      'usageDescendantCommitted', 'usageActual', 'usageFinal'
    ] as const;
    if (fields.some(field => !canonicalEqual(receipt[field], prior[field]))) {
      reasons.add('usage-reconciliation-mismatch');
    }
  }
  return [...byTicketReservation.values()].map(receipt => receipt.usageActual);
}

function validateTicketReservationBijection(
  receipts: readonly ReceiptEvidenceRecord[],
  reports: readonly ReportEvidenceRecord[],
  bindings: readonly ChildReportBinding[],
  reasons: Reasons
): void {
  const reservationTickets = new Map<string, string>();
  const ticketReservations = new Map<string, string>();
  const bind = (ticket: string, reservation: string): void => {
    if ((reservationTickets.has(reservation) && reservationTickets.get(reservation) !== ticket) ||
        (ticketReservations.has(ticket) && ticketReservations.get(ticket) !== reservation)) {
      reasons.add('usage-reservation-mismatch');
    }
    reservationTickets.set(reservation, ticket);
    ticketReservations.set(ticket, reservation);
  };
  for (const receipt of receipts) {
    const ticket = receipt.ticketRef ?? `controller-root:${receipt.nodeId}`;
    bind(ticket, receipt.ticketBudgetReservationId);
    bind(ticket, receipt.usageReservationId);
  }
  for (const report of reports) {
    const ticket = report.ticketRef ?? `controller-root:${report.nodeId}`;
    bind(ticket, report.ticketBudgetReservationId);
    bind(ticket, report.budgetReconciliation.reservationId);
  }
  for (const binding of bindings) {
    bind(binding.ticketRef, binding.budgetReservationId);
    bind(binding.ticketRef, binding.budgetReconciliation.reservationId);
  }
}

function validateBindingReservationSnapshots(
  bindings: readonly ChildReportBinding[],
  receipts: readonly ReceiptEvidenceRecord[],
  reasons: Reasons
): void {
  for (const binding of bindings) {
    const directReceipts = receipts.filter(receipt => receipt.ticketRef === binding.ticketRef);
    validateReservationSnapshot(binding.budgetReconciliation, directReceipts, reasons);
    const subtreeTickets = new Set(bindings.filter(candidate =>
      candidate.handleLineage.length >= binding.handleLineage.length &&
      binding.handleLineage.every((ticket, index) => candidate.handleLineage[index] === ticket))
      .map(candidate => candidate.ticketRef));
    const subtreeUsage = deduplicatedUsageActuals(
      receipts.filter(receipt => receipt.ticketRef !== null && subtreeTickets.has(receipt.ticketRef)),
      reasons
    );
    if (!exactBudgetAggregate(binding.subtreeActual, subtreeUsage)) {
      reasons.add('budget-contributor-mismatch');
    }
  }
}

function validateReservationSnapshot(
  reconciliation: ParsedReportContext['budgetReconciliation'],
  receipts: readonly ReceiptEvidenceRecord[],
  reasons: Reasons
): void {
  for (const receipt of receipts) {
    if (receipt.usageReservationId !== reconciliation.reservationId) {
      reasons.add('usage-reservation-mismatch');
      continue;
    }
    if ((receipt.usageStatus !== 'unresolved' && receipt.usageStatus !== reconciliation.status) ||
        !canonicalEqual(receipt.usageAmounts, reconciliation.amounts) ||
        receipt.usageSampleDigest !== reconciliation.sampleDigest ||
        !canonicalEqual(receipt.usageActual, reconciliation.actual)) {
      reasons.add('usage-reconciliation-mismatch');
    }
  }
}

function evidenceClosureIsExact(
  records: readonly { ref: string; digest: string; nodeId: string; kind: string }[],
  refs: readonly string[],
  criteria: readonly { nodeId: string; evidenceRef?: string }[],
  receipts: readonly ReceiptEvidenceRecord[]
): boolean {
  const byRef = new Map(records.map(record => [record.ref, record]));
  if (byRef.size !== records.length || !sameStrings(sortedUnique(records.map(record => record.ref)), refs)) return false;
  if (records.some(record => record.kind !== 'receipt' && receipts.some(receipt => receipt.ref === record.ref))) {
    return false;
  }
  if (receipts.some(receipt => receipt.artifactHashes.some(digest => !records.some(record =>
    record.kind === 'artifact' && record.digest === digest && record.nodeId === receipt.nodeId)))) return false;
  return records.every(record => {
    const owners = new Set(criteria.filter(result => result.evidenceRef === record.ref)
      .map(result => result.nodeId));
    if (record.kind === 'artifact') {
      for (const receipt of receipts) {
        if (receipt.artifactHashes.includes(record.digest)) owners.add(receipt.nodeId);
      }
      if (!receipts.some(receipt => receipt.artifactHashes.includes(record.digest))) return false;
    }
    if (record.kind === 'receipt') {
      const producers = receipts.filter(receipt => receipt.ref === record.ref &&
        receipt.envelopeDigest === record.digest && receipt.nodeId === record.nodeId);
      if (producers.length !== 1) return false;
      owners.add(producers[0].nodeId);
    }
    return owners.size === 1 && owners.has(record.nodeId);
  });
}

type Child = ParsedReportContext['children'][number];

function reportMatchesChildBinding(report: ReportEvidenceRecord, child: ChildReportBinding): boolean {
  return report.authorityKind === 'delegation-ticket' && report.leaseKind === child.leaseKind &&
    report.ref === child.reportRef && report.envelopeDigest === child.reportEnvelopeDigest &&
    report.ticketRef === child.ticketRef && report.parentTicketRef === child.parentTicketRef &&
    report.ticketBudgetReservationId === child.budgetReservationId &&
    report.nodeId === child.nodeId && report.parentNodeId === child.parentNodeId &&
    report.issuerRole === child.issuerRole && report.recipientRole === child.role &&
    sameStrings(report.handleLineage, child.handleLineage) &&
    report.reportDestination === child.reportDestination && report.reportSchemaRef === child.reportSchemaRef &&
    report.graphRevision === child.graphRevision && report.graphEpoch === child.graphEpoch &&
    report.cancellationGeneration === child.cancellationGeneration && report.leaseRef === child.leaseRef &&
    canonicalEqual(report.budgetReconciliation, child.budgetReconciliation) &&
    canonicalEqual(report.subtreeActual, child.subtreeActual);
}

function receiptMatchesChildBinding(receipt: ReceiptEvidenceRecord, child: ChildReportBinding): boolean {
  return receipt.authorityKind === 'delegation-ticket' && receipt.leaseKind === child.leaseKind &&
    receipt.ticketRef === child.ticketRef && receipt.parentTicketRef === child.parentTicketRef &&
    receipt.ticketBudgetReservationId === child.budgetReservationId &&
    receipt.usageReservationId === child.budgetReservationId && receipt.ticketGeneration === child.generation &&
    receipt.nodeId === child.nodeId && receipt.parentNodeId === child.parentNodeId &&
    receipt.issuerRole === child.issuerRole && receipt.recipientRole === child.role &&
    sameStrings(receipt.handleLineage, child.handleLineage) &&
    receipt.reportDestination === child.reportDestination && receipt.reportSchemaRef === child.reportSchemaRef &&
    receipt.graphRevision === child.graphRevision && receipt.graphEpoch === child.graphEpoch &&
    receipt.cancellationGeneration === child.cancellationGeneration && receipt.leaseRef === child.leaseRef &&
    receipt.leaseGeneration === child.leaseGeneration && receipt.leaseFence === child.leaseFence;
}

function validateChildBindingTopology(
  bindings: readonly ChildReportBinding[],
  context: ParsedReportContext,
  reasons: Reasons,
  enclosing?: ChildReportBinding
): void {
  const authority = authorityBinding(context);
  const byTicket = new Map(bindings.map(binding => [binding.ticketRef, binding]));
  const identities = [
    bindings.map(binding => binding.ticketRef),
    bindings.map(binding => binding.nodeId),
    bindings.map(binding => binding.reportRef),
    bindings.map(binding => binding.reportEnvelopeDigest),
    bindings.map(binding => binding.budgetReservationId)
  ];
  if (byTicket.size !== bindings.length || identities.some(values => new Set(values).size !== values.length)) {
    reasons.add('child-report-duplicate');
    reasons.add('child-lineage-illegal');
  }
  for (const child of bindings) {
    directionalGeneration(child.graphEpoch, context.graphEpoch, 'graph-epoch-drift', reasons);
    directionalGeneration(child.cancellationGeneration, context.cancellationGeneration, 'cancellation-late', reasons);
    if (child.graphRevision !== context.graphRevision || child.reportDestination !== `controller:${child.nodeId}` ||
        child.reportSchemaRef !== 'execution-report/v1' || child.leaseKind !== 'workstream' ||
        child.budgetReconciliation.reservationId !== child.budgetReservationId ||
        (child.role === 'EXECUTION' && (child.issuerRole !== 'PLAN_ROOT' || child.parentTicketRef !== null ||
          !sameStrings(child.handleLineage, [child.ticketRef]) || child.leaseNodeId !== child.nodeId ||
          child.leaseTicketRef !== child.ticketRef)) ||
        (child.role === 'LEAF' && (child.issuerRole !== 'EXECUTION' || child.parentTicketRef === null ||
          !sameStrings(child.handleLineage, [child.parentTicketRef, child.ticketRef]) ||
          child.leaseNodeId !== child.parentNodeId || child.leaseTicketRef !== child.parentTicketRef)) ||
        (child.role !== 'EXECUTION' && child.role !== 'LEAF')) {
      reasons.add('child-lineage-illegal');
    }
    if (child.status === 'revoked') reasons.add('ticket-revoked');
    if (child.status === 'expired' || Date.parse(context.receivedAt) >= Date.parse(child.expiresAt)) {
      reasons.add('ticket-expired');
    }
    if (child.status === 'unresolved' || child.leaseStatus === 'unresolved') {
      reasons.add('unresolved-authority-reference');
    }
    if (child.leaseStatus === 'released') reasons.add('lease-released');
    if (child.leaseStatus === 'invalidated') reasons.add('lease-invalidated');
    if (child.leaseStatus === 'expired' || Date.parse(context.receivedAt) >= Date.parse(child.leaseExpiresAt)) {
      reasons.add('lease-expired');
    }
    const parent = enclosing && child.parentTicketRef === enclosing.ticketRef ? enclosing
      : child.parentTicketRef === authority.ref && authority.kind === 'delegation-ticket'
      ? {
        generation: authority.generation!,
        expiresAt: context.authority.kind === 'delegation-ticket' ? context.authority.expiresAt : child.expiresAt,
        nodeId: authority.nodeId,
        leaseRef: context.lease.ref,
        leaseGeneration: context.lease.generation,
        leaseFence: context.lease.fence,
        leaseAcquiredAt: context.lease.acquiredAt,
        leaseExpiresAt: context.lease.expiresAt
      }
      : child.parentTicketRef === null ? null : byTicket.get(child.parentTicketRef);
    if (child.role === 'LEAF' && (!parent || child.generation <= parent.generation ||
        child.parentNodeId !== parent.nodeId || Date.parse(child.expiresAt) > Date.parse(parent.expiresAt) ||
        child.leaseRef !== parent.leaseRef || child.leaseGeneration !== parent.leaseGeneration ||
        child.leaseFence !== parent.leaseFence || child.leaseAcquiredAt !== parent.leaseAcquiredAt ||
        child.leaseExpiresAt !== parent.leaseExpiresAt)) {
      reasons.add('child-lineage-illegal');
    }
  }
  const siblingGenerations = new Map<string, Set<number>>();
  for (const child of bindings) {
    const parent = child.parentTicketRef ?? '<controller-root>';
    const generations = siblingGenerations.get(parent) ?? new Set<number>();
    if (generations.has(child.generation)) reasons.add('child-lineage-illegal');
    generations.add(child.generation);
    siblingGenerations.set(parent, generations);
  }
}

function validateChildReportBinding(
  report: ReportEvidenceRecord,
  child: Child,
  context: ParsedReportContext,
  reasons: Reasons
): boolean {
  validateEvidenceGeneration(report, context, reasons);
  if (!reportMatchesChildBinding(report, child)) reasons.add('child-report-unrelated');
  if (report.ticketGeneration === null) reasons.add('child-report-unrelated');
  else directionalGeneration(report.ticketGeneration, child.generation, 'ticket-generation-drift', reasons);
  if (report.nodeId !== child.nodeId || report.parentNodeId !== child.parentNodeId ||
      report.recipientRole !== child.role ||
      report.issuerRole !== (child.role === 'EXECUTION' ? 'PLAN_ROOT' : 'EXECUTION') ||
      !sameStrings(report.handleLineage, child.handleLineage)) reasons.add('child-report-unrelated');
  if (report.reportDestination !== child.reportDestination ||
      report.reportSchemaRef !== child.reportSchemaRef) reasons.add('child-report-unrelated');
  if (report.leaseRef !== child.leaseRef || child.leaseNodeId !==
      (child.role === 'LEAF' ? child.parentNodeId : child.nodeId) ||
      child.leaseTicketRef !== (child.role === 'LEAF' ? child.parentTicketRef : child.ticketRef)) {
    reasons.add('child-report-unrelated');
  }
  directionalGeneration(report.leaseGeneration, child.leaseGeneration, 'lease-generation-drift', reasons);
  directionalGeneration(report.leaseFence, child.leaseFence, 'lease-generation-drift', reasons);
  const reportActions = sortedUnique(report.actionReceipts.map(receipt => receipt.actionId));
  const identityFields = [
    report.actionReceipts.map(receipt => receipt.ref),
    report.actionReceipts.map(receipt => receipt.envelopeDigest),
    report.actionReceipts.map(receipt => receipt.actionId),
    report.actionReceipts.map(receipt => receipt.idempotencyId)
  ];
  if (!sameStrings(report.actions, reportActions) ||
      identityFields.some(values => new Set(values).size !== values.length)) {
    reasons.add('idempotency-conflict');
  }
  const reportMutations = sortedUnique(report.actionReceipts.flatMap(receipt => receipt.mutations));
  const directReceipts = report.actionReceipts.filter(receipt => receipt.ticketRef === report.ticketRef);
  const nestedReceipts = report.actionReceipts.filter(receipt => receipt.ticketRef !== report.ticketRef);
  for (const receipt of report.actionReceipts) validateEvidenceGeneration(receipt, context, reasons);
  validateChildBindingTopology(report.childBindings, context, reasons, child);
  validateTicketReservationBijection(
    report.actionReceipts,
    [report],
    report.childBindings,
    reasons
  );
  validateBindingReservationSnapshots(report.childBindings, report.actionReceipts, reasons);
  const directReceiptInvalid = directReceipts.some(receipt =>
    receipt.authorityKind !== report.authorityKind || receipt.leaseKind !== report.leaseKind ||
    receipt.parentTicketRef !== report.parentTicketRef ||
    receipt.ticketBudgetReservationId !== report.ticketBudgetReservationId ||
    receipt.usageReservationId !== report.ticketBudgetReservationId ||
    receipt.ticketGeneration !== report.ticketGeneration || receipt.nodeId !== report.nodeId ||
    receipt.parentNodeId !== report.parentNodeId || receipt.issuerRole !== report.issuerRole ||
    receipt.recipientRole !== report.recipientRole ||
    !sameStrings(receipt.handleLineage, report.handleLineage) ||
    receipt.reportDestination !== report.reportDestination ||
    receipt.reportSchemaRef !== report.reportSchemaRef || receipt.leaseRef !== report.leaseRef ||
    receipt.leaseGeneration !== report.leaseGeneration || receipt.leaseFence !== report.leaseFence);
  const bindingsByTicket = new Map(report.childBindings.map(binding => [binding.ticketRef, binding]));
  const nestedReceiptInvalid = nestedReceipts.some(receipt => {
    const binding = receipt.ticketRef === null ? undefined : bindingsByTicket.get(receipt.ticketRef);
    return report.recipientRole !== 'EXECUTION' || !binding || !receiptMatchesChildBinding(receipt, binding) ||
      Date.parse(receipt.intentTimestamp) < Date.parse(binding.leaseAcquiredAt) ||
      Date.parse(receipt.endedAt) >= Math.min(Date.parse(binding.expiresAt), Date.parse(binding.leaseExpiresAt));
  });
  const nestedTicketRefs = sortedUnique(nestedReceipts.flatMap(receipt =>
    receipt.ticketRef === null ? [] : [receipt.ticketRef]));
  const nestedSpawns = directReceipts.filter(receipt => receipt.operation === 'agent.spawn' &&
    receipt.resultClass === 'success' && receipt.childTicketRef !== null);
  const directBindings = report.childBindings.filter(binding => binding.parentTicketRef === report.ticketRef);
  const nestedSpawnInvalid = nestedTicketRefs.some(ticketRef => nestedSpawns.filter(receipt =>
    receipt.childTicketRef === ticketRef).length !== 1) || nestedSpawns.some(receipt =>
    !nestedTicketRefs.includes(receipt.childTicketRef!) || !directBindings.some(binding =>
      binding.ticketRef === receipt.childTicketRef && receipt.inputMetadata.agentRef === binding.nodeId)) ||
    !sameStrings(report.childLineage, nestedTicketRefs) ||
    report.childLineage.length !== report.childReportRefs.length ||
    report.childLineage.some(ref => !report.descendantTicketRefs.includes(ref)) ||
    report.childReportRefs.some(ref => !report.descendantReportRefs.includes(ref));
  const childBindingsInvalid = !sameStrings(
    directBindings.map(binding => binding.ticketRef).sort(),
    report.childLineage
  ) || !sameStrings(
    directBindings.map(binding => binding.reportRef).sort(),
    report.childReportRefs
  ) || !sameStrings(
    report.childBindings.map(binding => binding.ticketRef).sort(),
    report.descendantTicketRefs
  ) || !sameStrings(
    report.childBindings.map(binding => binding.reportRef).sort(),
    report.descendantReportRefs
  ) || report.childBindings.some(binding => !sameStrings(
    report.criterionResults.filter(result => result.nodeId === binding.nodeId)
      .map(result => result.criterionId),
    binding.criteria
  ));
  if (!sameStrings(report.mutations, reportMutations) || directReceiptInvalid || nestedReceiptInvalid ||
      report.budgetReconciliation.reservationId !== report.ticketBudgetReservationId ||
      !canonicalEqual(report.budgetReconciliation, child.budgetReconciliation) ||
      !canonicalEqual(report.subtreeActual, child.subtreeActual) || childBindingsInvalid) {
    reasons.add('child-report-unrelated');
  }
  if (nestedSpawnInvalid) reasons.add('child-spawn-mismatch');
  for (const receipt of report.actionReceipts) receiptRecordTransition(receipt, reasons);
  const reportTransition = workspaceTransition(
    report.workspaceBefore,
    report.workspaceAfter,
    report.mutations,
    reasons,
    'receipt-continuity-mismatch',
    false
  );
  if (reportTransition && (!sameStrings(report.workspaceScope, reportTransition.before.scope) ||
      report.beforeFingerprint !== reportTransition.before.digest ||
      report.afterFingerprint !== reportTransition.after.digest)) reasons.add('receipt-continuity-mismatch');
  if (reportTransition) {
    validatePathCausality(report.actionReceipts, reportTransition, reasons);
  }
  validateReservationSnapshot(report.budgetReconciliation, directReceipts, reasons);
  const reportUsage = deduplicatedUsageActuals(report.actionReceipts, reasons);
  if (!exactBudgetAggregate(report.subtreeActual, reportUsage)) {
    reasons.add('budget-contributor-mismatch');
  }
  if ((child.role === 'LEAF' && (report.childLineage.length !== 0 || report.childReportRefs.length !== 0 ||
      report.descendantTicketRefs.length !== 0 || report.descendantReportRefs.length !== 0)) ||
      report.criterionResults.some(result =>
    (child.role === 'LEAF' && result.nodeId !== report.nodeId) ||
    (result.outcome === 'met' && result.evidenceRef === undefined) ||
    (result.evidenceRef !== undefined && !report.evidenceRefs.includes(result.evidenceRef)))) {
    reasons.add('child-report-unrelated');
  }
  const expectedOrderRefs = sortedUnique([
    ...directReceipts.map(receipt => receipt.ref),
    ...report.childReportRefs
  ]);
  if (!sameStrings([...report.evidenceOrder].sort(), expectedOrderRefs)) reasons.add('child-report-unrelated');
  const startedAt = Date.parse(report.startedAt);
  const endedAt = Date.parse(report.endedAt);
  if (startedAt < Date.parse(child.leaseAcquiredAt) || endedAt > Date.parse(context.receivedAt) ||
      endedAt >= Math.min(Date.parse(child.expiresAt), Date.parse(child.leaseExpiresAt))) {
    reasons.add('timestamp-window-invalid');
  }
  if (report.actionReceipts.some(receipt => Date.parse(receipt.startedAt) < Date.parse(child.leaseAcquiredAt) ||
      Date.parse(receipt.intentTimestamp) < Date.parse(child.leaseAcquiredAt) ||
      Date.parse(receipt.endedAt) > endedAt || Date.parse(receipt.startedAt) < startedAt ||
      Date.parse(receipt.endedAt) >= Math.min(Date.parse(child.expiresAt), Date.parse(child.leaseExpiresAt)) ||
      (receipt.usageFinal !== null && (Date.parse(receipt.usageFinal.timestamp) < Date.parse(receipt.endedAt) ||
        Date.parse(receipt.usageFinal.timestamp) > endedAt)))) {
    reasons.add('timestamp-window-invalid');
  }
  if (child.status === 'revoked') reasons.add('ticket-revoked');
  if (child.status === 'expired') reasons.add('ticket-expired');
  if (child.status === 'unresolved' || child.leaseStatus === 'unresolved') {
    reasons.add('unresolved-authority-reference');
  }
  if (child.leaseStatus === 'released') reasons.add('lease-released');
  if (child.leaseStatus === 'invalidated') reasons.add('lease-invalidated');
  if (child.leaseStatus === 'expired') reasons.add('lease-expired');
  const directCriteria = report.criterionResults
    .filter(result => result.nodeId === report.nodeId)
    .map(result => result.criterionId);
  if (!sameStrings(directCriteria, child.criteria)) reasons.add('criteria-mismatch');
  const evidenceClosureInvalid = !evidenceClosureIsExact(
    report.evidenceRecords,
    report.evidenceRefs,
    report.criterionResults,
    report.actionReceipts
  );
  if (evidenceClosureInvalid) reasons.add('evidence-reference-open');
  const completionBlocked = report.criterionResults.length === 0 || directCriteria.length === 0 ||
    report.criterionResults.some(result => result.outcome !== 'met') ||
    report.actionReceipts.some(receipt => receipt.resultClass !== 'success' || receipt.usageStatus !== 'committed') ||
    report.budgetReconciliation.status !== 'committed' || report.assumptions.length > 0 ||
    report.unresolvedItems.length > 0 || report.uncertainOutcomes.length > 0 ||
    evidenceClosureInvalid || nestedSpawnInvalid || !sameStrings(report.childLineage, nestedTicketRefs) ||
    !sameStrings(directCriteria, child.criteria);
  if (report.completionBlocked !== completionBlocked) reasons.add('evidence-projection-mismatch');
  return completionBlocked;
}

function sourceOrder<T extends { startedAt: string; endedAt: string; ref: string }>(sources: readonly T[]): T[] {
  return [...sources].sort((left, right) =>
    Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
    Date.parse(left.endedAt) - Date.parse(right.endedAt) ||
    (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
}

function validatePathCausality(
  receipts: readonly (ReceiptEvidenceRecord | ReportEvidenceRecord)[],
  parent: WorkspaceTransition,
  reasons: Reasons
): void {
  const parentBefore = new Map(parent.before.entries.map(entry => [entry.path, entry]));
  const parentAfter = new Map(parent.after.entries.map(entry => [entry.path, entry]));
  const allPaths = sortedUnique([
    ...parentBefore.keys(),
    ...parentAfter.keys(),
    ...receipts.flatMap(receipt => receipt.workspaceBefore.entries.map(entry => entry.path)),
    ...receipts.flatMap(receipt => receipt.workspaceAfter.entries.map(entry => entry.path))
  ]);
  for (const path of allPaths) {
    const observations = sourceOrder(receipts.filter(receipt =>
      receipt.workspaceBefore.entries.some(entry => entry.path === path) ||
      receipt.workspaceAfter.entries.some(entry => entry.path === path)));
    if (observations.length === 0) {
      if (!canonicalEqual(parentBefore.get(path) ?? null, parentAfter.get(path) ?? null)) {
        reasons.add('receipt-continuity-mismatch');
      }
      continue;
    }
    const beforeEntry = (receipt: ReceiptEvidenceRecord | ReportEvidenceRecord) =>
      receipt.workspaceBefore.entries.find(entry => entry.path === path);
    const afterEntry = (receipt: ReceiptEvidenceRecord | ReportEvidenceRecord) =>
      receipt.workspaceAfter.entries.find(entry => entry.path === path);
    if (observations.some(receipt => !beforeEntry(receipt) || !afterEntry(receipt)) ||
        !canonicalEqual(beforeEntry(observations[0]) ?? null, parentBefore.get(path) ?? null) ||
        !canonicalEqual(afterEntry(observations[observations.length - 1]) ?? null, parentAfter.get(path) ?? null)) {
      reasons.add('receipt-continuity-mismatch');
    }
    for (let index = 1; index < observations.length; index += 1) {
      const previous = observations[index - 1];
      const current = observations[index];
      const overlapsMutation = Date.parse(current.startedAt) < Date.parse(previous.endedAt) &&
        'operation' in previous && 'operation' in current &&
        (previous.mutations.includes(path) || current.mutations.includes(path));
      if (overlapsMutation ||
          !canonicalEqual(afterEntry(previous) ?? null, beforeEntry(current) ?? null)) {
        reasons.add('receipt-continuity-mismatch');
      }
    }
  }
}

/** Pure report validation. Requested disposition remains advisory and no state transition occurs. */
export function validateExecutionReport(
  claim: unknown,
  expected: ExecutionReportValidationContext
): ExecutionReportValidationResult {
  const reasons = new Reasons();
  const envelope = parseEnvelope(claim, 'execution-report/v1', reasons);
  const context = parseContext(executionReportValidationContextSchema, expected, reasons);
  if (!envelope || !context) return reasons.result()!;
  const payloadResult = evidenceExecutionReportPayloadSchema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    reasons.add('malformed-payload');
    return reasons.result()!;
  }
  const payload = payloadResult.data;
  const authority = authorityBinding(context);
  for (const receipt of context.receipts) validateRetainedReceipt(receipt, reasons);
  for (const report of context.childReports) validateRetainedReport(report, reasons);
  commonValidation(payload, context, reasons);
  if (envelope.id !== context.reportId) reasons.add('report-binding-mismatch');
  if (!sameStrings(payload.handleLineage, authority.handleLineage)) reasons.add('lineage-mismatch');
  timestampsWithin([payload.startedAt, payload.endedAt], context, reasons);

  for (const receipt of context.receipts) validateDirectReceiptBinding(receipt, context, reasons);
  const childRefs = context.children.map(child => child.ticketRef).sort();
  if (!sameStrings(payload.childLineage, childRefs)) reasons.add('lineage-mismatch');
  const expectedChildBindings = [
    ...context.children,
    ...context.childReports.flatMap(report => report.childBindings)
  ].sort((left, right) => left.ticketRef < right.ticketRef ? -1 : left.ticketRef > right.ticketRef ? 1 : 0);
  validateChildBindingTopology(expectedChildBindings, context, reasons);
  if (!canonicalEqual(payload.childBindings, expectedChildBindings)) {
    reasons.add('evidence-projection-mismatch');
  }
  const childIdentityGroups = [
    context.children.map(child => child.ticketRef),
    context.children.map(child => child.nodeId),
    context.children.map(child => child.budgetReservationId),
    context.children.map(child => child.reportRef),
    context.children.map(child => child.reportEnvelopeDigest)
  ];
  if (childIdentityGroups.some(values => new Set(values).size !== values.length) ||
      (authority.kind === 'controller-root' &&
        new Set(context.children.map(child => child.leaseRef)).size !== context.children.length) ||
      context.children.some(child => child.ticketRef === authority.ref ||
        child.nodeId === authority.nodeId || child.budgetReservationId === authority.budgetReservationId ||
        (authority.kind === 'controller-root' && child.leaseRef === context.lease.ref))) {
    reasons.add('trusted-context-invalid');
    reasons.add('child-lineage-illegal');
  }
  if ((authority.recipientRole === 'LEAF' &&
      (context.children.length !== 0 || context.childReports.length !== 0)) ||
      context.children.some(child => authority.kind === 'controller-root'
        ? child.parentTicketRef !== null || child.parentNodeId !== authority.nodeId ||
          child.role !== 'EXECUTION' || !sameStrings(child.handleLineage, [child.ticketRef]) ||
          child.leaseNodeId !== child.nodeId || child.leaseTicketRef !== child.ticketRef
        : child.parentTicketRef !== authority.ref || child.parentNodeId !== authority.nodeId ||
          child.role !== 'LEAF' || !sameStrings(child.handleLineage, [authority.ref!, child.ticketRef]) ||
          context.lease.kind !== 'workstream' || child.leaseRef !== context.lease.ref ||
          child.leaseGeneration !== context.lease.generation || child.leaseFence !== context.lease.fence ||
          child.leaseNodeId !== authority.nodeId || child.leaseTicketRef !== authority.ref)) {
    reasons.add('child-lineage-illegal');
  }
  if (context.authority.kind === 'delegation-ticket' && context.authority.recipientRole === 'EXECUTION') {
    const parentGeneration = context.authority.generation;
    const parentExpiresAt = context.authority.expiresAt;
    const childGenerations = context.children.map(child => child.generation);
    if (new Set(childGenerations).size !== childGenerations.length || context.children.some(child =>
      child.generation <= parentGeneration || Date.parse(child.expiresAt) > Date.parse(parentExpiresAt) ||
      child.leaseRef !== context.lease.ref || child.leaseGeneration !== context.lease.generation ||
      child.leaseFence !== context.lease.fence || child.leaseAcquiredAt !== context.lease.acquiredAt ||
      child.leaseExpiresAt !== context.lease.expiresAt)) {
      reasons.add('child-lineage-illegal');
    }
  }

  const successfulSpawns = context.receipts.filter(receipt => receipt.operation === 'agent.spawn' &&
    receipt.resultClass === 'success' && receipt.childTicketRef !== null);
  if (context.children.some(child => successfulSpawns.filter(receipt =>
      receipt.childTicketRef === child.ticketRef && receipt.inputMetadata.agentRef === child.nodeId).length !== 1) ||
      successfulSpawns.some(receipt => !context.children.some(child =>
        child.ticketRef === receipt.childTicketRef && receipt.inputMetadata.agentRef === child.nodeId))) {
    reasons.add('child-spawn-mismatch');
  }

  const reportsByTicket = new Map<string, ReportEvidenceRecord[]>();
  for (const report of context.childReports) {
    if (report.ticketRef === null) {
      reasons.add('child-report-unrelated');
      continue;
    }
    reportsByTicket.set(report.ticketRef, [...(reportsByTicket.get(report.ticketRef) ?? []), report]);
  }
  const childCompletionBlocked: boolean[] = [];
  for (const child of context.children) {
    const ticketReports = reportsByTicket.get(child.ticketRef) ?? [];
    const reports = ticketReports.filter(report => report.ref === child.reportRef &&
      report.envelopeDigest === child.reportEnvelopeDigest);
    if (reports.length === 0) reasons.add('child-report-missing');
    if (reports.length > 1 || ticketReports.length > 1) reasons.add('child-report-duplicate');
    if (child.status === 'revoked') reasons.add('ticket-revoked');
    if (child.status === 'expired' || Date.parse(context.receivedAt) >= Date.parse(child.expiresAt)) {
      reasons.add('ticket-expired');
    }
    if (child.status === 'unresolved' || child.leaseStatus === 'unresolved') {
      reasons.add('unresolved-authority-reference');
    }
    if (child.leaseStatus === 'released') reasons.add('lease-released');
    if (child.leaseStatus === 'invalidated') reasons.add('lease-invalidated');
    if (child.leaseStatus === 'expired' ||
        Date.parse(context.receivedAt) >= Date.parse(child.leaseExpiresAt)) reasons.add('lease-expired');
    for (const report of reports) {
      childCompletionBlocked.push(validateChildReportBinding(report, child, context, reasons));
    }
  }
  if (context.childReports.some(report => !context.children.some(child =>
    child.ticketRef === report.ticketRef && child.reportRef === report.ref &&
    child.reportEnvelopeDigest === report.envelopeDigest))) {
    reasons.add('child-report-unrelated');
  }
  const childReportRefs = context.childReports.map(report => report.ref).sort();
  if (new Set(childReportRefs).size !== childReportRefs.length) reasons.add('child-report-duplicate');
  if (!sameStrings(payload.childReportRefs, childReportRefs)) reasons.add('child-report-missing');

  const receiptRefs = context.receipts.map(receipt => receipt.ref).sort();
  const directActions = context.receipts.map(receipt => receipt.actionId);
  const childActions = context.childReports.flatMap(report => report.actions);
  const expectedActions = sortedUnique([...directActions, ...childActions]);
  if (!sameStrings(payload.receiptRefs, receiptRefs) || !sameStrings(payload.actions, expectedActions) ||
      new Set(receiptRefs).size !== receiptRefs.length || new Set(expectedActions).size !== expectedActions.length) {
    reasons.add('actions-receipts-mismatch');
  }

  const actionReceipts = [
    ...context.receipts,
    ...context.childReports.flatMap(report => report.actionReceipts)
  ];
  validateTicketReservationBijection(
    actionReceipts,
    context.childReports,
    expectedChildBindings,
    reasons
  );
  validateBindingReservationSnapshots(expectedChildBindings, actionReceipts, reasons);
  const orderedActionReceipts = sourceOrder(actionReceipts);
  if (!canonicalEqual(payload.actionReceipts, orderedActionReceipts)) {
    reasons.add('evidence-projection-mismatch');
  }
  const idempotencyIds = actionReceipts.map(receipt => receipt.idempotencyId);
  const actionIds = actionReceipts.map(receipt => receipt.actionId);
  const allReceiptRefs = actionReceipts.map(receipt => receipt.ref);
  const receiptDigests = actionReceipts.map(receipt => receipt.envelopeDigest);
  if (actionReceipts.length > EVIDENCE_VALIDATION_LIMITS.evidenceEntries) {
    reasons.add('actions-receipts-mismatch');
  }
  if (new Set(idempotencyIds).size !== idempotencyIds.length ||
      new Set(actionIds).size !== actionIds.length || new Set(allReceiptRefs).size !== allReceiptRefs.length ||
      new Set(receiptDigests).size !== receiptDigests.length) {
    reasons.add('idempotency-conflict');
  }
  for (const receipt of actionReceipts) receiptRecordTransition(receipt, reasons);

  const sourceRecords = new Map<string, {
    beforeFingerprint: string;
    afterFingerprint: string;
    startedAt: string;
    endedAt: string;
    workspaceScope: readonly string[];
    mutations: readonly string[];
  }>();
  for (const source of [...context.receipts, ...context.childReports]) {
    if (sourceRecords.has(source.ref)) reasons.add('receipt-continuity-mismatch');
    sourceRecords.set(source.ref, source);
  }
  const expectedOrder = sourceOrder([...context.receipts, ...context.childReports]).map(source => source.ref);
  if (!sameStrings(context.evidenceOrder, expectedOrder) ||
      !sameStrings(payload.evidenceOrder, context.evidenceOrder) ||
      !sameStrings([...context.evidenceOrder].sort(), [...sourceRecords.keys()].sort())) {
    reasons.add('receipt-continuity-mismatch');
  }
  const ordered = context.evidenceOrder.flatMap(ref => {
    const source = sourceRecords.get(ref);
    return source ? [source] : [];
  });
  if (ordered.some(source => Date.parse(source.startedAt) < Date.parse(payload.startedAt) ||
      Date.parse(source.endedAt) > Date.parse(payload.endedAt))) reasons.add('timestamp-window-invalid');

  const aggregateMutations = sortedUnique(actionReceipts.flatMap(receipt => receipt.mutations));
  if (!sameStrings(payload.mutations, aggregateMutations)) reasons.add('mutation-corroboration-mismatch');
  if (!coveredMutations(payload.mutations, authority.writeSet)) reasons.add('mutation-outside-write-set');
  const transition = workspaceTransition(
    context.workspace.before,
    context.workspace.after,
    aggregateMutations,
    reasons,
    'unexplained-workspace-drift',
    false
  );
  if (transition && (payload.beforeFingerprint !== transition.before.digest ||
      payload.afterFingerprint !== transition.after.digest)) reasons.add('fingerprint-mismatch');
  if (transition && (!sameStrings(payload.workspaceScope, transition.before.scope) ||
      !canonicalEqual(payload.workspaceBefore, workspaceSnapshot(transition.before)) ||
      !canonicalEqual(payload.workspaceAfter, workspaceSnapshot(transition.after)))) {
    reasons.add('mutation-corroboration-mismatch');
  }
  if (transition) {
    validatePathCausality(actionReceipts, transition, reasons);
    validatePathCausality([...context.receipts, ...context.childReports], transition, reasons);
  }
  if (ordered.length === 0 && (payload.beforeFingerprint !== payload.afterFingerprint ||
      payload.mutations.length !== 0 || payload.actions.length !== 0)) {
    reasons.add('unexplained-workspace-drift');
  }

  const criteria = payload.criterionResults.map(result => result.criterionId);
  if (authority.criteria.length === 0 || !sameStrings(criteria, authority.criteria)) {
    reasons.add('criteria-mismatch');
  }
  const criterionEvidence = sortedUnique(payload.criterionResults.flatMap(result =>
    result.evidenceRef === undefined ? [] : [result.evidenceRef]));
  if (payload.criterionResults.some(result => result.outcome === 'met' && !result.evidenceRef)) {
    reasons.add('met-criterion-without-evidence');
  }
  const evidenceByRef = new Map(context.evidence.map(record => [record.ref, record]));
  const orderedEvidenceRecords = [...context.evidence].sort((left, right) =>
    left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
  if (!canonicalEqual(payload.evidenceRecords, orderedEvidenceRecords)) {
    reasons.add('evidence-projection-mismatch');
  }
  const artifactEvidence = context.evidence.filter(record => record.kind === 'artifact' &&
    context.receipts.some(receipt => receipt.artifactHashes.includes(record.digest))).map(record => record.ref);
  const childEvidence = context.childReports.flatMap(report => report.evidenceRefs);
  const expectedEvidence = sortedUnique([...criterionEvidence, ...artifactEvidence, ...childEvidence]);
  const childEvidenceRecords = new Map<string, ParsedReportContext['evidence'][number]>();
  for (const report of context.childReports) {
    const reportEvidenceRefs = new Set(report.evidenceRecords.map(record => record.ref));
    if (report.evidenceRefs.some(ref => !reportEvidenceRefs.has(ref))) reasons.add('evidence-reference-open');
    for (const record of report.evidenceRecords) {
      const prior = childEvidenceRecords.get(record.ref);
      if (prior && !canonicalEqual(prior, record)) reasons.add('evidence-reference-open');
      else if (!prior) childEvidenceRecords.set(record.ref, record);
      const retained = evidenceByRef.get(record.ref);
      if (!retained || !canonicalEqual(retained, record)) reasons.add('evidence-reference-open');
    }
  }
  const closureCriterionResults = [
    ...payload.criterionResults.map(result => ({ ...result, nodeId: authority.nodeId })),
    ...context.childReports.flatMap(report => report.criterionResults)
  ].sort((left, right) => {
    const leftKey = `${left.nodeId}\0${left.criterionId}`;
    const rightKey = `${right.nodeId}\0${right.criterionId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (!sameStrings(payload.evidenceRefs, expectedEvidence) ||
      !evidenceClosureIsExact(context.evidence, payload.evidenceRefs, closureCriterionResults, actionReceipts)) {
    reasons.add('evidence-reference-open');
  }

  if (!canonicalEqual(payload.budgetReconciliation, context.budgetReconciliation) ||
      payload.budgetReconciliation.reservationId !== authority.budgetReservationId) {
    reasons.add('budget-reconciliation-mismatch');
  }
  validateReservationSnapshot(context.budgetReconciliation, context.receipts, reasons);
  const ownUsage = deduplicatedUsageActuals(context.receipts, reasons);
  const childBudgetByReservation = new Map<string, Readonly<Record<string, number>>>();
  for (const report of context.childReports) {
    const prior = childBudgetByReservation.get(report.budgetReconciliation.reservationId);
    if (prior && !canonicalEqual(prior, report.subtreeActual)) {
      reasons.add('usage-reconciliation-mismatch');
    } else if (!prior) {
      childBudgetByReservation.set(report.budgetReconciliation.reservationId, report.subtreeActual);
    }
  }
  const childUsage = [...childBudgetByReservation.values()];
  if (!exactBudgetAggregate(context.budgetContributors.own, ownUsage) ||
      !canonicalEqual(context.budgetContributors.own, context.budgetReconciliation.actual) ||
      !exactBudgetAggregate(context.budgetContributors.children, childUsage) ||
      !exactBudgetAggregate(context.subtreeActual, [
        context.budgetContributors.own,
        context.budgetContributors.children
      ])) reasons.add('budget-contributor-mismatch');
  if (!canonicalEqual(payload.subtreeActual, context.subtreeActual)) {
    reasons.add('budget-reconciliation-mismatch');
  }

  const requiredAssumptions = sortedUnique([
    ...context.requiredDisclosures.assumptions,
    ...context.childReports.flatMap(report => report.assumptions)
  ]);
  const requiredUnresolved = sortedUnique([
    ...context.requiredDisclosures.unresolvedItems,
    ...context.childReports.flatMap(report => report.unresolvedItems)
  ]);
  const requiredUncertain = sortedUnique([
    ...context.requiredDisclosures.uncertainOutcomes,
    ...context.childReports.flatMap(report => report.uncertainOutcomes)
  ]);
  if (!preserves(payload.assumptions, requiredAssumptions) ||
      !preserves(payload.unresolvedItems, requiredUnresolved) ||
      !preserves(payload.uncertainOutcomes, requiredUncertain)) reasons.add('disclosure-omitted');
  const closureChildLineage = sortedUnique([
    ...context.children.map(child => child.ticketRef),
    ...context.childReports.flatMap(report => report.descendantTicketRefs)
  ]);
  const closureChildReportRefs = sortedUnique([
    ...context.childReports.map(report => report.ref),
    ...context.childReports.flatMap(report => report.descendantReportRefs)
  ]);
  if (closureChildLineage.length > EVIDENCE_VALIDATION_LIMITS.evidenceEntries ||
      closureChildReportRefs.length > EVIDENCE_VALIDATION_LIMITS.evidenceEntries ||
      closureCriterionResults.length > EVIDENCE_VALIDATION_LIMITS.evidenceEntries ||
      closureCriterionResults.some((result, index) => index > 0 &&
        result.nodeId === closureCriterionResults[index - 1].nodeId &&
        result.criterionId === closureCriterionResults[index - 1].criterionId)) {
    reasons.add('child-report-unrelated');
  }
  if (!canonicalEqual(payload.closureChildLineage, closureChildLineage) ||
      !canonicalEqual(payload.closureChildReportRefs, closureChildReportRefs) ||
      !canonicalEqual(payload.closureCriterionResults, closureCriterionResults)) {
    reasons.add('evidence-projection-mismatch');
  }
  const completionBlocked = payload.criterionResults.length === 0 ||
    payload.criterionResults.some(result => result.outcome !== 'met' || result.evidenceRef === undefined ||
      !evidenceByRef.has(result.evidenceRef)) ||
    context.receipts.some(receipt => receipt.resultClass !== 'success' || receipt.usageStatus !== 'committed') ||
    childCompletionBlocked.some(Boolean) || context.children.length !== context.childReports.length ||
    payload.assumptions.length > 0 || payload.unresolvedItems.length > 0 ||
    payload.uncertainOutcomes.length > 0 || payload.budgetReconciliation.status !== 'committed';
  if (payload.completionBlocked !== completionBlocked) reasons.add('evidence-projection-mismatch');
  const isReplay = replay(envelope, context.priorClaim, reasons);

  const invalid = reasons.result();
  if (invalid) return invalid;
  const typedEnvelope = { ...envelope, kind: 'execution-report/v1' as const, payload };
  const reportEvidence = projectReportEvidence(typedEnvelope);
  return freezeEvidenceData({
    ok: true as const,
    authority: false as const,
    classification: 'valid' as const,
    reasons: [] as const,
    envelope: typedEnvelope,
    evidence: reportEvidence,
    completionBlocked,
    requestedDisposition: payload.requestedDisposition,
    replay: isReplay
  }) as ValidExecutionReportResult;
}
