import {
  ActionReceiptValidationContext,
  computeNormalizedOperationDigest,
  computeUsageSampleDigest,
  computeWorkspaceFingerprint,
  DEFAULT_EXECUTION_PLAN_BUDGETS,
  deriveOperationMetadataBindings,
  EVIDENCE_DATA_LIMITS,
  EVIDENCE_REASON_CODES,
  evidenceUsageSampleSchema,
  ExecutionReportValidationContext,
  sealContract,
  validateActionReceipt,
  validateExecutionReport,
  WorkspaceFingerprintError,
  WORKSPACE_FINGERPRINT_LIMITS
} from '../../src/agents';
import {
  createBudgetLedger,
  reconcileBudget,
  reserveBudget
} from '../../src/agents/run/authority/budgets';
import { controllerProof, workstreamProof } from '../../src/agents/run/authority/leases';
import { createRunAuthorityManagerForTest } from '../../src/agents/run/authority/manager';
import { authorityRunStoreKey } from '../../src/agents/run/authority/protected-repository';
import { compilePlanGraph } from '../../src/agents/run/compiler';
import { AttestationChallengeParams, createFakeTrustedControlPlane } from '../../src/agents/run/trust';
import { InMemoryProtectedStoreAdapter, ProtectedControllerStore } from '../../src/agents/run/store';

const D0 = `sha256:${'0'.repeat(64)}`;
const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const D3 = `sha256:${'3'.repeat(64)}`;
const D4 = `sha256:${'4'.repeat(64)}`;
const BEFORE = {
  scope: ['src/**'],
  entries: [
    { path: 'src/a.ts', kind: 'file' as const, contentDigest: D1, target: null, size: 1 },
    { path: 'src/b.ts', kind: 'missing' as const, contentDigest: null, target: null, size: 0 }
  ]
};
const AFTER = {
  scope: ['src/**'],
  entries: [
    { path: 'src/a.ts', kind: 'file' as const, contentDigest: D2, target: null, size: 2 },
    { path: 'src/b.ts', kind: 'missing' as const, contentDigest: null, target: null, size: 0 }
  ]
};
const AFTER_CHILD = {
  scope: ['src/**'],
  entries: [
    { path: 'src/a.ts', kind: 'file' as const, contentDigest: D2, target: null, size: 2 },
    { path: 'src/b.ts', kind: 'file' as const, contentDigest: D3, target: null, size: 3 }
  ]
};
const ACTION = {
  operation: 'fs.write' as const,
  path: 'src/a.ts',
  writeSet: ['src/**'],
  sideEffectClass: 'workspace' as const
};
const USAGE = {
  source: 'trusted-meter',
  provider: 'provider',
  model: 'model',
  inputTokens: 2,
  outputTokens: 3,
  priceTableVersion: 'prices-v1',
  cost: { currency: 'USD', value: 0.1 },
  actionCount: 1,
  confidence: 'authoritative' as const,
  timestamp: '2026-09-13T00:00:04.000Z'
};

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function workspaceProjection(value: unknown) {
  const fingerprint = computeWorkspaceFingerprint(value);
  return {
    scope: [...fingerprint.scope],
    entries: fingerprint.entries.map(entry => ({ ...entry }))
  };
}

function evidenceSourceOrder<T extends { startedAt: string; endedAt: string; ref: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
    Date.parse(left.endedAt) - Date.parse(right.endedAt) ||
    (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
}

function receiptContext(overrides: Record<string, unknown> = {}): ActionReceiptValidationContext {
  const base = {
    runId: 'run-1',
    projectId: 'project-1',
    approvedPlanDigest: D0,
    approvedGraphDigest: D1,
    graphId: 'graph-1',
    graphRevision: 2,
    graphEpoch: 3,
    cancellationGeneration: 4,
    runStatus: 'active' as const,
    receivedAt: '2026-09-13T00:00:06.000Z',
    authority: {
      kind: 'delegation-ticket' as const,
      ref: 'ticket-eo-1',
      handleLineage: ['ticket-eo-1'],
      generation: 5,
      status: 'active' as const,
      expiresAt: '2026-09-13T00:10:00.000Z',
      nodeId: 'workstream-core',
      parentNodeId: 'milestone-core',
      issuerRole: 'PLAN_ROOT' as const,
      recipientRole: 'EXECUTION' as const,
      reportDestination: 'controller:workstream-core',
      reportSchemaRef: 'execution-report/v1',
      parentTicketRef: null,
      budgetReservationId: 'ticket-budget-1',
      writeSet: ['src/**'],
      criteria: ['criterion-a']
    },
    lease: {
      kind: 'workstream' as const,
      ref: 'lease-workstream-1',
      generation: 6,
      fence: 7,
      status: 'active' as const,
      nodeId: 'workstream-core',
      ticketRef: 'ticket-eo-1',
      acquiredAt: '2026-09-13T00:00:00.000Z',
      expiresAt: '2026-09-13T00:10:00.000Z'
    },
    receiptId: 'receipt-1',
    actionId: 'action-1',
    idempotencyId: 'idempotency-1',
    action: ACTION,
    resultClass: 'success' as const,
    uncertaintyStatus: null,
    intentTimestamp: '2026-09-13T00:00:02.000Z',
    startedAt: '2026-09-13T00:00:03.000Z',
    endedAt: '2026-09-13T00:00:04.000Z',
    metadata: {
      input: { contentDigest: D2, declaredBytes: 2, path: 'src/a.ts' },
      result: { artifactHash: D2, bytesWritten: 2, changed: true }
    },
    workspace: { before: BEFORE, after: AFTER, mutations: ['src/a.ts'] },
    usage: {
      reservationId: 'ticket-budget-1',
      status: 'committed' as const,
      startedAt: '2026-09-13T00:00:01.000Z',
      deadlineAt: '2026-09-13T00:09:00.000Z',
      final: USAGE,
      sampleDigest: computeUsageSampleDigest(USAGE),
      amounts: { toolActionsEo: 1 },
      currency: 'USD',
      descendantCommitted: {},
      actual: { toolActionsEo: 1 }
    },
    artifactHashes: [D2]
  };
  return { ...base, ...overrides } as ActionReceiptValidationContext;
}

function rootReceiptContext(overrides: Record<string, unknown> = {}): ActionReceiptValidationContext {
  const base = receiptContext() as any;
  return receiptContext({
    authority: {
      kind: 'controller-root',
      nodeId: 'milestone-4-core-integration',
      parentNodeId: null,
      role: 'PLAN_ROOT',
      reportDestination: 'controller:milestone-4-core-integration',
      reportSchemaRef: 'execution-report/v1',
      budgetReservationId: 'ticket-budget-1',
      writeSet: ['src/**'],
      criteria: ['criterion-a']
    },
    lease: {
      kind: 'controller',
      ref: 'lease-controller-1',
      generation: 6,
      fence: 7,
      status: 'active',
      acquiredAt: base.lease.acquiredAt,
      expiresAt: base.lease.expiresAt
    },
    ...overrides
  });
}

function receiptPayload(context: ActionReceiptValidationContext, overrides: Record<string, unknown> = {}) {
  const value = context as any;
  const authority = value.authority;
  const delegated = authority.kind === 'delegation-ticket';
  return {
    runId: value.runId,
    projectId: value.projectId,
    approvedPlanDigest: value.approvedPlanDigest,
    approvedGraphDigest: value.approvedGraphDigest,
    graphId: value.graphId,
    graphRevision: value.graphRevision,
    graphEpoch: value.graphEpoch,
    cancellationGeneration: value.cancellationGeneration,
    authorityKind: authority.kind,
    ticketRef: delegated ? authority.ref : null,
    parentTicketRef: delegated ? authority.parentTicketRef : null,
    ticketBudgetReservationId: authority.budgetReservationId,
    ticketGeneration: delegated ? authority.generation : null,
    nodeId: authority.nodeId,
    parentNodeId: authority.parentNodeId,
    issuerRole: delegated ? authority.issuerRole : null,
    recipientRole: delegated ? authority.recipientRole : authority.role,
    reportDestination: authority.reportDestination,
    reportSchemaRef: authority.reportSchemaRef,
    leaseKind: value.lease.kind,
    leaseRef: value.lease.ref,
    leaseGeneration: value.lease.generation,
    leaseFence: value.lease.fence,
    actionId: value.actionId,
    idempotencyId: value.idempotencyId,
    operation: value.action.operation,
    childTicketRef: value.action.operation === 'agent.spawn' &&
      typeof value.metadata.result.childTicketRef === 'string' ? value.metadata.result.childTicketRef : null,
    handleLineage: delegated ? authority.handleLineage : [],
    normalizedOperationDigest: computeNormalizedOperationDigest(value.action),
    intentTimestamp: value.intentTimestamp,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    resultClass: value.resultClass,
    inputMetadata: value.metadata.input,
    resultMetadata: value.metadata.result,
    mutations: value.workspace.mutations,
    workspaceScope: workspaceProjection(value.workspace.before).scope,
    workspaceBefore: workspaceProjection(value.workspace.before),
    workspaceAfter: workspaceProjection(value.workspace.after),
    beforeFingerprint: computeWorkspaceFingerprint(value.workspace.before).digest,
    afterFingerprint: computeWorkspaceFingerprint(value.workspace.after).digest,
    usageReservationId: value.usage.reservationId,
    usageStatus: value.usage.status,
    usageSampleDigest: value.usage.sampleDigest,
    usageAmounts: value.usage.amounts,
    usageCurrency: value.usage.currency,
    usageDescendantCommitted: value.usage.descendantCommitted,
    usageActual: value.usage.actual,
    ...(value.usage.final === null ? {} : { usageFinal: value.usage.final }),
    ...(value.uncertaintyStatus === null ? {} : { uncertaintyStatus: value.uncertaintyStatus }),
    artifactHashes: value.artifactHashes,
    ...overrides
  };
}

function receiptClaim(
  context: ActionReceiptValidationContext = receiptContext(),
  overrides: Record<string, unknown> = {}
) {
  return sealContract('action-receipt/v1', (context as any).receiptId, receiptPayload(context, overrides));
}

function validReceipt() {
  const context = receiptContext();
  const result = validateActionReceipt(receiptClaim(context), context);
  if (!result.ok) throw new Error(result.reasons.join(','));
  return result;
}

function resealReceiptEvidence(record: any, overrides: Record<string, unknown>) {
  const payload = copy(record.envelope.payload) as Record<string, unknown>;
  for (const key of Object.keys(payload)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) payload[key] = overrides[key];
  }
  const usageStatus = overrides.usageStatus ?? payload.usageStatus;
  if (usageStatus !== 'committed') delete payload.usageFinal;
  const ref = typeof overrides.ref === 'string' ? overrides.ref : record.ref;
  const envelope = sealContract('action-receipt/v1', ref, payload);
  return {
    ...record,
    ...overrides,
    ref,
    envelopeDigest: envelope.digest,
    envelope,
    usageFinal: usageStatus === 'committed' ? payload.usageFinal : null
  };
}

function resealReportEvidence(record: any, overrides: Record<string, unknown>) {
  const payload = copy(record.envelope.payload) as Record<string, unknown>;
  for (const key of Object.keys(payload)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) payload[key] = overrides[key];
  }
  if (overrides.descendantTicketRefs !== undefined) payload.closureChildLineage = overrides.descendantTicketRefs;
  if (overrides.descendantReportRefs !== undefined) payload.closureChildReportRefs = overrides.descendantReportRefs;
  if (overrides.criterionResults !== undefined) payload.closureCriterionResults = overrides.criterionResults;
  const ref = typeof overrides.ref === 'string' ? overrides.ref : record.ref;
  const envelope = sealContract('execution-report/v1', ref, payload);
  return { ...record, ...overrides, ref, envelopeDigest: envelope.digest, envelope };
}

function reportContext(overrides: Record<string, unknown> = {}): ExecutionReportValidationContext {
  const receipt = validReceipt().evidence;
  const rc = receiptContext() as any;
  const base = {
    runId: rc.runId,
    projectId: rc.projectId,
    approvedPlanDigest: rc.approvedPlanDigest,
    approvedGraphDigest: rc.approvedGraphDigest,
    graphId: rc.graphId,
    graphRevision: rc.graphRevision,
    graphEpoch: rc.graphEpoch,
    cancellationGeneration: rc.cancellationGeneration,
    runStatus: 'active' as const,
    receivedAt: '2026-09-13T00:00:06.000Z',
    authority: rc.authority,
    lease: rc.lease,
    reportId: 'report-1',
    workspace: { before: BEFORE, after: AFTER },
    receipts: [receipt],
    children: [],
    childReports: [],
    evidenceOrder: [receipt.ref],
    evidence: [
      { ref: 'artifact-a', digest: D2, nodeId: rc.authority.nodeId, kind: 'artifact' as const },
      { ref: 'evidence-a', digest: D4, nodeId: rc.authority.nodeId, kind: 'test' as const }
    ],
    budgetReconciliation: {
      reservationId: 'ticket-budget-1',
      status: 'committed' as const,
      amounts: { toolActionsEo: 1 },
      actual: { toolActionsEo: 1 },
      sampleDigest: receipt.usageSampleDigest
    },
    subtreeActual: { toolActionsEo: 1 },
    budgetContributors: { own: { toolActionsEo: 1 }, children: {} },
    requiredDisclosures: { assumptions: [], unresolvedItems: [], uncertainOutcomes: [] }
  };
  const result = { ...base, ...overrides } as any;
  if (overrides.evidence === undefined) {
    const childEvidence = result.childReports.flatMap((report: any) => report.evidenceRecords);
    const ownEvidence = base.evidence.filter(record => record.kind !== 'artifact' ||
      result.receipts.some((candidate: any) => candidate.artifactHashes.includes(record.digest)));
    result.evidence = [...ownEvidence, ...childEvidence].filter((record, index, records) =>
      records.findIndex(candidate => candidate.ref === record.ref) === index);
  }
  if (overrides.subtreeActual === undefined && overrides.budgetReconciliation !== undefined &&
      result.childReports.length === 0) result.subtreeActual = result.budgetReconciliation.actual;
  return result as ExecutionReportValidationContext;
}

function reportPayload(context: ExecutionReportValidationContext, overrides: Record<string, unknown> = {}) {
  const value = context as any;
  const authority = value.authority;
  const delegated = authority.kind === 'delegation-ticket';
  const artifactRefs = value.evidence.filter((record: any) => record.kind === 'artifact' &&
    value.receipts.some((receipt: any) => receipt.artifactHashes.includes(record.digest)))
    .map((record: any) => record.ref);
  const actionReceipts = evidenceSourceOrder([
    ...value.receipts,
    ...value.childReports.flatMap((report: any) => report.actionReceipts)
  ]);
  const criterionResults = overrides.criterionResults ??
    [{ criterionId: 'criterion-a', outcome: 'met', evidenceRef: 'evidence-a' }];
  const assumptions = (overrides.assumptions ?? []) as unknown[];
  const unresolvedItems = (overrides.unresolvedItems ?? []) as unknown[];
  const uncertainOutcomes = (overrides.uncertainOutcomes ?? []) as unknown[];
  const budgetReconciliation = (overrides.budgetReconciliation ?? value.budgetReconciliation) as any;
  const closureCriterionResults = [
    ...(criterionResults as any[]).map(result => ({ ...result, nodeId: authority.nodeId })),
    ...value.childReports.flatMap((report: any) => report.criterionResults)
  ].sort((left: any, right: any) => {
    const leftKey = `${left.nodeId}\0${left.criterionId}`;
    const rightKey = `${right.nodeId}\0${right.criterionId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const completionBlocked = (criterionResults as any[]).length === 0 ||
    (criterionResults as any[]).some(result => result.outcome !== 'met' || result.evidenceRef === undefined ||
      !value.evidence.some((record: any) => record.ref === result.evidenceRef)) ||
    value.receipts.some((receipt: any) => receipt.resultClass !== 'success' || receipt.usageStatus !== 'committed') ||
    value.childReports.some((report: any) => report.completionBlocked) ||
    value.children.length !== value.childReports.length || budgetReconciliation.status !== 'committed' ||
    assumptions.length > 0 || unresolvedItems.length > 0 || uncertainOutcomes.length > 0;
  return {
    runId: value.runId,
    projectId: value.projectId,
    approvedPlanDigest: value.approvedPlanDigest,
    approvedGraphDigest: value.approvedGraphDigest,
    graphId: value.graphId,
    graphRevision: value.graphRevision,
    graphEpoch: value.graphEpoch,
    cancellationGeneration: value.cancellationGeneration,
    authorityKind: authority.kind,
    ticketRef: delegated ? authority.ref : null,
    parentTicketRef: delegated ? authority.parentTicketRef : null,
    ticketBudgetReservationId: authority.budgetReservationId,
    ticketGeneration: delegated ? authority.generation : null,
    nodeId: authority.nodeId,
    parentNodeId: authority.parentNodeId,
    issuerRole: delegated ? authority.issuerRole : null,
    recipientRole: delegated ? authority.recipientRole : authority.role,
    reportDestination: authority.reportDestination,
    reportSchemaRef: authority.reportSchemaRef,
    leaseKind: value.lease.kind,
    leaseRef: value.lease.ref,
    leaseGeneration: value.lease.generation,
    leaseFence: value.lease.fence,
    handleLineage: delegated ? authority.handleLineage : [],
    childLineage: value.children.map((child: any) => child.ticketRef).sort(),
    mutations: [...new Set([
      ...value.receipts.flatMap((receipt: any) => receipt.mutations),
      ...value.childReports.flatMap((report: any) => report.mutations)
    ])].sort(),
    actions: [...new Set([
      ...value.receipts.map((receipt: any) => receipt.actionId),
      ...value.childReports.flatMap((report: any) => report.actions)
    ])].sort(),
    criterionResults,
    receiptRefs: value.receipts.map((receipt: any) => receipt.ref).sort(),
    childReportRefs: value.childReports.map((report: any) => report.ref).sort(),
    childBindings: [
      ...value.children,
      ...value.childReports.flatMap((report: any) => report.childBindings)
    ].sort((left: any, right: any) => left.ticketRef < right.ticketRef ? -1 : left.ticketRef > right.ticketRef ? 1 : 0),
    evidenceOrder: value.evidenceOrder,
    evidenceRefs: [...new Set([
      ...artifactRefs, 'evidence-a', ...value.childReports.flatMap((report: any) => report.evidenceRefs)
    ])].sort(),
    workspaceScope: workspaceProjection(value.workspace.before).scope,
    workspaceBefore: workspaceProjection(value.workspace.before),
    workspaceAfter: workspaceProjection(value.workspace.after),
    actionReceipts,
    closureChildReportRefs: [...new Set([
      ...value.childReports.map((report: any) => report.ref),
      ...value.childReports.flatMap((report: any) => report.descendantReportRefs)
    ])].sort(),
    closureChildLineage: [...new Set([
      ...value.children.map((child: any) => child.ticketRef),
      ...value.childReports.flatMap((report: any) => report.descendantTicketRefs)
    ])].sort(),
    closureCriterionResults,
    evidenceRecords: [...value.evidence].sort((left: any, right: any) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0),
    completionBlocked,
    budgetReconciliation,
    subtreeActual: value.subtreeActual,
    assumptions: [],
    unresolvedItems: [],
    uncertainOutcomes: [],
    requestedDisposition: 'complete',
    startedAt: '2026-09-13T00:00:01.000Z',
    endedAt: '2026-09-13T00:00:05.000Z',
    beforeFingerprint: computeWorkspaceFingerprint(value.workspace.before).digest,
    afterFingerprint: computeWorkspaceFingerprint(value.workspace.after).digest,
    ...overrides
  };
}

function reportClaim(
  context: ExecutionReportValidationContext = reportContext(),
  overrides: Record<string, unknown> = {}
) {
  return sealContract('execution-report/v1', (context as any).reportId, reportPayload(context, overrides));
}

function validChildBundle(options: {
  suffix?: string;
  nodeId?: string;
  path?: string;
  before?: typeof BEFORE;
  after?: typeof BEFORE;
  operation?: 'fs.write' | 'fs.delete';
  leaseAcquiredAt?: string;
  intentAt?: string;
  actionStartedAt?: string;
  actionEndedAt?: string;
  usageAt?: string;
  receiptReceivedAt?: string;
  reportStartedAt?: string;
  reportEndedAt?: string;
  reportReceivedAt?: string;
  generation?: number;
} = {}) {
  const suffix = options.suffix ?? '1';
  const path = options.path ?? 'src/b.ts';
  const before = options.before ?? AFTER;
  const after = options.after ?? AFTER_CHILD;
  const operation = options.operation ?? 'fs.write';
  const leaseAcquiredAt = options.leaseAcquiredAt ?? '2026-09-13T00:00:00.000Z';
  const intentAt = options.intentAt ?? '2026-09-13T00:00:04.200Z';
  const actionStartedAt = options.actionStartedAt ?? '2026-09-13T00:00:04.300Z';
  const actionEndedAt = options.actionEndedAt ?? '2026-09-13T00:00:04.600Z';
  const usageAt = options.usageAt ?? '2026-09-13T00:00:04.700Z';
  const receiptReceivedAt = options.receiptReceivedAt ?? '2026-09-13T00:00:04.900Z';
  const reportStartedAt = options.reportStartedAt ?? '2026-09-13T00:00:04.100Z';
  const reportEndedAt = options.reportEndedAt ?? '2026-09-13T00:00:04.800Z';
  const reportReceivedAt = options.reportReceivedAt ?? '2026-09-13T00:00:05.000Z';
  const afterEntry = after.entries.find(entry => entry.path === path)!;
  const nodeId = options.nodeId ?? `leaf-core-${suffix}`;
  const artifactDigest = afterEntry.contentDigest ?? D4;
  const usage = {
    ...USAGE,
    timestamp: usageAt,
    actionCount: 1
  };
  const ticket = {
    ...(receiptContext() as any).authority,
    kind: 'delegation-ticket' as const,
    ref: `ticket-leaf-${suffix}`,
    parentTicketRef: 'ticket-eo-1',
    handleLineage: ['ticket-eo-1', `ticket-leaf-${suffix}`],
    generation: options.generation ?? (suffix === '1' ? 8 : 9 + [...suffix].reduce(
      (total, character) => total + character.charCodeAt(0), 0)),
    nodeId,
    parentNodeId: 'workstream-core',
    issuerRole: 'EXECUTION' as const,
    recipientRole: 'LEAF' as const,
    reportDestination: `controller:${nodeId}`,
    budgetReservationId: `ticket-budget-leaf-${suffix}`,
    criteria: [`criterion-leaf-${suffix}`]
  };
  const lease = {
    ...(receiptContext() as any).lease,
    ref: 'lease-workstream-1',
    generation: 6,
    fence: 7,
    nodeId: ticket.parentNodeId,
    ticketRef: ticket.parentTicketRef,
    acquiredAt: leaseAcquiredAt
  };
  const action = { ...ACTION, operation, path };
  const inputMetadata = operation === 'fs.write'
    ? { contentDigest: artifactDigest, declaredBytes: afterEntry.size, path }
    : { path };
  const resultMetadata = operation === 'fs.write'
    ? { artifactHash: artifactDigest, bytesWritten: afterEntry.size, changed: true }
    : { changed: true, deleted: true };
  const artifactHashes = operation === 'fs.write' ? [artifactDigest] : [];
  const receipt = receiptContext({
    receivedAt: receiptReceivedAt,
    authority: ticket,
    lease,
    receiptId: `receipt-leaf-${suffix}`,
    actionId: `action-leaf-${suffix}`,
    idempotencyId: `idempotency-leaf-${suffix}`,
    action,
    intentTimestamp: intentAt,
    startedAt: actionStartedAt,
    endedAt: actionEndedAt,
    metadata: { input: inputMetadata, result: resultMetadata },
    workspace: { before, after, mutations: [path] },
    usage: {
      reservationId: ticket.budgetReservationId,
      status: 'committed',
      startedAt: reportStartedAt,
      deadlineAt: '2026-09-13T00:09:00.000Z',
      final: usage,
      sampleDigest: computeUsageSampleDigest(usage),
      amounts: { toolActionsLeaf: 1 },
      currency: 'USD',
      descendantCommitted: {},
      actual: { toolActionsLeaf: 1 }
    },
    artifactHashes
  });
  const receiptResult = validateActionReceipt(receiptClaim(receipt), receipt);
  if (!receiptResult.ok) throw new Error(`child receipt: ${receiptResult.reasons.join(',')}`);
  const report = reportContext({
    receivedAt: reportReceivedAt,
    authority: ticket,
    lease,
    reportId: `report-leaf-${suffix}`,
    workspace: { before, after },
    receipts: [receiptResult.evidence],
    children: [],
    childReports: [],
    evidenceOrder: [receiptResult.evidence.ref],
    evidence: [
      ...(artifactHashes.length === 0 ? [] : [{
        ref: `artifact-leaf-${suffix}`, digest: artifactDigest, nodeId: ticket.nodeId, kind: 'artifact' as const
      }]),
      { ref: `evidence-leaf-${suffix}`, digest: D0, nodeId: ticket.nodeId, kind: 'test' as const }
    ],
    budgetReconciliation: {
      reservationId: ticket.budgetReservationId,
      status: 'committed',
      amounts: { toolActionsLeaf: 1 },
      actual: { toolActionsLeaf: 1 },
      sampleDigest: receiptResult.evidence.usageSampleDigest
    },
    subtreeActual: { toolActionsLeaf: 1 },
    budgetContributors: { own: { toolActionsLeaf: 1 }, children: {} },
    requiredDisclosures: { assumptions: [], unresolvedItems: [], uncertainOutcomes: [] }
  });
  const reportEvidenceRefs = [
    ...(artifactHashes.length === 0 ? [] : [`artifact-leaf-${suffix}`]),
    `evidence-leaf-${suffix}`
  ].sort();
  const reportResult = validateExecutionReport(reportClaim(report, {
    criterionResults: [{
      criterionId: `criterion-leaf-${suffix}`, outcome: 'met', evidenceRef: `evidence-leaf-${suffix}`
    }],
    evidenceRefs: reportEvidenceRefs,
    startedAt: reportStartedAt,
    endedAt: reportEndedAt
  }), report);
  if (!reportResult.ok) throw new Error(`child report: ${reportResult.reasons.join(',')}`);
  return {
    child: {
      ticketRef: ticket.ref,
      reportRef: reportResult.evidence.ref,
      reportEnvelopeDigest: reportResult.evidence.envelopeDigest,
      parentTicketRef: ticket.parentTicketRef,
      handleLineage: ticket.handleLineage,
      generation: ticket.generation,
      nodeId: ticket.nodeId,
      parentNodeId: ticket.parentNodeId,
      issuerRole: ticket.issuerRole,
      role: ticket.recipientRole,
      status: 'active' as const,
      expiresAt: ticket.expiresAt,
      graphRevision: (receipt as any).graphRevision,
      graphEpoch: (receipt as any).graphEpoch,
      cancellationGeneration: (receipt as any).cancellationGeneration,
      leaseKind: lease.kind,
      leaseRef: lease.ref,
      leaseGeneration: lease.generation,
      leaseFence: lease.fence,
      leaseNodeId: lease.nodeId,
      leaseTicketRef: lease.ticketRef,
      leaseStatus: lease.status,
      leaseAcquiredAt: lease.acquiredAt,
      leaseExpiresAt: lease.expiresAt,
      budgetReservationId: ticket.budgetReservationId,
      budgetReconciliation: reportResult.evidence.budgetReconciliation,
      subtreeActual: reportResult.evidence.subtreeActual,
      reportDestination: ticket.reportDestination,
      reportSchemaRef: ticket.reportSchemaRef,
      criteria: ticket.criteria
    },
    report: reportResult.evidence
  };
}

function validSpawnReceipt(
  child: ReturnType<typeof validChildBundle>['child'],
  snapshot: unknown,
  suffix: string,
  usage = {
    ...(receiptContext() as any).usage,
    amounts: {},
    descendantCommitted: {},
    actual: {}
  }
) {
  const action = {
    operation: 'agent.spawn' as const,
    agentRef: child.nodeId,
    writeSet: [],
    sideEffectClass: 'external' as const
  };
  const context = receiptContext({
    receiptId: `receipt-spawn-${suffix}`,
    actionId: `action-spawn-${suffix}`,
    idempotencyId: `idempotency-spawn-${suffix}`,
    action,
    intentTimestamp: '2026-09-13T00:00:01.100Z',
    startedAt: '2026-09-13T00:00:01.200Z',
    endedAt: '2026-09-13T00:00:01.300Z',
    metadata: {
      input: deriveOperationMetadataBindings(action),
      result: { childTicketRef: child.ticketRef }
    },
    workspace: { before: snapshot, after: snapshot, mutations: [] },
    usage,
    artifactHashes: []
  });
  const result = validateActionReceipt(receiptClaim(context), context);
  if (!result.ok) throw new Error(`spawn receipt: ${result.reasons.join(',')}`);
  return result.evidence;
}

function reportWithChildren(
  bundles: readonly ReturnType<typeof validChildBundle>[],
  workspace: { before: unknown; after: unknown },
  evidenceOrder?: readonly string[]
): ExecutionReportValidationContext {
  const orderedBundles = [...bundles].sort((left, right) =>
    left.child.ticketRef < right.child.ticketRef ? -1 : left.child.ticketRef > right.child.ticketRef ? 1 : 0);
  const childActual = bundles.length;
  const usageSample = { ...USAGE, actionCount: childActual };
  const reservationAmounts = { toolActionsLeaf: childActual };
  const parentUsage = {
    ...(receiptContext() as any).usage,
    final: usageSample,
    sampleDigest: computeUsageSampleDigest(usageSample),
    amounts: reservationAmounts,
    descendantCommitted: reservationAmounts,
    actual: { toolActionsLeaf: 0 }
  };
  const spawnReceipts = bundles.map((bundle, index) =>
    validSpawnReceipt(bundle.child, workspace.before, `${index + 1}`, parentUsage));
  return reportContext({
    receipts: spawnReceipts,
    children: orderedBundles.map(bundle => bundle.child),
    childReports: bundles.map(bundle => bundle.report),
    evidenceOrder: evidenceOrder ?? [
      ...spawnReceipts.map(receipt => receipt.ref).sort(),
      ...bundles.map(bundle => bundle.report.ref)
    ],
    workspace,
    budgetReconciliation: {
      reservationId: 'ticket-budget-1',
      status: 'committed',
      amounts: reservationAmounts,
      actual: { toolActionsLeaf: 0 },
      sampleDigest: parentUsage.sampleDigest
    },
    subtreeActual: { toolActionsLeaf: childActual },
    budgetContributors: { own: { toolActionsLeaf: 0 }, children: { toolActionsLeaf: childActual } }
  });
}

function childBindingFor(context: ExecutionReportValidationContext, report: any) {
  const value = context as any;
  const authority = value.authority;
  return {
    ticketRef: authority.ref,
    reportRef: report.ref,
    reportEnvelopeDigest: report.envelopeDigest,
    parentTicketRef: authority.parentTicketRef,
    handleLineage: authority.handleLineage,
    generation: authority.generation,
    nodeId: authority.nodeId,
    parentNodeId: authority.parentNodeId,
    issuerRole: authority.issuerRole,
    role: authority.recipientRole,
    status: authority.status,
    expiresAt: authority.expiresAt,
    graphRevision: value.graphRevision,
    graphEpoch: value.graphEpoch,
    cancellationGeneration: value.cancellationGeneration,
    leaseKind: value.lease.kind,
    leaseRef: value.lease.ref,
    leaseGeneration: value.lease.generation,
    leaseFence: value.lease.fence,
    leaseNodeId: value.lease.nodeId,
    leaseTicketRef: value.lease.ticketRef,
    leaseStatus: value.lease.status,
    leaseAcquiredAt: value.lease.acquiredAt,
    leaseExpiresAt: value.lease.expiresAt,
    budgetReservationId: authority.budgetReservationId,
    budgetReconciliation: report.budgetReconciliation,
    subtreeActual: report.subtreeActual,
    reportDestination: authority.reportDestination,
    reportSchemaRef: authority.reportSchemaRef,
    criteria: authority.criteria
  };
}

function twoLeafEoBundle() {
  const before = {
    scope: ['src/**'],
    entries: [
      ...AFTER.entries,
      { path: 'src/c.ts', kind: 'missing' as const, contentDigest: null, target: null, size: 0 }
    ]
  };
  const middle = {
    scope: ['src/**'],
    entries: [
      ...AFTER_CHILD.entries,
      { path: 'src/c.ts', kind: 'missing' as const, contentDigest: null, target: null, size: 0 }
    ]
  };
  const after = {
    scope: ['src/**'],
    entries: [
      ...AFTER_CHILD.entries,
      { path: 'src/c.ts', kind: 'file' as const, contentDigest: D4, target: null, size: 4 }
    ]
  };
  const first = validChildBundle({
    suffix: '1', path: 'src/b.ts', before, after: middle,
    intentAt: '2026-09-13T00:00:02.100Z', actionStartedAt: '2026-09-13T00:00:02.200Z',
    actionEndedAt: '2026-09-13T00:00:02.300Z', usageAt: '2026-09-13T00:00:02.400Z',
    receiptReceivedAt: '2026-09-13T00:00:02.600Z', reportStartedAt: '2026-09-13T00:00:02.000Z',
    reportEndedAt: '2026-09-13T00:00:02.500Z', reportReceivedAt: '2026-09-13T00:00:02.700Z'
  });
  const second = validChildBundle({
    suffix: '2', path: 'src/c.ts', before: middle, after,
    intentAt: '2026-09-13T00:00:03.100Z', actionStartedAt: '2026-09-13T00:00:03.200Z',
    actionEndedAt: '2026-09-13T00:00:03.300Z', usageAt: '2026-09-13T00:00:03.400Z',
    receiptReceivedAt: '2026-09-13T00:00:03.600Z', reportStartedAt: '2026-09-13T00:00:03.000Z',
    reportEndedAt: '2026-09-13T00:00:03.500Z', reportReceivedAt: '2026-09-13T00:00:03.700Z'
  });
  const context = reportWithChildren([first, second], { before, after }) as any;
  context.evidence = context.evidence.map((record: any) => record.ref === 'evidence-a'
    ? { ...record, ref: 'evidence-eo' }
    : record);
  const result = validateExecutionReport(reportClaim(context, {
    criterionResults: [{ criterionId: 'criterion-a', outcome: 'met', evidenceRef: 'evidence-eo' }],
    evidenceRefs: ['evidence-eo', ...first.report.evidenceRefs, ...second.report.evidenceRefs].sort()
  }), context);
  if (!result.ok) throw new Error(`EO report: ${result.reasons.join(',')}`);
  return { context: context as ExecutionReportValidationContext, report: result.evidence, before, after };
}

function rootContextForEo(
  eoContext: ExecutionReportValidationContext,
  eoReport: any,
  workspace: { before: unknown; after: unknown },
  options: { authority?: Record<string, unknown>; lease?: Record<string, unknown> } = {}
) {
  const eo = eoContext as any;
  const rootBase = rootReceiptContext({
    runId: eo.runId,
    projectId: eo.projectId,
    approvedPlanDigest: eo.approvedPlanDigest,
    approvedGraphDigest: eo.approvedGraphDigest,
    graphId: eo.graphId,
    graphRevision: eo.graphRevision,
    graphEpoch: eo.graphEpoch,
    cancellationGeneration: eo.cancellationGeneration,
    ...(options.lease === undefined ? {} : { lease: options.lease })
  }) as any;
  const authority = options.authority ?? {
    ...rootBase.authority,
    nodeId: 'milestone-core',
    reportDestination: 'controller:milestone-core',
    budgetReservationId: 'root-budget-binding'
  };
  const action = {
    operation: 'agent.spawn' as const,
    agentRef: (eoContext as any).authority.nodeId,
    writeSet: [],
    sideEffectClass: 'external' as const
  };
  const usage = { ...USAGE, timestamp: '2026-09-13T00:00:00.900Z', actionCount: 1 };
  const receiptContextValue = rootReceiptContext({
    runId: eo.runId,
    projectId: eo.projectId,
    approvedPlanDigest: eo.approvedPlanDigest,
    approvedGraphDigest: eo.approvedGraphDigest,
    graphId: eo.graphId,
    graphRevision: eo.graphRevision,
    graphEpoch: eo.graphEpoch,
    cancellationGeneration: eo.cancellationGeneration,
    authority,
    lease: rootBase.lease,
    receiptId: 'receipt-root-binding',
    actionId: 'action-root-binding',
    idempotencyId: 'idempotency-root-binding',
    action,
    intentTimestamp: '2026-09-13T00:00:00.200Z',
    startedAt: '2026-09-13T00:00:00.300Z',
    endedAt: '2026-09-13T00:00:00.400Z',
    metadata: {
      input: deriveOperationMetadataBindings(action),
      result: { childTicketRef: (eoContext as any).authority.ref }
    },
    workspace: { before: workspace.before, after: workspace.before, mutations: [] },
    usage: {
      reservationId: authority.budgetReservationId,
      status: 'committed',
      startedAt: '2026-09-13T00:00:00.100Z',
      deadlineAt: '2026-09-13T00:09:00.000Z',
      final: usage,
      sampleDigest: computeUsageSampleDigest(usage),
      amounts: {},
      currency: 'USD',
      descendantCommitted: {},
      actual: {}
    },
    artifactHashes: []
  });
  const receipt = validateActionReceipt(receiptClaim(receiptContextValue), receiptContextValue);
  if (!receipt.ok) throw new Error(`root receipt: ${receipt.reasons.join(',')}`);
  const child = childBindingFor(eoContext, eoReport);
  return reportContext({
    runId: eo.runId,
    projectId: eo.projectId,
    approvedPlanDigest: eo.approvedPlanDigest,
    approvedGraphDigest: eo.approvedGraphDigest,
    graphId: eo.graphId,
    graphRevision: eo.graphRevision,
    graphEpoch: eo.graphEpoch,
    cancellationGeneration: eo.cancellationGeneration,
    authority,
    lease: rootBase.lease,
    reportId: 'report-root-binding',
    receivedAt: '2026-09-13T00:00:06.000Z',
    workspace,
    receipts: [receipt.evidence],
    children: [child],
    childReports: [eoReport],
    evidenceOrder: evidenceSourceOrder([receipt.evidence, eoReport]).map(source => source.ref),
    evidence: [
      { ref: 'evidence-a', digest: D4, nodeId: authority.nodeId, kind: 'test' },
      ...eoReport.evidenceRecords
    ],
    budgetReconciliation: {
      reservationId: authority.budgetReservationId,
      status: 'committed',
      amounts: {},
      actual: {},
      sampleDigest: receipt.evidence.usageSampleDigest
    },
    subtreeActual: eoReport.subtreeActual,
    budgetContributors: { own: {}, children: eoReport.subtreeActual }
  });
}

function rootClaimForEo(context: ExecutionReportValidationContext) {
  const authority = (context as any).authority;
  return reportClaim(context, {
    criterionResults: authority.criteria.map((criterionId: string) => ({
      criterionId,
      outcome: 'met',
      evidenceRef: 'evidence-a'
    })),
    startedAt: '2026-09-13T00:00:00.100Z',
    endedAt: '2026-09-13T00:00:05.500Z'
  });
}

function reasons(result: { ok: boolean; reasons: readonly string[] }): readonly string[] {
  expect(result.ok).toBe(false);
  return result.reasons;
}

describe('workspace evidence fingerprints', () => {
  test('is stable across supplied order and commits empty/missing scope explicitly', () => {
    const first = computeWorkspaceFingerprint({
      scope: ['test/**', 'src/**', 'src/**'],
      entries: [
        { path: 'test/a.ts', kind: 'missing', contentDigest: null, target: null, size: 0 },
        ...BEFORE.entries
      ]
    });
    const second = computeWorkspaceFingerprint({
      entries: [...BEFORE.entries, {
        path: 'test/a.ts', kind: 'missing', contentDigest: null, target: null, size: 0
      }],
      scope: ['src/**', 'test/**']
    });
    expect(first.digest).toBe(second.digest);
    expect(first.scope).toEqual(['src/**', 'test/**']);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(computeWorkspaceFingerprint({ scope: [], entries: [] }).digest)
      .not.toBe(computeWorkspaceFingerprint({ scope: ['src/**'], entries: [] }).digest);
  });

  test('reads no filesystem state and leaves supplied entries unchanged', () => {
    const input = copy(BEFORE);
    const fs = require('fs') as typeof import('fs');
    const reads = [
      jest.spyOn(fs, 'readFileSync'),
      jest.spyOn(fs, 'readdirSync'),
      jest.spyOn(fs, 'realpathSync'),
      jest.spyOn(fs, 'statSync')
    ];
    try {
      computeWorkspaceFingerprint(input);
      expect(reads.every(spy => spy.mock.calls.length === 0)).toBe(true);
      expect(input).toEqual(BEFORE);
    } finally {
      reads.forEach(spy => spy.mockRestore());
    }
  });

  test('detects content, kind, target, and size drift', () => {
    const base = computeWorkspaceFingerprint(BEFORE).digest;
    for (const entry of [
      { path: 'src/a.ts', kind: 'file', contentDigest: D2, target: null, size: 1 },
      { path: 'src/a.ts', kind: 'file', contentDigest: D1, target: null, size: 2 },
      { path: 'src/a.ts', kind: 'symlink', contentDigest: null, target: 'src/b.ts', size: 1 }
    ]) {
      expect(computeWorkspaceFingerprint({ scope: ['src/**'], entries: [entry] }).digest).not.toBe(base);
    }
  });

  test.each(['../escape', '/absolute', 'src\\a.ts', 'src/./a.ts', 'src//a.ts'])
  ('rejects non-canonical path %s', path => {
    expect(() => computeWorkspaceFingerprint({
      scope: ['src/**'],
      entries: [{ path, kind: 'missing', contentDigest: null, target: null, size: 0 }]
    })).toThrow(WorkspaceFingerprintError);
  });

  test('rejects duplicate paths, portable collisions, bounds, hostile accessors, and proxies', () => {
    const entry = { path: 'src/a.ts', kind: 'missing', contentDigest: null, target: null, size: 0 };
    expect(() => computeWorkspaceFingerprint({ scope: ['src/**'], entries: [entry, entry] }))
      .toThrow(expect.objectContaining({ code: 'duplicate-path' }));
    expect(() => computeWorkspaceFingerprint({ scope: ['src/**', 'SRC/**'], entries: [entry, { ...entry, path: 'SRC/A.ts' }] }))
      .toThrow(expect.objectContaining({ code: 'portable-path-collision' }));
    expect(() => computeWorkspaceFingerprint({
      scope: ['src/**'],
      entries: [{ ...entry, path: 'src/οσ.ts' }, { ...entry, path: 'src/ος.ts' }]
    })).toThrow(expect.objectContaining({ code: 'portable-path-collision' }));
    expect(() => computeWorkspaceFingerprint({
      scope: ['src/**'],
      entries: [{
        ...entry,
        kind: 'file',
        contentDigest: D1,
        size: WORKSPACE_FINGERPRINT_LIMITS.totalDeclaredBytes + 1
      }]
    })).toThrow(expect.objectContaining({ code: 'snapshot-size-exceeded' }));
    expect(() => computeWorkspaceFingerprint({
      scope: [],
      entries: Array.from({ length: WORKSPACE_FINGERPRINT_LIMITS.entries + 1 }, (_, index) => ({
        path: `src/${index}.ts`, kind: 'missing', contentDigest: null, target: null, size: 0
      }))
    })).toThrow(expect.objectContaining({ code: 'invalid-snapshot' }));
    let invoked = false;
    const accessor = { scope: [], entries: [] } as any;
    Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => { invoked = true; return 'x'; } });
    expect(() => computeWorkspaceFingerprint(accessor)).toThrow(WorkspaceFingerprintError);
    expect(invoked).toBe(false);
    expect(() => computeWorkspaceFingerprint(new Proxy({}, {}))).toThrow(WorkspaceFingerprintError);
  });
});

describe('action receipt validation', () => {
  test('shares WP-210 numeric safety for usage samples', () => {
    for (const sample of [
      { ...USAGE, inputTokens: -0 },
      { ...USAGE, outputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...USAGE, cacheTokens: 0.5 },
      { ...USAGE, actionCount: Number.POSITIVE_INFINITY },
      { ...USAGE, cost: { currency: 'USD', value: -0 } },
      { ...USAGE, cost: { currency: 'USD', value: Number.MAX_SAFE_INTEGER + 1 } }
    ]) {
      expect(evidenceUsageSampleSchema.safeParse(sample).success).toBe(false);
    }
    expect(evidenceUsageSampleSchema.safeParse({
      ...USAGE,
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      actionCount: Number.MAX_SAFE_INTEGER,
      cost: { currency: 'USD', value: Number.MAX_SAFE_INTEGER }
    }).success).toBe(true);
  });

  test('validates, canonicalizes, detaches, and deeply freezes a valid claim', () => {
    const context = receiptContext();
    const claim = receiptClaim(context);
    const original = copy(claim);
    const result = validateActionReceipt(claim, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.classification).toBe('valid');
    expect(result.replay).toBe(false);
    expect(result.evidence.mutations).toEqual(['src/a.ts']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.envelope.payload.inputMetadata)).toBe(true);
    expect(claim).toEqual(original);
    (claim.payload as any).actionId = 'mutated-after-validation';
    expect(result.envelope.payload.actionId).toBe('action-1');
  });

  test('validates controller-root integration receipt without a fabricated ticket', () => {
    const context = rootReceiptContext();
    const result = validateActionReceipt(receiptClaim(context), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toMatchObject({
      authorityKind: 'controller-root',
      ticketRef: null,
      ticketGeneration: null,
      recipientRole: 'PLAN_ROOT',
      leaseKind: 'controller'
    });
  });

  test('rejects unknown and sensitive metadata without masking', () => {
    const context = receiptContext();
    expect(reasons(validateActionReceipt(receiptClaim(context, {
      inputMetadata: { ...(context as any).metadata.input, mystery: true }
    }), context))).toContain('unknown-metadata-field');
    expect(reasons(validateActionReceipt(receiptClaim(context, {
      resultMetadata: { ...(context as any).metadata.result, authorization: 'Bearer secret' }
    }), context))).toContain('sensitive-metadata');
  });

  test('rejects malformed/tampered envelopes and hostile objects without invoking accessors', () => {
    const context = receiptContext();
    const tampered = receiptClaim(context);
    (tampered.payload as any).actionId = 'tampered';
    expect(reasons(validateActionReceipt(tampered, context))).toContain('envelope-digest-mismatch');
    let invoked = false;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'kind', { enumerable: true, get: () => { invoked = true; return 'x'; } });
    expect(reasons(validateActionReceipt(hostile, context))).toEqual(['malformed-envelope']);
    expect(invoked).toBe(false);
    expect(reasons(validateActionReceipt(new Proxy({}, {}), context))).toEqual(['malformed-envelope']);
  });

  test.each([
    ['run binding', { runId: 'run-forged' }, 'run-binding-mismatch'],
    ['project binding', { projectId: 'project-forged' }, 'project-binding-mismatch'],
    ['plan digest', { approvedPlanDigest: D4 }, 'plan-binding-mismatch'],
    ['graph digest', { approvedGraphDigest: D4 }, 'graph-binding-mismatch'],
    ['graph revision', { graphRevision: 99 }, 'graph-revision-mismatch'],
    ['ticket ref', { ticketRef: 'ticket-forged' }, 'ticket-binding-mismatch'],
    ['lease ref', { leaseRef: 'lease-forged' }, 'lease-binding-mismatch'],
    ['node', { nodeId: 'workstream-forged' }, 'node-binding-mismatch'],
    ['role', { recipientRole: 'LEAF' }, 'role-binding-mismatch'],
    ['lineage', { handleLineage: ['ticket-forged'] }, 'lineage-mismatch'],
    ['action', { actionId: 'action-forged' }, 'action-binding-mismatch'],
    ['operation', { normalizedOperationDigest: D4 }, 'operation-digest-mismatch'],
    ['fingerprint', { afterFingerprint: D4 }, 'fingerprint-mismatch'],
    ['artifact', { artifactHashes: [D4] }, 'artifact-mismatch'],
    ['usage', { usageReservationId: 'usage-forged' }, 'usage-reservation-mismatch'],
    ['usage final', { usageFinal: { ...USAGE, actionCount: 2 } }, 'usage-reconciliation-mismatch'],
    ['timestamp order', { startedAt: '2026-09-13T00:00:05.000Z' }, 'timestamp-order-invalid'],
    ['timestamp window', { endedAt: '2026-09-13T00:11:00.000Z' }, 'timestamp-window-invalid']
  ])('rejects wrong %s', (_label, overrides, reason) => {
    const context = receiptContext();
    expect(reasons(validateActionReceipt(receiptClaim(context, overrides), context))).toContain(reason);
  });

  test('rejects mutation mismatch/outside authority and conflicting replay', () => {
    const context = receiptContext();
    expect(reasons(validateActionReceipt(receiptClaim(context, { mutations: [] }), context)))
      .toContain('mutation-corroboration-mismatch');
    const outsideContext = receiptContext({
      workspace: { before: BEFORE, after: AFTER, mutations: ['other/a.ts'] }
    });
    expect(reasons(validateActionReceipt(receiptClaim(outsideContext), outsideContext)))
      .toContain('mutation-outside-write-set');
    const claim = receiptClaim(context);
    const replay = receiptContext({ priorClaim: { id: claim.id, digest: claim.digest } });
    const replayed = validateActionReceipt(claim, replay);
    expect(replayed.ok && replayed.replay).toBe(true);
    const conflict = receiptContext({ priorClaim: { id: claim.id, digest: D4 } });
    expect(reasons(validateActionReceipt(claim, conflict))).toContain('replay-conflict');
  });

  test('accepts pending usage without final telemetry', () => {
    const context = receiptContext({
      usage: {
        reservationId: 'ticket-budget-1',
        status: 'pending',
        startedAt: '2026-09-13T00:00:01.000Z',
        deadlineAt: '2026-09-13T00:09:00.000Z',
        final: null,
        sampleDigest: null,
        amounts: { toolActionsEo: 1 },
        currency: 'USD',
        descendantCommitted: {},
        actual: {}
      }
    });
    expect(validateActionReceipt(receiptClaim(context), context).ok).toBe(true);
  });

  test('quarantines unresolved usage without final telemetry', () => {
    const context = receiptContext({
      usage: {
        ...(receiptContext() as any).usage,
        status: 'unresolved',
        final: null,
        sampleDigest: null,
        actual: {}
      }
    });
    const result = validateActionReceipt(receiptClaim(context), context);
    expect(result.classification).toBe('quarantined');
    expect(result.reasons).toEqual(['unresolved-authority-reference']);
  });

  test('uses exact WP-210 ledger digest and descendant reconciliation output', () => {
    let ledger = reserveBudget(createBudgetLedger(DEFAULT_EXECUTION_PLAN_BUDGETS), {
      reservationId: 'usage-parent',
      ticketHandleId: 'ticket-parent',
      parentTicketHandleId: null,
      amounts: { toolActionsEo: 2, tokensEo: 10, costUsdEo: 0.2 },
      scope: 'workstream-core',
      role: 'EXECUTION',
      startedAt: '2026-09-13T00:00:01.000Z',
      deadlineAt: '2026-09-13T00:09:00.000Z'
    });
    ledger = reserveBudget(ledger, {
      reservationId: 'usage-child',
      ticketHandleId: 'ticket-child',
      parentTicketHandleId: 'ticket-parent',
      amounts: { toolActionsEo: 1, tokensEo: 5, costUsdEo: 0.1 },
      scope: 'leaf-core',
      role: 'LEAF',
      startedAt: '2026-09-13T00:00:01.000Z',
      deadlineAt: '2026-09-13T00:09:00.000Z'
    });
    ledger = reconcileBudget(ledger, 'usage-child', {
      ...USAGE,
      timestamp: '2026-09-13T00:00:03.000Z'
    });
    const parentSample = {
      ...USAGE,
      inputTokens: 4,
      outputTokens: 6,
      cost: { currency: 'USD', value: 0.2 },
      actionCount: 2
    };
    ledger = reconcileBudget(ledger, 'usage-parent', parentSample);
    const reservation = ledger.reservations.find(item => item.reservationId === 'usage-parent')!;
    const childAccount = ledger.accounts.find(item => item.ticketHandleId === 'ticket-child')!;
    const descendantCommitted = Object.fromEntries(Object.keys(reservation.amounts).map(dimension =>
      [dimension, childAccount.committed[dimension as keyof typeof childAccount.committed] ?? 0]));
    expect(reservation.sampleDigest).toBe(computeUsageSampleDigest(parentSample));

    const context = receiptContext({
      authority: { ...(receiptContext() as any).authority, budgetReservationId: reservation.reservationId },
      usage: {
        reservationId: reservation.reservationId,
        status: reservation.status,
        startedAt: reservation.startedAt,
        deadlineAt: reservation.deadlineAt,
        final: parentSample,
        sampleDigest: reservation.sampleDigest,
        amounts: reservation.amounts,
        currency: ledger.currency,
        descendantCommitted,
        actual: reservation.actual
      }
    });
    expect(validateActionReceipt(receiptClaim(context), context).ok).toBe(true);

    const forged = receiptContext({
      usage: { ...(context as any).usage, actual: { ...reservation.actual, toolActionsEo: 2 } }
    });
    expect(reasons(validateActionReceipt(receiptClaim(forged), forged))).toContain('trusted-context-invalid');

    const unreservedDescendant = receiptContext({
      usage: { ...(receiptContext() as any).usage, descendantCommitted: { tokensEo: 1 } }
    });
    expect(reasons(validateActionReceipt(receiptClaim(unreservedDescendant), unreservedDescendant)))
      .toContain('trusted-context-invalid');

    const providerIdInLedgerSlot = receiptContext({
      usage: { ...(receiptContext() as any).usage, reservationId: 'provider-reservation-private' }
    });
    expect(reasons(validateActionReceipt(receiptClaim(providerIdInLedgerSlot), providerIdInLedgerSlot)))
      .toEqual(expect.arrayContaining(['trusted-context-invalid', 'usage-reservation-mismatch']));
  });

  test('accepts released usage only for corroborated no-effect failure', () => {
    const releasedUsage = {
      ...(receiptContext() as any).usage,
      status: 'released',
      final: null,
      sampleDigest: null,
      actual: {}
    };
    const valid = receiptContext({
      resultClass: 'failure',
      metadata: {
        input: { contentDigest: D2, declaredBytes: 2, path: 'src/a.ts' },
        result: { changed: false, errorCode: 'write-failed' }
      },
      workspace: { before: BEFORE, after: BEFORE, mutations: [] },
      usage: releasedUsage,
      artifactHashes: []
    });
    expect(validateActionReceipt(receiptClaim(valid), valid).ok).toBe(true);

    for (const invalid of [
      receiptContext({ usage: releasedUsage }),
      receiptContext({ resultClass: 'failure', usage: releasedUsage })
    ]) {
      expect(reasons(validateActionReceipt(receiptClaim(invalid), invalid)))
        .toContain('usage-lifecycle-mismatch');
    }
  });

  test('corroborates fs no-op metadata against exact path transition', () => {
    const noOpWrite = receiptContext({
      metadata: {
        input: { contentDigest: D1, declaredBytes: 1, path: 'src/a.ts' },
        result: { bytesWritten: 1, changed: false }
      },
      workspace: { before: BEFORE, after: BEFORE, mutations: [] },
      artifactHashes: []
    });
    expect(validateActionReceipt(receiptClaim(noOpWrite), noOpWrite).ok).toBe(true);

    const missingDelete = receiptContext({
      action: { operation: 'fs.delete', path: 'src/b.ts', writeSet: ['src/**'], sideEffectClass: 'workspace' },
      metadata: { input: { path: 'src/b.ts' }, result: { changed: false, deleted: false } },
      workspace: { before: BEFORE, after: BEFORE, mutations: [] },
      artifactHashes: []
    });
    expect(validateActionReceipt(receiptClaim(missingDelete), missingDelete).ok).toBe(true);

    const falseNoOp = receiptContext({
      metadata: {
        input: { contentDigest: D2, declaredBytes: 2, path: 'src/a.ts' },
        result: { bytesWritten: 2, changed: false }
      }
    });
    expect(reasons(validateActionReceipt(receiptClaim(falseNoOp), falseNoOp)))
      .toContain('trusted-context-invalid');
  });

  test.each([
    ['content digest', {
      input: { contentDigest: D4, declaredBytes: 2, path: 'src/a.ts' },
      result: { artifactHash: D2, bytesWritten: 2, changed: true }
    }],
    ['declared bytes', {
      input: { contentDigest: D2, declaredBytes: 1, path: 'src/a.ts' },
      result: { artifactHash: D2, bytesWritten: 2, changed: true }
    }],
    ['written bytes', {
      input: { contentDigest: D2, declaredBytes: 2, path: 'src/a.ts' },
      result: { artifactHash: D2, bytesWritten: 1, changed: true }
    }],
    ['artifact hash', {
      input: { contentDigest: D2, declaredBytes: 2, path: 'src/a.ts' },
      result: { artifactHash: D4, bytesWritten: 2, changed: true }
    }]
  ])('rejects changed write with contradictory %s', (_label, metadata) => {
    const context = receiptContext({ metadata });
    expect(reasons(validateActionReceipt(receiptClaim(context), context)))
      .toContain('trusted-context-invalid');
  });

  test('rejects write target kinds and incoherent delete transitions', () => {
    const symlinkAfter = {
      scope: ['src/**'],
      entries: [
        { path: 'src/a.ts', kind: 'symlink' as const, contentDigest: null, target: 'src/b.ts', size: 2 },
        BEFORE.entries[1]
      ]
    };
    const targetKind = receiptContext({
      workspace: { before: BEFORE, after: symlinkAfter, mutations: ['src/a.ts'] }
    });
    expect(reasons(validateActionReceipt(receiptClaim(targetKind), targetKind)))
      .toContain('trusted-context-invalid');

    const deleteContext = receiptContext({
      action: { operation: 'fs.delete', path: 'src/a.ts', writeSet: ['src/**'], sideEffectClass: 'workspace' },
      metadata: { input: { path: 'src/a.ts' }, result: { changed: true, deleted: false } },
      workspace: { before: BEFORE, after: BEFORE, mutations: [] },
      artifactHashes: []
    });
    expect(reasons(validateActionReceipt(receiptClaim(deleteContext), deleteContext)))
      .toContain('trusted-context-invalid');
  });

  test.each([
    [{ runStatus: 'unresolved' }, 'unresolved-authority-reference'],
    [{ runStatus: 'cancelled' }, 'cancellation-late'],
    [{ authority: { ...(receiptContext() as any).authority, status: 'revoked' } }, 'ticket-revoked'],
    [{ authority: { ...(receiptContext() as any).authority, status: 'expired' } }, 'ticket-expired'],
    [{ lease: { ...(receiptContext() as any).lease, status: 'released' } }, 'lease-released'],
    [{ lease: { ...(receiptContext() as any).lease, status: 'invalidated' } }, 'lease-invalidated'],
    [{ lease: { ...(receiptContext() as any).lease, status: 'expired' } }, 'lease-expired']
  ])('quarantines structurally valid stale authority %#', (override, reason) => {
    const baseline = receiptContext();
    const context = receiptContext(override as any);
    const result = validateActionReceipt(receiptClaim(baseline), context);
    expect(result.classification).toBe('quarantined');
    expect(result.reasons).toContain(reason);
  });

  test('quarantines generation drift in deterministic finite reason order', () => {
    const context = receiptContext();
    const result = validateActionReceipt(receiptClaim(context, {
      graphEpoch: 2,
      cancellationGeneration: 3,
      ticketGeneration: 4,
      leaseGeneration: 5
    }), context);
    expect(result.classification).toBe('quarantined');
    expect(result.reasons).toEqual([
      'ticket-generation-drift',
      'lease-generation-drift',
      'graph-epoch-drift',
      'cancellation-late'
    ]);
    expect(result.reasons.every(reason => EVIDENCE_REASON_CODES.includes(reason))).toBe(true);
  });

});

describe('execution report validation', () => {
  test('validates exact receipts, criteria, evidence, budget, and advisory completion', () => {
    const context = reportContext();
    const claim = reportClaim(context);
    const result = validateExecutionReport(claim, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authority).toBe(false);
    expect(result.completionBlocked).toBe(false);
    expect(result.requestedDisposition).toBe('complete');
    expect(Object.isFrozen(result.envelope.payload.criterionResults)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('validates PLAN_ROOT integration report under controller lease', () => {
    const receiptContextValue = rootReceiptContext();
    const receipt = validateActionReceipt(receiptClaim(receiptContextValue), receiptContextValue);
    if (!receipt.ok) throw new Error(receipt.reasons.join(','));
    const root = receiptContextValue as any;
    const context = reportContext({
      authority: root.authority,
      lease: root.lease,
      receipts: [receipt.evidence],
      evidenceOrder: [receipt.evidence.ref],
      evidence: [
        { ref: 'artifact-a', digest: D2, nodeId: root.authority.nodeId, kind: 'artifact' },
        { ref: 'evidence-a', digest: D4, nodeId: root.authority.nodeId, kind: 'test' }
      ]
    });
    const result = validateExecutionReport(reportClaim(context), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toMatchObject({
      authorityKind: 'controller-root',
      ticketRef: null,
      recipientRole: 'PLAN_ROOT',
      leaseKind: 'controller',
      authority: false
    });
  });

  test.each([
    ['mutations', { mutations: [] }, 'mutation-corroboration-mismatch'],
    ['actions', { actions: ['action-forged'] }, 'actions-receipts-mismatch'],
    ['receipts', { receiptRefs: ['receipt-forged'] }, 'actions-receipts-mismatch'],
    ['criteria', { criterionResults: [] }, 'criteria-mismatch'],
    ['met evidence', {
      criterionResults: [{ criterionId: 'criterion-a', outcome: 'met' }],
      evidenceRefs: ['artifact-a']
    }, 'met-criterion-without-evidence'],
    ['open evidence', { evidenceRefs: ['evidence-forged'] }, 'evidence-reference-open'],
    ['budget', { budgetReconciliation: {
      reservationId: 'ticket-budget-1', status: 'committed', amounts: { toolActionsEo: 1 },
      actual: { toolActionsEo: 0 }, sampleDigest: D4
    } }, 'budget-reconciliation-mismatch'],
    ['evidence order', { evidenceOrder: [] }, 'receipt-continuity-mismatch'],
    ['fingerprint', { beforeFingerprint: D4 }, 'fingerprint-mismatch'],
    ['timestamp', { endedAt: '2026-09-13T00:11:00.000Z' }, 'timestamp-window-invalid']
  ])('rejects report %s mismatch', (_label, overrides, reason) => {
    const context = reportContext();
    expect(reasons(validateExecutionReport(reportClaim(context, overrides as any), context))).toContain(reason);
  });

  test('requires disclosure preservation but treats requested completion as advisory', () => {
    const required = {
      assumptions: ['assumption-a'],
      unresolvedItems: ['unresolved-a'],
      uncertainOutcomes: ['uncertain-a']
    };
    const context = reportContext({ requiredDisclosures: required });
    expect(reasons(validateExecutionReport(reportClaim(context), context))).toContain('disclosure-omitted');

    const uncertainContext = reportContext({
      requiredDisclosures: { assumptions: [], unresolvedItems: [], uncertainOutcomes: ['uncertain-a'] },
      evidence: [{ ref: 'artifact-a', digest: D2, nodeId: 'workstream-core', kind: 'artifact' }]
    });
    const uncertainClaim = reportClaim(uncertainContext, {
      criterionResults: [{ criterionId: 'criterion-a', outcome: 'uncertain' }],
      evidenceRefs: ['artifact-a'],
      uncertainOutcomes: ['uncertain-a'],
      requestedDisposition: 'complete'
    });
    const result = validateExecutionReport(uncertainClaim, uncertainContext);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authority).toBe(false);
      expect(result.completionBlocked).toBe(true);
      expect(result.requestedDisposition).toBe('complete');
    }
  });

  test('requires child report closure and rejects illegal descendant role', () => {
    const child = {
      ticketRef: 'ticket-leaf-1',
      reportRef: 'report-leaf-1',
      reportEnvelopeDigest: D4,
      parentTicketRef: 'ticket-eo-1',
      handleLineage: ['ticket-eo-1', 'ticket-leaf-1'],
      generation: 8,
      nodeId: 'leaf-core-a',
      parentNodeId: 'workstream-core',
      issuerRole: 'EXECUTION' as const,
      role: 'LEAF' as const,
      status: 'active' as const,
      leaseRef: 'lease-workstream-1',
      leaseGeneration: 6,
      leaseFence: 7,
      leaseNodeId: 'workstream-core',
      leaseTicketRef: 'ticket-eo-1',
      budgetReservationId: 'ticket-budget-leaf-1',
      budgetReconciliation: {
        reservationId: 'ticket-budget-leaf-1', status: 'pending', amounts: {}, actual: {}, sampleDigest: null
      },
      subtreeActual: {},
      expiresAt: '2026-09-13T00:10:00.000Z',
      graphRevision: 2,
      graphEpoch: 3,
      cancellationGeneration: 4,
      leaseKind: 'workstream' as const,
      reportDestination: 'controller:leaf-core-a',
      reportSchemaRef: 'execution-report/v1',
      leaseStatus: 'active' as const,
      leaseAcquiredAt: '2026-09-13T00:00:00.000Z',
      leaseExpiresAt: '2026-09-13T00:10:00.000Z',
      criteria: ['criterion-leaf-1']
    };
    const context = reportContext({ children: [child] });
    expect(reasons(validateExecutionReport(reportClaim(context), context))).toContain('child-report-missing');
    const revoked = reportContext({ children: [{ ...child, status: 'revoked' }] });
    const revokedResult = validateExecutionReport(reportClaim(revoked), revoked);
    expect(reasons(revokedResult)).toContain('ticket-revoked');
    const illegalContext = reportContext({ children: [{ ...child, role: 'EXECUTION' }] });
    expect(reasons(validateExecutionReport(reportClaim(illegalContext), illegalContext)))
      .toContain('child-lineage-illegal');
  });

  test('rejects mutation outside ticket write set', () => {
    const context = reportContext();
    const outsideReceipt = { ...(context as any).receipts[0], mutations: ['other/a.ts'] };
    const outside = reportContext({ receipts: [outsideReceipt] });
    expect(reasons(validateExecutionReport(reportClaim(outside), outside)))
      .toContain('mutation-outside-write-set');
  });

  test('rejects report replay conflicts and accepts exact replay without authority', () => {
    const context = reportContext();
    const claim = reportClaim(context);
    const replayContext = reportContext({ priorClaim: { id: claim.id, digest: claim.digest } });
    const replay = validateExecutionReport(claim, replayContext);
    expect(replay.ok && replay.replay).toBe(true);
    const conflict = reportContext({ priorClaim: { id: claim.id, digest: D4 } });
    expect(reasons(validateExecutionReport(claim, conflict))).toContain('replay-conflict');
  });

  test('quarantines late report', () => {
    const late = reportContext({ runStatus: 'cancelled' });
    const lateResult = validateExecutionReport(reportClaim(reportContext()), late);
    expect(lateResult.classification).toBe('quarantined');
    expect(lateResult.reasons).toContain('cancellation-late');

  });

  test('malformed context and claims are deterministic, pure, and deeply frozen', () => {
    const context = reportContext();
    const claim = reportClaim(context);
    const malformedContext = copy(context) as any;
    malformedContext.unexpected = true;
    const first = validateExecutionReport(claim, malformedContext);
    const second = validateExecutionReport(claim, malformedContext);
    expect(first).toEqual(second);
    expect(first.reasons).toEqual(['trusted-context-invalid']);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.reasons)).toBe(true);
  });
});

describe('WP-220 independent review regressions', () => {
  test('validates manager-issued root to EO to sibling LEAF aggregation', async () => {
    const now = new Date('2026-09-13T00:00:00.000Z');
    const compiled = compilePlanGraph({
      planKey: 'evidence-manager',
      planRevision: 1,
      objective: 'Validate real authority topology',
      scope: ['src/**'],
      outOfScope: [],
      milestones: [{
        key: 'core',
        dependsOn: [],
        criteria: ['Core complete'],
        verification: 'Run tests',
        writeSet: ['src/**'],
        integrationCriteria: ['Core integrated'],
        workstreams: [{
          key: 'api',
          criteria: ['API complete'],
          writeSet: ['src/api/**'],
          leaves: [
            { key: 'first', criteria: ['First complete'], writeSet: ['src/api/first.ts'] },
            { key: 'second', criteria: ['Second complete'], writeSet: ['src/api/second.ts'] }
          ]
        }]
      }],
      integrationCriteria: ['Integrated'],
      regressionCriteria: [],
      expectedSideEffects: [],
      policy: {},
      budgets: {
        maxActiveExecutionOrchestrators: 2,
        maxLeavesPerEO: 2,
        maxGlobalDescendants: 3,
        maxCumulativeSpawns: 3,
        toolActionsGlobal: 20,
        toolActionsEo: 10,
        toolActionsLeaf: 4,
        tokensGlobal: 100,
        tokensEo: 50,
        tokensLeaf: 20,
        costUsdGlobal: 4,
        costUsdEo: 2
      },
      adapterRequirements: [],
      pauseRules: [],
      failureRules: [],
      cancelRules: [],
      completionRules: []
    });
    const controlPlane = createFakeTrustedControlPlane({ now: () => new Date(now) });
    const binding: AttestationChallengeParams = {
      planDigest: compiled.plan.digest as AttestationChallengeParams['planDigest'],
      graphDigest: compiled.graph.digest as AttestationChallengeParams['graphDigest'],
      planRevision: compiled.planRevision,
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake',
      principalRef: 'principal:fake'
    };
    const approvalChallenge = await controlPlane.attestation.beginChallenge(binding);
    const approval = await controlPlane.attestation.recordApproval(approvalChallenge.challengeId, 'approved');
    const modeChallenge = await controlPlane.attestation.beginChallenge(binding);
    const modeSelection = await controlPlane.attestation.recordModeSelection(modeChallenge.challengeId, 'autonomous');
    const attestationResults = new Map<string, any>();
    const adapter = new InMemoryProtectedStoreAdapter();
    const store = new ProtectedControllerStore({ storeId: 'evidence-manager', adapter });
    const writer = await store.openWriter();
    let entropy = 0;
    const manager = createRunAuthorityManagerForTest({
      runId: 'run:evidence-manager',
      projectId: 'project:fake',
      compiled,
      reader: store.reader(),
      writer,
      hostIdentityProvider: controlPlane.identity,
      attestationProvider: {
        reservePair: async request => {
          const verified = await controlPlane.attestation.verifyPair(
            request.approval,
            request.modeSelection,
            request.expected
          );
          if (!verified.ok) throw new Error(verified.reason);
          const reservationId = `attestation:${request.idempotencyKey}`;
          attestationResults.set(reservationId, {
            ok: true,
            reservationId,
            approvalEventId: request.approval.eventId,
            modeSelectionEventId: request.modeSelection.eventId,
            approvalRef: request.approval.verificationRef,
            modeSelectionRef: request.modeSelection.verificationRef,
            mode: request.modeSelection.mode,
            initializationRequestDigest: request.initializationRequestDigest,
            projectId: request.expected.projectId,
            hostSessionRef: request.expected.hostSessionRef,
            principalRef: request.expected.principalRef,
            planDigest: request.expected.planDigest,
            graphDigest: request.expected.graphDigest,
            planRevision: request.expected.planRevision
          });
          return {
            reservationId,
            idempotencyKey: request.idempotencyKey,
            expiresAt: '2026-09-13T00:05:00.000Z'
          };
        },
        verifyReservedPair: async reservationId => attestationResults.get(reservationId),
        reconcileReservedPair: async reservationId => attestationResults.get(reservationId) ?? null
      },
      usageMeter: {
        reserve: async request => ({
          providerReservationId: `provider:${request.idempotencyKey}`,
          idempotencyKey: request.idempotencyKey,
          opaqueScope: request.scope.opaqueScope
        }),
        finalize: async () => ({ ...USAGE, timestamp: '2026-09-13T00:00:04.000Z' }),
        commit: async () => undefined,
        release: async () => undefined
      },
      usageBinding: {
        source: 'trusted-meter',
        provider: 'provider',
        model: 'model',
        priceTableVersion: 'prices-v1',
        currency: 'USD'
      }
    }, {
      now: () => new Date(now),
      monotonicClock: () => 1000,
      clockDomainId: () => 'evidence-manager-clock',
      randomBytes: () => Buffer.alloc(32, ++entropy)
    });
    await manager.initialize({
      idempotencyKey: 'evidence-manager-initialize',
      approval,
      modeSelection
    });
    const controllerLease = await manager.acquireControllerLease();
    const eoNode = compiled.graph.payload.nodes.find(node => node.ownerRole === 'EXECUTION')!;
    const leafNodes = compiled.graph.payload.nodes.filter(node => node.ownerRole === 'LEAF');
    const eo = await manager.issueExecutionTicket({
      operationId: 'spawn-eo',
      controllerProof: controllerProof(controllerLease),
      ticket: {
        nodeId: eoNode.nodeId,
        scope: 'api',
        roots: eoNode.writeSet,
        approvalRefs: [approval.verificationRef],
        budgets: {
          toolActionsGlobal: 10, toolActionsEo: 6, toolActionsLeaf: 4,
          tokensGlobal: 50, tokensEo: 30, tokensLeaf: 20,
          costUsdGlobal: 2, costUsdEo: 1
        },
        expiresAt: '2026-09-13T00:10:00.000Z',
        maxChildDepth: 1,
        maxFanout: 2
      }
    });
    const workstreamLease = await manager.claimExecutionAndAcquireWorkstream({
      handle: eo.handle,
      controllerProof: controllerProof(controllerLease)
    });
    const leaves = [];
    for (const [index, node] of leafNodes.entries()) {
      leaves.push(await manager.issueLeafTicket({
        operationId: `spawn-leaf-${index + 1}`,
        workstreamProof: workstreamProof(workstreamLease),
        ticket: {
          parentHandle: eo.handle,
          nodeId: node.nodeId,
          scope: `leaf-${index + 1}`,
          roots: node.writeSet,
          approvalRefs: [approval.verificationRef],
          budgets: {
            toolActionsGlobal: 2, toolActionsEo: 2, toolActionsLeaf: 2,
            tokensGlobal: 10, tokensEo: 10, tokensLeaf: 10,
            costUsdGlobal: 0.5, costUsdEo: 0.5
          },
          expiresAt: '2026-09-13T00:05:00.000Z',
          maxChildDepth: 0,
          maxFanout: 1
        }
      }));
    }
    const stored = await store.reader().read<any>(authorityRunStoreKey(
      'project:fake',
      'run:evidence-manager'
    ));
    if (stored.status !== 'active') throw new Error('Expected active manager authority');
    const state = stored.record.value;
    const integrationNode = compiled.graph.payload.nodes.find(node =>
      node.ownerRole === 'PLAN_ROOT' && node.nodeType === 'integration' &&
      node.expectedReportKind === 'execution-report/v1')!;
    const rootContext = rootReceiptContext({
      runId: state.runId,
      projectId: state.projectId,
      approvedPlanDigest: state.approvedPlanDigest,
      approvedGraphDigest: state.approvedGraphDigest,
      graphId: state.graphId,
      graphRevision: state.graphRevision,
      graphEpoch: state.graphEpoch,
      cancellationGeneration: state.cancellationGeneration,
      authority: {
        kind: 'controller-root',
        nodeId: integrationNode.nodeId,
        parentNodeId: null,
        role: integrationNode.ownerRole,
        reportDestination: `controller:${integrationNode.nodeId}`,
        reportSchemaRef: integrationNode.expectedReportKind,
        budgetReservationId: 'root-integration-budget',
        writeSet: integrationNode.writeSet,
        criteria: integrationNode.localCriteria
      },
      lease: {
        kind: 'controller',
        ref: controllerLease.leaseRef,
        generation: controllerLease.generation,
        fence: controllerLease.fence,
        status: controllerLease.lifecycle,
        acquiredAt: controllerLease.acquiredAt,
        expiresAt: controllerLease.expiresAt
      },
      usage: {
        ...(rootReceiptContext() as any).usage,
        reservationId: 'root-integration-budget'
      }
    });
    const rootReceipt = validateActionReceipt(receiptClaim(rootContext), rootContext);
    if (!rootReceipt.ok) throw new Error(rootReceipt.reasons.join(','));
    const rootReportContext = reportContext({
      runId: state.runId,
      projectId: state.projectId,
      approvedPlanDigest: state.approvedPlanDigest,
      approvedGraphDigest: state.approvedGraphDigest,
      graphId: state.graphId,
      graphRevision: state.graphRevision,
      graphEpoch: state.graphEpoch,
      cancellationGeneration: state.cancellationGeneration,
      authority: (rootContext as any).authority,
      lease: (rootContext as any).lease,
      receipts: [rootReceipt.evidence],
      evidenceOrder: [rootReceipt.evidence.ref],
      evidence: [
        { ref: 'artifact-a', digest: D2, nodeId: integrationNode.nodeId, kind: 'artifact' },
        { ref: 'evidence-a', digest: D4, nodeId: integrationNode.nodeId, kind: 'test' }
      ],
      budgetReconciliation: {
        reservationId: 'root-integration-budget',
        status: 'committed',
        amounts: { toolActionsEo: 1 },
        actual: { toolActionsEo: 1 },
        sampleDigest: rootReceipt.evidence.usageSampleDigest
      }
    });
    const rootReport = validateExecutionReport(reportClaim(rootReportContext, {
      criterionResults: integrationNode.localCriteria.map(criterionId => ({
        criterionId,
        outcome: 'met',
        evidenceRef: 'evidence-a'
      }))
    }), rootReportContext);
    expect(rootReport.ok).toBe(true);
    const emptyWorkspace = { scope: ['src/api/**'], entries: [] };
    const validated = leaves.map((leaf, index) => {
      const record = state.ticketState.tickets.find((item: any) =>
        item.ticket.ticketHandleId === leaf.handle);
      const reservation = state.budgets.reservations.find((item: any) =>
        item.ticketHandleId === leaf.handle);
      const authority = {
        kind: 'delegation-ticket',
        ref: record.ticket.ticketHandleId,
        handleLineage: [record.parentTicketHandleId, record.ticket.ticketHandleId],
        generation: record.ticket.generation,
        status: record.lifecycle,
        expiresAt: record.ticket.expiresAt,
        nodeId: record.ticket.nodeId,
        parentNodeId: record.ticket.parentNodeId,
        issuerRole: record.ticket.issuerRole,
        recipientRole: record.ticket.recipientRole,
        reportDestination: record.ticket.reportDestination,
        reportSchemaRef: record.ticket.reportSchemaRef,
        parentTicketRef: record.parentTicketHandleId,
        budgetReservationId: reservation.reservationId,
        writeSet: record.ticket.writeSet,
        criteria: record.ticket.criteria
      };
      const lease = {
        kind: 'workstream',
        ref: workstreamLease.leaseRef,
        generation: workstreamLease.generation,
        fence: workstreamLease.fence,
        status: workstreamLease.lifecycle,
        nodeId: workstreamLease.nodeId,
        ticketRef: workstreamLease.ticketHandleId,
        acquiredAt: workstreamLease.acquiredAt,
        expiresAt: workstreamLease.expiresAt
      };
      const action = {
        operation: 'process.exec' as const,
        argv: ['/bin/true'],
        writeSet: [],
        sideEffectClass: 'external' as const
      };
      const context = receiptContext({
        runId: state.runId,
        projectId: state.projectId,
        approvedPlanDigest: state.approvedPlanDigest,
        approvedGraphDigest: state.approvedGraphDigest,
        graphId: state.graphId,
        graphRevision: state.graphRevision,
        graphEpoch: state.graphEpoch,
        cancellationGeneration: state.cancellationGeneration,
        authority,
        lease,
        receiptId: `receipt-manager-leaf-${index + 1}`,
        actionId: `action-manager-leaf-${index + 1}`,
        idempotencyId: `idempotency-manager-leaf-${index + 1}`,
        action,
        intentTimestamp: '2026-09-13T00:00:01.000Z',
        startedAt: '2026-09-13T00:00:02.000Z',
        endedAt: '2026-09-13T00:00:03.000Z',
        receivedAt: '2026-09-13T00:00:05.000Z',
        metadata: { input: deriveOperationMetadataBindings(action), result: { exitCode: 0 } },
        workspace: { before: emptyWorkspace, after: emptyWorkspace, mutations: [] },
        usage: {
          reservationId: reservation.reservationId,
          status: 'pending',
          startedAt: reservation.startedAt,
          deadlineAt: reservation.deadlineAt,
          final: null,
          sampleDigest: null,
          amounts: reservation.amounts,
          currency: state.budgets.currency,
          descendantCommitted: {},
          actual: {}
        },
        artifactHashes: []
      });
      const receipt = validateActionReceipt(receiptClaim(context), context);
      if (!receipt.ok) throw new Error(receipt.reasons.join(','));
      const report = reportContext({
        runId: state.runId,
        projectId: state.projectId,
        approvedPlanDigest: state.approvedPlanDigest,
        approvedGraphDigest: state.approvedGraphDigest,
        graphId: state.graphId,
        graphRevision: state.graphRevision,
        graphEpoch: state.graphEpoch,
        cancellationGeneration: state.cancellationGeneration,
        authority,
        lease,
        reportId: `report-manager-leaf-${index + 1}`,
        receivedAt: '2026-09-13T00:00:05.000Z',
        workspace: { before: emptyWorkspace, after: emptyWorkspace },
        receipts: [receipt.evidence],
        children: [],
        childReports: [],
        evidenceOrder: [receipt.evidence.ref],
        evidence: [{
          ref: `evidence-manager-leaf-${index + 1}`,
          digest: D4,
          nodeId: authority.nodeId,
          kind: 'test'
        }],
        budgetReconciliation: {
          reservationId: reservation.reservationId,
          status: 'pending',
          amounts: reservation.amounts,
          actual: {},
          sampleDigest: null
        },
        budgetContributors: { own: {}, children: {} }
      });
      const reportResult = validateExecutionReport(reportClaim(report, {
        criterionResults: authority.criteria.map((criterionId: string) => ({
          criterionId,
          outcome: 'met',
          evidenceRef: `evidence-manager-leaf-${index + 1}`
        })),
        evidenceRefs: [`evidence-manager-leaf-${index + 1}`]
      }), report);
      if (!reportResult.ok) throw new Error(reportResult.reasons.join(','));
      return { receipt, report: reportResult, context: report };
    });
    expect(validated).toHaveLength(2);
    expect(validated.every(result => result.report.completionBlocked)).toBe(true);
    expect(validated.map(result => result.receipt.evidence.leaseRef)).toEqual([
      workstreamLease.leaseRef,
      workstreamLease.leaseRef
    ]);
    expect(validated.map(result => result.receipt.evidence.parentNodeId))
      .toEqual([workstreamLease.nodeId, workstreamLease.nodeId]);

    const eoRecord = state.ticketState.tickets.find((item: any) =>
      item.ticket.ticketHandleId === eo.handle);
    const eoReservation = state.budgets.reservations.find((item: any) =>
      item.ticketHandleId === eo.handle);
    const eoAuthority = {
      kind: 'delegation-ticket',
      ref: eoRecord.ticket.ticketHandleId,
      handleLineage: [eoRecord.ticket.ticketHandleId],
      generation: eoRecord.ticket.generation,
      status: eoRecord.lifecycle,
      expiresAt: eoRecord.ticket.expiresAt,
      nodeId: eoRecord.ticket.nodeId,
      parentNodeId: eoRecord.ticket.parentNodeId,
      issuerRole: eoRecord.ticket.issuerRole,
      recipientRole: eoRecord.ticket.recipientRole,
      reportDestination: eoRecord.ticket.reportDestination,
      reportSchemaRef: eoRecord.ticket.reportSchemaRef,
      parentTicketRef: eoRecord.parentTicketHandleId,
      budgetReservationId: eoReservation.reservationId,
      writeSet: eoRecord.ticket.writeSet,
      criteria: eoRecord.ticket.criteria
    };
    const eoLease = {
      kind: 'workstream',
      ref: workstreamLease.leaseRef,
      generation: workstreamLease.generation,
      fence: workstreamLease.fence,
      status: workstreamLease.lifecycle,
      nodeId: workstreamLease.nodeId,
      ticketRef: workstreamLease.ticketHandleId,
      acquiredAt: workstreamLease.acquiredAt,
      expiresAt: workstreamLease.expiresAt
    };
    const spawnReceipts = validated.map((leaf, index) => {
      const action = {
        operation: 'agent.spawn' as const,
        agentRef: (leaf.context as any).authority.nodeId,
        writeSet: [],
        sideEffectClass: 'external' as const
      };
      const context = receiptContext({
        runId: state.runId,
        projectId: state.projectId,
        approvedPlanDigest: state.approvedPlanDigest,
        approvedGraphDigest: state.approvedGraphDigest,
        graphId: state.graphId,
        graphRevision: state.graphRevision,
        graphEpoch: state.graphEpoch,
        cancellationGeneration: state.cancellationGeneration,
        authority: eoAuthority,
        lease: eoLease,
        receiptId: `receipt-manager-spawn-leaf-${index + 1}`,
        actionId: `action-manager-spawn-leaf-${index + 1}`,
        idempotencyId: `idempotency-manager-spawn-leaf-${index + 1}`,
        action,
        intentTimestamp: `2026-09-13T00:00:00.${index + 2}00Z`,
        startedAt: `2026-09-13T00:00:00.${index + 3}00Z`,
        endedAt: `2026-09-13T00:00:00.${index + 4}00Z`,
        receivedAt: '2026-09-13T00:00:05.000Z',
        metadata: {
          input: deriveOperationMetadataBindings(action),
          result: { childTicketRef: (leaf.context as any).authority.ref }
        },
        workspace: { before: emptyWorkspace, after: emptyWorkspace, mutations: [] },
        usage: {
          reservationId: eoReservation.reservationId,
          status: 'pending',
          startedAt: eoReservation.startedAt,
          deadlineAt: eoReservation.deadlineAt,
          final: null,
          sampleDigest: null,
          amounts: eoReservation.amounts,
          currency: state.budgets.currency,
          descendantCommitted: {},
          actual: {}
        },
        artifactHashes: []
      });
      const receipt = validateActionReceipt(receiptClaim(context), context);
      if (!receipt.ok) throw new Error(receipt.reasons.join(','));
      return receipt.evidence;
    });
    const eoContext = reportContext({
      runId: state.runId,
      projectId: state.projectId,
      approvedPlanDigest: state.approvedPlanDigest,
      approvedGraphDigest: state.approvedGraphDigest,
      graphId: state.graphId,
      graphRevision: state.graphRevision,
      graphEpoch: state.graphEpoch,
      cancellationGeneration: state.cancellationGeneration,
      receivedAt: '2026-09-13T00:00:06.000Z',
      authority: eoAuthority,
      lease: eoLease,
      reportId: 'report-manager-eo',
      workspace: { before: emptyWorkspace, after: emptyWorkspace },
      receipts: spawnReceipts,
      children: validated.map(leaf => childBindingFor(leaf.context, leaf.report.evidence))
        .sort((left, right) => left.ticketRef < right.ticketRef ? -1 : left.ticketRef > right.ticketRef ? 1 : 0),
      childReports: validated.map(leaf => leaf.report.evidence),
      evidenceOrder: evidenceSourceOrder([
        ...spawnReceipts,
        ...validated.map(leaf => leaf.report.evidence)
      ]).map(source => source.ref),
      evidence: [
        { ref: 'evidence-manager-eo', digest: D3, nodeId: eoAuthority.nodeId, kind: 'test' },
        ...validated.flatMap(leaf => leaf.report.evidence.evidenceRecords)
      ],
      budgetReconciliation: {
        reservationId: eoReservation.reservationId,
        status: 'pending',
        amounts: eoReservation.amounts,
        actual: {},
        sampleDigest: null
      },
      subtreeActual: {},
      budgetContributors: { own: {}, children: {} }
    });
    const eoClaim = reportClaim(eoContext, {
      criterionResults: eoAuthority.criteria.map((criterionId: string) => ({
        criterionId,
        outcome: 'met',
        evidenceRef: 'evidence-manager-eo'
      })),
      evidenceRefs: [
        'evidence-manager-eo',
        ...validated.flatMap(leaf => leaf.report.evidence.evidenceRefs)
      ].sort(),
      startedAt: '2026-09-13T00:00:00.100Z',
      endedAt: '2026-09-13T00:00:05.500Z'
    });
    const eoReport = validateExecutionReport(eoClaim, eoContext);
    if (!eoReport.ok) throw new Error(eoReport.reasons.join(','));
    const managerRoot = rootContextForEo(
      eoContext,
      eoReport.evidence,
      { before: emptyWorkspace, after: emptyWorkspace },
      {
        authority: (() => {
          const node = compiled.graph.payload.nodes.find(candidate =>
            candidate.nodeId === eoAuthority.parentNodeId)!;
          return {
            kind: 'controller-root',
            nodeId: node.nodeId,
            parentNodeId: null,
            role: 'PLAN_ROOT',
            reportDestination: `controller:${node.nodeId}`,
            reportSchemaRef: 'execution-report/v1',
            budgetReservationId: 'root-integration-budget',
            writeSet: node.writeSet,
            criteria: node.localCriteria
          };
        })(),
        lease: (rootContext as any).lease
      }
    );
    const aggregated = validateExecutionReport(rootClaimForEo(managerRoot), managerRoot);
    expect(aggregated.ok).toBe(true);
    if (aggregated.ok) {
      expect(aggregated.evidence.childBindings.map(child => child.reportDestination).sort()).toEqual([
        eoAuthority.reportDestination,
        ...validated.map(leaf => (leaf.context as any).authority.reportDestination)
      ].sort());
      expect(aggregated.evidence.descendantTicketRefs).toHaveLength(3);
      expect(aggregated.evidence.descendantReportRefs).toHaveLength(3);
    }
  });

  test('bounds oversized object keys and aggregate strings before envelope parsing', () => {
    const oversizedKey = 'k'.repeat(EVIDENCE_DATA_LIMITS.keyBytes + 1);
    expect(reasons(validateActionReceipt({ [oversizedKey]: true }, receiptContext())))
      .toEqual(['malformed-envelope']);

    const aggregate = {
      kind: 'action-receipt/v1',
      schemaVersion: 1,
      id: 'aggregate',
      payload: Array.from({ length: 300 }, () => 'x'.repeat(EVIDENCE_DATA_LIMITS.stringBytes)),
      digest: D0
    };
    expect(reasons(validateActionReceipt(aggregate, receiptContext())))
      .toEqual(['malformed-envelope']);
  });

  test('requires every fingerprint entry inside scope and rejects Win32 aliases', () => {
    expect(() => computeWorkspaceFingerprint({
      scope: ['src/**'],
      entries: [{ path: 'test/a.ts', kind: 'missing', contentDigest: null, target: null, size: 0 }]
    })).toThrow(expect.objectContaining({ code: 'entry-outside-scope' }));
    for (const path of [
      'src/file. ', 'src/file.', 'src/file:stream', 'src/a<b', 'src/CON', 'src/CONIN$',
      'src/com1.txt', 'src/COM¹.log', 'src/lpt²', 'src/LPT³.txt', 'NUL'
    ]) {
      expect(() => computeWorkspaceFingerprint({
        scope: path.startsWith('src/') ? ['src/**'] : ['NUL'],
        entries: [{ path, kind: 'missing', contentDigest: null, target: null, size: 0 }]
      })).toThrow(WorkspaceFingerprintError);
    }
  });

  test('requires equal snapshot scope and mutation representation on both sides', () => {
    const scopeContext = receiptContext({
      workspace: {
        before: BEFORE,
        after: { ...AFTER, scope: ['src/**', 'test/**'] },
        mutations: ['src/a.ts']
      }
    });
    expect(reasons(validateActionReceipt(receiptClaim(scopeContext), scopeContext))).toContain('scope-mismatch');

    const missingContext = receiptContext({
      workspace: {
        before: { ...BEFORE, entries: BEFORE.entries.filter(entry => entry.path !== 'src/a.ts') },
        after: AFTER,
        mutations: ['src/a.ts']
      }
    });
    expect(reasons(validateActionReceipt(receiptClaim(missingContext), missingContext)))
      .toContain('mutation-snapshot-mismatch');
  });

  test('binds receipt timestamps exactly to protected mediator intent', () => {
    const context = receiptContext();
    const result = validateActionReceipt(receiptClaim(context, {
      intentTimestamp: '2026-09-13T00:00:02.500Z',
      startedAt: '2026-09-13T00:00:03.500Z',
      endedAt: '2026-09-13T00:00:04.500Z'
    }), context);
    expect(reasons(result)).toContain('timestamp-binding-mismatch');
  });

  test('cross-checks operation-bound metadata against structured action', () => {
    const context = receiptContext({
      metadata: {
        input: { contentDigest: D2, declaredBytes: 2, path: 'src/b.ts' },
        result: { bytesWritten: 2, changed: true }
      }
    });
    expect(reasons(validateActionReceipt(receiptClaim(context), context)))
      .toContain('operation-metadata-mismatch');

    const networkAction = {
      operation: 'network.request' as const,
      url: 'https://example.test/resource',
      method: 'GET',
      writeSet: [],
      sideEffectClass: 'external' as const
    };
    const bindings = deriveOperationMetadataBindings(networkAction);
    expect(bindings.method).toBe('GET');
    const networkContext = receiptContext({
      action: networkAction,
      metadata: {
        input: { ...bindings, method: 'POST' },
        result: { statusCode: 200 }
      },
      workspace: { before: AFTER, after: AFTER, mutations: [] }
    });
    expect(reasons(validateActionReceipt(receiptClaim(networkContext), networkContext)))
      .toContain('operation-metadata-mismatch');
  });

  test.each([
    [{ operation: 'process.exec', argv: ['/path with space/bin', '--flag'], writeSet: [], sideEffectClass: 'external' }, 'argvDigest'],
    [{ operation: 'git.mutate', args: ['commit', '-m', 'message'], writeSet: ['src/**'], sideEffectClass: 'workspace' }, 'argsDigest'],
    [{ operation: 'package.hook', hook: 'postinstall', writeSet: [], sideEffectClass: 'external' }, 'hook'],
    [{ operation: 'agent.spawn', agentRef: 'leaf-1', writeSet: [], sideEffectClass: 'external' }, 'agentRef'],
    [{ operation: 'tool.invoke', tool: 'jest', argumentsDigest: D2, writeSet: [], sideEffectClass: 'external' }, 'toolRef']
  ])('derives and enforces metadata binding for $operation', (action, bindingKey) => {
    const bindings = deriveOperationMetadataBindings(action as any);
    expect(bindings[bindingKey]).toBeDefined();
    const context = receiptContext({
      action,
      metadata: { input: { ...bindings, [bindingKey]: bindingKey.endsWith('Digest') ? D4 : 'wrong' }, result: {} },
      workspace: { before: AFTER, after: AFTER, mutations: [] }
    });
    expect(reasons(validateActionReceipt(receiptClaim(context), context)))
      .toContain('operation-metadata-mismatch');
  });

  test.each([
    ['pending with final', 'pending', USAGE, computeUsageSampleDigest(USAGE), { toolActionsEo: 1 }],
    ['released with final', 'released', USAGE, computeUsageSampleDigest(USAGE), { toolActionsEo: 1 }],
    ['unresolved with final', 'unresolved', USAGE, computeUsageSampleDigest(USAGE), { toolActionsEo: 1 }],
    ['committed without final', 'committed', null, D4, { toolActionsEo: 1 }]
  ])('rejects impossible usage lifecycle: %s', (_label, status, final, sampleDigest, actual) => {
    const context = receiptContext({
      usage: {
        ...(receiptContext() as any).usage,
        status,
        final,
        sampleDigest,
        actual
      }
    });
    expect(reasons(validateActionReceipt(receiptClaim(context), context))).toContain('trusted-context-invalid');
  });

  test('rejects final usage sampled before effect end or after receipt arrival', () => {
    for (const timestamp of ['2026-09-13T00:00:03.500Z', '2026-09-13T00:00:07.000Z']) {
      const usage = { ...USAGE, timestamp };
      const context = receiptContext({
        usage: {
          ...(receiptContext() as any).usage,
          final: usage,
          sampleDigest: computeUsageSampleDigest(usage)
        }
      });
      expect(reasons(validateActionReceipt(receiptClaim(context), context))).toContain('timestamp-window-invalid');
    }
  });

  test('receipt evidence retains complete authority and usage lineage', () => {
    const result = validReceipt();
    expect(result.evidence).toMatchObject({
      validation: 'valid',
      authority: false,
      runId: 'run-1',
      projectId: 'project-1',
      approvedPlanDigest: D0,
      approvedGraphDigest: D1,
      graphRevision: 2,
      graphEpoch: 3,
      cancellationGeneration: 4,
      ticketGeneration: 5,
      leaseRef: 'lease-workstream-1',
      leaseGeneration: 6,
      leaseFence: 7,
      handleLineage: ['ticket-eo-1'],
      usageReservationId: 'ticket-budget-1',
      usageStatus: 'committed',
      usageSampleDigest: computeUsageSampleDigest(USAGE),
      workspaceScope: ['src/**'],
      usageAmounts: { toolActionsEo: 1 },
      usageCurrency: 'USD',
      usageDescendantCommitted: {},
      workspaceBefore: BEFORE,
      workspaceAfter: AFTER
    });
  });

  test.each([
    ['graph epoch', { graphEpoch: 4 }],
    ['cancellation generation', { cancellationGeneration: 5 }],
    ['ticket generation', { ticketGeneration: 6 }],
    ['lease generation', { leaseGeneration: 7 }],
    ['lease fence', { leaseFence: 8 }]
  ])('rejects forged future %s instead of quarantining', (_label, override) => {
    const context = receiptContext();
    const result = validateActionReceipt(receiptClaim(context, override), context);
    expect(result.classification).toBe('rejected');
    expect(result.reasons).toContain('future-authority-claim');
  });

  test('binds LEAF lineage to exact trusted parent ticket', () => {
    const baseline = receiptContext() as any;
    const ticket = {
      ...baseline.authority,
      ref: 'ticket-leaf-1',
      parentTicketRef: 'ticket-eo-1',
      handleLineage: ['ticket-arbitrary', 'ticket-leaf-1'],
      issuerRole: 'EXECUTION',
      recipientRole: 'LEAF'
    };
    const context = receiptContext({ authority: ticket });
    expect(reasons(validateActionReceipt(receiptClaim(context), context))).toContain('trusted-context-invalid');
  });

  test('rejects budget overshoot, fractional counts, released actuals, and wrong ticket reservation', () => {
    const context = reportContext();
    const overshoot = {
      ...((context as any).budgetReconciliation),
      amounts: { toolActionsEo: 1 },
      actual: { toolActionsEo: 2 }
    };
    expect(reasons(validateExecutionReport(reportClaim(context, { budgetReconciliation: overshoot }), context)))
      .toContain('malformed-payload');
    const fractional = {
      ...((context as any).budgetReconciliation),
      amounts: { toolActionsEo: 1.5 },
      actual: { toolActionsEo: 1.5 }
    };
    expect(reasons(validateExecutionReport(reportClaim(context, { budgetReconciliation: fractional }), context)))
      .toContain('malformed-payload');
    const released = {
      reservationId: 'ticket-budget-1', status: 'released', amounts: { toolActionsEo: 1 },
      actual: { toolActionsEo: 1 }, sampleDigest: D4
    };
    expect(reasons(validateExecutionReport(reportClaim(context, { budgetReconciliation: released }), context)))
      .toContain('malformed-payload');
    const wrongReservation = {
      ...((context as any).budgetReconciliation), reservationId: 'ticket-budget-forged'
    };
    expect(reasons(validateExecutionReport(reportClaim(context, { budgetReconciliation: wrongReservation }), context)))
      .toContain('budget-reconciliation-mismatch');
  });

  test('matching but internally impossible trusted budget cannot validate', () => {
    const impossible = {
      reservationId: 'ticket-budget-1', status: 'committed', amounts: { toolActionsEo: 1 },
      actual: { toolActionsEo: 2 }, sampleDigest: D4
    };
    const context = reportContext({ budgetReconciliation: impossible });
    const result = validateExecutionReport(reportClaim(context), context);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('trusted-context-invalid');
  });

  test('validates exact EO child report closure and aggregate mutation/action/budget evidence', () => {
    const child = validChildBundle();
    const direct = validReceipt().evidence;
    const spawn = validSpawnReceipt(child.child, BEFORE, 'exact', (receiptContext() as any).usage);
    const context = reportContext({
      receipts: [spawn, direct],
      children: [child.child],
      childReports: [child.report],
      evidenceOrder: [spawn.ref, direct.ref, child.report.ref],
      workspace: { before: BEFORE, after: AFTER_CHILD },
      budgetReconciliation: {
        reservationId: 'ticket-budget-1',
        status: 'committed',
        amounts: direct.usageAmounts,
        actual: direct.usageActual,
        sampleDigest: direct.usageSampleDigest
      },
      subtreeActual: { toolActionsEo: 1, toolActionsLeaf: 1 },
      budgetContributors: {
        own: { toolActionsEo: 1 },
        children: { toolActionsLeaf: 1 }
      }
    });
    const result = validateExecutionReport(reportClaim(context), context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.completionBlocked).toBe(false);
      expect(result.envelope.payload.childReportRefs).toEqual([child.report.ref]);
      expect(result.envelope.payload.actions).toEqual(['action-1', 'action-leaf-1', 'action-spawn-exact']);
      expect(result.authority).toBe(false);
    }
  });

  test('requires exactly one successful committed direct spawn receipt per child', () => {
    const child = validChildBundle();
    const valid = reportWithChildren([child], { before: AFTER, after: AFTER_CHILD }) as any;
    expect(validateExecutionReport(reportClaim(valid), valid).ok).toBe(true);

    const missing = { ...valid, receipts: [], evidenceOrder: [child.report.ref] };
    expect(reasons(validateExecutionReport(reportClaim(missing), missing))).toContain('child-spawn-mismatch');

    const spawn = valid.receipts[0];
    const duplicateReceipt = {
      ...spawn,
      ref: 'receipt-spawn-duplicate',
      envelopeDigest: D4,
      actionId: 'action-spawn-duplicate',
      idempotencyId: 'idempotency-spawn-duplicate'
    };
    const duplicate = {
      ...valid,
      receipts: [spawn, duplicateReceipt],
      evidenceOrder: [spawn.ref, duplicateReceipt.ref, child.report.ref]
    };
    expect(reasons(validateExecutionReport(reportClaim(duplicate), duplicate))).toContain('child-spawn-mismatch');

    const unknown = {
      ...valid,
      receipts: [{ ...spawn, childTicketRef: 'ticket-leaf-unknown' }]
    };
    expect(reasons(validateExecutionReport(reportClaim(unknown), unknown))).toContain('child-spawn-mismatch');
  });

  test('composes disjoint parallel children with narrower scopes', () => {
    const before = {
      scope: ['src/**'],
      entries: [
        { path: 'src/b.ts', kind: 'missing' as const, contentDigest: null, target: null, size: 0 },
        { path: 'src/c.ts', kind: 'missing' as const, contentDigest: null, target: null, size: 0 }
      ]
    };
    const after = {
      scope: ['src/**'],
      entries: [
        { path: 'src/b.ts', kind: 'file' as const, contentDigest: D2, target: null, size: 2 },
        { path: 'src/c.ts', kind: 'file' as const, contentDigest: D3, target: null, size: 3 }
      ]
    };
    const childB = validChildBundle({
      suffix: 'b', path: 'src/b.ts', nodeId: 'leaf-b',
      before: { scope: ['src/b.ts'], entries: [before.entries[0]] } as any,
      after: { scope: ['src/b.ts'], entries: [after.entries[0]] } as any
    });
    const childC = validChildBundle({
      suffix: 'c', path: 'src/c.ts', nodeId: 'leaf-c',
      before: { scope: ['src/c.ts'], entries: [before.entries[1]] } as any,
      after: { scope: ['src/c.ts'], entries: [after.entries[1]] } as any
    });
    const context = reportWithChildren([childB, childC], { before, after });
    expect(childB.child.leaseRef).toBe(childC.child.leaseRef);
    expect(childB.child.leaseNodeId).toBe('workstream-core');
    expect(childC.child.leaseTicketRef).toBe('ticket-eo-1');
    const result = validateExecutionReport(reportClaim(context), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.workspaceScope).toEqual(['src/**']);
    expect(result.evidence.childReportRefs).toEqual(['report-leaf-b', 'report-leaf-c']);
    expect(result.evidence.criterionResults.map(item => item.nodeId)).toEqual([
      'leaf-b', 'leaf-c', 'workstream-core'
    ]);
    expect(result.evidence.evidenceOrder).toEqual([
      'receipt-spawn-1', 'receipt-spawn-2', 'report-leaf-b', 'report-leaf-c'
    ]);
  });

  test('rejects reverse-time audit order and unsafe concurrent overlap', () => {
    const missing = {
      scope: ['src/b.ts'],
      entries: [{ path: 'src/b.ts', kind: 'missing' as const, contentDigest: null, target: null, size: 0 }]
    };
    const written = {
      scope: ['src/b.ts'],
      entries: [{ path: 'src/b.ts', kind: 'file' as const, contentDigest: D2, target: null, size: 2 }]
    };
    const first = validChildBundle({ suffix: 'overlap-a', path: 'src/b.ts', before: missing as any, after: written as any });
    const second = validChildBundle({ suffix: 'overlap-b', path: 'src/b.ts', before: missing as any, after: written as any });
    const parentBefore = { ...missing, scope: ['src/**'] };
    const parentAfter = { ...written, scope: ['src/**'] };

    const reverse = reportWithChildren(
      [first, validChildBundle({
        suffix: 'later', path: 'src/c.ts',
        before: {
          scope: ['src/c.ts'],
          entries: [{ path: 'src/c.ts', kind: 'missing', contentDigest: null, target: null, size: 0 }]
        } as any,
        after: {
          scope: ['src/c.ts'],
          entries: [{ path: 'src/c.ts', kind: 'file', contentDigest: D3, target: null, size: 3 }]
        } as any,
        reportStartedAt: '2026-09-13T00:00:04.150Z',
        reportEndedAt: '2026-09-13T00:00:04.850Z'
      })],
      {
        before: {
          scope: ['src/**'],
          entries: [parentBefore.entries[0], {
            path: 'src/c.ts', kind: 'missing', contentDigest: null, target: null, size: 0
          }]
        },
        after: {
          scope: ['src/**'],
          entries: [parentAfter.entries[0], {
            path: 'src/c.ts', kind: 'file', contentDigest: D3, target: null, size: 3
          }]
        }
      },
      ['report-leaf-later', first.report.ref]
    );
    expect(reasons(validateExecutionReport(reportClaim(reverse), reverse)))
      .toContain('receipt-continuity-mismatch');

    const overlap = reportWithChildren([first, second], { before: parentBefore, after: parentAfter });
    expect(reasons(validateExecutionReport(reportClaim(overlap), overlap)))
      .toContain('receipt-continuity-mismatch');
  });

  test('allows safely serialized write-then-restore while retaining touched path', () => {
    const missing = {
      scope: ['src/b.ts'],
      entries: [{ path: 'src/b.ts', kind: 'missing' as const, contentDigest: null, target: null, size: 0 }]
    };
    const written = {
      scope: ['src/b.ts'],
      entries: [{ path: 'src/b.ts', kind: 'file' as const, contentDigest: D2, target: null, size: 2 }]
    };
    const write = validChildBundle({
      suffix: 'write', path: 'src/b.ts', before: missing as any, after: written as any,
      reportStartedAt: '2026-09-13T00:00:02.100Z',
      intentAt: '2026-09-13T00:00:02.200Z',
      actionStartedAt: '2026-09-13T00:00:02.300Z',
      actionEndedAt: '2026-09-13T00:00:03.000Z',
      usageAt: '2026-09-13T00:00:03.100Z',
      receiptReceivedAt: '2026-09-13T00:00:03.200Z',
      reportEndedAt: '2026-09-13T00:00:04.600Z',
      reportReceivedAt: '2026-09-13T00:00:04.700Z'
    });
    const restore = validChildBundle({
      suffix: 'restore', path: 'src/b.ts', before: written as any, after: missing as any, operation: 'fs.delete',
      reportStartedAt: '2026-09-13T00:00:03.600Z',
      intentAt: '2026-09-13T00:00:03.700Z',
      actionStartedAt: '2026-09-13T00:00:03.800Z',
      actionEndedAt: '2026-09-13T00:00:04.300Z',
      usageAt: '2026-09-13T00:00:04.400Z',
      receiptReceivedAt: '2026-09-13T00:00:04.500Z',
      reportEndedAt: '2026-09-13T00:00:04.700Z',
      reportReceivedAt: '2026-09-13T00:00:04.800Z'
    });
    const disjointBefore = {
      scope: ['src/c.ts'],
      entries: [{ path: 'src/c.ts', kind: 'missing' as const, contentDigest: null, target: null, size: 0 }]
    };
    const disjointAfter = {
      scope: ['src/c.ts'],
      entries: [{ path: 'src/c.ts', kind: 'file' as const, contentDigest: D3, target: null, size: 3 }]
    };
    const disjoint = validChildBundle({
      suffix: 'intervening', path: 'src/c.ts', before: disjointBefore as any, after: disjointAfter as any,
      reportStartedAt: '2026-09-13T00:00:03.000Z',
      intentAt: '2026-09-13T00:00:03.100Z',
      actionStartedAt: '2026-09-13T00:00:03.200Z',
      actionEndedAt: '2026-09-13T00:00:03.400Z',
      usageAt: '2026-09-13T00:00:03.450Z',
      receiptReceivedAt: '2026-09-13T00:00:03.500Z',
      reportEndedAt: '2026-09-13T00:00:04.000Z',
      reportReceivedAt: '2026-09-13T00:00:04.100Z'
    });
    const parentBefore = {
      scope: ['src/**'],
      entries: [missing.entries[0], disjointBefore.entries[0]]
    };
    const parentAfter = {
      scope: ['src/**'],
      entries: [missing.entries[0], disjointAfter.entries[0]]
    };
    const context = reportWithChildren([write, disjoint, restore], {
      before: parentBefore,
      after: parentAfter
    });
    const result = validateExecutionReport(reportClaim(context), context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.payload.mutations).toEqual(['src/b.ts', 'src/c.ts']);
  });

  test('rejects effect chain whose first snapshot is foreign to parent state', () => {
    const child = validChildBundle();
    const foreignBefore = {
      scope: ['src/**'],
      entries: [
        AFTER.entries[0],
        { path: 'src/b.ts', kind: 'file' as const, contentDigest: D4, target: null, size: 4 }
      ]
    };
    const context = reportWithChildren([child], { before: foreignBefore, after: AFTER_CHILD });
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toContain('receipt-continuity-mismatch');
  });

  test('rejects duplicate, unrelated, and stale child reports directionally', () => {
    const child = validChildBundle();
    const direct = validReceipt().evidence;
    const spawn = validSpawnReceipt(child.child, BEFORE, 'stale', (receiptContext() as any).usage);
    const base = {
      receipts: [spawn, direct],
      children: [child.child],
      evidenceOrder: [spawn.ref, direct.ref, child.report.ref],
      workspace: { before: BEFORE, after: AFTER_CHILD },
      budgetReconciliation: {
        reservationId: 'ticket-budget-1', status: 'committed',
        amounts: direct.usageAmounts,
        actual: direct.usageActual,
        sampleDigest: direct.usageSampleDigest
      },
      subtreeActual: { toolActionsEo: 1, toolActionsLeaf: 1 },
      budgetContributors: { own: { toolActionsEo: 1 }, children: { toolActionsLeaf: 1 } }
    };
    const duplicate = reportContext({ ...base, childReports: [child.report, child.report] });
    expect(reasons(validateExecutionReport(reportClaim(duplicate, {
      childReportRefs: [child.report.ref]
    }), duplicate)))
      .toContain('child-report-duplicate');
    const unrelatedReport = { ...child.report, ticketRef: 'ticket-unrelated' };
    const unrelated = reportContext({ ...base, childReports: [unrelatedReport] });
    expect(reasons(validateExecutionReport(reportClaim(unrelated), unrelated)))
      .toContain('child-report-unrelated');
    const staleReceipts = child.report.actionReceipts.map(receipt => resealReceiptEvidence(receipt, {
      leaseGeneration: receipt.leaseGeneration - 1
    }));
    const staleReport = resealReportEvidence(child.report, {
      leaseGeneration: child.report.leaseGeneration - 1,
      actionReceipts: staleReceipts
    });
    const stale = reportContext({
      ...base,
      children: [{ ...child.child, reportEnvelopeDigest: staleReport.envelopeDigest }],
      childReports: [staleReport]
    });
    const staleResult = validateExecutionReport(reportClaim(stale), stale);
    expect(staleResult.classification).toBe('quarantined');
    expect(staleResult.reasons).toContain('lease-generation-drift');
  });

  test('rejects duplicated/self child authority identities and quarantines stale child lifecycle', () => {
    const child = validChildBundle();
    const workspace = { before: AFTER, after: AFTER_CHILD };
    const duplicate = reportWithChildren([child, child], workspace);
    expect(reasons(validateExecutionReport(reportClaim(duplicate, {
      childLineage: [child.child.ticketRef],
      childReportRefs: [child.report.ref],
      evidenceOrder: [child.report.ref]
    }), duplicate))).toEqual(['trusted-context-invalid']);

    const selfChild = {
      ...child.child,
      ticketRef: 'ticket-eo-1',
      handleLineage: ['ticket-eo-1', 'ticket-eo-1']
    };
    const self = reportContext({ receipts: [], children: [selfChild], childReports: [], evidenceOrder: [] });
    expect(reasons(validateExecutionReport(reportClaim(self), self)))
      .toEqual(expect.arrayContaining(['trusted-context-invalid', 'child-lineage-illegal']));

    for (const staleChild of [
      { ...child.child, expiresAt: '2026-09-13T00:00:05.500Z' },
      { ...child.child, leaseStatus: 'released' as const },
      { ...child.child, leaseStatus: 'unresolved' as const }
    ]) {
      const stale = reportWithChildren([{ child: staleChild, report: child.report } as any], workspace);
      expect(validateExecutionReport(reportClaim(stale), stale).classification).toBe('quarantined');
    }
    const leaseMismatch = reportWithChildren([{
      child: { ...child.child, leaseExpiresAt: '2026-09-13T00:00:05.500Z' },
      report: child.report
    } as any], workspace);
    expect(reasons(validateExecutionReport(reportClaim(leaseMismatch), leaseMismatch)))
      .toContain('child-lineage-illegal');
  });

  test('closes child action identities and child-owned evidence references', () => {
    const child = validChildBundle();
    const workspace = { before: AFTER, after: AFTER_CHILD };
    for (const report of [
      { ...child.report, actions: [] },
      { ...child.report, actions: [...child.report.actions, 'phantom-action'].sort() },
      { ...child.report, actionReceipts: [...child.report.actionReceipts, child.report.actionReceipts[0]] }
    ]) {
      const context = reportWithChildren([{ child: child.child, report } as any], workspace);
      expect(reasons(validateExecutionReport(reportClaim(context), context)))
        .toContain('idempotency-conflict');
    }

    const complete = reportWithChildren([child], workspace) as any;
    const missingEvidence = {
      ...complete,
      evidence: complete.evidence.filter((record: any) => record.ref !== child.report.evidenceRefs[0])
    };
    expect(reasons(validateExecutionReport(reportClaim(missingEvidence), missingEvidence)))
      .toContain('evidence-reference-open');

    const wrongOwner = {
      ...complete,
      evidence: complete.evidence.map((record: any) => child.report.evidenceRefs.includes(record.ref)
        ? { ...record, nodeId: 'wrong-child-node' } : record)
    };
    expect(reasons(validateExecutionReport(reportClaim(wrongOwner), wrongOwner)))
      .toContain('evidence-reference-open');
  });

  test('revalidates full nested receipt authority and child time window', () => {
    const child = validChildBundle();
    const workspace = { before: AFTER, after: AFTER_CHILD };
    const forgedAuthority = {
      ...child.report,
      actionReceipts: child.report.actionReceipts.map(receipt => ({
        ...receipt,
        reportDestination: 'controller:forged'
      }))
    };
    const authorityContext = reportWithChildren([
      { child: child.child, report: forgedAuthority } as any
    ], workspace);
    expect(reasons(validateExecutionReport(reportClaim(authorityContext), authorityContext)))
      .toContain('child-report-unrelated');

    const forgedWindow = {
      ...child.report,
      actionReceipts: child.report.actionReceipts.map(receipt => ({
        ...receipt,
        startedAt: '2026-09-13T00:00:03.000Z'
      }))
    };
    const windowContext = reportWithChildren([
      { child: child.child, report: forgedWindow } as any
    ], workspace);
    expect(reasons(validateExecutionReport(reportClaim(windowContext), windowContext)))
      .toContain('timestamp-window-invalid');
  });

  test('rejects stale and future direct receipt evidence directionally', () => {
    const context = reportContext() as any;
    const staleReceipt = resealReceiptEvidence(context.receipts[0], {
      cancellationGeneration: 3, leaseFence: 6
    });
    const stale = reportContext({ receipts: [staleReceipt] });
    const staleResult = validateExecutionReport(reportClaim(stale), stale);
    expect(staleResult.classification).toBe('quarantined');
    expect(staleResult.reasons).toEqual(expect.arrayContaining(['lease-generation-drift', 'cancellation-late']));

    const futureReceipt = resealReceiptEvidence(context.receipts[0], { ticketGeneration: 6 });
    const future = reportContext({ receipts: [futureReceipt] });
    const futureResult = validateExecutionReport(reportClaim(future), future);
    expect(futureResult.classification).toBe('rejected');
    expect(futureResult.reasons).toContain('future-authority-claim');
  });

  test('rejects duplicate idempotency identity across direct and child receipts', () => {
    const child = validChildBundle();
    const conflictingChild = {
      ...child.report,
      actionReceipts: child.report.actionReceipts.map(receipt => ({
        ...receipt,
        idempotencyId: 'idempotency-1'
      }))
    };
    const context = reportContext({
      children: [child.child],
      childReports: [conflictingChild],
      evidenceOrder: ['receipt-1', conflictingChild.ref],
      workspace: { before: BEFORE, after: AFTER_CHILD },
      budgetReconciliation: {
        reservationId: 'ticket-budget-1', status: 'committed',
        amounts: { toolActionsEo: 1, toolActionsLeaf: 1 },
        actual: { toolActionsEo: 1, toolActionsLeaf: 1 }, sampleDigest: D4
      },
      budgetContributors: { own: { toolActionsEo: 1 }, children: { toolActionsLeaf: 1 } }
    });
    expect(reasons(validateExecutionReport(reportClaim(context), context))).toContain('idempotency-conflict');
  });

  test('deduplicates ticket reservation usage across direct receipts and rejects conflicts', () => {
    const first = validReceipt().evidence;
    const action = {
      operation: 'process.exec' as const,
      argv: ['/bin/true'],
      writeSet: [],
      sideEffectClass: 'external' as const
    };
    const secondContext = receiptContext({
      receiptId: 'receipt-2',
      actionId: 'action-2',
      idempotencyId: 'idempotency-2',
      action,
      intentTimestamp: '2026-09-13T00:00:04.000Z',
      startedAt: '2026-09-13T00:00:04.000Z',
      endedAt: '2026-09-13T00:00:04.000Z',
      metadata: {
        input: deriveOperationMetadataBindings(action),
        result: { exitCode: 0 }
      },
      workspace: { before: AFTER, after: AFTER, mutations: [] },
      artifactHashes: []
    });
    const secondResult = validateActionReceipt(receiptClaim(secondContext), secondContext);
    if (!secondResult.ok) throw new Error(secondResult.reasons.join(','));
    const context = reportContext({
      receipts: [first, secondResult.evidence],
      evidenceOrder: [first.ref, secondResult.evidence.ref]
    });
    const result = validateExecutionReport(reportClaim(context), context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.actionReceipts).toHaveLength(2);
      expect(Object.isFrozen(result.evidence.actionReceipts[0].workspaceBefore.entries)).toBe(true);
    }

    const conflictingReceipt = { ...secondResult.evidence, usageCurrency: 'EUR' };
    const conflicting = reportContext({
      receipts: [first, conflictingReceipt],
      evidenceOrder: [first.ref, conflictingReceipt.ref]
    });
    expect(reasons(validateExecutionReport(reportClaim(conflicting), conflicting)))
      .toContain('usage-reconciliation-mismatch');
  });

  test('rejects stale no-op observation hidden behind a prior mutation', () => {
    const first = validReceipt().evidence;
    const action = {
      operation: 'process.exec' as const,
      argv: ['/bin/true'],
      writeSet: [],
      sideEffectClass: 'external' as const
    };
    const staleContext = receiptContext({
      receiptId: 'receipt-stale-observation',
      actionId: 'action-stale-observation',
      idempotencyId: 'idempotency-stale-observation',
      action,
      intentTimestamp: '2026-09-13T00:00:04.000Z',
      startedAt: '2026-09-13T00:00:04.000Z',
      endedAt: '2026-09-13T00:00:04.000Z',
      metadata: { input: deriveOperationMetadataBindings(action), result: { exitCode: 0 } },
      workspace: { before: BEFORE, after: BEFORE, mutations: [] },
      artifactHashes: []
    });
    const stale = validateActionReceipt(receiptClaim(staleContext), staleContext);
    if (!stale.ok) throw new Error(stale.reasons.join(','));
    const context = reportContext({
      receipts: [first, stale.evidence],
      evidenceOrder: [first.ref, stale.evidence.ref]
    });
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toContain('receipt-continuity-mismatch');
  });

  test('deduplicates nested child receipt usage and quarantines nested unresolved usage', () => {
    const child = validChildBundle();
    const originalReceipt = child.report.actionReceipts[0];
    const noOpReceipt = resealReceiptEvidence(originalReceipt, {
      ref: 'receipt-leaf-noop',
      actionId: 'action-leaf-noop',
      idempotencyId: 'idempotency-leaf-noop',
      mutations: [],
      workspaceBefore: originalReceipt.workspaceAfter,
      workspaceAfter: originalReceipt.workspaceAfter,
      beforeFingerprint: originalReceipt.afterFingerprint,
      startedAt: '2026-09-13T00:00:04.610Z',
      endedAt: '2026-09-13T00:00:04.650Z'
    });
    const dedupedReport = resealReportEvidence(child.report, {
      actions: [...child.report.actions, noOpReceipt.actionId].sort(),
      actionReceipts: [originalReceipt, noOpReceipt],
      evidenceOrder: [originalReceipt.ref, noOpReceipt.ref]
    });
    const context = reportWithChildren([
      { child: { ...child.child, reportEnvelopeDigest: dedupedReport.envelopeDigest }, report: dedupedReport } as any
    ], { before: AFTER, after: AFTER_CHILD });
    expect(validateExecutionReport(reportClaim(context), context).ok).toBe(true);

    const unresolvedReceipt = resealReceiptEvidence(originalReceipt, {
      usageStatus: 'unresolved' as const,
      usageSampleDigest: null,
      usageActual: {}
    });
    const unresolvedBudget = {
      ...child.report.budgetReconciliation,
      status: 'pending' as const,
      actual: {},
      sampleDigest: null
    };
    const unresolvedReport = resealReportEvidence(child.report, {
      actionReceipts: [unresolvedReceipt],
      budgetReconciliation: unresolvedBudget,
      subtreeActual: {},
      completionBlocked: true
    });
    const unresolved = reportWithChildren([
      { child: {
        ...child.child,
        reportEnvelopeDigest: unresolvedReport.envelopeDigest,
        budgetReconciliation: unresolvedBudget,
        subtreeActual: {}
      }, report: unresolvedReport } as any
    ], { before: AFTER, after: AFTER_CHILD }) as any;
    unresolved.subtreeActual = { toolActionsLeaf: 0 };
    unresolved.budgetContributors = { own: { toolActionsLeaf: 0 }, children: {} };
    const unresolvedResult = validateExecutionReport(reportClaim(unresolved), unresolved);
    expect(unresolvedResult.classification).toBe('quarantined');
    expect(unresolvedResult.reasons).toContain('unresolved-authority-reference');
  });

  test('rejects unexplained no-evidence drift and zero criteria', () => {
    const noEvidence = reportContext({
      receipts: [],
      childReports: [],
      evidenceOrder: [],
      workspace: { before: BEFORE, after: AFTER },
      budgetReconciliation: {
        reservationId: 'ticket-budget-1', status: 'committed', amounts: {}, actual: {}, sampleDigest: D4
      },
      budgetContributors: { own: {}, children: {} }
    });
    expect(reasons(validateExecutionReport(reportClaim(noEvidence, {
      evidenceRefs: ['evidence-a']
    }), noEvidence))).toContain('unexplained-workspace-drift');

    const base = reportContext() as any;
    const zeroCriteria = reportContext({ authority: { ...base.authority, criteria: [] } });
    expect(reasons(validateExecutionReport(reportClaim(zeroCriteria, {
      criterionResults: [], evidenceRefs: ['artifact-a']
    }), zeroCriteria))).toContain('criteria-mismatch');
  });

  test('blocks completion for failure, noncommitted usage, and blocked child regardless of request', () => {
    const base = reportContext() as any;
    const failedReceipt = resealReceiptEvidence(base.receipts[0], { resultClass: 'failure' });
    const failed = reportContext({ receipts: [failedReceipt] });
    const failedResult = validateExecutionReport(reportClaim(failed), failed);
    expect(failedResult.ok && failedResult.completionBlocked).toBe(true);

    const pendingReceipt = resealReceiptEvidence(base.receipts[0], {
      usageStatus: 'pending', usageSampleDigest: null, usageActual: {}
    });
    const pending = reportContext({
      receipts: [pendingReceipt],
      budgetReconciliation: {
        reservationId: 'ticket-budget-1', status: 'pending',
        amounts: pendingReceipt.usageAmounts, actual: {}, sampleDigest: null
      },
      budgetContributors: { own: {}, children: {} }
    });
    const pendingResult = validateExecutionReport(reportClaim(pending), pending);
    expect(pendingResult.ok && pendingResult.completionBlocked).toBe(true);
    const unresolvedReceipt = resealReceiptEvidence(pendingReceipt, { usageStatus: 'unresolved' as const });
    const unresolved = reportContext({
      receipts: [unresolvedReceipt],
      budgetReconciliation: {
        reservationId: 'ticket-budget-1', status: 'pending',
        amounts: unresolvedReceipt.usageAmounts, actual: {}, sampleDigest: null
      },
      budgetContributors: { own: {}, children: {} }
    });
    const unresolvedResult = validateExecutionReport(reportClaim(unresolved), unresolved);
    expect(unresolvedResult.classification).toBe('quarantined');
    expect(unresolvedResult.reasons).toContain('unresolved-authority-reference');

    const released = reportContext({
      receipts: [],
      evidenceOrder: [],
      workspace: { before: BEFORE, after: BEFORE },
      budgetReconciliation: {
        reservationId: 'ticket-budget-1', status: 'released', amounts: {}, actual: {}, sampleDigest: null
      },
      budgetContributors: { own: {}, children: {} }
    });
    const releasedResult = validateExecutionReport(reportClaim(released, {
      receiptRefs: [],
      mutations: [],
      actions: [],
      evidenceRefs: ['evidence-a'],
      budgetReconciliation: released.budgetReconciliation
    }), released);
    expect(releasedResult.ok && releasedResult.completionBlocked).toBe(true);

    const child = validChildBundle();
    const blockedReceipts = child.report.actionReceipts.map(receipt =>
      resealReceiptEvidence(receipt, { resultClass: 'failure' as const }));
    const blockedChild = resealReportEvidence(child.report, {
      actionReceipts: blockedReceipts,
      completionBlocked: true
    });
    const parent = reportWithChildren([
      { child: { ...child.child, reportEnvelopeDigest: blockedChild.envelopeDigest }, report: blockedChild } as any
    ], { before: AFTER, after: AFTER_CHILD });
    const parentResult = validateExecutionReport(reportClaim(parent, { requestedDisposition: 'complete' }), parent);
    expect(parentResult.ok && parentResult.completionBlocked).toBe(true);
    if (parentResult.ok) expect(parentResult.authority).toBe(false);

    const forged = reportWithChildren([
      { child: child.child, report: { ...child.report, completionBlocked: true } } as any
    ], { before: AFTER, after: AFTER_CHILD });
    expect(reasons(validateExecutionReport(reportClaim(forged), forged))).toContain('evidence-projection-mismatch');
  });

  test.each([
    ['operation', 'fs.delete'],
    ['normalizedOperationDigest', D4],
    ['intentTimestamp', '2026-09-13T00:00:02.500Z'],
    ['graphEpoch', 4],
    ['cancellationGeneration', 5],
    ['ticketGeneration', 6],
    ['leaseGeneration', 7],
    ['leaseFence', 8],
    ['usageSampleDigest', D3],
    ['usageAmounts', { toolActionsEo: 2 }],
    ['usageCurrency', 'EUR'],
    ['usageDescendantCommitted', { toolActionsLeaf: 1 }],
    ['usageActual', { toolActionsEo: 0 }],
    ['usageFinal', { ...USAGE, outputTokens: 4 }]
  ])('rejects mutated retained receipt projection field %s', (field, value) => {
    const base = reportContext() as any;
    const mutated = { ...base.receipts[0], [field]: value };
    const context = reportContext({ receipts: [mutated] });
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toContain('evidence-projection-mismatch');
  });

  test('verifies embedded receipt and report envelopes before nested report logic', () => {
    const direct = reportContext() as any;
    const alteredEnvelope = copy(direct.receipts[0].envelope);
    alteredEnvelope.payload.graphEpoch += 1;
    const alteredReceipt = { ...direct.receipts[0], envelope: alteredEnvelope };
    const directContext = reportContext({ receipts: [alteredReceipt] });
    expect(reasons(validateExecutionReport(reportClaim(directContext), directContext)))
      .toEqual(expect.arrayContaining(['envelope-digest-mismatch', 'evidence-projection-mismatch']));

    const child = validChildBundle();
    const nestedReceipt = { ...child.report.actionReceipts[0], operation: 'fs.delete' as const };
    const nestedReport = { ...child.report, actionReceipts: [nestedReceipt] };
    const nestedContext = reportWithChildren([
      { child: child.child, report: nestedReport } as any
    ], { before: AFTER, after: AFTER_CHILD });
    expect(reasons(validateExecutionReport(reportClaim(nestedContext), nestedContext)))
      .toContain('evidence-projection-mismatch');
  });

  test.each([
    ['graphEpoch', 4],
    ['cancellationGeneration', 5],
    ['ticketGeneration', 9],
    ['leaseGeneration', 7],
    ['leaseFence', 8],
    ['usageSampleDigest', D3],
    ['usageAmounts', { toolActionsLeaf: 2 }],
    ['usageActual', { toolActionsLeaf: 0 }]
  ])('rejects forged nested receipt %s projection', (field, value) => {
    const child = validChildBundle();
    const nestedReceipt = { ...child.report.actionReceipts[0], [field]: value };
    const nestedReport = { ...child.report, actionReceipts: [nestedReceipt] };
    const context = reportWithChildren([
      { child: child.child, report: nestedReport } as any
    ], { before: AFTER, after: AFTER_CHILD });
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toContain('evidence-projection-mismatch');
  });

  test('retains a nonrecursive sealed report projection and exact evidence records', () => {
    const child = validChildBundle();
    expect(child.report.envelope.payload.actionReceipts[0].envelope.kind).toBe('action-receipt/v1');
    expect('childReports' in child.report.envelope.payload).toBe(false);
    expect(child.report.evidenceRecords).toEqual(child.report.envelope.payload.evidenceRecords);

    const context = reportWithChildren([child], { before: AFTER, after: AFTER_CHILD }) as any;
    const childEvidence = child.report.evidenceRecords[0];
    context.evidence = context.evidence.map((record: any) => record.ref === childEvidence.ref
      ? { ...record, digest: record.digest === D3 ? D4 : D3 }
      : record);
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toContain('evidence-reference-open');

    const duplicate = reportContext() as any;
    duplicate.evidence = [
      ...duplicate.evidence,
      { ...duplicate.evidence[0], digest: D3 }
    ];
    expect(reasons(validateExecutionReport(reportClaim(duplicate), duplicate)))
      .toContain('evidence-reference-open');
  });

  test('requires exact trusted child budget reconciliation', () => {
    const child = validChildBundle();
    const context = reportWithChildren([child], { before: AFTER, after: AFTER_CHILD }) as any;
    context.children[0] = {
      ...context.children[0],
      budgetReconciliation: {
        ...context.children[0].budgetReconciliation,
        actual: { toolActionsLeaf: 0 }
      }
    };
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toContain('child-report-unrelated');
  });

  test('matches successful spawn independently of usage settlement state', () => {
    const child = validChildBundle();
    const base = reportWithChildren([child], { before: AFTER, after: AFTER_CHILD }) as any;
    const pendingSpawn = resealReceiptEvidence(base.receipts[0], {
      usageStatus: 'pending', usageSampleDigest: null, usageActual: {}
    });
    const pendingBudget = {
      reservationId: 'ticket-budget-1', status: 'pending' as const,
      amounts: pendingSpawn.usageAmounts, actual: {}, sampleDigest: null
    };
    const pending = {
      ...base,
      receipts: [pendingSpawn],
      budgetReconciliation: pendingBudget,
      budgetContributors: { own: {}, children: { toolActionsLeaf: 1 } }
    };
    const pendingResult = validateExecutionReport(reportClaim(pending), pending);
    expect(pendingResult.ok && pendingResult.completionBlocked).toBe(true);

    const unresolvedSpawn = resealReceiptEvidence(pendingSpawn, { usageStatus: 'unresolved' });
    const unresolved = {
      ...base,
      receipts: [unresolvedSpawn],
      budgetReconciliation: pendingBudget,
      budgetContributors: { own: {}, children: { toolActionsLeaf: 1 } }
    };
    const unresolvedResult = validateExecutionReport(reportClaim(unresolved), unresolved);
    expect(unresolvedResult.classification).toBe('quarantined');
    expect(unresolvedResult.reasons).toContain('unresolved-authority-reference');

    const failedSpawn = resealReceiptEvidence(base.receipts[0], {
      resultClass: 'failure', childTicketRef: null
    });
    const failed = { ...base, receipts: [failedSpawn] };
    expect(reasons(validateExecutionReport(reportClaim(failed), failed))).toContain('child-spawn-mismatch');
  });

  test('recomputes child completion instead of trusting its sealed boolean', () => {
    const child = validChildBundle();
    const pendingReceipt = resealReceiptEvidence(child.report.actionReceipts[0], {
      usageStatus: 'pending', usageSampleDigest: null, usageActual: {}
    });
    const pendingBudget = {
      ...child.report.budgetReconciliation,
      status: 'pending' as const,
      actual: {},
      sampleDigest: null
    };
    const forgedReport = resealReportEvidence(child.report, {
      actionReceipts: [pendingReceipt],
      budgetReconciliation: pendingBudget,
      completionBlocked: false
    });
    const context = reportWithChildren([{
      child: {
        ...child.child,
        reportEnvelopeDigest: forgedReport.envelopeDigest,
        budgetReconciliation: pendingBudget,
        subtreeActual: {}
      },
      report: forgedReport
    } as any], { before: AFTER, after: AFTER_CHILD }) as any;
    context.subtreeActual = { toolActionsLeaf: 0 };
    context.budgetContributors = { own: { toolActionsLeaf: 0 }, children: {} };
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toContain('evidence-projection-mismatch');
  });

  test('binds each trusted child to one exact report ref and envelope digest', () => {
    const child = validChildBundle();
    const changedReport = resealReportEvidence(child.report, {
      uncertainOutcomes: ['resealed-child'],
      completionBlocked: true
    });
    const changed = reportWithChildren([
      { child: child.child, report: changedReport } as any
    ], { before: AFTER, after: AFTER_CHILD });
    expect(reasons(validateExecutionReport(reportClaim(changed), changed)))
      .toEqual(expect.arrayContaining(['child-report-missing', 'child-report-unrelated']));

    const changedReceipt = resealReceiptEvidence(child.report.actionReceipts[0], {
      idempotencyId: 'resealed-nested-idempotency'
    });
    const changedNestedReport = resealReportEvidence(child.report, { actionReceipts: [changedReceipt] });
    const changedNested = reportWithChildren([
      { child: child.child, report: changedNestedReport } as any
    ], { before: AFTER, after: AFTER_CHILD });
    expect(reasons(validateExecutionReport(reportClaim(changedNested), changedNested)))
      .toContain('child-report-unrelated');
  });

  test('revalidates nested receipt global bindings directionally after trusted report identity update', () => {
    const child = validChildBundle();
    const validateChangedReceipt = (receiptOverrides: Record<string, unknown>) => {
      const receipt = resealReceiptEvidence(child.report.actionReceipts[0], receiptOverrides);
      const report = resealReportEvidence(child.report, { actionReceipts: [receipt] });
      const context = reportWithChildren([{
        child: { ...child.child, reportEnvelopeDigest: report.envelopeDigest },
        report
      } as any], { before: AFTER, after: AFTER_CHILD });
      return validateExecutionReport(reportClaim(context), context);
    };
    const stale = validateChangedReceipt({ graphEpoch: 2 });
    expect(stale.classification).toBe('quarantined');
    expect(stale.reasons).toContain('graph-epoch-drift');
    expect(reasons(validateChangedReceipt({ graphRevision: 3 }))).toContain('graph-revision-mismatch');
  });

  test('separates ticket lineage from report ids through root to EO to LEAF closure', () => {
    const leaf = validChildBundle();
    const eoContext = reportWithChildren([leaf], { before: AFTER, after: AFTER_CHILD }) as any;
    eoContext.evidence = eoContext.evidence.map((record: any) => record.ref === 'evidence-a'
      ? { ...record, ref: 'evidence-eo' }
      : record);
    const eoEvidenceRefs = ['evidence-eo', ...leaf.report.evidenceRefs].sort();
    const eoResult = validateExecutionReport(reportClaim(eoContext, {
      criterionResults: [{ criterionId: 'criterion-a', outcome: 'met', evidenceRef: 'evidence-eo' }],
      evidenceRefs: eoEvidenceRefs
    }), eoContext);
    if (!eoResult.ok) throw new Error(eoResult.reasons.join(','));

    const rootBase = rootReceiptContext() as any;
    const rootAuthority = {
      ...rootBase.authority,
      nodeId: 'milestone-core',
      reportDestination: 'controller:milestone-core',
      budgetReservationId: 'root-budget-closure'
    };
    const rootUsageSample = { ...USAGE, timestamp: '2026-09-13T00:00:00.900Z', actionCount: 1 };
    const rootAction = {
      operation: 'agent.spawn' as const,
      agentRef: 'workstream-core',
      writeSet: [],
      sideEffectClass: 'external' as const
    };
    const rootReceiptValue = rootReceiptContext({
      authority: rootAuthority,
      receiptId: 'receipt-root-spawn-eo',
      actionId: 'action-root-spawn-eo',
      idempotencyId: 'idempotency-root-spawn-eo',
      action: rootAction,
      intentTimestamp: '2026-09-13T00:00:00.200Z',
      startedAt: '2026-09-13T00:00:00.300Z',
      endedAt: '2026-09-13T00:00:00.400Z',
      metadata: {
        input: deriveOperationMetadataBindings(rootAction),
        result: { childTicketRef: 'ticket-eo-1' }
      },
      workspace: { before: AFTER, after: AFTER, mutations: [] },
      usage: {
        reservationId: 'root-budget-closure', status: 'committed',
        startedAt: '2026-09-13T00:00:00.100Z', deadlineAt: '2026-09-13T00:09:00.000Z',
        final: rootUsageSample, sampleDigest: computeUsageSampleDigest(rootUsageSample),
        amounts: {}, currency: 'USD', descendantCommitted: {}, actual: {}
      },
      artifactHashes: []
    });
    const rootReceipt = validateActionReceipt(receiptClaim(rootReceiptValue), rootReceiptValue);
    if (!rootReceipt.ok) throw new Error(rootReceipt.reasons.join(','));
    const eo = receiptContext() as any;
    const eoChild = {
      ticketRef: eo.authority.ref,
      reportRef: eoResult.evidence.ref,
      reportEnvelopeDigest: eoResult.evidence.envelopeDigest,
      parentTicketRef: eo.authority.parentTicketRef,
      handleLineage: eo.authority.handleLineage,
      generation: eo.authority.generation,
      nodeId: eo.authority.nodeId,
      parentNodeId: eo.authority.parentNodeId,
      issuerRole: eo.authority.issuerRole,
      role: eo.authority.recipientRole,
      status: eo.authority.status,
      expiresAt: eo.authority.expiresAt,
      graphRevision: eo.graphRevision,
      graphEpoch: eo.graphEpoch,
      cancellationGeneration: eo.cancellationGeneration,
      leaseKind: eo.lease.kind,
      leaseRef: eo.lease.ref,
      leaseGeneration: eo.lease.generation,
      leaseFence: eo.lease.fence,
      leaseNodeId: eo.lease.nodeId,
      leaseTicketRef: eo.lease.ticketRef,
      leaseStatus: eo.lease.status,
      leaseAcquiredAt: eo.lease.acquiredAt,
      leaseExpiresAt: eo.lease.expiresAt,
      budgetReservationId: eo.authority.budgetReservationId,
      budgetReconciliation: eoResult.evidence.budgetReconciliation,
      subtreeActual: eoResult.evidence.subtreeActual,
      reportDestination: eo.authority.reportDestination,
      reportSchemaRef: eo.authority.reportSchemaRef,
      criteria: eo.authority.criteria
    };
    const rootContext = reportContext({
      authority: rootAuthority,
      lease: rootBase.lease,
      reportId: 'report-root-closure',
      workspace: { before: AFTER, after: AFTER_CHILD },
      receipts: [rootReceipt.evidence],
      children: [eoChild],
      childReports: [eoResult.evidence],
      evidenceOrder: [rootReceipt.evidence.ref, eoResult.evidence.ref],
      evidence: [
        { ref: 'evidence-a', digest: D4, nodeId: rootAuthority.nodeId, kind: 'test' },
        ...eoResult.evidence.evidenceRecords
      ],
      budgetReconciliation: {
        reservationId: 'root-budget-closure', status: 'committed', amounts: {}, actual: {},
        sampleDigest: rootReceipt.evidence.usageSampleDigest
      },
      subtreeActual: eoResult.evidence.subtreeActual,
      budgetContributors: { own: {}, children: eoResult.evidence.subtreeActual }
    });
    const rootResult = validateExecutionReport(reportClaim(rootContext, {
      startedAt: '2026-09-13T00:00:00.100Z',
      endedAt: '2026-09-13T00:00:05.500Z'
    }), rootContext);
    expect(rootResult.ok).toBe(true);
    if (!rootResult.ok) return;
    expect(rootResult.evidence.childLineage).toEqual(['ticket-eo-1']);
    expect(rootResult.evidence.childReportRefs).toEqual(['report-1']);
    expect(rootResult.evidence.descendantTicketRefs).toEqual(['ticket-eo-1', 'ticket-leaf-1']);
    expect(rootResult.evidence.descendantReportRefs).toEqual(['report-1', 'report-leaf-1']);
  });

  test('retains and validates root to EO to two-LEAF authority/report tuples', () => {
    const eo = twoLeafEoBundle();
    const root = rootContextForEo(eo.context, eo.report, { before: eo.before, after: eo.after });
    const baseline = validateExecutionReport(rootClaimForEo(root), root);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.evidence.childBindings.map(binding => binding.ticketRef)).toEqual([
      'ticket-eo-1', 'ticket-leaf-1', 'ticket-leaf-2'
    ]);
    expect(baseline.evidence.childBindings.map(binding => binding.reportDestination)).toEqual([
      'controller:workstream-core', 'controller:leaf-core-1', 'controller:leaf-core-2'
    ]);

    const attackResult = (
      bindingIndex: number,
      bindingChanges: Record<string, unknown>,
      receiptChanges: Record<string, unknown> = {},
      reportChanges: Record<string, unknown> = {}
    ) => {
      const childBindings = copy(eo.report.childBindings) as any[];
      const target = childBindings[bindingIndex];
      childBindings[bindingIndex] = { ...target, ...bindingChanges };
      let actionReceipts = [...eo.report.actionReceipts];
      if (Object.keys(receiptChanges).length > 0) {
        actionReceipts = actionReceipts.map(receipt => receipt.ticketRef === target.ticketRef
          ? resealReceiptEvidence(receipt, receiptChanges)
          : receipt);
      }
      const changed = resealReportEvidence(eo.report, {
        childBindings,
        actionReceipts,
        ...reportChanges
      });
      const context = rootContextForEo(eo.context, changed, { before: eo.before, after: eo.after });
      return validateExecutionReport(rootClaimForEo(context), context);
    };

    expect(reasons(attackResult(0, { reportRef: 'report-invented' })))
      .toContain('child-report-unrelated');
    const duplicateGeneration = eo.report.childBindings[0].generation;
    expect(reasons(attackResult(1, { generation: duplicateGeneration }, {
      ticketGeneration: duplicateGeneration
    }))).toContain('child-lineage-illegal');
    expect(reasons(attackResult(1, { expiresAt: '2026-09-13T00:11:00.000Z' })))
      .toContain('child-lineage-illegal');
    expect(reasons(attackResult(1, { expiresAt: '2026-09-13T00:00:05.000Z' })))
      .toContain('ticket-expired');
    const sharedReservation = eo.report.childBindings[0].budgetReservationId;
    expect(reasons(attackResult(1, {
      budgetReservationId: sharedReservation,
      budgetReconciliation: {
        ...eo.report.childBindings[1].budgetReconciliation,
        reservationId: sharedReservation
      }
    }, {
      ticketBudgetReservationId: sharedReservation,
      usageReservationId: sharedReservation
    }))).toContain('usage-reservation-mismatch');
    expect(reasons(attackResult(1, { leaseGeneration: 7 }, { leaseGeneration: 7 })))
      .toContain('child-lineage-illegal');
    expect(reasons(attackResult(1, { parentNodeId: 'workstream-forged' }, {
      parentNodeId: 'workstream-forged'
    }))).toContain('child-lineage-illegal');
    expect(reasons(attackResult(1, {}, { reportDestination: 'controller:workstream-core' })))
      .toContain('child-report-unrelated');
  });

  test('rejects orphan evidence and parent substitutions of child evidence identity', () => {
    const orphan = reportContext() as any;
    orphan.evidence = [...orphan.evidence, {
      ref: 'orphan-evidence', digest: D3, nodeId: 'workstream-core', kind: 'review'
    }];
    expect(reasons(validateExecutionReport(reportClaim(orphan), orphan))).toContain('evidence-reference-open');

    const child = validChildBundle();
    const mutate = (changes: Record<string, unknown>) => {
      const context = reportWithChildren([child], { before: AFTER, after: AFTER_CHILD }) as any;
      const ref = child.report.evidenceRecords.find(record => record.kind === 'test')!.ref;
      context.evidence = context.evidence.map((record: any) => record.ref === ref
        ? { ...record, ...changes }
        : record);
      return validateExecutionReport(reportClaim(context), context);
    };
    expect(reasons(mutate({ digest: D3 }))).toContain('evidence-reference-open');
    expect(reasons(mutate({ nodeId: 'forged-owner' }))).toContain('evidence-reference-open');
    expect(reasons(mutate({ kind: 'review' }))).toContain('evidence-reference-open');
  });

  test.each([
    [{ digest: D3 }, 'digest'],
    [{ nodeId: 'resealed-owner' }, 'owner'],
    [{ kind: 'review' as const }, 'kind']
  ])('rejects fully resealed child evidence %s change against trusted report digest', (changes, _label) => {
    const child = validChildBundle();
    const evidenceRecords = child.report.evidenceRecords.map(record => record.kind === 'test'
      ? { ...record, ...changes }
      : record);
    const report = resealReportEvidence(child.report, { evidenceRecords });
    const context = reportWithChildren([
      { child: child.child, report } as any
    ], { before: AFTER, after: AFTER_CHILD });
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toEqual(expect.arrayContaining(['child-report-missing', 'child-report-unrelated']));
  });

  test.each([
    [{ usageAmounts: { toolActionsEo: 2 } }, 'amounts'],
    [{ usageSampleDigest: D3 }, 'sample digest'],
    [{ usageActual: { toolActionsEo: 0 } }, 'actual'],
    [{ usageStatus: 'pending', usageSampleDigest: null, usageActual: {} }, 'status']
  ])('rejects receipt reservation snapshot mismatch in %s', (receiptChanges, _label) => {
    const base = reportContext() as any;
    const receipt = resealReceiptEvidence(base.receipts[0], receiptChanges);
    const context = reportContext({ receipts: [receipt] });
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toContain('usage-reconciliation-mismatch');
  });

  test('separates reservation own actual from exact subtree total', () => {
    const child = validChildBundle();
    const context = reportWithChildren([child], { before: AFTER, after: AFTER_CHILD });
    const result = validateExecutionReport(reportClaim(context), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.budgetReconciliation.actual).toEqual({ toolActionsLeaf: 0 });
    expect(result.evidence.subtreeActual).toEqual({ toolActionsLeaf: 1 });
  });

  test.each([
    [{ amounts: { toolActionsLeaf: 2 } }, 'amounts'],
    [{ sampleDigest: D3 }, 'sample digest'],
    [{ actual: { toolActionsLeaf: 0 } }, 'actual'],
    [{ status: 'pending' as const, actual: {}, sampleDigest: null }, 'status']
  ])('rejects trusted child reservation %s mismatch', (changes, _label) => {
    const child = validChildBundle();
    const context = reportWithChildren([child], { before: AFTER, after: AFTER_CHILD }) as any;
    context.children[0] = {
      ...context.children[0],
      budgetReconciliation: { ...context.children[0].budgetReconciliation, ...changes }
    };
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toContain('child-report-unrelated');
  });

  test('rejects a fully resealed two-LEAF shared reservation', () => {
    const first = validChildBundle({ suffix: '1' });
    const second = validChildBundle({ suffix: '2' });
    const sharedReservation = first.child.budgetReservationId;
    const changedReceipt = resealReceiptEvidence(second.report.actionReceipts[0], {
      ticketBudgetReservationId: sharedReservation,
      usageReservationId: sharedReservation
    });
    const budgetReconciliation = {
      ...second.report.budgetReconciliation,
      reservationId: sharedReservation
    };
    const changedReport = resealReportEvidence(second.report, {
      actionReceipts: [changedReceipt],
      ticketBudgetReservationId: sharedReservation,
      budgetReconciliation
    });
    const attack = {
      report: changedReport,
      child: {
        ...second.child,
        reportEnvelopeDigest: changedReport.envelopeDigest,
        budgetReservationId: sharedReservation,
        budgetReconciliation
      }
    } as any;
    const context = reportWithChildren([first, attack], { before: AFTER, after: AFTER_CHILD });
    expect(reasons(validateExecutionReport(reportClaim(context), context)))
      .toContain('usage-reservation-mismatch');
  });

  test('deduplicates exact reservation snapshots across two receipts for the same ticket', () => {
    const first = validReceipt().evidence;
    const action = {
      operation: 'process.exec' as const,
      argv: ['/bin/true'],
      writeSet: [],
      sideEffectClass: 'external' as const
    };
    const secondContext = receiptContext({
      receiptId: 'receipt-2',
      actionId: 'action-2',
      idempotencyId: 'idempotency-2',
      action,
      intentTimestamp: '2026-09-13T00:00:01.500Z',
      startedAt: '2026-09-13T00:00:02.000Z',
      endedAt: '2026-09-13T00:00:02.500Z',
      metadata: { input: deriveOperationMetadataBindings(action), result: { exitCode: 0 } },
      workspace: { before: BEFORE, after: BEFORE, mutations: [] },
      artifactHashes: []
    });
    const secondResult = validateActionReceipt(receiptClaim(secondContext), secondContext);
    if (!secondResult.ok) throw new Error(secondResult.reasons.join(','));
    const receipts = evidenceSourceOrder([first, secondResult.evidence]);
    const context = reportContext({
      receipts,
      evidenceOrder: receipts.map(receipt => receipt.ref)
    });
    expect(validateExecutionReport(reportClaim(context), context).ok).toBe(true);

    const conflicting = resealReceiptEvidence(secondResult.evidence, {
      ticketBudgetReservationId: 'ticket-budget-conflict',
      usageReservationId: 'ticket-budget-conflict'
    });
    const conflictReceipts = evidenceSourceOrder([first, conflicting]);
    const conflict = reportContext({
      receipts: conflictReceipts,
      evidenceOrder: conflictReceipts.map(receipt => receipt.ref)
    });
    expect(reasons(validateExecutionReport(reportClaim(conflict), conflict)))
      .toContain('usage-reservation-mismatch');
  });

  test('rejects fully resealed sibling spawn agentRef swaps at EO and flattened root', () => {
    const eo = twoLeafEoBundle();
    const children = (eo.context as any).children as any[];
    const swapped = (eo.context as any).receipts.map((receipt: any) => {
      const target = children.find(child => child.ticketRef === receipt.childTicketRef)!;
      const sibling = children.find(child => child.ticketRef !== target.ticketRef)!;
      return resealReceiptEvidence(receipt, {
        inputMetadata: { ...receipt.inputMetadata, agentRef: sibling.nodeId }
      });
    });
    const eoAttack = { ...(eo.context as any), receipts: swapped };
    expect(reasons(validateExecutionReport(reportClaim(eoAttack), eoAttack)))
      .toContain('child-spawn-mismatch');

    const byRef = new Map(swapped.map((receipt: any) => [receipt.ref, receipt]));
    const changedReport = resealReportEvidence(eo.report, {
      actionReceipts: eo.report.actionReceipts.map(receipt => byRef.get(receipt.ref) ?? receipt)
    });
    const root = rootContextForEo(eo.context, changedReport, { before: eo.before, after: eo.after });
    expect(reasons(validateExecutionReport(rootClaimForEo(root), root)))
      .toContain('child-spawn-mismatch');
  });

  test('accepts receipt evidence only for its exact retained sealed producer', () => {
    const context = reportContext() as any;
    const receipt = context.receipts[0];
    context.evidence = [
      context.evidence.find((record: any) => record.kind === 'artifact'),
      { ref: receipt.ref, digest: receipt.envelopeDigest, nodeId: receipt.nodeId, kind: 'receipt' }
    ];
    const result = validateExecutionReport(reportClaim(context, {
      criterionResults: [{ criterionId: 'criterion-a', outcome: 'met', evidenceRef: receipt.ref }],
      evidenceRefs: ['artifact-a', receipt.ref].sort()
    }), context);
    expect(result.ok).toBe(true);
  });

  test.each([
    ['digest', (receipt: any) => ({ ref: receipt.ref, digest: D3, nodeId: receipt.nodeId, kind: 'receipt' })],
    ['ref', (receipt: any) => ({ ref: 'receipt-missing', digest: receipt.envelopeDigest, nodeId: receipt.nodeId, kind: 'receipt' })],
    ['owner', (receipt: any) => ({ ref: receipt.ref, digest: receipt.envelopeDigest, nodeId: 'leaf-forged', kind: 'receipt' })],
    ['kind collision', (receipt: any) => ({ ref: receipt.ref, digest: D3, nodeId: receipt.nodeId, kind: 'test' })]
  ])('rejects fully resealed receipt evidence with wrong %s', (_label, createRecord) => {
    const context = reportContext() as any;
    const receipt = context.receipts[0];
    const record = createRecord(receipt);
    context.evidence = [
      context.evidence.find((candidate: any) => candidate.kind === 'artifact'),
      record
    ];
    expect(reasons(validateExecutionReport(reportClaim(context, {
      criterionResults: [{ criterionId: 'criterion-a', outcome: 'met', evidenceRef: record.ref }],
      evidenceRefs: ['artifact-a', record.ref].sort(),
      completionBlocked: false
    }), context))).toContain('evidence-reference-open');
  });

  test.each([
    [{ generation: 5 }, 'generation regression'],
    [{ expiresAt: '2026-09-13T00:11:00.000Z' }, 'expiry extension'],
    [{ leaseAcquiredAt: '2026-09-13T00:00:00.001Z' }, 'lease acquisition mismatch'],
    [{ leaseExpiresAt: '2026-09-13T00:09:59.999Z' }, 'lease expiry mismatch']
  ])('rejects EO child topology %s', (changes, _label) => {
    const child = validChildBundle();
    const context = reportWithChildren([{
      child: { ...child.child, ...changes }, report: child.report
    } as any], { before: AFTER, after: AFTER_CHILD });
    expect(reasons(validateExecutionReport(reportClaim(context), context))).toContain('child-lineage-illegal');
  });

  test('rejects duplicate sibling ticket generations while preserving shared lease', () => {
    const first = validChildBundle({ suffix: 'generation-a' });
    const second = validChildBundle({ suffix: 'generation-b' });
    const context = reportWithChildren([first, {
      child: { ...second.child, generation: first.child.generation },
      report: second.report
    } as any], { before: AFTER, after: AFTER_CHILD });
    expect(first.child.leaseRef).toBe(second.child.leaseRef);
    expect(reasons(validateExecutionReport(reportClaim(context), context))).toContain('child-lineage-illegal');
  });
});
