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
}

const MAX_ACTIONS = 65_536;
const MAX_MEDIATION_AGGREGATE_BYTES = 896 * 1024;
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
  if (authority.usage.status !== 'pending' || authority.usage.final !== null ||
      authority.usage.sampleDigest !== null || Object.keys(authority.usage.actual).length !== 0 ||
      Object.keys(authority.usage.descendantCommitted).length !== 0 ||
      authority.usage.deadlineAt !== authority.authorityExpiresAt) {
    issue('Action authority usage must be an unreconciled pending projection');
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
interface StoredAction {
  format: 'harness-mdocs/action-intent';
  schemaVersion: 1;
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
  actualTargets: string[] | null;
  actualResources: string[] | null;
  receipt: Record<string, unknown> | null;
}
interface MediationAggregate {
  format: 'harness-mdocs/action-mediation';
  schemaVersion: 1;
  runId: string;
  projectId: string;
  actions: StoredAction[];
}

const storedActionSchema = z.object({
  format: z.literal('harness-mdocs/action-intent'),
  schemaVersion: z.literal(1),
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
  actualTargets: canonicalStrings.nullable(),
  actualResources: canonicalStrings.nullable(),
  receipt: z.unknown().nullable()
}).strict().superRefine((action, context) => {
  const valid = action.lifecycle === 'intent'
    ? action.startedAt === null && action.endedAt === null && action.receipt === null &&
      action.uncertaintyStatus === null && action.actualTargets === null && action.actualResources === null
    : action.lifecycle === 'executing'
      ? action.startedAt !== null && action.endedAt === null && action.receipt === null &&
        action.uncertaintyStatus === null && action.actualTargets === null && action.actualResources === null
      : action.lifecycle === 'denied'
        ? action.startedAt === null && action.endedAt !== null && action.receipt === null &&
          action.uncertaintyStatus !== null && action.actualTargets === null && action.actualResources === null
      : action.lifecycle === 'uncertain'
        ? action.startedAt !== null && action.endedAt !== null && action.receipt === null &&
          action.uncertaintyStatus !== null
        : action.startedAt !== null && action.endedAt !== null && action.receipt !== null &&
          action.actualTargets !== null && action.actualResources !== null;
  if (!valid) {
    context.addIssue({ code: 'custom', message: 'Action lifecycle fields are inconsistent' });
  }
});
const mediationAggregateSchema = z.object({
  format: z.literal('harness-mdocs/action-mediation'),
  schemaVersion: z.literal(1),
  runId: bounded,
  projectId: bounded,
  actions: z.array(storedActionSchema).max(MAX_ACTIONS)
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
});

function hash(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256')
    .update(domain, 'utf8').update('\0').update(canonicalizeJson(value), 'utf8').digest('hex')}`;
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
  if (authority.usage.status !== 'pending') {
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
      status: authority.usage.status,
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
    current.usage.status === 'pending' && same(immutable(persisted), immutable(current)) &&
    Date.parse(current.lease.expiresAt) >= Date.parse(persisted.lease.expiresAt);
}

function summary(action: StoredAction): ActionReceiptSummary {
  const start = action.startedAt ?? action.intentTimestamp;
  const end = action.endedAt ?? start;
  const receipt = action.receipt ?? undefined;
  return canonical({
    actionRef: `public-action:${hash('harness-mdocs/public-action-ref/v1', action.actionId).slice(7)}`,
    resultClass: action.lifecycle === 'completed'
      ? ((receipt?.payload as { resultClass?: unknown } | undefined)?.resultClass ?? 'uncertain')
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
  const start = action.startedAt ?? action.intentTimestamp;
  const end = action.endedAt ?? start;
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
    const parsed = mediationAggregateSchema.safeParse(snapshotEvidenceData(value));
    if (!parsed.success) {
      throw new Error('Protected mediation aggregate is malformed');
    }
    const raw = parsed.data as MediationAggregate;
    if (Buffer.byteLength(canonicalizeJson(raw), 'utf8') > MAX_MEDIATION_AGGREGATE_BYTES) {
      throw new Error('Protected mediation aggregate exceeds conservative capacity');
    }
    for (const action of raw.actions) {
      if (!action.receipt) continue;
      const envelope = contractEnvelopeSchema.safeParse(action.receipt);
      if (!envelope.success || envelope.data.kind !== 'action-receipt/v1' ||
          !evidenceActionReceiptPayloadSchema.safeParse(envelope.data.payload).success ||
          !verifyContractEnvelope(envelope.data).ok) {
        throw new Error('Protected mediation receipt is malformed');
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
        schemaVersion: 1 as const,
        runId: initialize!.runId,
        projectId: initialize!.projectId,
        actions: []
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
    rawResult: unknown,
    receiptAuthority: ResolvedActionAuthority = intent.authority
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

    // One pending reservation spans all actions under either ticket or root node.
    // WP-230 alone reconciles cumulative usage and projects committed report evidence.
    const usage: ActionUsageAuthority = receiptAuthority.usage;
    let before: ReturnType<typeof computeWorkspaceFingerprint>;
    let after: ReturnType<typeof computeWorkspaceFingerprint>;
    try {
      before = computeWorkspaceFingerprint(result.workspaceBefore);
      after = computeWorkspaceFingerprint(result.workspaceAfter);
    } catch {
      return markUncertain(key, intent.reservationId, 'workspace-fingerprint-invalid', true);
    }
    const endedAt = result.endedAt;
    const receivedAt = safeNow(now);
    if (Date.parse(receivedAt) < Date.parse(endedAt)) {
      return markUncertain(key, intent.reservationId, 'trusted-clock-precedes-effect', true);
    }
    const authority = receiptAuthority;
    const payload = {
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
      actionId: intent.actionId,
      idempotencyId: intent.idempotencyKey,
      operation: intent.action.operation,
      childTicketRef: intent.action.operation === 'agent.spawn' && result.resultClass === 'success'
        ? intent.spawnChildTicketRef : null,
      handleLineage: authority.handleLineage,
      normalizedOperationDigest: intent.actionDigest,
      intentTimestamp: intent.intentTimestamp,
      startedAt: result.startedAt,
      endedAt,
      resultClass: result.resultClass,
      inputMetadata: result.inputMetadata,
      resultMetadata: result.resultMetadata,
      mutations: result.mutations,
      workspaceScope: before.scope,
      workspaceBefore: { scope: before.scope, entries: before.entries },
      workspaceAfter: { scope: after.scope, entries: after.entries },
      beforeFingerprint: before.digest,
      afterFingerprint: after.digest,
      usageReservationId: usage.reservationId,
      usageStatus: usage.status,
      usageSampleDigest: usage.sampleDigest,
      usageAmounts: usage.amounts,
      usageCurrency: usage.currency,
      usageDescendantCommitted: usage.descendantCommitted,
      usageActual: usage.actual,
      ...(usage.final === null ? {} : { usageFinal: usage.final }),
      ...(result.uncertaintyStatus === undefined ? {} : { uncertaintyStatus: result.uncertaintyStatus }),
      artifactHashes: result.artifactHashes
    };
    const receiptId = `receipt:${hash('harness-mdocs/action-receipt-id/v1', {
      runId: authority.runId, actionId: intent.actionId, idempotencyKey: intent.idempotencyKey
    }).slice(7)}`;
    const payloadCheck = evidenceActionReceiptPayloadSchema.safeParse(payload);
    if (!payloadCheck.success) {
      return markUncertain(key, intent.reservationId, 'receipt-payload-invalid', true);
    }
    let receipt: ContractEnvelope;
    try {
      receipt = sealContract('action-receipt/v1', receiptId, payloadCheck.data);
    } catch {
      return markUncertain(key, intent.reservationId, 'receipt-sealing-failed', true);
    }
    const receiptContext = {
      runId: authority.runId,
      projectId: authority.projectId,
      approvedPlanDigest: authority.approvedPlanDigest,
      approvedGraphDigest: authority.approvedGraphDigest,
      graphId: authority.graphId,
      graphRevision: authority.graphRevision,
      graphEpoch: authority.graphEpoch,
      cancellationGeneration: authority.cancellationGeneration,
      runStatus: 'active' as const,
      receivedAt,
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
      actionId: intent.actionId,
      idempotencyId: intent.idempotencyKey,
      action: intent.action,
      resultClass: result.resultClass,
      uncertaintyStatus: result.uncertaintyStatus ?? null,
      intentTimestamp: intent.intentTimestamp,
      startedAt: result.startedAt,
      endedAt,
      metadata: { input: result.inputMetadata, result: result.resultMetadata },
      workspace: {
        before: { scope: [...result.workspaceBefore.scope], entries: result.workspaceBefore.entries.map(item => ({ ...item })) },
        after: { scope: [...result.workspaceAfter.scope], entries: result.workspaceAfter.entries.map(item => ({ ...item })) },
        mutations: [...result.mutations]
      },
      usage: {
        reservationId: usage.reservationId, status: usage.status,
        startedAt: usage.startedAt, deadlineAt: usage.deadlineAt,
        final: usage.final, sampleDigest: usage.sampleDigest,
        amounts: usage.amounts, currency: usage.currency,
        descendantCommitted: usage.descendantCommitted, actual: usage.actual
      },
      artifactHashes: [...result.artifactHashes]
    };
    const contextCheck = actionReceiptValidationContextSchema.safeParse(receiptContext);
    if (!contextCheck.success) {
      return markUncertain(key, intent.reservationId, 'receipt-context-invalid', true);
    }
    const validation = validateActionReceipt(receipt, contextCheck.data);
    if (!validation.ok) {
      return markUncertain(key, intent.reservationId, 'receipt-validation-rejected', true);
    }

    try {
      const aggregate = await update(key, null, state => ({
        ...state,
        actions: state.actions.map(item => item.reservationId === intent.reservationId
          ? item.lifecycle === 'completed' ? item
            : item.lifecycle === 'executing' || item.lifecycle === 'uncertain'
              ? { ...item, lifecycle: 'completed' as const, startedAt: result.startedAt, endedAt,
                uncertaintyStatus: result.uncertaintyStatus ?? null,
                actualTargets: [...result.actualTargets], actualResources: [...result.actualResources],
                receipt: receipt as unknown as Record<string, unknown> }
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
      const requestDigest = hash('harness-mdocs/action-intent-request/v1', {
        actionId, idempotencyKey, actionDigest, adapterKind, budgetCharge,
        approvalRefs, credentialClasses, declaredPaths, declaredResources,
        nodeId: authorization.nodeId ?? null,
        targetNodeId: authorization.targetNodeId ?? null,
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
            format: 'harness-mdocs/action-intent', schemaVersion: 1,
            reservationId: reservation, actionId, idempotencyKey, requestDigest, actionDigest, action,
            authority, adapterKind, budgetCharge, approvalRefs, credentialClasses,
            declaredPaths, declaredResources, nodeId: authorization.nodeId ?? null,
            targetNodeId: authorization.targetNodeId ?? null,
            spawnChildTicketRef: authority.spawnChildTicketRef,
            intentTimestamp: safeNow(now), lifecycle: 'intent', startedAt: null, endedAt: null,
            uncertaintyStatus: null, actualTargets: null, actualResources: null, receipt: null
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
        return complete(key, intent, reconciled, reconciledAuthority);
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
      return complete(key, intent, result, postEffectAuthority);
    }
  });

  return Object.freeze({
    mediator,
    async receiptEvidence(reservation: string): Promise<Readonly<ContractEnvelope> | null> {
      const key = keyFromReservation(reservation);
      if (!key) return null;
      const current = await read(key);
      const receipt = current?.aggregate.actions.find(item =>
        item.reservationId === reservation && item.lifecycle === 'completed')?.receipt;
      if (!receipt) return null;
      return canonical(contractEnvelopeSchema.parse(receipt)) as Readonly<ContractEnvelope>;
    }
  });
}
