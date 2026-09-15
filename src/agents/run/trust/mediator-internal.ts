import * as crypto from 'crypto';

import { z } from 'zod';

import {
  canonicalizeJson,
  ContractEnvelope,
  contractEnvelopeSchema,
  sealContract,
  verifyContractEnvelope
} from '../../contracts';
import { writeSelectorCovers } from '../compiler/schema';
import {
  assertRunAuthorityReportBackend,
  computeRunAuthoritySettlementConstraintDigest,
  type RunAuthorityReportBackend,
  type RunAuthoritySettlementConstraints,
  type TrustedFinalUsage
} from '../authority/manager';
import { BUDGET_DIMENSIONS } from '../authority/budgets';
import {
  computeAuthorityUsageSampleDigest,
  deriveAuthorityUsageActual
} from '../authority/usage-accounting';
import {
  computeNormalizedOperationDigest,
  computeWorkspaceFingerprint,
  evidenceActionReceiptPayloadSchema,
  evidenceUsageSampleSchema,
  structuredActionSchema,
  validateActionReceipt
} from '../evidence';
import { snapshotEvidenceData } from '../evidence/internal';
import { workspaceSnapshotInputSchema } from '../evidence/fingerprint';
import { actionReceiptValidationContextSchema } from '../evidence/schema';
import { CasConflictError } from '../store/types';
import {
  ActionAuthorizationOptions,
  ActionEffectGuard,
  ActionExecutorRequest,
  ActionExecutorResult,
  ActionMediator,
  ActionMediatorOptions,
  ActionOperation,
  ActionReceiptSummary,
  ActionUsageAuthority,
  MediationDecision,
  MediationDenialCode,
  ResolvedActionAuthority,
  StructuredAction,
  StructuredActionExecutor
} from './mediator';

export interface ActionMediatorHost {
  readonly mediator: ActionMediator;
  /** WP-230-only protected evidence lookup. Never expose this host object to descendants. */
  receiptEvidence(reservationId: string): Promise<Readonly<ContractEnvelope> | null>;
  preliminaryReceiptEvidence(reservationId: string): Promise<Readonly<ContractEnvelope> | null>;
  terminalReceipts(scope: ReceiptAuthorityScope): Promise<readonly Readonly<ContractEnvelope>[]>;
  finalizeDelegatedReceipts(
    scope: DelegatedReceiptAuthorityScope,
    authority: RunAuthorityReportBackend
  ): Promise<Readonly<FinalizedReceiptSet>>;
  finalizeRootReceipts(scope: ControllerRootReceiptAuthorityScope): Promise<Readonly<FinalizedReceiptSet>>;
}

interface ReceiptAuthorityScopeBase {
  readonly runId: string;
  readonly projectId: string;
  readonly approvedPlanDigest: string;
  readonly approvedGraphDigest: string;
  readonly graphId: string;
  readonly graphRevision: number;
  readonly graphEpoch: number;
  readonly cancellationGeneration: number;
  readonly nodeId: string;
  readonly reservationId: string;
  readonly authorityInstanceId: string;
  readonly usageBindingDigest: string;
  readonly reportDestination: string;
  readonly reportSchemaRef: 'execution-report/v1';
}

export interface DelegatedReceiptAuthorityScope extends ReceiptAuthorityScopeBase {
  readonly authorityKind: 'delegation-ticket';
  readonly authorityRef: string;
  readonly leaseRef: string;
  readonly leaseGeneration: number;
  readonly leaseFence: number;
}

export interface ControllerRootReceiptAuthorityScope extends ReceiptAuthorityScopeBase {
  readonly authorityKind: 'controller-root';
  readonly authorityRef: null;
}

export type ReceiptAuthorityScope = DelegatedReceiptAuthorityScope | ControllerRootReceiptAuthorityScope;

export interface FinalizedReceiptSet {
  readonly scope: Readonly<ReceiptAuthorityScope>;
  readonly usage: Readonly<TrustedFinalUsage>;
  readonly receipts: readonly Readonly<ContractEnvelope>[];
}

export type ActionReceiptProjectionErrorCode =
  | 'invalid-scope'
  | 'unknown-authority'
  | 'scope-mismatch'
  | 'authority-not-terminal'
  | 'final-usage-conflict'
  | 'projection-invalid'
  | 'persistence-indeterminate';

export class ActionReceiptProjectionError extends Error {
  constructor(readonly code: ActionReceiptProjectionErrorCode, message: string) {
    super(message);
    this.name = 'ActionReceiptProjectionError';
  }
}

const MAX_ACTIONS = 65_536;
const MAX_MEDIATION_AGGREGATE_BYTES = 896 * 1024;
const MEDIATION_SCHEMA_VERSION = 9 as const;
const bounded = z.string().min(1).max(16 * 1024);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const canonicalTimestamp = z.string().refine(value => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, 'Expected canonical timestamp');
const canonicalStrings = z.array(bounded).max(4096).refine(
  values => values.every((value, index) => index === 0 || values[index - 1] < value),
  'Expected sorted unique strings'
);
const orderedUniqueStrings = z.array(bounded).max(4096).refine(
  values => new Set(values).size === values.length,
  'Expected unique ordered strings'
);
const amountMap = z.record(z.string().min(1).max(16 * 1024),
  z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .refine(value => !Object.is(value, -0), 'Negative zero is forbidden'))
  .refine(value => Object.keys(value).length <= 128, 'Budget amount map exceeds limit');
const usageSchema = z.object({
  reservationId: bounded,
  authorityInstanceId: digest,
  usageBindingDigest: digest,
  status: z.enum(['pending', 'committed', 'released', 'unresolved']),
  startedAt: canonicalTimestamp,
  deadlineAt: canonicalTimestamp,
  final: evidenceUsageSampleSchema.nullable(),
  sampleDigest: digest.nullable(),
  amounts: amountMap,
  currency: bounded,
  descendantCommitted: amountMap,
  actual: amountMap,
  measuredUsageRequired: z.boolean()
}).strict().superRefine((usage, context) => {
  if (Date.parse(usage.startedAt) >= Date.parse(usage.deadlineAt)) {
    context.addIssue({ code: 'custom', message: 'Usage deadline must follow start' });
  }
  if (usage.status === 'committed') {
    if (usage.final?.confidence !== 'authoritative' || usage.sampleDigest === null) {
      context.addIssue({ code: 'custom', message: 'Committed usage lacks authoritative final sample' });
    }
  } else if (usage.final !== null || usage.sampleDigest !== null || Object.keys(usage.actual).length !== 0) {
    context.addIssue({ code: 'custom', message: 'Noncommitted usage carries terminal values' });
  }
});
const authoritySchema = z.object({
  runId: bounded,
  projectId: bounded,
  approvedPlanDigest: digest,
  approvedGraphDigest: digest,
  graphId: bounded,
  graphRevision: z.number().int().positive().safe(),
  graphEpoch: z.number().int().nonnegative().safe(),
  cancellationGeneration: z.number().int().nonnegative().safe(),
  authorityKind: z.enum(['controller-root', 'delegation-ticket']),
  authorityRef: bounded,
  parentAuthorityRef: bounded.nullable(),
  authorityGeneration: z.number().int().positive().safe().nullable(),
  authorityExpiresAt: canonicalTimestamp,
  nodeId: bounded,
  parentNodeId: bounded.nullable(),
  issuerRole: z.enum(['PLAN_ROOT', 'EXECUTION']).nullable(),
  recipientRole: z.enum(['PLAN_ROOT', 'EXECUTION', 'LEAF']),
  handleLineage: orderedUniqueStrings,
  spawnChildTicketRef: bounded.nullable(),
  reportDestination: bounded,
  reportSchemaRef: z.literal('execution-report/v1'),
  lease: z.object({
    kind: z.enum(['controller', 'workstream']),
    ref: bounded,
    generation: z.number().int().positive().safe(),
    fence: z.number().int().positive().safe(),
    acquiredAt: canonicalTimestamp,
    expiresAt: canonicalTimestamp
  }).strict(),
  operationClasses: canonicalStrings,
  toolClasses: canonicalStrings,
  credentialClasses: canonicalStrings,
  approvalRefs: canonicalStrings,
  approvalsCurrent: z.boolean(),
  writeSet: canonicalStrings,
  criteria: canonicalStrings,
  globalActionLimit: z.number().int().nonnegative().safe(),
  localActionLimit: z.number().int().nonnegative().safe(),
  eoLineageKey: bounded.nullable(),
  eoLineageActionLimit: z.number().int().nonnegative().safe(),
  usage: usageSchema
}).strict().superRefine((authority, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (Date.parse(authority.lease.acquiredAt) >= Date.parse(authority.lease.expiresAt)) {
    issue('Lease window is invalid');
  }
  if (authority.usage.deadlineAt !== authority.authorityExpiresAt ||
      (authority.usage.status === 'pending' &&
        (authority.usage.final !== null || authority.usage.sampleDigest !== null ||
          Object.keys(authority.usage.actual).length !== 0 ||
          Object.keys(authority.usage.descendantCommitted).length !== 0)) ||
      !['pending', 'committed'].includes(authority.usage.status)) {
    issue('Action authority usage must be pending or committed for exact replay');
  }
  if (authority.localActionLimit > authority.globalActionLimit ||
      authority.eoLineageActionLimit > authority.globalActionLimit) {
    issue('Action authority limits exceed global authority');
  }
  if (authority.authorityKind === 'controller-root') {
    if (authority.authorityGeneration !== null || authority.parentAuthorityRef !== null ||
        authority.parentNodeId !== null || authority.issuerRole !== null ||
        authority.recipientRole !== 'PLAN_ROOT' || authority.handleLineage.length !== 0 ||
        authority.lease.kind !== 'controller' || authority.authorityRef !== authority.lease.ref ||
        authority.eoLineageKey !== null || authority.localActionLimit !== authority.globalActionLimit ||
        authority.eoLineageActionLimit !== authority.globalActionLimit) {
      issue('Controller-root role, lineage, lease, or limit binding is inconsistent');
    }
  } else if (authority.authorityGeneration === null || authority.parentNodeId === null ||
      authority.lease.kind !== 'workstream') {
    issue('Delegation authority lacks generation, parent node, or workstream lease');
  } else if (authority.recipientRole === 'EXECUTION') {
    if (authority.issuerRole !== 'PLAN_ROOT' || authority.parentAuthorityRef !== null ||
        authority.handleLineage.length !== 1 || authority.handleLineage[0] !== authority.authorityRef ||
        authority.eoLineageKey !== authority.authorityRef) {
      issue('Execution authority lineage is inconsistent');
    }
  } else if (authority.recipientRole === 'LEAF') {
    if (authority.issuerRole !== 'EXECUTION' || authority.parentAuthorityRef === null ||
        authority.handleLineage.length !== 2 ||
        authority.handleLineage[0] !== authority.parentAuthorityRef ||
        authority.handleLineage[1] !== authority.authorityRef ||
        authority.eoLineageKey !== authority.parentAuthorityRef) {
      issue('Leaf authority lineage is inconsistent');
    }
  } else {
    issue('Delegation authority cannot grant PLAN_ROOT');
  }
});
const receiptAuthorityScopeFields = {
  runId: bounded,
  projectId: bounded,
  approvedPlanDigest: digest,
  approvedGraphDigest: digest,
  graphId: bounded,
  graphRevision: z.number().int().positive().safe(),
  graphEpoch: z.number().int().nonnegative().safe(),
  cancellationGeneration: z.number().int().nonnegative().safe(),
  nodeId: bounded,
  reservationId: bounded,
  authorityInstanceId: digest,
  usageBindingDigest: digest,
  reportDestination: bounded,
  reportSchemaRef: z.literal('execution-report/v1')
} as const;
const delegatedReceiptAuthorityScopeSchema = z.object({
  ...receiptAuthorityScopeFields,
  authorityKind: z.literal('delegation-ticket'),
  authorityRef: bounded,
  leaseRef: bounded,
  leaseGeneration: z.number().int().positive().safe(),
  leaseFence: z.number().int().positive().safe()
}).strict();
const controllerRootReceiptAuthorityScopeSchema = z.object({
  ...receiptAuthorityScopeFields,
  authorityKind: z.literal('controller-root'),
  authorityRef: z.null()
}).strict();
const receiptAuthorityScopeSchema = z.discriminatedUnion('authorityKind', [
  delegatedReceiptAuthorityScopeSchema,
  controllerRootReceiptAuthorityScopeSchema
]);
const trustedFinalUsageSchema = z.object({
  runId: bounded,
  projectId: bounded,
  authorityKind: z.enum(['controller-root', 'delegation-ticket']),
  authorityRef: bounded.nullable(),
  nodeId: bounded,
  reservationId: bounded,
  authorityInstanceId: digest,
  usageBindingDigest: digest,
  settlementConstraintDigest: digest.nullable(),
  status: z.literal('committed'),
  startedAt: canonicalTimestamp,
  deadlineAt: canonicalTimestamp,
  final: evidenceUsageSampleSchema,
  sampleDigest: digest,
  amounts: amountMap,
  currency: bounded,
  descendantCommitted: amountMap,
  actual: amountMap
}).strict().superRefine((usage, context) => {
  if (usage.final.confidence !== 'authoritative') {
    context.addIssue({ code: 'custom', message: 'Final usage must be authoritative' });
  }
  const startedAt = Date.parse(usage.startedAt);
  const deadlineAt = Date.parse(usage.deadlineAt);
  const sampledAt = Date.parse(usage.final.timestamp);
  if (startedAt >= deadlineAt || sampledAt < startedAt || sampledAt > deadlineAt) {
    context.addIssue({ code: 'custom', message: 'Final usage timestamp is outside reservation window' });
  }
});
const executorResultSchema = z.object({
  resultClass: z.enum(['success', 'failure', 'uncertain']),
  uncertaintyStatus: bounded.optional(),
  startedAt: canonicalTimestamp,
  endedAt: canonicalTimestamp,
  actualTargets: canonicalStrings,
  actualResources: canonicalStrings,
  inputMetadata: z.record(z.string(), z.unknown()),
  resultMetadata: z.record(z.string(), z.unknown()),
  workspaceBefore: workspaceSnapshotInputSchema,
  workspaceAfter: workspaceSnapshotInputSchema,
  mutations: canonicalStrings,
  artifactHashes: z.array(digest).max(4096).refine(
    values => values.every((value, index) => index === 0 || values[index - 1] < value),
    'Expected sorted unique artifact hashes'
  )
}).strict().superRefine((result, context) => {
  if (Date.parse(result.startedAt) > Date.parse(result.endedAt)) {
    context.addIssue({ code: 'custom', message: 'Executor end precedes start' });
  }
  if ((result.resultClass === 'uncertain') !== (result.uncertaintyStatus !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Uncertainty status mismatch' });
  }
});
const executorCompletionSchema = z.object({
  format: z.literal('harness-mdocs/action-executor-completion'),
  schemaVersion: z.literal(1),
  resultClass: z.enum(['success', 'failure', 'uncertain']),
  uncertaintyStatus: bounded.nullable(),
  startedAt: canonicalTimestamp,
  endedAt: canonicalTimestamp,
  actualTargets: canonicalStrings,
  actualResources: canonicalStrings,
  inputMetadata: z.record(z.string(), z.unknown()),
  resultMetadata: z.record(z.string(), z.unknown()),
  workspaceBefore: workspaceSnapshotInputSchema,
  workspaceAfter: workspaceSnapshotInputSchema,
  beforeFingerprint: digest,
  afterFingerprint: digest,
  mutations: canonicalStrings,
  artifactHashes: z.array(digest).max(4096).refine(
    values => values.every((value, index) => index === 0 || values[index - 1] < value),
    'Expected sorted unique artifact hashes'
  ),
  receiptReceivedAt: canonicalTimestamp
}).strict().superRefine((completion, context) => {
  if (Date.parse(completion.startedAt) > Date.parse(completion.endedAt)) {
    context.addIssue({ code: 'custom', message: 'Executor end precedes start' });
  }
  if ((completion.resultClass === 'uncertain') !== (completion.uncertaintyStatus !== null)) {
    context.addIssue({ code: 'custom', message: 'Uncertainty status mismatch' });
  }
  if (Date.parse(completion.receiptReceivedAt) < Date.parse(completion.endedAt)) {
    context.addIssue({ code: 'custom', message: 'Receipt arrival precedes effect end' });
  }
});
const optionsSchema = z.object({
  idempotencyKey: bounded.optional(),
  actionId: bounded.optional(),
  adapterKind: bounded.optional(),
  leaseProof: z.union([
    z.object({ kind: z.literal('controller'), leaseRef: bounded,
      generation: z.number().int().positive().safe(), fence: z.number().int().positive().safe() }).strict(),
    z.object({ kind: z.literal('workstream'), nodeId: bounded, leaseRef: bounded,
      generation: z.number().int().positive().safe(), fence: z.number().int().positive().safe() }).strict()
  ]).optional(),
  graphEpoch: z.number().int().nonnegative().safe().optional(),
  cancellationGeneration: z.number().int().nonnegative().safe().optional(),
  approvalRefs: z.array(bounded).max(1024).optional(),
  credentialClasses: z.array(bounded).max(1024).optional(),
  declaredPaths: z.array(bounded).max(4096).optional(),
  declaredResources: z.array(bounded).max(4096).optional(),
  nodeId: bounded.optional(),
  targetNodeId: bounded.optional(),
  budgetCharge: z.number().int().positive().safe().optional()
}).strict();

type Lifecycle = 'intent' | 'executing' | 'completed' | 'denied' | 'uncertain';
type StoredExecutorCompletion = z.infer<typeof executorCompletionSchema>;
interface StoredAction {
  format: 'harness-mdocs/action-intent';
  schemaVersion: typeof MEDIATION_SCHEMA_VERSION;
  reservationId: string;
  actionId: string;
  idempotencyKey: string;
  requestDigest: string;
  actionDigest: string;
  action: StructuredAction;
  authority: ResolvedActionAuthority;
  adapterKind: string;
  budgetCharge: number;
  approvalRefs: string[];
  credentialClasses: string[];
  declaredPaths: string[];
  declaredResources: string[];
  nodeId: string | null;
  targetNodeId: string | null;
  spawnChildTicketRef: string | null;
  intentTimestamp: string;
  lifecycle: Lifecycle;
  startedAt: string | null;
  endedAt: string | null;
  uncertaintyStatus: string | null;
  completion: StoredExecutorCompletion | null;
  completionDigest: string | null;
  receipt: Record<string, unknown> | null;
  finalizedReceipt: Record<string, unknown> | null;
}
interface FinalizedAuthority {
  scope: ReceiptAuthorityScope;
  status: 'settling' | 'finalized' | 'conflict';
  usage: TrustedFinalUsage | null;
}
interface EoLineageBarrier {
  runId: string;
  projectId: string;
  eoAuthorityRef: string;
  reservationId: string;
  authorityInstanceId: string;
  usageBindingDigest: string;
}
interface MediationAggregate {
  format: 'harness-mdocs/action-mediation';
  schemaVersion: typeof MEDIATION_SCHEMA_VERSION;
  runId: string;
  projectId: string;
  actions: StoredAction[];
  finalizedAuthorities: FinalizedAuthority[];
  eoLineageBarriers: EoLineageBarrier[];
}

const storedActionSchema = z.object({
  format: z.literal('harness-mdocs/action-intent'),
  schemaVersion: z.literal(MEDIATION_SCHEMA_VERSION),
  reservationId: bounded,
  actionId: bounded,
  idempotencyKey: bounded,
  requestDigest: digest,
  actionDigest: digest,
  action: structuredActionSchema,
  authority: authoritySchema,
  adapterKind: bounded,
  budgetCharge: z.number().int().positive().safe(),
  approvalRefs: canonicalStrings,
  credentialClasses: canonicalStrings,
  declaredPaths: canonicalStrings,
  declaredResources: canonicalStrings,
  nodeId: bounded.nullable(),
  targetNodeId: bounded.nullable(),
  spawnChildTicketRef: bounded.nullable(),
  intentTimestamp: canonicalTimestamp,
  lifecycle: z.enum(['intent', 'executing', 'completed', 'denied', 'uncertain']),
  startedAt: canonicalTimestamp.nullable(),
  endedAt: canonicalTimestamp.nullable(),
  uncertaintyStatus: bounded.nullable(),
  completion: executorCompletionSchema.nullable(),
  completionDigest: digest.nullable(),
  receipt: z.unknown().nullable(),
  finalizedReceipt: z.unknown().nullable()
}).strict().superRefine((action, context) => {
  const valid = action.lifecycle === 'intent'
    ? action.startedAt === null && action.endedAt === null && action.receipt === null &&
      action.uncertaintyStatus === null && action.completion === null && action.completionDigest === null
    : action.lifecycle === 'executing'
      ? action.startedAt !== null && action.endedAt === null && action.receipt === null &&
        action.uncertaintyStatus === null && action.completion === null && action.completionDigest === null
      : action.lifecycle === 'denied'
        ? action.startedAt === null && action.endedAt !== null && action.receipt === null &&
          action.uncertaintyStatus !== null && action.completion === null && action.completionDigest === null
      : action.lifecycle === 'uncertain'
        ? action.startedAt !== null && action.endedAt !== null && action.receipt === null &&
          action.uncertaintyStatus !== null && action.completion === null && action.completionDigest === null
        : action.startedAt === null && action.endedAt === null && action.uncertaintyStatus === null &&
          action.completion !== null && action.completionDigest !== null && action.receipt !== null;
  if (!valid) {
    context.addIssue({ code: 'custom', message: 'Action lifecycle fields are inconsistent' });
  }
  if (action.finalizedReceipt !== null && action.lifecycle !== 'completed') {
    context.addIssue({ code: 'custom', message: 'Only completed actions can carry finalized receipts' });
  }
});
const finalizedAuthoritySchema = z.object({
  scope: receiptAuthorityScopeSchema,
  status: z.enum(['settling', 'finalized', 'conflict']),
  usage: trustedFinalUsageSchema.nullable()
}).strict().superRefine((record, context) => {
  if ((record.status === 'settling') !== (record.usage === null)) {
    context.addIssue({ code: 'custom', message: 'Authority settlement phase and usage mismatch' });
  }
});
const eoLineageBarrierSchema = z.object({
  runId: bounded,
  projectId: bounded,
  eoAuthorityRef: bounded,
  reservationId: bounded,
  authorityInstanceId: digest,
  usageBindingDigest: digest
}).strict();
const mediationAggregateSchema = z.object({
  format: z.literal('harness-mdocs/action-mediation'),
  schemaVersion: z.literal(MEDIATION_SCHEMA_VERSION),
  runId: bounded,
  projectId: bounded,
  actions: z.array(storedActionSchema).max(MAX_ACTIONS),
  finalizedAuthorities: z.array(finalizedAuthoritySchema).max(MAX_ACTIONS),
  eoLineageBarriers: z.array(eoLineageBarrierSchema).max(MAX_ACTIONS)
}).strict().superRefine((aggregate, context) => {
  for (const values of [
    aggregate.actions.map(action => action.reservationId),
    aggregate.actions.map(action => action.idempotencyKey),
    aggregate.actions.map(action => action.actionId)
  ]) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Action identities are not unique' });
    }
  }
  if (aggregate.actions.some(action => action.authority.runId !== aggregate.runId ||
      action.authority.projectId !== aggregate.projectId)) {
    context.addIssue({ code: 'custom', message: 'Action run/project binding mismatch' });
  }
  const spawnChildren = aggregate.actions
    .map(action => action.spawnChildTicketRef)
    .filter((value): value is string => value !== null);
  if (new Set(spawnChildren).size !== spawnChildren.length) {
    context.addIssue({ code: 'custom', message: 'Pre-issued child ticket is bound more than once' });
  }
  const finalizationKeys = aggregate.finalizedAuthorities.map(item => scopeKey(item.scope));
  if (new Set(finalizationKeys).size !== finalizationKeys.length) {
    context.addIssue({ code: 'custom', message: 'Finalized authority scopes are not unique' });
  }
  const barrierKeys = aggregate.eoLineageBarriers.map(item => eoLineageBarrierKey(item));
  if (new Set(barrierKeys).size !== barrierKeys.length) {
    context.addIssue({ code: 'custom', message: 'EO lineage barriers are not unique' });
  }
});

function hash(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256')
    .update(domain, 'utf8').update('\0').update(canonicalizeJson(value), 'utf8').digest('hex')}`;
}

/** Internal protected-record commitment. Deliberately omitted from public barrels. */
export function computeStoredActionCompletionDigest(action: Pick<StoredAction,
  'reservationId' | 'actionId' | 'idempotencyKey' | 'requestDigest' | 'actionDigest' |
  'authority' | 'completion'>): `sha256:${string}` {
  if (action.completion === null) throw new Error('Cannot digest absent executor completion');
  return hash('harness-mdocs/action-executor-completion/v1', {
    runId: action.authority.runId,
    projectId: action.authority.projectId,
    reservationId: action.reservationId,
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
    requestDigest: action.requestDigest,
    actionDigest: action.actionDigest,
    authorityInstanceId: action.authority.usage.authorityInstanceId,
    leaseFence: action.authority.lease.fence,
    cancellationGeneration: action.authority.cancellationGeneration,
    completion: action.completion
  });
}

function projectionFail(code: ActionReceiptProjectionErrorCode, message: string): never {
  throw new ActionReceiptProjectionError(code, message);
}

export function actionReceiptAuthorityScope(
  authorityValue: ResolvedActionAuthority
): Readonly<ReceiptAuthorityScope> {
  let authority: ResolvedActionAuthority;
  try { authority = parseAuthority(authorityValue); } catch {
    projectionFail('invalid-scope', 'Resolved receipt authority is malformed');
  }
  const stable = {
    runId: authority.runId,
    projectId: authority.projectId,
    approvedPlanDigest: authority.approvedPlanDigest,
    approvedGraphDigest: authority.approvedGraphDigest,
    graphId: authority.graphId,
    graphRevision: authority.graphRevision,
    graphEpoch: authority.graphEpoch,
    cancellationGeneration: authority.cancellationGeneration,
    nodeId: authority.nodeId,
    reservationId: authority.usage.reservationId,
    authorityInstanceId: authority.usage.authorityInstanceId,
    usageBindingDigest: authority.usage.usageBindingDigest,
    reportDestination: authority.reportDestination,
    reportSchemaRef: authority.reportSchemaRef
  };
  return authority.authorityKind === 'controller-root'
    ? canonical({ ...stable, authorityKind: 'controller-root' as const, authorityRef: null }) as
      Readonly<ControllerRootReceiptAuthorityScope>
    : canonical({
      ...stable,
      authorityKind: 'delegation-ticket' as const,
      authorityRef: authority.authorityRef,
      leaseRef: authority.lease.ref,
      leaseGeneration: authority.lease.generation,
      leaseFence: authority.lease.fence
    }) as Readonly<DelegatedReceiptAuthorityScope>;
}

function parseReceiptScope(value: unknown): ReceiptAuthorityScope {
  const parsed = receiptAuthorityScopeSchema.safeParse(snapshotEvidenceData(value));
  if (!parsed.success) projectionFail('invalid-scope', 'Receipt authority scope is malformed');
  return canonical(parsed.data) as ReceiptAuthorityScope;
}

function scopeKey(scope: unknown): string {
  return hash('harness-mdocs/receipt-authority-identity/v2', scope);
}

function eoLineageBarrierKey(value: EoLineageBarrier): string {
  return hash('harness-mdocs/eo-lineage-barrier/v1', {
    runId: value.runId,
    projectId: value.projectId,
    eoAuthorityRef: value.eoAuthorityRef,
    authorityInstanceId: value.authorityInstanceId,
    usageBindingDigest: value.usageBindingDigest
  });
}

function eoLineageBarrierFor(scope: DelegatedReceiptAuthorityScope): EoLineageBarrier {
  return canonical({
    runId: scope.runId,
    projectId: scope.projectId,
    eoAuthorityRef: scope.authorityRef,
    reservationId: scope.reservationId,
    authorityInstanceId: scope.authorityInstanceId,
    usageBindingDigest: scope.usageBindingDigest
  }) as EoLineageBarrier;
}

function authorityEoBarrierKey(authority: ResolvedActionAuthority): string | null {
  if (authority.authorityKind !== 'delegation-ticket' || authority.eoLineageKey === null) return null;
  return eoLineageBarrierKey({
    runId: authority.runId,
    projectId: authority.projectId,
    eoAuthorityRef: authority.eoLineageKey,
    reservationId: authority.recipientRole === 'EXECUTION'
      ? authority.usage.reservationId : '',
    authorityInstanceId: authority.usage.authorityInstanceId,
    usageBindingDigest: authority.usage.usageBindingDigest
  });
}

function actionInScope(action: StoredAction, scope: ReceiptAuthorityScope): boolean {
  return same(actionReceiptAuthorityScope(action.authority), scope);
}

function completedEvidence(action: StoredAction): StoredExecutorCompletion {
  if (action.lifecycle !== 'completed' || action.completion === null) {
    throw new Error('Completed action lacks protected executor evidence');
  }
  return action.completion;
}

function terminalEndedAt(action: StoredAction): string {
  return action.lifecycle === 'completed' ? completedEvidence(action).endedAt : action.endedAt!;
}

function receiptValidationContext(
  action: StoredAction,
  receiptId: string,
  usage: ActionUsageAuthority | TrustedFinalUsage,
  preliminaryReceiptDigest: string | null
): z.infer<typeof actionReceiptValidationContextSchema> {
  const completion = completedEvidence(action);
  const authority = action.authority;
  return actionReceiptValidationContextSchema.parse({
    runId: authority.runId,
    projectId: authority.projectId,
    approvedPlanDigest: authority.approvedPlanDigest,
    approvedGraphDigest: authority.approvedGraphDigest,
    graphId: authority.graphId,
    graphRevision: authority.graphRevision,
    graphEpoch: authority.graphEpoch,
    cancellationGeneration: authority.cancellationGeneration,
    runStatus: 'active',
    receivedAt: completion.receiptReceivedAt,
    authority: authority.authorityKind === 'controller-root' ? {
      kind: 'controller-root', nodeId: authority.nodeId, parentNodeId: null, role: 'PLAN_ROOT',
      reportDestination: authority.reportDestination, reportSchemaRef: authority.reportSchemaRef,
      budgetReservationId: usage.reservationId,
      writeSet: [...authority.writeSet], criteria: [...authority.criteria]
    } : {
      kind: 'delegation-ticket', ref: authority.authorityRef,
      handleLineage: [...authority.handleLineage], generation: authority.authorityGeneration!, status: 'active',
      expiresAt: authority.authorityExpiresAt, nodeId: authority.nodeId,
      parentNodeId: authority.parentNodeId!, issuerRole: authority.issuerRole!,
      recipientRole: authority.recipientRole as 'EXECUTION' | 'LEAF',
      reportDestination: authority.reportDestination, reportSchemaRef: authority.reportSchemaRef,
      parentTicketRef: authority.parentAuthorityRef, budgetReservationId: usage.reservationId,
      writeSet: [...authority.writeSet], criteria: [...authority.criteria]
    },
    lease: authority.lease.kind === 'controller' ? {
      kind: 'controller', ref: authority.lease.ref, generation: authority.lease.generation,
      fence: authority.lease.fence, status: 'active', acquiredAt: authority.lease.acquiredAt,
      expiresAt: authority.lease.expiresAt
    } : {
      kind: 'workstream', ref: authority.lease.ref, generation: authority.lease.generation,
      fence: authority.lease.fence, status: 'active', acquiredAt: authority.lease.acquiredAt,
      expiresAt: authority.lease.expiresAt,
      nodeId: authority.recipientRole === 'LEAF' ? authority.parentNodeId! : authority.nodeId,
      ticketRef: authority.recipientRole === 'LEAF' ? authority.parentAuthorityRef! : authority.authorityRef
    },
    receiptId,
    actionId: action.actionId,
    idempotencyId: action.idempotencyKey,
    action: action.action,
    resultClass: completion.resultClass,
    uncertaintyStatus: completion.uncertaintyStatus,
    intentTimestamp: action.intentTimestamp,
    startedAt: completion.startedAt,
    endedAt: completion.endedAt,
    metadata: { input: completion.inputMetadata, result: completion.resultMetadata },
    workspace: {
      before: completion.workspaceBefore,
      after: completion.workspaceAfter,
      mutations: completion.mutations
    },
    executorCompletionDigest: action.completionDigest,
    preliminaryReceiptDigest,
    usage: {
      reservationId: usage.reservationId,
      status: usage.status,
      startedAt: usage.startedAt,
      deadlineAt: usage.deadlineAt,
      final: usage.final,
      sampleDigest: usage.sampleDigest,
      amounts: usage.amounts,
      currency: usage.currency,
      descendantCommitted: usage.descendantCommitted,
      actual: usage.actual
    },
    artifactHashes: completion.artifactHashes
  });
}

function projectedReceipt(
  action: StoredAction,
  usage: ActionUsageAuthority | TrustedFinalUsage,
  preliminary: ContractEnvelope | null
): ContractEnvelope {
  const completion = completedEvidence(action);
  const authority = action.authority;
  const payload = evidenceActionReceiptPayloadSchema.parse({
    runId: authority.runId,
    projectId: authority.projectId,
    approvedPlanDigest: authority.approvedPlanDigest,
    approvedGraphDigest: authority.approvedGraphDigest,
    graphId: authority.graphId,
    graphRevision: authority.graphRevision,
    graphEpoch: authority.graphEpoch,
    cancellationGeneration: authority.cancellationGeneration,
    authorityKind: authority.authorityKind,
    ticketRef: authority.authorityKind === 'delegation-ticket' ? authority.authorityRef : null,
    parentTicketRef: authority.parentAuthorityRef,
    ticketBudgetReservationId: usage.reservationId,
    ticketGeneration: authority.authorityGeneration,
    nodeId: authority.nodeId,
    parentNodeId: authority.parentNodeId,
    issuerRole: authority.issuerRole,
    recipientRole: authority.recipientRole,
    reportDestination: authority.reportDestination,
    reportSchemaRef: authority.reportSchemaRef,
    leaseKind: authority.lease.kind,
    leaseRef: authority.lease.ref,
    leaseGeneration: authority.lease.generation,
    leaseFence: authority.lease.fence,
    actionId: action.actionId,
    idempotencyId: action.idempotencyKey,
    operation: action.action.operation,
    childTicketRef: action.action.operation === 'agent.spawn' && completion.resultClass === 'success'
      ? action.spawnChildTicketRef : null,
    handleLineage: authority.handleLineage,
    normalizedOperationDigest: action.actionDigest,
    intentTimestamp: action.intentTimestamp,
    startedAt: completion.startedAt,
    endedAt: completion.endedAt,
    resultClass: completion.resultClass,
    inputMetadata: completion.inputMetadata,
    resultMetadata: completion.resultMetadata,
    mutations: completion.mutations,
    workspaceScope: completion.workspaceBefore.scope,
    workspaceBefore: completion.workspaceBefore,
    workspaceAfter: completion.workspaceAfter,
    beforeFingerprint: completion.beforeFingerprint,
    afterFingerprint: completion.afterFingerprint,
    executorCompletionDigest: action.completionDigest,
    preliminaryReceiptDigest: preliminary?.digest ?? null,
    usageReservationId: usage.reservationId,
    usageStatus: usage.status,
    usageSampleDigest: usage.sampleDigest,
    usageAmounts: usage.amounts,
    usageCurrency: usage.currency,
    usageDescendantCommitted: usage.descendantCommitted,
    usageActual: usage.actual,
    ...(usage.final === null ? {} : { usageFinal: usage.final }),
    ...(completion.uncertaintyStatus === null ? {} : {
      uncertaintyStatus: completion.uncertaintyStatus
    }),
    artifactHashes: completion.artifactHashes
  });
  const receiptId = preliminary === null
    ? `receipt:${hash('harness-mdocs/action-receipt-id/v1', {
      runId: authority.runId, actionId: action.actionId, idempotencyKey: action.idempotencyKey
    }).slice(7)}`
    : `receipt-final:${hash('harness-mdocs/final-action-receipt-id/v1', {
      preliminaryReceiptId: preliminary.id,
      preliminaryReceiptDigest: preliminary.digest,
      usage
    }).slice(7)}`;
  const envelope = sealContract('action-receipt/v1', receiptId, payload);
  const validation = validateActionReceipt(envelope, receiptValidationContext(
    action, receiptId, usage, preliminary?.digest ?? null
  ));
  if (!validation.ok) {
    throw new Error(`Projected receipt validation failed: ${validation.reasons.join(',')}`);
  }
  return envelope;
}

function preliminaryReceipt(action: StoredAction): ContractEnvelope {
  return projectedReceipt(action, action.authority.usage, null);
}

function parseTrustedFinalUsage(value: unknown, scope: ReceiptAuthorityScope): TrustedFinalUsage {
  const parsed = trustedFinalUsageSchema.safeParse(snapshotEvidenceData(value));
  if (!parsed.success) projectionFail('projection-invalid', 'Trusted final usage is malformed');
  const usage = parsed.data;
  if (usage.runId !== scope.runId || usage.projectId !== scope.projectId ||
      usage.authorityKind !== scope.authorityKind || usage.authorityRef !== scope.authorityRef ||
      usage.nodeId !== scope.nodeId || usage.reservationId !== scope.reservationId ||
      usage.authorityInstanceId !== scope.authorityInstanceId ||
      usage.usageBindingDigest !== scope.usageBindingDigest ||
      usage.sampleDigest !== computeAuthorityUsageSampleDigest(usage.final)) {
    projectionFail('scope-mismatch', 'Trusted final usage differs from receipt authority scope');
  }
  let actual: Readonly<Record<string, number>>;
  try {
    actual = deriveAuthorityUsageActual({
      amounts: usage.amounts,
      currency: usage.currency,
      sample: usage.final,
      descendantCommitted: usage.descendantCommitted
    });
  } catch {
    projectionFail('projection-invalid', 'Trusted final usage accounting is invalid');
  }
  if (!same(actual, usage.actual)) {
    projectionFail('projection-invalid', 'Trusted final usage actuals do not reproduce');
  }
  return canonical(usage) as TrustedFinalUsage;
}

function resourceBindings(action: StructuredAction): string[] {
  if (action.operation === 'fs.write' || action.operation === 'fs.delete') return [];
  return [`action-resource:${hash('harness-mdocs/action-resource/v1', action).slice(7)}`];
}

function inputMetadataIsRedacted(action: StructuredAction, metadata: Readonly<Record<string, unknown>>): boolean {
  const safeKeys: Record<ActionOperation, readonly string[]> = {
    'fs.write': ['contentDigest', 'declaredBytes', 'path', 'pathDigest'],
    'fs.delete': ['path', 'pathDigest'],
    'process.exec': ['argvDigest'],
    'network.request': ['method', 'payloadDigest', 'requestDigest', 'urlDigest'],
    'git.mutate': ['argsDigest'],
    'package.hook': [],
    'agent.spawn': ['agentRef', 'requestDigest'],
    'tool.invoke': ['argumentsDigest']
  };
  return Object.keys(metadata).every(key => safeKeys[action.operation].includes(key));
}

function executorCompletionIsConsistent(action: StoredAction): boolean {
  if (action.completion === null || action.completionDigest === null ||
      action.completionDigest !== computeStoredActionCompletionDigest(action)) return false;
  const completion = action.completion;
  let before: ReturnType<typeof computeWorkspaceFingerprint>;
  let after: ReturnType<typeof computeWorkspaceFingerprint>;
  try {
    before = computeWorkspaceFingerprint(completion.workspaceBefore);
    after = computeWorkspaceFingerprint(completion.workspaceAfter);
  } catch {
    return false;
  }
  if (!same(completion.workspaceBefore, { scope: before.scope, entries: before.entries }) ||
      !same(completion.workspaceAfter, { scope: after.scope, entries: after.entries }) ||
      completion.beforeFingerprint !== before.digest || completion.afterFingerprint !== after.digest ||
      completion.actualTargets.some(target => !action.declaredPaths.includes(target) ||
        !action.action.writeSet.some(selector => writeSelectorCovers(selector, target))) ||
      completion.mutations.some(target => !completion.actualTargets.includes(target) ||
        !action.declaredPaths.includes(target) ||
        !action.action.writeSet.some(selector => writeSelectorCovers(selector, target))) ||
      !same(completion.actualResources, action.declaredResources) ||
      ((action.action.operation === 'fs.write' || action.action.operation === 'fs.delete') &&
        !completion.actualTargets.includes(action.action.path)) ||
      !inputMetadataIsRedacted(action.action, completion.inputMetadata) ||
      Date.parse(completion.startedAt) < Date.parse(action.intentTimestamp)) return false;
  if (action.action.operation === 'agent.spawn') {
    const childTicketRef = completion.resultMetadata.childTicketRef;
    if ((completion.resultClass === 'success' && childTicketRef !== action.spawnChildTicketRef) ||
        (completion.resultClass !== 'success' && childTicketRef !== null)) return false;
  }
  return true;
}

const credentialRequirementsSchema = z.array(bounded).max(1024);

function requiredCredentialClasses(
  adapter: StructuredActionExecutor,
  request: ActionExecutorRequest
): string[] {
  const parsed = credentialRequirementsSchema.safeParse(snapshotEvidenceData(
    adapter.requiredCredentialClasses(request)
  ));
  if (!parsed.success) throw new Error('Executor credential policy returned malformed classes');
  return sorted(parsed.data);
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

function canonical<T>(value: T): Readonly<T> {
  return deepFreeze(JSON.parse(canonicalizeJson(value)) as T);
}

function denial(code: MediationDenialCode, reason: string): MediationDecision {
  return canonical({ allowed: false as const, code, reason });
}

function executionDenial(actionId: string, reason: string, at: string): ActionReceiptSummary {
  return canonical({
    actionRef: `public-action:${hash('harness-mdocs/public-action-ref/v1', actionId).slice(7)}`,
    resultClass: 'failure' as const,
    startedAt: at, endedAt: at, durationMs: 0, failureReason: reason
  }) as ActionReceiptSummary;
}

function errorCode(error: unknown): MediationDenialCode {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code) : '';
  if (['unknown-handle', 'no-handle'].includes(code)) return 'no-handle';
  if (['graph-epoch-mismatch', 'cancellation-generation-mismatch', 'stale-lease',
    'expired-lease', 'inactive-lease', 'expired-ticket', 'inactive-ticket'].includes(code)) {
    return 'stale-generation';
  }
  if (code === 'budget-exceeded') return 'budget-exceeded';
  if (code === 'cancelled') return 'cancelled';
  if (['store-unavailable', 'commit-unknown', 'recovery-required', 'concurrency-exhausted'].includes(code)) {
    return 'store-unavailable';
  }
  return 'policy-denied';
}

function safeNow(source: () => Date): string {
  const value = source();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Trusted clock failed');
  return value.toISOString();
}

function reservationId(runId: string, idempotencyKey: string): string {
  const encodedRun = Buffer.from(runId, 'utf8').toString('base64url');
  return `action-reservation:${encodedRun}:${hash('harness-mdocs/action-reservation/v1', idempotencyKey).slice(7)}`;
}

function keyFromReservation(value: string): string | null {
  const match = /^action-reservation:([A-Za-z0-9_-]+):[0-9a-f]{64}$/.exec(value);
  if (!match) return null;
  try {
    const runId = Buffer.from(match[1], 'base64url').toString('utf8');
    return runId.length > 0 && Buffer.byteLength(runId, 'utf8') <= 16 * 1024 ? `intent/${runId}` : null;
  } catch {
    return null;
  }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function parseAuthority(value: unknown): ResolvedActionAuthority {
  const parsed = authoritySchema.safeParse(snapshotEvidenceData(value));
  if (!parsed.success) throw new Error('Host authority verifier returned malformed grant');
  const authority = parsed.data as ResolvedActionAuthority;
  if (Date.parse(authority.lease.acquiredAt) >= Date.parse(authority.lease.expiresAt) ||
      authority.usage.reservationId.length === 0) {
    throw new Error('Host authority verifier returned inconsistent grant');
  }
  return canonical(authority) as ResolvedActionAuthority;
}

function assertAuthority(
  authority: ResolvedActionAuthority,
  action: StructuredAction,
  options: ReturnType<typeof optionsSchema.parse>,
  adapter: StructuredActionExecutor
): MediationDecision | null {
  if (!authority.approvalsCurrent) return denial('approval-invalid', 'Approval binding is revoked or unavailable');
  if (authority.usage.status !== 'pending' && authority.usage.status !== 'committed') {
    return denial('budget-exceeded', 'Authority usage reservation is not pending');
  }
  if (options.graphEpoch !== undefined && options.graphEpoch !== authority.graphEpoch) {
    return denial('stale-generation', 'Graph generation changed');
  }
  if (options.cancellationGeneration !== undefined &&
      options.cancellationGeneration !== authority.cancellationGeneration) {
    return denial('stale-generation', 'Cancellation generation changed');
  }
  if (options.nodeId !== undefined && options.nodeId !== authority.nodeId) {
    return denial('policy-denied', 'Action graph node differs from current authority');
  }
  if (!authority.operationClasses.includes(action.operation)) {
    return denial('policy-denied', 'Operation is outside authority scope');
  }
  if (!adapter.operations.includes(action.operation)) {
    return denial('unknown-operation', 'Selected adapter does not allow operation');
  }
  const expectedEffectClass: Partial<Record<ActionOperation, readonly string[]>> = {
    'fs.write': ['workspace'], 'fs.delete': ['workspace'],
    'process.exec': ['external'], 'network.request': ['external', 'credential'],
    'git.mutate': ['workspace'], 'package.hook': ['workspace', 'external'],
    'agent.spawn': ['none'], 'tool.invoke': ['external', 'credential']
  };
  if (!expectedEffectClass[action.operation]?.includes(action.sideEffectClass)) {
    return denial('policy-denied', 'Operation side-effect class is inconsistent');
  }
  if (action.operation === 'tool.invoke' && !authority.toolClasses.includes(action.tool)) {
    return denial('policy-denied', 'Tool is outside authority scope');
  }
  const approvals = sorted(options.approvalRefs ?? authority.approvalRefs);
  if (!same(approvals, authority.approvalRefs)) {
    return denial('approval-invalid', 'Action approval refs differ from current authority');
  }
  if (action.writeSet.some(selector => !authority.writeSet.some(parent =>
    writeSelectorCovers(parent, selector)))) {
    return denial('write-set-violation', 'Action write set exceeds current authority');
  }
  const paths = sorted(options.declaredPaths ??
    (action.operation === 'fs.write' || action.operation === 'fs.delete' ? [action.path] : []));
  if (action.sideEffectClass === 'workspace' && (action.writeSet.length === 0 || paths.length === 0)) {
    return denial('write-set-violation', 'Workspace effect requires an exact non-empty write boundary');
  }
  if (paths.some(path => !action.writeSet.some(selector => writeSelectorCovers(selector, path)))) {
    return denial('write-set-violation', 'Declared path is outside exact action write set');
  }
  if ((action.operation === 'fs.write' || action.operation === 'fs.delete') &&
      !paths.includes(action.path)) {
    return denial('write-set-violation', 'Filesystem target is absent from declared paths');
  }
  if (authority.authorityKind === 'delegation-ticket' && authority.recipientRole === 'LEAF' &&
      action.operation === 'agent.spawn') {
    return denial('policy-denied', 'LEAF authority cannot spawn descendants');
  }
  if (action.operation === 'agent.spawn' && options.targetNodeId === undefined) {
    return denial('invalid-request', 'Spawn requires explicit targetNodeId');
  }
  if (action.operation === 'agent.spawn' && action.agentRef !== options.targetNodeId) {
    return denial('policy-denied', 'Spawn agent ref differs from target graph node');
  }
  if ((action.operation === 'agent.spawn') !== (authority.spawnChildTicketRef !== null)) {
    return denial('policy-denied', 'Spawn lacks one active pre-issued child ticket');
  }
  return null;
}

function requestFor(action: StoredAction): ActionExecutorRequest {
  return canonical({
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
    actionDigest: action.actionDigest,
    action: action.action,
    declaredPaths: action.declaredPaths,
    declaredResources: action.declaredResources,
    spawnChildTicketRef: action.spawnChildTicketRef
  }) as ActionExecutorRequest;
}

function intentRequestDigest(action: Pick<StoredAction,
  'actionId' | 'idempotencyKey' | 'actionDigest' | 'adapterKind' | 'budgetCharge' |
  'approvalRefs' | 'credentialClasses' | 'declaredPaths' | 'declaredResources' |
  'nodeId' | 'targetNodeId' | 'authority'>): string {
  const authority = action.authority;
  return hash('harness-mdocs/action-intent-request/v1', {
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
    actionDigest: action.actionDigest,
    adapterKind: action.adapterKind,
    budgetCharge: action.budgetCharge,
    approvalRefs: action.approvalRefs,
    credentialClasses: action.credentialClasses,
    declaredPaths: action.declaredPaths,
    declaredResources: action.declaredResources,
    nodeId: action.nodeId,
    targetNodeId: action.targetNodeId,
    authorityRef: authority.authorityRef,
    spawnChildTicketRef: authority.spawnChildTicketRef,
    graphEpoch: authority.graphEpoch,
    cancellationGeneration: authority.cancellationGeneration,
    lease: {
      kind: authority.lease.kind,
      ref: authority.lease.ref,
      generation: authority.lease.generation,
      fence: authority.lease.fence,
      acquiredAt: authority.lease.acquiredAt
    }
  });
}

function executorPolicyMatches(adapter: StructuredActionExecutor, action: StoredAction): boolean {
  const request = requestFor(action);
  return adapter.validate(request) === true &&
    same(requiredCredentialClasses(adapter, request), action.credentialClasses);
}

function localActionKey(authority: ResolvedActionAuthority): string {
  return authority.authorityKind === 'controller-root'
    ? `root-node:${authority.nodeId}` : `ticket:${authority.authorityRef}`;
}

function liveBindingMatches(
  persisted: ResolvedActionAuthority,
  current: ResolvedActionAuthority
): boolean {
  const immutable = (authority: ResolvedActionAuthority) => ({
    runId: authority.runId,
    projectId: authority.projectId,
    approvedPlanDigest: authority.approvedPlanDigest,
    approvedGraphDigest: authority.approvedGraphDigest,
    graphId: authority.graphId,
    graphRevision: authority.graphRevision,
    graphEpoch: authority.graphEpoch,
    cancellationGeneration: authority.cancellationGeneration,
    authorityKind: authority.authorityKind,
    authorityRef: authority.authorityRef,
    parentAuthorityRef: authority.parentAuthorityRef,
    authorityGeneration: authority.authorityGeneration,
    authorityExpiresAt: authority.authorityExpiresAt,
    nodeId: authority.nodeId,
    parentNodeId: authority.parentNodeId,
    issuerRole: authority.issuerRole,
    recipientRole: authority.recipientRole,
    handleLineage: authority.handleLineage,
    spawnChildTicketRef: authority.spawnChildTicketRef,
    reportDestination: authority.reportDestination,
    reportSchemaRef: authority.reportSchemaRef,
    operationClasses: authority.operationClasses,
    toolClasses: authority.toolClasses,
    credentialClasses: authority.credentialClasses,
    approvalRefs: authority.approvalRefs,
    writeSet: authority.writeSet,
    criteria: authority.criteria,
    globalActionLimit: authority.globalActionLimit,
    localActionLimit: authority.localActionLimit,
    eoLineageKey: authority.eoLineageKey,
    eoLineageActionLimit: authority.eoLineageActionLimit,
    usage: {
      reservationId: authority.usage.reservationId,
      authorityInstanceId: authority.usage.authorityInstanceId,
      usageBindingDigest: authority.usage.usageBindingDigest,
      startedAt: authority.usage.startedAt,
      deadlineAt: authority.usage.deadlineAt,
      amounts: authority.usage.amounts,
      currency: authority.usage.currency,
      measuredUsageRequired: authority.usage.measuredUsageRequired
    },
    lease: {
      kind: authority.lease.kind,
      ref: authority.lease.ref,
      generation: authority.lease.generation,
      fence: authority.lease.fence,
      acquiredAt: authority.lease.acquiredAt
    }
  });
  return current.approvalsCurrent && persisted.usage.status === 'pending' &&
    ['pending', 'committed'].includes(current.usage.status) &&
    same(immutable(persisted), immutable(current)) &&
    Date.parse(current.lease.expiresAt) >= Date.parse(persisted.lease.expiresAt);
}

function summary(action: StoredAction): ActionReceiptSummary {
  const completion = action.lifecycle === 'completed' ? completedEvidence(action) : null;
  const start = completion?.startedAt ?? action.startedAt ?? action.intentTimestamp;
  const end = completion?.endedAt ?? action.endedAt ?? start;
  const receipt = action.receipt ?? undefined;
  return canonical({
    actionRef: `public-action:${hash('harness-mdocs/public-action-ref/v1', action.actionId).slice(7)}`,
    resultClass: completion
      ? completion.resultClass
      : action.lifecycle === 'denied' ? 'failure' : 'uncertain',
    startedAt: start,
    endedAt: end,
    durationMs: Math.max(0, Date.parse(end) - Date.parse(start)),
    ...(receipt ? { receiptRef: receipt.id, receiptDigest: receipt.digest } : {}),
    ...(action.lifecycle === 'denied' && action.uncertaintyStatus
      ? { failureReason: action.uncertaintyStatus } : {}),
    ...(action.lifecycle === 'uncertain' && action.uncertaintyStatus
      ? { uncertaintyStatus: action.uncertaintyStatus } : {})
  }) as ActionReceiptSummary;
}

function terminalConflictSummary(action: StoredAction): ActionReceiptSummary {
  const completion = action.lifecycle === 'completed' ? completedEvidence(action) : null;
  const start = completion?.startedAt ?? action.startedAt ?? action.intentTimestamp;
  const end = completion?.endedAt ?? action.endedAt ?? start;
  return canonical({
    actionRef: `public-action:${hash('harness-mdocs/public-action-ref/v1', action.actionId).slice(7)}`,
    resultClass: 'uncertain' as const,
    startedAt: start,
    endedAt: end,
    durationMs: Math.max(0, Date.parse(end) - Date.parse(start)),
    uncertaintyStatus: 'terminal-evidence-conflict'
  }) as ActionReceiptSummary;
}

/** Host assembly only. Deliberately omitted from public trust/package barrels. */
export function createActionMediator(options: ActionMediatorOptions): ActionMediatorHost {
  const maxCasRetries = options.maxCasRetries ?? 8;
  if (!Number.isSafeInteger(maxCasRetries) || maxCasRetries < 1 || maxCasRetries > 64) {
    throw new TypeError('maxCasRetries must be 1..64');
  }
  const now = options.now ?? (() => new Date());
  const idempotencySource = options.idempotencySource ?? (() => crypto.randomUUID());
  const executors = new Map<string, StructuredActionExecutor>();
  const operationOwners = new Map<ActionOperation, string>();
  for (const executor of options.executors) {
    if (!executor || typeof executor.kind !== 'string' || !bounded.safeParse(executor.kind).success ||
        typeof executor.validate !== 'function' || typeof executor.execute !== 'function' ||
        typeof executor.requiredCredentialClasses !== 'function' ||
        executors.has(executor.kind) ||
        !Array.isArray(executor.operations) || executor.operations.length === 0) {
      throw new TypeError('Structured executor registration is malformed or duplicated');
    }
    const operations = structuredActionSchema.options.map(option => option.shape.operation.value)
      .filter(operation => executor.operations.includes(operation));
    if (operations.length !== executor.operations.length ||
        operations.length !== new Set(executor.operations).size) {
      throw new TypeError('Structured executor registration contains unknown or duplicate operations');
    }
    for (const operation of operations) {
      if (operationOwners.has(operation)) throw new TypeError(`Operation "${operation}" has multiple executors`);
      operationOwners.set(operation, executor.kind);
    }
    const registered: StructuredActionExecutor = {
      kind: executor.kind,
      operations: Object.freeze(operations),
      validate: executor.validate,
      requiredCredentialClasses: executor.requiredCredentialClasses,
      execute: executor.execute,
      ...(executor.reconcile ? { reconcile: executor.reconcile } : {})
    };
    executors.set(executor.kind, Object.freeze(registered));
  }

  async function read(key: string): Promise<{ aggregate: MediationAggregate; generation: number } | null> {
    const value = await options.reader.read<MediationAggregate>(key);
    if (value.status === 'missing') return null;
    if (value.status !== 'active') throw new Error(`Protected mediation state is ${value.status}`);
    const parsed = parseAggregate(value.record.value);
    return { aggregate: parsed, generation: value.record.generation };
  }

  function parseAggregate(value: unknown): MediationAggregate {
    const snapshot = snapshotEvidenceData(value) as { format?: unknown; schemaVersion?: unknown };
    if (snapshot?.format === 'harness-mdocs/action-mediation' &&
        snapshot.schemaVersion !== MEDIATION_SCHEMA_VERSION) {
      throw new Error(`Protected mediation schemaVersion ${String(snapshot.schemaVersion)} is unsupported; expected ${MEDIATION_SCHEMA_VERSION}`);
    }
    const parsed = mediationAggregateSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new Error('Protected mediation aggregate is malformed');
    }
    const raw = parsed.data as MediationAggregate;
    if (Buffer.byteLength(canonicalizeJson(raw), 'utf8') > MAX_MEDIATION_AGGREGATE_BYTES) {
      throw new Error('Protected mediation aggregate exceeds conservative capacity');
    }
    for (const action of raw.actions) {
      if (action.actionDigest !== computeNormalizedOperationDigest(action.action) ||
          action.requestDigest !== intentRequestDigest(action)) {
        throw new Error('Protected mediation action binding is inconsistent');
      }
      if (action.lifecycle === 'completed') {
        if (!executorCompletionIsConsistent(action)) {
          throw new Error('Protected executor completion binding is inconsistent');
        }
        let expected: ContractEnvelope;
        try { expected = preliminaryReceipt(action); } catch {
          throw new Error('Protected preliminary receipt cannot be reconstructed');
        }
        if (!same(action.receipt, expected)) {
          throw new Error('Protected preliminary receipt differs from deterministic projection');
        }
      }
      for (const receipt of [action.receipt, action.finalizedReceipt]) {
        if (!receipt) continue;
        const envelope = contractEnvelopeSchema.safeParse(receipt);
        if (!envelope.success || envelope.data.kind !== 'action-receipt/v1' ||
            !evidenceActionReceiptPayloadSchema.safeParse(envelope.data.payload).success ||
            !verifyContractEnvelope(envelope.data).ok) {
          throw new Error('Protected mediation receipt is malformed');
        }
      }
      if (action.receipt !== null) {
        const envelope = contractEnvelopeSchema.parse(action.receipt);
        let validation;
        try {
          validation = validateActionReceipt(envelope, receiptValidationContext(
            action, envelope.id, action.authority.usage, null
          ));
        } catch {
          throw new Error('Protected preliminary receipt context is inconsistent');
        }
        if (!validation.ok) {
          throw new Error('Protected preliminary receipt no longer validates');
        }
      }
    }
    for (const barrier of raw.eoLineageBarriers) {
      const parentActions = raw.actions.filter(action =>
        action.authority.authorityKind === 'delegation-ticket' &&
        action.authority.recipientRole === 'EXECUTION' &&
        action.authority.authorityRef === barrier.eoAuthorityRef &&
        action.authority.eoLineageKey === barrier.eoAuthorityRef &&
        action.authority.usage.reservationId === barrier.reservationId &&
        action.authority.runId === barrier.runId &&
        action.authority.projectId === barrier.projectId &&
        action.authority.usage.authorityInstanceId === barrier.authorityInstanceId &&
        action.authority.usage.usageBindingDigest === barrier.usageBindingDigest);
      const settlement = raw.finalizedAuthorities.find(item =>
        item.scope.authorityKind === 'delegation-ticket' &&
        item.scope.runId === barrier.runId && item.scope.projectId === barrier.projectId &&
        item.scope.authorityRef === barrier.eoAuthorityRef &&
        item.scope.reservationId === barrier.reservationId &&
        item.scope.authorityInstanceId === barrier.authorityInstanceId &&
        item.scope.usageBindingDigest === barrier.usageBindingDigest);
      if (parentActions.length === 0 || !settlement) {
        throw new Error('Protected EO lineage barrier is inconsistent');
      }
    }
    for (const finalized of raw.finalizedAuthorities) {
      const matching = raw.actions.filter(action => actionInScope(action, finalized.scope));
      const completed = matching.filter(action => action.lifecycle === 'completed');
      if (matching.length === 0 || matching.some(action =>
            !['completed', 'denied'].includes(action.lifecycle) ||
            (action.lifecycle === 'completed' ? action.receipt === null : action.receipt !== null)) ||
          (finalized.usage !== null && finalized.usage.reservationId !== finalized.scope.reservationId) ||
          (finalized.status === 'finalized' && (completed.some(action => action.finalizedReceipt === null) ||
            matching.some(action => action.lifecycle === 'denied' && action.finalizedReceipt !== null))) ||
          (finalized.status === 'settling' && matching.some(action => action.finalizedReceipt !== null))) {
        throw new Error('Protected finalized authority is inconsistent');
      }
      if (finalized.scope.authorityKind === 'delegation-ticket' &&
          matching[0].authority.recipientRole === 'EXECUTION') {
        const expectedBarrier = eoLineageBarrierFor(finalized.scope);
        if (!raw.eoLineageBarriers.some(item =>
            eoLineageBarrierKey(item) === eoLineageBarrierKey(expectedBarrier))) {
          throw new Error('Protected finalized EO authority lacks lineage barrier');
        }
      }
      if (finalized.status !== 'settling') {
        if (finalized.scope.authorityKind === 'delegation-ticket') {
          validateDelegatedFinalization(raw, finalized, matching);
        }
        if (finalized.scope.authorityKind === 'controller-root' &&
            !same(finalized.usage, expectedRootUsage(finalized.scope, matching))) {
          throw new Error('Protected controller-root usage differs from deterministic projection');
        }
        for (const action of completed) {
          let expected: ContractEnvelope;
          try {
            expected = committedReceipt(action, finalized.usage!);
          } catch {
            throw new Error('Protected finalized receipt cannot be reconstructed');
          }
          if (!same(action.finalizedReceipt, expected)) {
            throw new Error('Protected finalized receipt differs from deterministic projection');
          }
        }
      }
    }
    return canonical(raw) as MediationAggregate;
  }

  async function update(
    key: string,
    initialize: { runId: string; projectId: string } | null,
    transition: (aggregate: MediationAggregate) => MediationAggregate
  ): Promise<MediationAggregate> {
    for (let attempt = 0; attempt < maxCasRetries; attempt += 1) {
      const current = await read(key);
      if (!current && !initialize) throw new Error('Protected mediation intent is absent');
      const aggregate = current?.aggregate ?? {
        format: 'harness-mdocs/action-mediation' as const,
        schemaVersion: MEDIATION_SCHEMA_VERSION,
        runId: initialize!.runId,
        projectId: initialize!.projectId,
        actions: [],
        finalizedAuthorities: [],
        eoLineageBarriers: []
      };
      const next = parseAggregate(transition(aggregate));
      if (same(next, aggregate)) return aggregate;
      try {
        const committed = await options.writer.compareAndSwap({
          key,
          expectedGeneration: current?.generation ?? 0,
          value: next
        });
        return committed.value as MediationAggregate;
      } catch (error) {
        if (error instanceof CasConflictError) continue;
        throw error;
      }
    }
    throw new Error('Mediation CAS retries exhausted');
  }

  function executorFor(kind: string, operation: ActionOperation): StructuredActionExecutor | null {
    const executor = executors.get(kind);
    return executor?.operations.includes(operation) ? executor : null;
  }

  async function verifyCurrent(
    intent: StoredAction,
    phase: 'pre-execute' | 'effect' | 'post-effect'
  ): Promise<ResolvedActionAuthority> {
    return parseAuthority(await options.authority.verifyAndReserve({
      phase, handle: intent.authority.authorityRef,
      actionId: intent.actionId, idempotencyKey: intent.idempotencyKey,
      actionDigest: intent.actionDigest, operation: intent.action.operation,
      adapterKind: intent.adapterKind,
      leaseProof: intent.authority.lease.kind === 'controller'
        ? { kind: 'controller', leaseRef: intent.authority.lease.ref,
          generation: intent.authority.lease.generation, fence: intent.authority.lease.fence }
        : { kind: 'workstream', nodeId: intent.authority.recipientRole === 'LEAF'
          ? intent.authority.parentNodeId! : intent.authority.nodeId,
          leaseRef: intent.authority.lease.ref, generation: intent.authority.lease.generation,
          fence: intent.authority.lease.fence },
      ...(intent.nodeId ? { nodeId: intent.nodeId } : {}),
      ...(intent.targetNodeId ? { targetNodeId: intent.targetNodeId } : {})
    }));
  }

  async function markUncertain(
    key: string,
    reservation: string,
    status: string,
    completedIsConflict = false
  ): Promise<ActionReceiptSummary> {
    let action: StoredAction | undefined;
    try {
      const aggregate = await update(key, null, state => ({
        ...state,
        actions: state.actions.map(item => item.reservationId === reservation
          ? item.lifecycle === 'completed' ? item
            : { ...item, lifecycle: 'uncertain' as const, endedAt: safeNow(now), uncertaintyStatus: status }
          : item)
      }));
      action = aggregate.actions.find(item => item.reservationId === reservation);
    } catch {
      const persisted = await read(key).catch(() => null);
      action = persisted?.aggregate.actions.find(item => item.reservationId === reservation);
    }
    if (!action) {
      const at = safeNow(now);
      return canonical({
        actionRef: `public-action:${hash('harness-mdocs/public-action-ref/v1', reservation).slice(7)}`,
        resultClass: 'uncertain' as const, startedAt: at, endedAt: at, durationMs: 0,
        uncertaintyStatus: status
      }) as ActionReceiptSummary;
    }
    if (action.lifecycle === 'completed') {
      return completedIsConflict ? terminalConflictSummary(action) : summary(action);
    }
    return summary({ ...action, lifecycle: 'uncertain', uncertaintyStatus: status });
  }

  async function markDenied(key: string, reservation: string, reason: string): Promise<ActionReceiptSummary> {
    let action: StoredAction | undefined;
    try {
      const aggregate = await update(key, null, state => ({
        ...state,
        actions: state.actions.map(item => item.reservationId === reservation && item.lifecycle === 'intent'
          ? { ...item, lifecycle: 'denied' as const, endedAt: safeNow(now), uncertaintyStatus: reason }
          : item)
      }));
      action = aggregate.actions.find(item => item.reservationId === reservation);
    } catch {
      const persisted = await read(key).catch(() => null);
      action = persisted?.aggregate.actions.find(item => item.reservationId === reservation);
    }
    if (action?.lifecycle === 'denied' || action?.lifecycle === 'completed') return summary(action);
    if (action?.lifecycle === 'executing' || action?.lifecycle === 'uncertain') {
      return markUncertain(key, reservation, reason);
    }
    return executionDenial(action?.actionId ?? 'unresolved-action', reason, safeNow(now));
  }

  async function complete(
    key: string,
    intent: StoredAction,
    rawResult: unknown
  ): Promise<ActionReceiptSummary> {
    let result: ActionExecutorResult;
    try {
      const parsed = executorResultSchema.safeParse(snapshotEvidenceData(rawResult));
      if (!parsed.success) throw new Error('Executor result is malformed');
      result = parsed.data as ActionExecutorResult;
    } catch {
      return markUncertain(key, intent.reservationId, 'executor-result-invalid', true);
    }
    if (result.actualTargets.some(target => !intent.declaredPaths.includes(target) ||
          !intent.action.writeSet.some(selector => writeSelectorCovers(selector, target))) ||
        result.mutations.some(target => !result.actualTargets.includes(target) ||
          !intent.declaredPaths.includes(target) ||
          !intent.action.writeSet.some(selector => writeSelectorCovers(selector, target))) ||
        !same(result.actualResources, intent.declaredResources) ||
        ((intent.action.operation === 'fs.write' || intent.action.operation === 'fs.delete') &&
          !result.actualTargets.includes(intent.action.path))) {
      return markUncertain(key, intent.reservationId, 'executor-target-boundary-violation', true);
    }
    if (!inputMetadataIsRedacted(intent.action, result.inputMetadata)) {
      return markUncertain(key, intent.reservationId, 'executor-metadata-not-redacted', true);
    }
    if (intent.action.operation === 'agent.spawn') {
      const childTicketRef = result.resultMetadata.childTicketRef;
      if ((result.resultClass === 'success' && childTicketRef !== intent.spawnChildTicketRef) ||
          (result.resultClass !== 'success' && childTicketRef !== null)) {
        return markUncertain(key, intent.reservationId, 'spawn-child-ticket-mismatch', true);
      }
    }
    if (Date.parse(result.startedAt) < Date.parse(intent.intentTimestamp)) {
      return markUncertain(key, intent.reservationId, 'executor-timestamp-invalid', true);
    }

    let before: ReturnType<typeof computeWorkspaceFingerprint>;
    let after: ReturnType<typeof computeWorkspaceFingerprint>;
    try {
      before = computeWorkspaceFingerprint(result.workspaceBefore);
      after = computeWorkspaceFingerprint(result.workspaceAfter);
    } catch {
      return markUncertain(key, intent.reservationId, 'workspace-fingerprint-invalid', true);
    }
    const receivedAt = safeNow(now);
    if (Date.parse(receivedAt) < Date.parse(result.endedAt)) {
      return markUncertain(key, intent.reservationId, 'trusted-clock-precedes-effect', true);
    }
    const completion = executorCompletionSchema.parse({
      format: 'harness-mdocs/action-executor-completion',
      schemaVersion: 1,
      resultClass: result.resultClass,
      uncertaintyStatus: result.uncertaintyStatus ?? null,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      actualTargets: result.actualTargets,
      actualResources: result.actualResources,
      inputMetadata: result.inputMetadata,
      resultMetadata: result.resultMetadata,
      workspaceBefore: { scope: before.scope, entries: before.entries },
      workspaceAfter: { scope: after.scope, entries: after.entries },
      beforeFingerprint: before.digest,
      afterFingerprint: after.digest,
      mutations: result.mutations,
      artifactHashes: result.artifactHashes,
      receiptReceivedAt: receivedAt
    });
    let completedAction: StoredAction = {
      ...intent,
      lifecycle: 'completed',
      startedAt: null,
      endedAt: null,
      uncertaintyStatus: null,
      completion,
      completionDigest: null,
      receipt: null
    };
    completedAction = {
      ...completedAction,
      completionDigest: computeStoredActionCompletionDigest(completedAction)
    };
    let receipt: ContractEnvelope;
    try {
      receipt = preliminaryReceipt(completedAction);
    } catch {
      return markUncertain(key, intent.reservationId, 'receipt-projection-invalid', true);
    }
    completedAction = {
      ...completedAction,
      receipt: receipt as unknown as Record<string, unknown>
    };

    try {
      const aggregate = await update(key, null, state => ({
        ...state,
        actions: state.actions.map(item => item.reservationId === intent.reservationId
           ? item.lifecycle === 'completed' ? item
              : item.lifecycle === 'executing' || item.lifecycle === 'uncertain'
                ? { ...completedAction, finalizedReceipt: item.finalizedReceipt }
               : item
          : item)
      }));
      const terminal = aggregate.actions.find(item => item.reservationId === intent.reservationId)!;
      if (!same(terminal.receipt, receipt)) {
        return terminalConflictSummary(terminal);
      }
      return summary(terminal);
    } catch {
      const recovered = await read(key).catch(() => null);
      const action = recovered?.aggregate.actions.find(item => item.reservationId === intent.reservationId);
      if (action?.lifecycle === 'completed' && same(action.receipt, receipt)) return summary(action);
      return markUncertain(key, intent.reservationId, 'receipt-persistence-indeterminate', true);
    }
  }

  const mediator: ActionMediator = Object.freeze({
    async authorize(
      handle: string,
      rawAction: StructuredAction,
      rawOptions: ActionAuthorizationOptions = {}
    ): Promise<MediationDecision> {
      if (!options.killSwitch.effectsAllowed()) {
        return denial('kill-switch', 'Run effects disabled');
      }
      let action: StructuredAction;
      let authorization: ReturnType<typeof optionsSchema.parse>;
      try {
        action = structuredActionSchema.parse(snapshotEvidenceData(rawAction)) as StructuredAction;
        action = canonical({ ...action, writeSet: sorted(action.writeSet) }) as StructuredAction;
        authorization = optionsSchema.parse(snapshotEvidenceData(rawOptions));
      } catch (error) {
        return denial('invalid-request', 'Action request is invalid');
      }
      const adapterKind = authorization.adapterKind ?? operationOwners.get(action.operation);
      if (!adapterKind) return denial('unknown-operation', `No executor registered for "${action.operation}"`);
      const adapter = executorFor(adapterKind, action.operation);
      if (!adapter) return denial('unknown-operation', 'Unknown or mismatched structured executor');
      const idempotencyKey = authorization.idempotencyKey ?? idempotencySource();
      const actionDigest = computeNormalizedOperationDigest(action);
      const actionId = authorization.actionId ??
        `action:${hash('harness-mdocs/action-id/v1', { idempotencyKey, actionDigest }).slice(7)}`;
      let authority: ResolvedActionAuthority;
      // Live authority is always checked before persisted idempotency lookup.
      // Lost acknowledgement retains its conservative charge but cannot revive revoked authority.
      try {
        authority = parseAuthority(await options.authority.verifyAndReserve({
          phase: 'authorize', handle, actionId, idempotencyKey, actionDigest,
          operation: action.operation, adapterKind,
          ...(authorization.leaseProof ? { leaseProof: authorization.leaseProof } : {}),
          ...(authorization.nodeId ? { nodeId: authorization.nodeId } : {}),
          ...(authorization.targetNodeId ? { targetNodeId: authorization.targetNodeId } : {})
        }));
      } catch (error) {
        const code = errorCode(error);
        return denial(code, `Authority verification denied (${code})`);
      }
      const denied = assertAuthority(authority, action, authorization, adapter);
      if (denied) return denied;
      const approvalRefs = sorted(authorization.approvalRefs ?? authority.approvalRefs);
      const declaredPaths = sorted(authorization.declaredPaths ??
        (action.operation === 'fs.write' || action.operation === 'fs.delete' ? [action.path] : []));
      const declaredResources = resourceBindings(action);
      if (authorization.declaredResources !== undefined &&
          !same(sorted(authorization.declaredResources), declaredResources)) {
        return denial('invalid-request', 'Declared resources differ from canonical action binding');
      }
      const executorRequest = canonical({
        actionId, idempotencyKey, actionDigest, action, declaredPaths, declaredResources,
        spawnChildTicketRef: authority.spawnChildTicketRef
      }) as ActionExecutorRequest;
      let credentialClasses: string[];
      try {
        credentialClasses = requiredCredentialClasses(adapter, executorRequest);
      } catch {
        return denial('policy-denied', 'Structured executor credential policy unavailable');
      }
      if (authorization.credentialClasses !== undefined &&
          !same(sorted(authorization.credentialClasses), credentialClasses)) {
        return denial('policy-denied', 'Credential classes differ from host executor requirements');
      }
      if (credentialClasses.some(item => !authority.credentialClasses.includes(item))) {
        return denial('policy-denied', 'Host-required credential class is outside authority scope');
      }
      const budgetCharge = authorization.budgetCharge ?? 1;
      const requestDigest = intentRequestDigest({
        actionId, idempotencyKey, actionDigest, adapterKind, budgetCharge,
        approvalRefs, credentialClasses, declaredPaths, declaredResources,
        nodeId: authorization.nodeId ?? null,
        targetNodeId: authorization.targetNodeId ?? null,
        authority
      });
      try {
        if (adapter.validate(executorRequest) !== true) {
          return denial('policy-denied', 'Structured executor request policy denied action');
        }
      } catch {
        return denial('policy-denied', 'Structured executor request validation failed');
      }
      const reservation = reservationId(authority.runId, idempotencyKey);
      const key = `intent/${authority.runId}`;
      try {
        const aggregate = await update(key, { runId: authority.runId, projectId: authority.projectId }, state => {
          if (state.runId !== authority.runId || state.projectId !== authority.projectId) {
            throw new Error('Mediation aggregate run/project binding mismatch');
          }
          const existing = state.actions.find(item => item.idempotencyKey === idempotencyKey);
          if (existing) {
            if (!liveBindingMatches(existing.authority, authority)) {
              const conflict = new Error('Persisted authority binding differs from live authority');
              Object.assign(conflict, { code: 'authority-drift' });
              throw conflict;
            }
            if (existing.requestDigest !== requestDigest) {
              const conflict = new Error('Idempotency key conflicts with persisted action');
              Object.assign(conflict, { code: 'idempotency-conflict' });
              throw conflict;
            }
            return state;
          }
          const authorityScope = actionReceiptAuthorityScope(authority);
          const barrierKey = authorityEoBarrierKey(authority);
          if ((barrierKey !== null && state.eoLineageBarriers.some(item =>
                eoLineageBarrierKey(item) === barrierKey)) ||
              authority.usage.status === 'committed' ||
              state.finalizedAuthorities.some(item => scopeKey(item.scope) === scopeKey(authorityScope))) {
            const conflict = new Error('Receipt authority is finalized and cannot accept new actions');
            Object.assign(conflict, { code: 'authority-finalized' });
            throw conflict;
          }
          if (authority.spawnChildTicketRef !== null && state.actions.some(item =>
              item.spawnChildTicketRef === authority.spawnChildTicketRef)) {
            const conflict = new Error('Pre-issued child ticket is already bound to another action');
            Object.assign(conflict, { code: 'idempotency-conflict' });
            throw conflict;
          }
          if (state.actions.some(item => item.actionId === actionId)) {
            const conflict = new Error('Action ID conflicts with persisted action');
            Object.assign(conflict, { code: 'idempotency-conflict' });
            throw conflict;
          }
          const charged = state.actions
            .filter(item => localActionKey(item.authority) === localActionKey(authority))
            .reduce((total, item) => total + item.budgetCharge, 0);
          const eoLineageCharged = authority.eoLineageKey === null ? 0 : state.actions
            .filter(item => item.authority.eoLineageKey === authority.eoLineageKey)
            .reduce((total, item) => total + item.budgetCharge, 0);
          const globallyCharged = state.actions.reduce((total, item) => total + item.budgetCharge, 0);
          if (state.actions.length >= MAX_ACTIONS ||
              globallyCharged + budgetCharge > authority.globalActionLimit ||
              charged + budgetCharge > authority.localActionLimit ||
              (authority.eoLineageKey !== null &&
                eoLineageCharged + budgetCharge > authority.eoLineageActionLimit)) {
            const exhausted = new Error('Cumulative action budget exhausted');
            Object.assign(exhausted, { code: 'budget-exceeded' });
            throw exhausted;
          }
          const intent: StoredAction = {
            format: 'harness-mdocs/action-intent', schemaVersion: MEDIATION_SCHEMA_VERSION,
            reservationId: reservation, actionId, idempotencyKey, requestDigest, actionDigest, action,
            authority, adapterKind, budgetCharge, approvalRefs, credentialClasses,
            declaredPaths, declaredResources, nodeId: authorization.nodeId ?? null,
            targetNodeId: authorization.targetNodeId ?? null,
            spawnChildTicketRef: authority.spawnChildTicketRef,
            intentTimestamp: safeNow(now), lifecycle: 'intent', startedAt: null, endedAt: null,
            uncertaintyStatus: null, completion: null, completionDigest: null,
            receipt: null, finalizedReceipt: null
          };
          return { ...state, actions: [...state.actions, intent] };
        });
        const persisted = aggregate.actions.find(item => item.idempotencyKey === idempotencyKey)!;
        return canonical({ allowed: true as const, reservationId: persisted.reservationId });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code) : '';
        if (code === 'idempotency-conflict') {
          return denial('idempotency-conflict', 'Persisted action identity conflicts');
        }
        if (code === 'authority-drift') return denial('policy-denied', 'Persisted authority binding changed');
        if (code === 'authority-finalized') return denial('policy-denied', 'Receipt authority is finalized');
        if (code === 'budget-exceeded') return denial('budget-exceeded', 'Cumulative action budget exhausted');
        return denial('store-unavailable', 'Protected mediation store unavailable');
      }
    },

    async execute(reservation: string): Promise<ActionReceiptSummary> {
      const key = keyFromReservation(reservation);
      if (!key) {
        const at = safeNow(now);
        return executionDenial('unresolved-action', 'unknown-reservation', at);
      }
      let current;
      try { current = await read(key); } catch { return markUncertain(key, reservation, 'store-unavailable'); }
      let intent = current?.aggregate.actions.find(item => item.reservationId === reservation);
      if (!intent) return executionDenial('unresolved-action', 'unknown-reservation', safeNow(now));
      if (intent.lifecycle === 'completed' || intent.lifecycle === 'denied') return summary(intent);
      const adapter = executorFor(intent.adapterKind, intent.action.operation);
      if (!adapter && intent.lifecycle === 'intent') {
        return markDenied(key, reservation, 'executor-unavailable');
      }
      if (!adapter) return markUncertain(key, reservation, 'executor-unavailable');
      if (intent.lifecycle === 'executing' || intent.lifecycle === 'uncertain') {
        if (!adapter.reconcile) return markUncertain(key, reservation, 'execution-outcome-unknown');
        let reconciled: ActionExecutorResult | null;
        try { reconciled = await adapter.reconcile(requestFor(intent)); } catch { reconciled = null; }
        if (!reconciled) return markUncertain(key, reservation, 'reconciliation-unresolved');
        let reconciledAuthority: ResolvedActionAuthority;
        try { reconciledAuthority = await verifyCurrent(intent, 'post-effect'); } catch (error) {
          return markUncertain(key, reservation, `post-effect-authority-denied:${errorCode(error)}`);
        }
        if (!liveBindingMatches(intent.authority, reconciledAuthority)) {
          return markUncertain(key, reservation, 'post-effect-authority-generation-drift');
        }
        return complete(key, intent, reconciled);
      }
      if (!options.killSwitch.effectsAllowed()) {
        return markDenied(key, reservation, 'kill-switch-before-effect');
      }
      let currentAuthority: ResolvedActionAuthority;
      try {
        currentAuthority = await verifyCurrent(intent, 'pre-execute');
      } catch (error) {
        return markDenied(key, reservation, `authority-revalidation-denied:${errorCode(error)}`);
      }
      if (!liveBindingMatches(intent.authority, currentAuthority)) {
        return markDenied(key, reservation, 'authority-generation-drift');
      }
      if (!options.killSwitch.effectsAllowed()) {
        return markDenied(key, reservation, 'kill-switch-before-effect');
      }
      try {
        if (!executorPolicyMatches(adapter, intent)) {
          return markDenied(key, reservation, 'executor-policy-drift');
        }
      } catch {
        return markDenied(key, reservation, 'executor-policy-unavailable');
      }
      let claimedExecution = false;
      try {
        const aggregate = await update(key, null, state => {
          claimedExecution = false;
          return {
            ...state,
            actions: state.actions.map(item => {
              if (item.reservationId !== reservation || item.lifecycle !== 'intent') return item;
              claimedExecution = true;
              return { ...item, lifecycle: 'executing' as const, startedAt: safeNow(now) };
            })
          };
        });
        intent = aggregate.actions.find(item => item.reservationId === reservation)!;
        if (!claimedExecution) {
          return intent.lifecycle === 'completed' ? summary(intent) :
            markUncertain(key, reservation, 'concurrent-execution-in-progress');
        }
      } catch {
        const recovered = await read(key).catch(() => null);
        const recoveredAction = recovered?.aggregate.actions.find(item => item.reservationId === reservation);
        if (recoveredAction?.lifecycle === 'completed') return summary(recoveredAction);
        return markUncertain(key, reservation, 'execution-start-persistence-indeterminate');
      }
      try {
        currentAuthority = await verifyCurrent(intent, 'pre-execute');
      } catch (error) {
        return markUncertain(key, reservation, `final-authority-denied:${errorCode(error)}`);
      }
      if (!liveBindingMatches(intent.authority, currentAuthority)) {
        return markUncertain(key, reservation, 'final-authority-generation-drift');
      }
      if (!options.killSwitch.effectsAllowed()) {
        return markUncertain(key, reservation, 'final-kill-switch-before-effect');
      }
      try {
        if (!executorPolicyMatches(adapter, intent)) {
          return markUncertain(key, reservation, 'final-executor-policy-drift');
        }
      } catch {
        return markUncertain(key, reservation, 'final-executor-policy-unavailable');
      }
      let guardCalls = 0;
      let guardedAuthority: ResolvedActionAuthority | null = null;
      const guard: ActionEffectGuard = Object.freeze({
        async assertCurrent() {
          guardCalls += 1;
          if (guardCalls !== 1) throw new Error('Effect guard must be invoked exactly once');
          const live = await verifyCurrent(intent, 'effect');
          if (!liveBindingMatches(intent.authority, live) || !options.killSwitch.effectsAllowed() ||
              !executorPolicyMatches(adapter, intent)) {
            throw new Error('Effect guard rejected current authority');
          }
          guardedAuthority = live;
        }
      });
      let result: ActionExecutorResult;
      try {
        result = await adapter.execute(requestFor(intent), guard);
      } catch {
        if (guardCalls !== 1 || guardedAuthority === null) {
          return markUncertain(key, reservation, 'effect-guard-rejected');
        }
        return markUncertain(key, reservation, 'executor-threw-outcome-unknown');
      }
      if (guardCalls !== 1 || guardedAuthority === null) {
        return markUncertain(key, reservation, 'effect-guard-not-satisfied');
      }
      let postEffectAuthority: ResolvedActionAuthority;
      try {
        postEffectAuthority = await verifyCurrent(intent, 'post-effect');
      } catch (error) {
        return markUncertain(key, reservation, `post-effect-authority-denied:${errorCode(error)}`);
      }
      if (!liveBindingMatches(guardedAuthority, postEffectAuthority)) {
        return markUncertain(key, reservation, 'post-effect-authority-generation-drift');
      }
      return complete(key, intent, result);
    }
  });

  function scopedActions(aggregate: MediationAggregate, scope: ReceiptAuthorityScope): StoredAction[] {
    if (aggregate.runId !== scope.runId || aggregate.projectId !== scope.projectId) {
      projectionFail('scope-mismatch', 'Receipt scope run/project differs from protected aggregate');
    }
    const candidates = aggregate.actions.filter(action =>
      action.authority.usage.reservationId === scope.reservationId);
    if (candidates.length === 0) projectionFail('unknown-authority', 'Receipt authority has no protected actions');
    if (candidates.some(action => !actionInScope(action, scope))) {
      projectionFail('scope-mismatch', 'Receipt authority scope differs from protected action binding');
    }
    return candidates;
  }

  function settlementActions(
    aggregate: MediationAggregate,
    scope: ReceiptAuthorityScope
  ): StoredAction[] {
    const direct = scopedActions(aggregate, scope);
    if (scope.authorityKind !== 'delegation-ticket' ||
        direct[0].authority.recipientRole !== 'EXECUTION') {
      return direct;
    }
    const subtree = aggregate.actions.filter(action =>
      action.authority.authorityKind === 'delegation-ticket' &&
      action.authority.eoLineageKey === scope.authorityRef &&
      (action.authority.authorityRef === scope.authorityRef ||
        (action.authority.parentAuthorityRef === scope.authorityRef &&
          action.authority.handleLineage[0] === scope.authorityRef)));
    if (subtree.some(action => action.authority.runId !== scope.runId ||
        action.authority.projectId !== scope.projectId ||
        action.authority.usage.authorityInstanceId !== scope.authorityInstanceId ||
        action.authority.usage.usageBindingDigest !== scope.usageBindingDigest)) {
      projectionFail('scope-mismatch', 'EO subtree authority binding is inconsistent');
    }
    return subtree;
  }

  function settlementConstraints(
    scope: DelegatedReceiptAuthorityScope,
    actions: readonly StoredAction[]
  ): RunAuthoritySettlementConstraints {
    const completed = actions.filter(action => action.lifecycle === 'completed');
    const notBefore = completed.reduce((latest, action) =>
      Date.parse(terminalEndedAt(action)) > Date.parse(latest) ? terminalEndedAt(action) : latest,
    actions[0].authority.usage.startedAt);
    return canonical({
      runId: scope.runId,
      projectId: scope.projectId,
      reservationId: scope.reservationId,
      authorityKind: 'delegation-ticket' as const,
      authorityRef: scope.authorityRef,
      nodeId: scope.nodeId,
      authorityInstanceId: scope.authorityInstanceId,
      usageBindingDigest: scope.usageBindingDigest,
      notBefore,
      expectedActionCount: completed.reduce((total, action) => total + action.budgetCharge, 0)
    }) as RunAuthoritySettlementConstraints;
  }

  function expectedRootUsage(
    scope: ControllerRootReceiptAuthorityScope,
    actions: readonly StoredAction[]
  ): TrustedFinalUsage {
    const completed = actions.filter(action => action.lifecycle === 'completed');
    const pending = actions[0].authority.usage;
    const terminalTimestamp = (completed.length > 0 ? completed : actions).reduce((latest, action) =>
      Date.parse(terminalEndedAt(action)) > Date.parse(latest) ? terminalEndedAt(action) : latest,
    pending.startedAt);
    if (Date.parse(terminalTimestamp) < Date.parse(pending.startedAt) ||
        Date.parse(terminalTimestamp) > Date.parse(pending.deadlineAt)) {
      projectionFail('projection-invalid', 'Controller-root action timestamp is outside authority window');
    }
    const final = {
      source: 'harness-mdocs/action-mediator',
      provider: 'harness-mdocs',
      model: 'controller-root-actions',
      priceTableVersion: 'action-count/v1',
      actionCount: completed.reduce((total, action) => total + action.budgetCharge, 0),
      confidence: 'authoritative' as const,
      timestamp: terminalTimestamp
    };
    const actual = deriveAuthorityUsageActual({
      amounts: pending.amounts,
      currency: pending.currency,
      sample: final,
      descendantCommitted: {}
    });
    return canonical({
      runId: scope.runId,
      projectId: scope.projectId,
      authorityKind: 'controller-root' as const,
      authorityRef: null,
      nodeId: scope.nodeId,
      reservationId: scope.reservationId,
      authorityInstanceId: scope.authorityInstanceId,
      usageBindingDigest: scope.usageBindingDigest,
      settlementConstraintDigest: null,
      status: 'committed' as const,
      startedAt: pending.startedAt,
      deadlineAt: pending.deadlineAt,
      final,
      sampleDigest: computeAuthorityUsageSampleDigest(final),
      amounts: pending.amounts,
      currency: pending.currency,
      descendantCommitted: {},
      actual
    }) as TrustedFinalUsage;
  }

  function validateDelegatedFinalization(
    aggregate: MediationAggregate,
    finalized: FinalizedAuthority,
    direct: readonly StoredAction[]
  ): void {
    if (finalized.scope.authorityKind !== 'delegation-ticket' || !finalized.usage) return;
    const usage = parseTrustedFinalUsage(finalized.usage, finalized.scope);
    assertUsageBinding(direct, usage);
    const included = settlementActions(aggregate, finalized.scope);
    const constraints = settlementConstraints(finalized.scope, included);
    if (usage.settlementConstraintDigest !==
        computeRunAuthoritySettlementConstraintDigest(constraints)) {
      throw new Error('Protected delegated settlement constraint digest is inconsistent');
    }
    const completed = included.filter(action => action.lifecycle === 'completed');
    if (included.some(action => !['completed', 'denied'].includes(action.lifecycle)) ||
        usage.final.actionCount !== completed.reduce((total, action) => total + action.budgetCharge, 0)) {
      throw new Error('Protected delegated action count differs from frozen effects');
    }
    const latest = completed.reduce((value, action) =>
      Date.parse(terminalEndedAt(action)) > Date.parse(value) ? terminalEndedAt(action) : value,
    usage.startedAt);
    if (Date.parse(usage.final.timestamp) < Date.parse(latest) ||
        Date.parse(usage.final.timestamp) > Date.parse(usage.deadlineAt)) {
      throw new Error('Protected delegated usage timestamp differs from frozen effects');
    }
    const expectedDescendants = Object.fromEntries(BUDGET_DIMENSIONS.map(dimension => [dimension, 0]));
    if (direct[0].authority.recipientRole === 'EXECUTION') {
      const descendantReservations = [...new Set(included
        .filter(action => action.authority.usage.reservationId !== finalized.scope.reservationId)
        .map(action => action.authority.usage.reservationId))];
      for (const reservationId of descendantReservations) {
        const actions = included.filter(action => action.authority.usage.reservationId === reservationId);
        const childScope = actionReceiptAuthorityScope(actions[0].authority);
        const child = aggregate.finalizedAuthorities.find(item =>
          scopeKey(item.scope) === scopeKey(childScope));
        if (!child || child.status !== 'finalized' || !child.usage || !same(child.scope, childScope)) {
          throw new Error('Protected EO usage lacks finalized descendant authority');
        }
        const childUsage = parseTrustedFinalUsage(child.usage, childScope);
        for (const dimension of BUDGET_DIMENSIONS) {
          expectedDescendants[dimension] += childUsage.actual[dimension] ?? 0;
        }
      }
    }
    if (!same(usage.descendantCommitted, expectedDescendants)) {
      throw new Error('Protected delegated descendant usage differs from finalized children');
    }
  }

  function assertUsageBinding(actions: readonly StoredAction[], usage: TrustedFinalUsage): void {
    if (actions.some(action => {
      const pending = action.authority.usage;
      return pending.reservationId !== usage.reservationId || pending.startedAt !== usage.startedAt ||
        pending.deadlineAt !== usage.deadlineAt || pending.currency !== usage.currency ||
        !same(pending.amounts, usage.amounts);
    })) {
      projectionFail('scope-mismatch', 'Trusted usage differs from protected pending reservation');
    }
  }

  function committedReceipt(action: StoredAction, usage: TrustedFinalUsage): ContractEnvelope {
    const preliminary = preliminaryReceipt(action);
    if (!same(action.receipt, preliminary)) {
      projectionFail('projection-invalid', 'Preliminary receipt differs from deterministic projection');
    }
    try {
      return projectedReceipt(action, usage, preliminary);
    } catch (error) {
      projectionFail('projection-invalid', `Committed receipt validation failed: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function finalizeScope(
    scopeValue: ReceiptAuthorityScope,
    usageValue: TrustedFinalUsage
  ): Promise<Readonly<FinalizedReceiptSet>> {
    const scope = parseReceiptScope(scopeValue);
    const usage = parseTrustedFinalUsage(usageValue, scope);
    const key = `intent/${scope.runId}`;
    let persisted: MediationAggregate;
    try {
      persisted = await update(key, null, aggregate => {
        const actions = scopedActions(aggregate, scope);
        const completed = actions.filter(action => action.lifecycle === 'completed');
        if (actions.some(action => !['completed', 'denied'].includes(action.lifecycle)) ||
            completed.some(action => action.receipt === null)) {
          projectionFail('authority-not-terminal', 'Receipt authority still has unresolved effects');
        }
        assertUsageBinding(actions, usage);
        const existing = aggregate.finalizedAuthorities.find(item => scopeKey(item.scope) === scopeKey(scope));
        if (!existing || !same(existing.scope, scope)) {
          projectionFail('persistence-indeterminate', 'Receipt authority settlement phase is absent');
        }
        if (existing.status === 'conflict') {
          projectionFail('final-usage-conflict', 'Receipt authority is in terminal usage conflict');
        }
        if (existing.status === 'finalized') {
          if (same(existing.usage, usage)) return aggregate;
          return {
            ...aggregate,
            finalizedAuthorities: aggregate.finalizedAuthorities.map(item =>
              scopeKey(item.scope) === scopeKey(scope) ? { ...item, status: 'conflict' as const } : item)
          };
        }
        const projections = new Map(completed.map(action =>
          [action.reservationId, committedReceipt(action, usage) as unknown as Record<string, unknown>]));
        return {
          ...aggregate,
          actions: aggregate.actions.map(action => projections.has(action.reservationId)
            ? { ...action, finalizedReceipt: projections.get(action.reservationId)! }
            : action),
          finalizedAuthorities: aggregate.finalizedAuthorities.map(item =>
            scopeKey(item.scope) === scopeKey(scope)
              ? { scope, status: 'finalized' as const, usage }
              : item)
        };
      });
    } catch (error) {
      if (error instanceof ActionReceiptProjectionError) throw error;
      const recovered = await read(key).catch(() => null);
      if (!recovered) projectionFail('persistence-indeterminate', 'Receipt projection persistence is indeterminate');
      const record = recovered.aggregate.finalizedAuthorities.find(item =>
        scopeKey(item.scope) === scopeKey(scope));
      if (record?.status === 'conflict' && same(record.scope, scope)) {
        projectionFail('final-usage-conflict', 'Receipt authority has conflicting final usage');
      }
      if (!record || !same(record.scope, scope) || !same(record.usage, usage)) {
        projectionFail('persistence-indeterminate', `Receipt projection persistence is indeterminate: ${
          error instanceof Error ? error.message : String(error)}`);
      }
      persisted = recovered.aggregate;
    }
    const record = persisted.finalizedAuthorities.find(item => scopeKey(item.scope) === scopeKey(scope));
    if (!record || record.status !== 'finalized' || !record.usage ||
        !same(record.scope, scope) || !same(record.usage, usage)) {
      projectionFail('final-usage-conflict', 'Receipt authority has conflicting final usage');
    }
    const actions = scopedActions(persisted, scope).filter(action => action.lifecycle === 'completed');
    const receipts = actions.map(action => {
      if (!action.finalizedReceipt) projectionFail('persistence-indeterminate', 'Committed receipt projection is absent');
      return canonical(contractEnvelopeSchema.parse(action.finalizedReceipt)) as Readonly<ContractEnvelope>;
    });
    return canonical({ scope, usage: record.usage, receipts }) as Readonly<FinalizedReceiptSet>;
  }

  async function beginFinalization(scopeValue: ReceiptAuthorityScope): Promise<FinalizedAuthority> {
    const scope = parseReceiptScope(scopeValue);
    const key = `intent/${scope.runId}`;
    let aggregate: MediationAggregate;
    try {
      aggregate = await update(key, null, state => {
        const direct = scopedActions(state, scope);
        const actions = settlementActions(state, scope);
        const completed = actions.filter(action => action.lifecycle === 'completed');
        if (actions.some(action => !['completed', 'denied'].includes(action.lifecycle)) ||
            completed.some(action => action.receipt === null)) {
          projectionFail('authority-not-terminal', 'Receipt authority still has unresolved effects');
        }
        const existing = state.finalizedAuthorities.find(item => scopeKey(item.scope) === scopeKey(scope));
        const barrier = scope.authorityKind === 'delegation-ticket' &&
          direct[0].authority.recipientRole === 'EXECUTION'
          ? eoLineageBarrierFor(scope) : null;
        if (existing) {
          if (!same(existing.scope, scope)) {
            projectionFail('scope-mismatch', 'Receipt authority settlement scope conflicts');
          }
          if (existing.status === 'conflict') {
            projectionFail('final-usage-conflict', 'Receipt authority is in terminal usage conflict');
          }
          if (barrier && !state.eoLineageBarriers.some(item =>
              eoLineageBarrierKey(item) === eoLineageBarrierKey(barrier))) {
            projectionFail('persistence-indeterminate', 'EO settlement barrier is absent');
          }
          return state;
        }
        return {
          ...state,
          finalizedAuthorities: [...state.finalizedAuthorities, {
            scope, status: 'settling' as const, usage: null
          }],
          eoLineageBarriers: barrier
            ? [...state.eoLineageBarriers, barrier]
            : state.eoLineageBarriers
        };
      });
    } catch (error) {
      if (error instanceof ActionReceiptProjectionError) throw error;
      const recovered = await read(key).catch(() => null);
      const record = recovered?.aggregate.finalizedAuthorities.find(item =>
        scopeKey(item.scope) === scopeKey(scope));
      if (!record || !same(record.scope, scope) || record.status === 'conflict') {
        projectionFail('persistence-indeterminate', 'Receipt authority settlement persistence is indeterminate');
      }
      aggregate = recovered!.aggregate;
    }
    const record = aggregate.finalizedAuthorities.find(item => scopeKey(item.scope) === scopeKey(scope));
    if (!record || !same(record.scope, scope) || record.status === 'conflict') {
      projectionFail('persistence-indeterminate', 'Receipt authority settlement phase is unavailable');
    }
    return record;
  }

  async function readReceipt(reservation: string, preliminary: boolean): Promise<Readonly<ContractEnvelope> | null> {
    const key = keyFromReservation(reservation);
    if (!key) return null;
    const current = await read(key);
    const action = current?.aggregate.actions.find(item =>
      item.reservationId === reservation && item.lifecycle === 'completed');
    if (!action?.receipt) return null;
    if (!preliminary && action.finalizedReceipt) {
      const scope = actionReceiptAuthorityScope(action.authority);
      const record = current!.aggregate.finalizedAuthorities.find(item =>
        scopeKey(item.scope) === scopeKey(scope));
      if (!record || record.status !== 'finalized') {
        projectionFail('final-usage-conflict', 'Receipt authority projection is conflicted');
      }
      return canonical(contractEnvelopeSchema.parse(action.finalizedReceipt)) as Readonly<ContractEnvelope>;
    }
    return canonical(contractEnvelopeSchema.parse(action.receipt)) as Readonly<ContractEnvelope>;
  }

  return Object.freeze({
    mediator,
    async receiptEvidence(reservation: string): Promise<Readonly<ContractEnvelope> | null> {
      return readReceipt(reservation, false);
    },
    async preliminaryReceiptEvidence(reservation: string): Promise<Readonly<ContractEnvelope> | null> {
      return readReceipt(reservation, true);
    },
    async terminalReceipts(scopeValue: ReceiptAuthorityScope) {
      const scope = parseReceiptScope(scopeValue);
      const current = await read(`intent/${scope.runId}`);
      if (!current) projectionFail('unknown-authority', 'Receipt authority aggregate is absent');
      const actions = scopedActions(current.aggregate, scope).filter(action => action.lifecycle === 'completed');
      const record = current.aggregate.finalizedAuthorities.find(item => scopeKey(item.scope) === scopeKey(scope));
      if (record?.status === 'conflict') {
        projectionFail('final-usage-conflict', 'Receipt authority projection is conflicted');
      }
      return canonical(actions.map(action => contractEnvelopeSchema.parse(
        record?.status === 'finalized' ? action.finalizedReceipt : action.receipt
      ))) as readonly Readonly<ContractEnvelope>[];
    },
    async finalizeDelegatedReceipts(
      scopeValue: DelegatedReceiptAuthorityScope,
      authority: RunAuthorityReportBackend
    ) {
      const scope = parseReceiptScope(scopeValue);
      if (scope.authorityKind !== 'delegation-ticket') {
        projectionFail('invalid-scope', 'Delegated receipt finalization requires authority report backend');
      }
      try {
        await assertRunAuthorityReportBackend(authority, {
          runId: scope.runId,
          projectId: scope.projectId,
          authorityInstanceId: scope.authorityInstanceId,
          usageBindingDigest: scope.usageBindingDigest
        });
      } catch {
        projectionFail('invalid-scope', 'Delegated receipt finalization requires matching trusted backend');
      }
      const settlement = await beginFinalization(scope);
      const frozen = await read(`intent/${scope.runId}`);
      if (!frozen) projectionFail('unknown-authority', 'Receipt authority aggregate is absent');
      const included = settlementActions(frozen.aggregate, scope);
      const direct = scopedActions(frozen.aggregate, scope);
      if (direct[0].authority.recipientRole === 'EXECUTION') {
        const descendants = [...new Set(included
          .filter(action => action.authority.usage.reservationId !== scope.reservationId)
          .map(action => action.authority.usage.reservationId))];
        if (descendants.some(reservationId => {
          const action = included.find(item => item.authority.usage.reservationId === reservationId)!;
          const childScope = actionReceiptAuthorityScope(action.authority);
          const child = frozen.aggregate.finalizedAuthorities.find(item =>
            scopeKey(item.scope) === scopeKey(childScope));
          return !child || child.status !== 'finalized' || !same(child.scope, childScope);
        })) {
          projectionFail('authority-not-terminal', 'EO descendants require finalized receipt authority');
        }
      }
      const constraints = settlementConstraints(scope, included);
      if (settlement.status === 'finalized' && settlement.usage) {
        return finalizeScope(scope, await authority.readUsage(constraints));
      }
      const usage = await authority.settleAndReadUsage(constraints);
      return finalizeScope(scope, usage);
    },
    async finalizeRootReceipts(scopeValue: ControllerRootReceiptAuthorityScope) {
      const scope = parseReceiptScope(scopeValue);
      if (scope.authorityKind !== 'controller-root') {
        projectionFail('invalid-scope', 'Root receipt finalization requires controller-root scope');
      }
      const settlement = await beginFinalization(scope);
      if (settlement.status === 'finalized' && settlement.usage) {
        return finalizeScope(scope, settlement.usage);
      }
      const current = await read(`intent/${scope.runId}`);
      if (!current) projectionFail('unknown-authority', 'Root receipt authority aggregate is absent');
      const actions = scopedActions(current.aggregate, scope);
      const completed = actions.filter(action => action.lifecycle === 'completed');
      if (actions.some(action => !['completed', 'denied'].includes(action.lifecycle)) ||
          completed.some(action => action.receipt === null)) {
        projectionFail('authority-not-terminal', 'Root receipt authority still has unresolved effects');
      }
      const usage = parseTrustedFinalUsage(expectedRootUsage(scope, actions), scope);
      return finalizeScope(scope, usage);
    }
  });
}
