import { z } from 'zod';

import { canonicalizeJson } from '../../contracts';
import { surfaceFidelitySchema } from '../../schema';
import { snapshotAuthorityData, TicketAuthorityError } from '../authority/state';
import {
  computeRunControllerCommandId,
  computeRunControllerAuditHead,
  computeRunControllerBindingDigest,
  computeRunControllerEventDigest,
  computeRunControllerModelDigest,
  computeRunControllerPayloadDigest,
  computeRunControllerQuiescenceDigest,
  RUN_CONTROLLER_COMMAND_KINDS,
  RUN_CONTROLLER_EVENT_TYPES,
  RUN_CONTROLLER_FORMAT,
  RUN_CONTROLLER_MAX_BYTES,
  RUN_CONTROLLER_PHASES,
  RUN_CONTROLLER_PUBLIC_STATES,
  RUN_CONTROLLER_REASON_CODES,
  RUN_CONTROLLER_REPORT_OUTCOMES,
  RUN_CONTROLLER_SCHEMA_VERSION,
  RunControllerCommandCompletionProof,
  RunControllerCommand,
  RunControllerCommandKind,
  RunControllerEvent,
  RunControllerState
} from './algebra';
import { RUN_CONTROLLER_POLICY, RUN_CONTROLLER_PROFILE_ID } from './model';

const HARD_COMPLETED_COMMAND_LIMIT = 256;
const HARD_PROCESSED_EVENT_LIMIT = 512;
const CANCELLATION_COMMAND_ATTEMPTS = 3;
const CANCELLATION_COMMAND_STAGES = 4;
const MAX_INTERRUPTED_COMMANDS = 8;
const CLOSURE_COMPLETION_RESERVE = 16;
const CLOSURE_EVENT_RESERVE = 1 + MAX_INTERRUPTED_COMMANDS +
  CANCELLATION_COMMAND_STAGES * (2 * CANCELLATION_COMMAND_ATTEMPTS - 1);
const NORMAL_OPERATION_AGGREGATE_BYTES = 192 * 1024;
const NORMAL_TRANSITION_BYTES = 64 * 1024;
const PROCESSED_EVENT_RECORD_BYTES = 4 * 1024;
const COMPLETED_COMMAND_RECORD_BYTES = 24 * 1024;
const RECOVERY_EVENT_BYTES = 8 * 1024;
const RECOVERY_COMPLETION_GROWTH_BYTES = 16 * 1024;
const OUTBOX_ENTRY_BYTES = 16 * 1024;

export const RUN_CONTROLLER_LIMITS = Object.freeze({
  aggregateBytes: RUN_CONTROLLER_MAX_BYTES,
  normalOperationAggregateBytes: NORMAL_OPERATION_AGGREGATE_BYTES,
  normalTransitionBytes: NORMAL_TRANSITION_BYTES,
  closureByteReserve: RUN_CONTROLLER_MAX_BYTES - NORMAL_OPERATION_AGGREGATE_BYTES,
  processedEventRecordBytes: PROCESSED_EVENT_RECORD_BYTES,
  completedCommandRecordBytes: COMPLETED_COMMAND_RECORD_BYTES,
  recoveryEventBytes: RECOVERY_EVENT_BYTES,
  recoveryCompletionGrowthBytes: RECOVERY_COMPLETION_GROWTH_BYTES,
  outboxEntryBytes: OUTBOX_ENTRY_BYTES,
  stringBytes: 16 * 1024,
  completedCommands: HARD_COMPLETED_COMMAND_LIMIT,
  processedEvents: HARD_PROCESSED_EVENT_LIMIT,
  normalOperationCompletedCommands: HARD_COMPLETED_COMMAND_LIMIT - CLOSURE_COMPLETION_RESERVE,
  normalOperationProcessedEvents: HARD_PROCESSED_EVENT_LIMIT - CLOSURE_EVENT_RESERVE,
  closureEventReserve: CLOSURE_EVENT_RESERVE,
  closureCompletionReserve: CLOSURE_COMPLETION_RESERVE,
  cancellationCommandAttempts: CANCELLATION_COMMAND_ATTEMPTS,
  digestIndexEntries: 256,
  protectedBindings: 32,
  interruptedCommands: MAX_INTERRUPTED_COMMANDS
} as const);

export function hasRunControllerNormalJournalCapacity(state: Readonly<RunControllerState>): boolean {
  return state.processedEvents.length < RUN_CONTROLLER_LIMITS.normalOperationProcessedEvents &&
    state.completedCommands.length < RUN_CONTROLLER_LIMITS.normalOperationCompletedCommands &&
    runControllerCanonicalBytes(state) <= RUN_CONTROLLER_LIMITS.normalOperationAggregateBytes -
      RUN_CONTROLLER_LIMITS.normalTransitionBytes;
}

export function runControllerCanonicalBytes(value: unknown): number {
  return Buffer.byteLength(canonicalizeJson(value), 'utf8');
}

export class RunControllerDataError extends Error {
  constructor(
    readonly code: 'invalid-event' | 'invalid-state' | 'resource-limit',
    message: string
  ) {
    super(message);
    this.name = 'RunControllerDataError';
  }
}

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const commandIdSchema = z.string().regex(/^rcmd:[0-9a-f]{64}$/);
const boundedStringSchema = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= RUN_CONTROLLER_LIMITS.stringBytes,
  `String exceeds ${RUN_CONTROLLER_LIMITS.stringBytes} UTF-8 bytes`
);
const boundedIdentifierSchema = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= 1024,
  'Identifier exceeds 1024 UTF-8 bytes'
);
const bindingNameSchema = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= 256,
  'Binding name exceeds 256 UTF-8 bytes'
);
const safeNonNegativeSchema = z.number().int().nonnegative().safe();
const safePositiveSchema = z.number().int().positive().safe();
const canonicalTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'Expected canonical RFC3339 UTC timestamp');
const canonicalDigestSetSchema = z.array(digestSchema)
  .max(RUN_CONTROLLER_LIMITS.digestIndexEntries)
  .refine(values => values.every((value, index) => index === 0 || values[index - 1] < value),
    'Expected sorted unique digest values');
const canonicalProofDigestSetSchema = z.array(digestSchema)
  .max(32)
  .refine(values => values.every((value, index) => index === 0 || values[index - 1] < value),
    'Expected sorted unique digest values');
const canonicalStringSetSchema = z.array(boundedStringSchema)
  .max(RUN_CONTROLLER_LIMITS.interruptedCommands)
  .refine(values => values.every((value, index) => index === 0 || values[index - 1] < value),
    'Expected sorted unique values');
const modelStringSetSchema = z.array(boundedStringSchema).max(1024)
  .refine(values => values.every((value, index) => index === 0 || values[index - 1] < value),
    'Expected sorted unique values');

const controllerPolicySchema = z.object({
  milestoneSelection: z.literal(RUN_CONTROLLER_POLICY.milestoneSelection),
  onUncertainty: z.literal(RUN_CONTROLLER_POLICY.onUncertainty),
  onUnexpectedEvent: z.literal(RUN_CONTROLLER_POLICY.onUnexpectedEvent),
  onNodeFailure: z.literal(RUN_CONTROLLER_POLICY.onNodeFailure),
  maxConcurrentMilestones: z.literal(RUN_CONTROLLER_POLICY.maxConcurrentMilestones),
  maxConcurrentExecutionOrchestrators:
    z.literal(RUN_CONTROLLER_POLICY.maxConcurrentExecutionOrchestrators),
  leafExecution: z.literal(RUN_CONTROLLER_POLICY.leafExecution)
}).strict();
const compiledNodeSchema = z.object({
  nodeId: boundedIdentifierSchema,
  nodeType: z.enum(['milestone', 'workstream', 'leaf', 'integration']),
  ownerRole: z.enum(['PLAN_ROOT', 'EXECUTION', 'LEAF']),
  writeSet: modelStringSetSchema,
  isolation: boundedStringSchema,
  localCriteria: modelStringSetSchema,
  expectedReportKind: boundedStringSchema
}).strict();
const compiledMilestoneSchema = z.object({
  milestoneId: boundedIdentifierSchema,
  dependencyIds: z.array(boundedIdentifierSchema).max(1)
    .refine(values => values.every((value, index) => index === 0 || values[index - 1] < value),
      'Expected sorted unique values'),
  criteria: modelStringSetSchema,
  verification: boundedStringSchema,
  executionOrchestratorNodeId: boundedIdentifierSchema,
  integrationNodeId: boundedIdentifierSchema
}).strict();
const compiledRunModelSchema = z.object({
  profileId: z.literal(RUN_CONTROLLER_PROFILE_ID),
  planKey: boundedIdentifierSchema,
  planRevision: safePositiveSchema,
  planDigest: digestSchema,
  graphDigest: digestSchema,
  controllerPolicy: controllerPolicySchema,
  milestones: z.array(compiledMilestoneSchema).length(1),
  globalIntegrationNodeId: boundedIdentifierSchema,
  nodes: z.array(compiledNodeSchema).min(4).max(4)
}).strict().superRefine((model, context) => {
  const milestone = model.milestones[0];
  if (milestone.dependencyIds.length !== 0) {
    context.addIssue({ code: 'custom', path: ['milestones', 0], message: 'Dependencies unsupported' });
  }
  const nodeIds = model.nodes.map(node => node.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length ||
      nodeIds.some((value, index) => index > 0 && nodeIds[index - 1] >= value)) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'Nodes must be sorted and unique' });
  }
  const byId = new Map(model.nodes.map(node => [node.nodeId, node]));
  const milestoneNode = byId.get(milestone.milestoneId);
  const executionNode = byId.get(milestone.executionOrchestratorNodeId);
  const integrationNode = byId.get(milestone.integrationNodeId);
  const globalNode = byId.get(model.globalIntegrationNodeId);
  if (new Set([
    milestone.milestoneId, milestone.executionOrchestratorNodeId,
    milestone.integrationNodeId, model.globalIntegrationNodeId
  ]).size !== 4) {
    context.addIssue({ code: 'custom', message: 'First profile node links must be four distinct IDs' });
  }
  if (milestoneNode?.nodeType !== 'milestone' || milestoneNode.ownerRole !== 'PLAN_ROOT' ||
      milestoneNode.expectedReportKind !== 'execution-report/v1') {
    context.addIssue({ code: 'custom', path: ['milestones', 0, 'milestoneId'], message: 'Milestone node mismatch' });
  }
  if (executionNode?.nodeType !== 'workstream' || executionNode.ownerRole !== 'EXECUTION' ||
      executionNode.expectedReportKind !== 'execution-report/v1') {
    context.addIssue({ code: 'custom', path: ['milestones', 0, 'executionOrchestratorNodeId'], message: 'EO node mismatch' });
  }
  if (integrationNode?.nodeType !== 'integration' || integrationNode.ownerRole !== 'PLAN_ROOT' ||
      integrationNode.expectedReportKind !== 'execution-report/v1') {
    context.addIssue({ code: 'custom', path: ['milestones', 0, 'integrationNodeId'], message: 'Integration node mismatch' });
  }
  if (globalNode?.nodeType !== 'integration' || globalNode.ownerRole !== 'PLAN_ROOT' ||
      globalNode.expectedReportKind !== 'goal-verdict/v1') {
    context.addIssue({ code: 'custom', path: ['globalIntegrationNodeId'], message: 'Global integration node mismatch' });
  }
  if (model.nodes.filter(node => node.nodeType === 'milestone' && node.ownerRole === 'PLAN_ROOT').length !== 1 ||
      model.nodes.filter(node => node.nodeType === 'workstream' && node.ownerRole === 'EXECUTION').length !== 1 ||
      model.nodes.filter(node => node.nodeType === 'integration' && node.ownerRole === 'PLAN_ROOT').length !== 2 ||
      model.nodes.some(node => node.ownerRole === 'LEAF')) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'First profile requires exact node roles/types' });
  }
  if (milestoneNode && milestone.criteria.join('\0') !== milestoneNode.localCriteria.join('\0')) {
    context.addIssue({ code: 'custom', path: ['milestones', 0, 'criteria'], message: 'Milestone criteria mismatch' });
  }
  if (milestoneNode && integrationNode && globalNode &&
      (milestoneNode.writeSet.join('\0') !== integrationNode.writeSet.join('\0') ||
       milestoneNode.writeSet.join('\0') !== globalNode.writeSet.join('\0'))) {
    context.addIssue({ code: 'custom', path: ['nodes'], message: 'Root integration write sets must match milestone' });
  }
});

const commandSchema = z.object({
  id: commandIdSchema,
  kind: z.enum(RUN_CONTROLLER_COMMAND_KINDS),
  runId: boundedIdentifierSchema,
  projectId: boundedIdentifierSchema,
  nodeId: boundedIdentifierSchema.nullable(),
  transitionSequence: safePositiveSchema,
  ordinal: safeNonNegativeSchema,
  attempt: safePositiveSchema,
  expectedControllerEpoch: safeNonNegativeSchema,
  expectedLeaseFence: safePositiveSchema.nullable(),
  payloadDigest: digestSchema
}).strict();
const protectedPayloadSchema = z.object({
  bindings: z.array(z.object({ name: bindingNameSchema, digest: digestSchema }).strict())
    .max(RUN_CONTROLLER_LIMITS.protectedBindings)
    .refine(values => values.every((value, index) => index === 0 || values[index - 1].name < value.name),
      'Expected sorted unique binding names'),
  graphEpoch: safeNonNegativeSchema,
  cancellationGeneration: safeNonNegativeSchema
}).strict();
const outboxEntrySchema = z.object({
  command: commandSchema,
  protectedPayload: protectedPayloadSchema,
  insertedAt: canonicalTimestampSchema
}).strict().refine(value => runControllerCanonicalBytes(value) <= OUTBOX_ENTRY_BYTES,
  `Outbox entry exceeds ${OUTBOX_ENTRY_BYTES} canonical UTF-8 bytes`);
const outboxSchema = z.array(outboxEntrySchema).max(1);
const completionOutcomeSchema = z.union([
  z.enum(['succeeded', 'failed', 'uncertain', 'not-applied']),
  z.enum(RUN_CONTROLLER_REPORT_OUTCOMES)
]);
const processedEventSchema = z.object({
  eventId: boundedIdentifierSchema,
  eventDigest: digestSchema,
  transitionSequence: safePositiveSchema,
  priorAuditHash: digestSchema,
  nextAuditHash: digestSchema,
  result: z.object({
    code: z.literal('applied'),
    commandIds: z.array(commandIdSchema).max(1)
  }).strict()
}).strict().refine(value => runControllerCanonicalBytes(value) <= PROCESSED_EVENT_RECORD_BYTES,
  `Processed event exceeds ${PROCESSED_EVENT_RECORD_BYTES} canonical UTF-8 bytes`);
const runtimeSchema = z.object({
  nodeId: boundedStringSchema,
  state: z.enum(['pending', 'running', 'accepted', 'failed', 'cancelled']),
  attempt: safeNonNegativeSchema,
  reportDigest: digestSchema.nullable(),
  evidenceDigest: digestSchema.nullable()
}).strict();
const executionRuntimeSchema = runtimeSchema.extend({
  ticketRefDigest: digestSchema.nullable(),
  spawnRefDigest: digestSchema.nullable(),
  workstreamLeaseRefDigest: digestSchema.nullable(),
  workstreamLeaseFence: safePositiveSchema.nullable()
}).strict();
const budgetSummarySchema = z.object({
  trusted: z.literal(true),
  reserved: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  committed: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().min(1).max(16).nullable()
}).strict().refine(summary => summary.committed <= summary.reserved,
  'Committed budget cannot exceed reserved budget');
const commandCompletionProofSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fidelity.preflight'),
    fidelity: surfaceFidelitySchema,
    requestedMode: z.enum(['milestone', 'autonomous']),
    assessmentDigest: digestSchema
  }).strict(),
  z.object({
    kind: z.literal('authority.initialize'),
    authorityStateDigest: digestSchema,
    authorityInitialized: z.literal(true)
  }).strict(),
  z.object({
    kind: z.literal('authority.acquire-controller'),
    controllerLeaseRefDigest: digestSchema,
    controllerEpoch: safePositiveSchema,
    leaseFence: safePositiveSchema
  }).strict(),
  z.object({ kind: z.literal('authority.issue-eo-ticket'), ticketRefDigest: digestSchema }).strict(),
  z.object({ kind: z.literal('mediator.spawn-eo'), spawnRefDigest: digestSchema }).strict(),
  z.object({
    kind: z.literal('authority.claim-workstream'),
    workstreamLeaseRefDigest: digestSchema,
    leaseFence: safePositiveSchema
  }).strict(),
  z.object({
    kind: z.literal('authority.settle-usage'),
    settledUsageDigest: digestSchema,
    projectionDigests: canonicalProofDigestSetSchema.min(1),
    budgetSummary: budgetSummarySchema
  }).strict(),
  z.object({
    kind: z.literal('mediator.finalize-receipts'),
    finalizedProjectionDigests: canonicalProofDigestSetSchema.min(1)
  }).strict(),
  z.object({
    kind: z.literal('evidence.validate-preliminary-report'),
    authority: z.literal(false),
    classification: z.enum(RUN_CONTROLLER_REPORT_OUTCOMES),
    reportDigest: digestSchema,
    evidenceDigest: digestSchema,
    requestedDisposition: z.enum(['continue', 'pause', 'escalate', 'complete']).nullable()
  }).strict(),
  z.object({
    kind: z.literal('evidence.validate-final-report'),
    authority: z.literal(false),
    classification: z.enum(RUN_CONTROLLER_REPORT_OUTCOMES),
    reportDigest: digestSchema,
    evidenceDigest: digestSchema,
    requestedDisposition: z.enum(['continue', 'pause', 'escalate', 'complete']).nullable()
  }).strict(),
  z.object({
    kind: z.literal('integration.root-milestone'),
    integrationAccepted: z.literal(true),
    evidenceDigest: digestSchema
  }).strict(),
  z.object({
    kind: z.literal('integration.root-global-seal-verdict'),
    accepted: z.literal(true),
    reportKind: z.literal('goal-verdict/v1'),
    verdictDigest: digestSchema,
    finalState: z.literal('completed'),
    unresolvedCount: z.literal(0),
    pendingCount: z.literal(0)
  }).strict(),
  z.object({ kind: z.literal('checkpoint.persist'), checkpointDigest: digestSchema }).strict(),
  z.object({
    kind: z.literal('authority.cancel'),
    authorityCancelled: z.literal(true),
    cancellationGeneration: safePositiveSchema
  }).strict(),
  z.object({ kind: z.literal('descendant.signal'), pendingDescendants: safeNonNegativeSchema }).strict(),
  z.object({ kind: z.literal('descendant.force'), pendingDescendants: safeNonNegativeSchema }).strict()
]);
const eventBase = {
  eventId: boundedIdentifierSchema,
  occurredAt: canonicalTimestampSchema
} as const;
const completionBinding = {
  commandId: commandIdSchema,
  controllerEpoch: safeNonNegativeSchema,
  leaseFence: safePositiveSchema.nullable(),
  attempt: safePositiveSchema
} as const;
const reportOutcomeFields = {
  ...eventBase,
  ...completionBinding,
  authority: z.literal(false),
  classification: z.enum(RUN_CONTROLLER_REPORT_OUTCOMES),
  reportDigest: digestSchema,
  evidenceDigest: digestSchema,
  requestedDisposition: z.enum(['continue', 'pause', 'escalate', 'complete']).nullable()
} as const;
const preflightResultEventSchema = z.object({
  ...eventBase,
  ...completionBinding,
  type: z.literal('preflight-result'),
  fidelity: surfaceFidelitySchema,
  requestedMode: z.enum(['milestone', 'autonomous']),
  assessmentDigest: digestSchema
}).strict();
const commandCompletionEventSchema = z.object({
  ...eventBase,
  ...completionBinding,
  type: z.literal('command-completion'),
  outcome: z.enum(['succeeded', 'failed', 'uncertain']),
  resultDigest: digestSchema,
  proof: commandCompletionProofSchema.nullable()
}).strict().superRefine((event, context) => {
  if (event.outcome === 'succeeded' && event.proof === null) {
    context.addIssue({ code: 'custom', path: ['proof'], message: 'Successful completion requires proof' });
  }
  if (event.outcome !== 'succeeded' && event.proof !== null) {
    context.addIssue({ code: 'custom', path: ['proof'], message: 'Non-success completion cannot carry proof' });
  }
});
const preliminaryReportEventSchema = z.object({
  ...reportOutcomeFields, type: z.literal('preliminary-report-outcome')
}).strict();
const finalReportEventSchema = z.object({
  ...reportOutcomeFields, type: z.literal('final-report-outcome')
}).strict();
const cancelEventSchema = z.object({
  ...eventBase, type: z.literal('cancel'), reasonDigest: digestSchema
}).strict();
const recoveryEventSchema = z.object({
  ...eventBase,
  type: z.literal('recovery'),
  targetCommandId: commandIdSchema,
  reconciliationDigest: digestSchema,
  disposition: z.enum(['applied', 'not-applied', 'still-uncertain']),
  quiescenceDigest: digestSchema.nullable(),
  resultDigest: digestSchema.nullable(),
  proof: commandCompletionProofSchema.nullable()
}).strict().superRefine((event, context) => {
  if (event.disposition === 'applied' && (event.resultDigest === null || event.proof === null)) {
    context.addIssue({ code: 'custom', message: 'Applied recovery requires result digest and proof' });
  }
  if (event.disposition !== 'applied' && (event.resultDigest !== null || event.proof !== null)) {
    context.addIssue({ code: 'custom', message: 'Non-applied recovery cannot carry result proof' });
  }
  if ((event.disposition === 'not-applied') !== (event.quiescenceDigest !== null)) {
    context.addIssue({ code: 'custom', message: 'Only quiesced not-applied recovery requires quiescence digest' });
  }
  if (runControllerCanonicalBytes(event) > RECOVERY_EVENT_BYTES) {
    context.addIssue({ code: 'custom', message: `Recovery event exceeds ${RECOVERY_EVENT_BYTES} canonical UTF-8 bytes` });
  }
});
const completionRecordEventSchema = z.union([
  preflightResultEventSchema,
  commandCompletionEventSchema,
  preliminaryReportEventSchema,
  finalReportEventSchema,
  cancelEventSchema
]);
const completedCommandSchema = z.object({
  command: commandSchema,
  protectedPayload: protectedPayloadSchema,
  completionEventId: boundedIdentifierSchema,
  completionDigest: digestSchema,
  completionEvent: completionRecordEventSchema,
  reconciliationDigest: digestSchema.nullable(),
  reconciliationEvent: recoveryEventSchema.nullable(),
  outcome: completionOutcomeSchema,
  resultDigest: digestSchema,
  proof: commandCompletionProofSchema.nullable(),
  resultLeaseFence: safePositiveSchema.nullable(),
  resultCount: safeNonNegativeSchema.nullable(),
  completedAt: canonicalTimestampSchema
}).strict().refine(value => runControllerCanonicalBytes(value) <= COMPLETED_COMMAND_RECORD_BYTES,
  `Completed command exceeds ${COMPLETED_COMMAND_RECORD_BYTES} canonical UTF-8 bytes`);

export const runControllerStateSchema = z.object({
  format: z.literal(RUN_CONTROLLER_FORMAT),
  schemaVersion: z.literal(RUN_CONTROLLER_SCHEMA_VERSION),
  runId: boundedIdentifierSchema,
  projectId: boundedIdentifierSchema,
  model: compiledRunModelSchema,
  modelDigest: digestSchema,
  mode: z.enum(['unselected', 'milestone', 'autonomous']),
  requestedMode: z.enum(['milestone', 'autonomous']).nullable(),
  fidelity: z.object({
    result: z.union([z.literal('pending'), surfaceFidelitySchema]),
    requirementsDigest: digestSchema,
    assessmentDigest: digestSchema.nullable()
  }).strict(),
  approvalDigests: z.object({ approval: digestSchema.nullable(), modeSelection: digestSchema.nullable() }).strict(),
  publicState: z.enum(RUN_CONTROLLER_PUBLIC_STATES),
  phase: z.enum(RUN_CONTROLLER_PHASES),
  reasonCode: z.enum(RUN_CONTROLLER_REASON_CODES).nullable(),
  terminalIntent: z.enum(['completed', 'failed', 'cancelled']).nullable(),
  authorityInitialized: z.boolean(),
  authorityAcquired: z.boolean(),
  workstreamActive: z.boolean(),
  controllerEpoch: safeNonNegativeSchema,
  controllerLeaseRefDigest: digestSchema.nullable(),
  controllerLeaseFence: safePositiveSchema.nullable(),
  graphEpoch: safeNonNegativeSchema,
  cancellationGeneration: safeNonNegativeSchema,
  execution: executionRuntimeSchema,
  milestone: runtimeSchema,
  globalIntegration: runtimeSchema,
  outbox: outboxSchema,
  completedCommands: z.array(completedCommandSchema).max(RUN_CONTROLLER_LIMITS.completedCommands),
  processedEvents: z.array(processedEventSchema).max(RUN_CONTROLLER_LIMITS.processedEvents),
  reportDigestIndex: canonicalDigestSetSchema,
  evidenceDigestIndex: canonicalDigestSetSchema,
  pendingUsageRefs: canonicalDigestSetSchema,
  pendingProjectionRefs: canonicalDigestSetSchema,
  settledUsageDigest: digestSchema.nullable(),
  committedProjectionDigests: canonicalDigestSetSchema,
  continuationCheckpointDigest: digestSchema.nullable(),
  drainSummary: z.object({
    authorityCancelled: z.boolean(),
    descendantsSignalled: z.boolean(),
    descendantsForced: z.boolean(),
    signalPendingDescendants: safeNonNegativeSchema.nullable(),
    forceRequired: z.boolean(),
    pendingDescendants: safeNonNegativeSchema,
    interruptedCommandIds: canonicalStringSetSchema
  }).strict(),
  recoverySummary: z.object({
    required: z.boolean(),
    reasonCode: z.enum(RUN_CONTROLLER_REASON_CODES).nullable(),
    uncertainCommandIds: canonicalStringSetSchema,
    resumePhase: z.enum(RUN_CONTROLLER_PHASES).nullable()
  }).strict(),
  counters: z.object({
    transitionSequence: safePositiveSchema,
    eventsApplied: safePositiveSchema,
    commandsIssued: safePositiveSchema
  }).strict(),
  budgetSummary: budgetSummarySchema.nullable(),
  auditHashHead: digestSchema,
  createdAt: canonicalTimestampSchema,
  updatedAt: canonicalTimestampSchema
}).strict().superRefine((state, context) => {
  if (state.modelDigest !== computeRunControllerModelDigest(state.model as import('./model').CompiledRunModel)) {
    context.addIssue({ code: 'custom', path: ['modelDigest'], message: 'Model digest mismatch' });
  }
  const milestone = state.model.milestones[0];
  if (state.milestone.nodeId !== milestone.milestoneId ||
      state.execution.nodeId !== milestone.executionOrchestratorNodeId ||
      state.globalIntegration.nodeId !== state.model.globalIntegrationNodeId) {
    context.addIssue({ code: 'custom', message: 'Runtime/model node binding mismatch' });
  }
  const eventIds = state.processedEvents.map(event => event.eventId);
  const commandIds = [
    ...state.outbox.map(entry => entry.command.id),
    ...state.completedCommands.map(entry => entry.command.id)
  ];
  if (new Set(eventIds).size !== eventIds.length || new Set(commandIds).size !== commandIds.length) {
    context.addIssue({ code: 'custom', message: 'Event and command IDs must be unique' });
  }
  const expectedCommandNode = (kind: string): string | null =>
    ['authority.issue-eo-ticket', 'mediator.spawn-eo', 'authority.claim-workstream',
      'evidence.validate-preliminary-report', 'authority.settle-usage',
      'mediator.finalize-receipts', 'evidence.validate-final-report'].includes(kind)
      ? state.execution.nodeId
      : kind === 'integration.root-milestone'
        ? state.model.milestones[0].integrationNodeId
        : kind === 'integration.root-global-seal-verdict'
          ? state.globalIntegration.nodeId
          : null;
  const expectedFenceAt = (kind: string, issuanceSequence: number): number | null => {
    if (['fidelity.preflight', 'authority.initialize', 'authority.acquire-controller'].includes(kind)) {
      return null;
    }
    let controllerFence: number | null = null;
    let workstreamFence: number | null = null;
    const completions = state.completedCommands.map(completed => ({
      completed,
      sequence: state.processedEvents.find(
        event => event.eventId === (completed.reconciliationEvent?.eventId ?? completed.completionEventId)
      )?.transitionSequence ?? Number.MAX_SAFE_INTEGER
    })).filter(item => item.sequence <= issuanceSequence)
      .sort((left, right) => left.sequence - right.sequence);
    for (const item of completions) {
      const completed = item.completed;
      if (completed.outcome !== 'succeeded' || completed.proof === null) continue;
      if (state.terminalIntent !== null &&
          state.drainSummary.interruptedCommandIds.includes(completed.command.id) &&
          completed.reconciliationEvent !== null) continue;
      if (completed.proof.kind === 'authority.acquire-controller') {
        controllerFence = completed.proof.leaseFence;
      } else if (completed.proof.kind === 'authority.claim-workstream') {
        workstreamFence = completed.proof.leaseFence;
      } else if (completed.proof.kind === 'authority.cancel') {
        controllerFence = null;
        workstreamFence = null;
      }
    }
    return ['evidence.validate-preliminary-report', 'authority.settle-usage',
      'mediator.finalize-receipts', 'evidence.validate-final-report'].includes(kind)
      ? workstreamFence : controllerFence;
  };
  const effectiveCompletionSequence = (completed: typeof state.completedCommands[number]): number =>
    state.processedEvents.find(event => event.eventId ===
      (completed.reconciliationEvent?.eventId ?? completed.completionEventId))?.transitionSequence ??
      Number.MAX_SAFE_INTEGER;
  const completedBefore = (kind: string, issuanceSequence: number) => state.completedCommands
    .filter(completed => completed.command.kind === kind &&
      effectiveCompletionSequence(completed) <= issuanceSequence)
    .sort((left, right) => effectiveCompletionSequence(right) - effectiveCompletionSequence(left));
  const successfulBefore = (kind: string, issuanceSequence: number) => completedBefore(kind, issuanceSequence)
    .find(completed => completed.outcome === 'succeeded' && completed.proof?.kind === kind);
  const reportFacts = (completed: typeof state.completedCommands[number]) => {
    const completion = completed.completionEvent;
    if (completion.type === 'preliminary-report-outcome' || completion.type === 'final-report-outcome') {
      return completion;
    }
    const proof = completed.reconciliationEvent?.disposition === 'applied' ? completed.proof : null;
    return proof?.kind === 'evidence.validate-preliminary-report' ||
      proof?.kind === 'evidence.validate-final-report' ? proof : null;
  };
  const validationReportBindingMismatch = (
    entry: { command: { kind: string }; protectedPayload: { bindings: readonly { name: string; digest: string }[] } },
    expectedDigest: string | null | undefined
  ): boolean => {
    if (entry.command.kind !== 'evidence.validate-preliminary-report' &&
        entry.command.kind !== 'evidence.validate-final-report') return false;
    if (expectedDigest === null || expectedDigest === undefined) return false;
    const bindingName = entry.command.kind === 'evidence.validate-preliminary-report'
      ? 'report' : 'report-input';
    return entry.protectedPayload.bindings.find(binding => binding.name === bindingName)?.digest !== expectedDigest;
  };
  const exactStageBindings = (
    kind: string,
    issuanceSequence: number
  ): ReadonlyArray<Readonly<{ name: string; digest: string }>> | null => {
    if (!['mediator.finalize-receipts', 'evidence.validate-final-report',
      'integration.root-milestone', 'integration.root-global-seal-verdict'].includes(kind)) return null;
    const settlement = successfulBefore('authority.settle-usage', issuanceSequence);
    const settlementProof = settlement?.proof?.kind === 'authority.settle-usage'
      ? settlement.proof : null;
    if (settlementProof === null) return [];
    const settledUsageDigest = settlementProof.settledUsageDigest;
    const budgetDigest = computeRunControllerBindingDigest('budget-summary', settlementProof.budgetSummary);
    if (kind === 'mediator.finalize-receipts') {
      const firstPreliminary = [...completedBefore('evidence.validate-preliminary-report', issuanceSequence)]
        .sort((left, right) => left.command.transitionSequence - right.command.transitionSequence)[0];
      const reportInput = firstPreliminary?.protectedPayload.bindings.find(binding => binding.name === 'report')?.digest;
      if (reportInput === undefined) return [];
      const pendingInputs = [...new Set([
        reportInput, ...settlementProof.projectionDigests, settledUsageDigest
      ])].sort();
      return [
        { name: 'graph', digest: state.model.graphDigest },
        { name: 'pending-projection-inputs',
          digest: computeRunControllerBindingDigest('pending-projection-inputs', pendingInputs) },
        { name: 'plan', digest: state.model.planDigest },
        { name: 'settled-usage', digest: settledUsageDigest }
      ];
    }
    const finalization = successfulBefore('mediator.finalize-receipts', issuanceSequence);
    const finalizationProof = finalization?.proof?.kind === 'mediator.finalize-receipts'
      ? finalization.proof : null;
    if (finalizationProof === null) return [];
    const committedDigest = computeRunControllerBindingDigest(
      'committed-projections', finalizationProof.finalizedProjectionDigests
    );
    const reports = state.completedCommands.map(completed => ({
      completed,
      report: reportFacts(completed)
    })).filter(item => item.report !== null &&
      effectiveCompletionSequence(item.completed) <= issuanceSequence)
      .sort((left, right) =>
        effectiveCompletionSequence(right.completed) - effectiveCompletionSequence(left.completed));
    if (kind === 'evidence.validate-final-report') {
      const report = reports[0]?.report;
      if (report === null || report === undefined) return [];
      return [
        { name: 'committed-projections', digest: committedDigest },
        { name: 'graph', digest: state.model.graphDigest },
        { name: 'plan', digest: state.model.planDigest },
        { name: 'report-input', digest: report.reportDigest },
        { name: 'settled-usage', digest: settledUsageDigest }
      ];
    }
    if (kind === 'integration.root-milestone') {
      const report = reports.find(item =>
        item.completed.command.kind === 'evidence.validate-final-report' &&
        item.completed.outcome === 'accepted')?.report;
      if (report === null || report === undefined) return [];
      return [
        { name: 'budget-summary', digest: budgetDigest },
        { name: 'committed-projections', digest: committedDigest },
        { name: 'eo-final-evidence', digest: report.evidenceDigest },
        { name: 'eo-final-report', digest: report.reportDigest },
        { name: 'graph', digest: state.model.graphDigest },
        { name: 'plan', digest: state.model.planDigest },
        { name: 'settled-usage', digest: settledUsageDigest }
      ];
    }
    const milestone = successfulBefore('integration.root-milestone', issuanceSequence);
    const milestoneProof = milestone?.proof?.kind === 'integration.root-milestone'
      ? milestone.proof : null;
    if (milestone === undefined || milestoneProof === null) return [];
    return [
      { name: 'budget-summary', digest: budgetDigest },
      { name: 'committed-projections', digest: committedDigest },
      { name: 'graph', digest: state.model.graphDigest },
      { name: 'milestone-evidence', digest: milestoneProof.evidenceDigest },
      { name: 'milestone-report', digest: milestone.resultDigest },
      { name: 'plan', digest: state.model.planDigest },
      { name: 'settled-usage', digest: settledUsageDigest }
    ];
  };
  const priorAttempts = new Map<string, number>();
  for (const entry of state.outbox) {
    const planBinding = entry.protectedPayload.bindings.find(binding => binding.name === 'plan');
    const graphBinding = entry.protectedPayload.bindings.find(binding => binding.name === 'graph');
    const nodeId = expectedCommandNode(entry.command.kind);
    const attemptKey = `${entry.command.kind}\0${entry.command.nodeId ?? ''}`;
    const expectedAttempt = state.completedCommands
      .filter(completed => `${completed.command.kind}\0${completed.command.nodeId ?? ''}` === attemptKey)
      .reduce((highest, completed) => Math.max(highest, completed.command.attempt), 0) + 1;
    const expectedStageBindings = exactStageBindings(
      entry.command.kind, entry.command.transitionSequence
    );
    const expectedValidationReport = entry.command.kind === 'evidence.validate-preliminary-report'
      ? state.execution.reportDigest ??
        (state.pendingProjectionRefs.length === 1 ? state.pendingProjectionRefs[0] : null)
      : entry.command.kind === 'evidence.validate-final-report' ? state.execution.reportDigest : null;
    if (entry.command.runId !== state.runId || entry.command.projectId !== state.projectId ||
        entry.command.expectedControllerEpoch !== state.controllerEpoch ||
        entry.command.expectedLeaseFence !== expectedFenceAt(
          entry.command.kind, entry.command.transitionSequence
        ) ||
        entry.command.nodeId !== nodeId ||
        entry.command.attempt !== expectedAttempt ||
        validationReportBindingMismatch(entry, expectedValidationReport) ||
        entry.protectedPayload.graphEpoch !== state.graphEpoch ||
        entry.protectedPayload.cancellationGeneration !== state.cancellationGeneration ||
        (expectedStageBindings !== null &&
         canonicalizeJson(entry.protectedPayload.bindings) !== canonicalizeJson(expectedStageBindings)) ||
        planBinding?.digest !== state.model.planDigest || graphBinding?.digest !== state.model.graphDigest ||
        entry.command.payloadDigest !== computeRunControllerPayloadDigest(
          entry.protectedPayload as import('./algebra').ProtectedRunControllerCommandPayload
        ) ||
        entry.command.id !== computeRunControllerCommandId({
          runId: entry.command.runId,
          projectId: entry.command.projectId,
          controllerEpoch: entry.command.expectedControllerEpoch,
          expectedLeaseFence: entry.command.expectedLeaseFence,
          graphEpoch: entry.protectedPayload.graphEpoch,
          transitionSequence: entry.command.transitionSequence,
          ordinal: entry.command.ordinal,
          kind: entry.command.kind,
          nodeId: entry.command.nodeId,
          attempt: entry.command.attempt,
          payloadDigest: entry.command.payloadDigest
        })) {
      context.addIssue({ code: 'custom', path: ['outbox'], message: 'Outbox command integrity mismatch' });
    }
  }
  for (const [index, completed] of state.completedCommands.entries()) {
    const attemptKey = `${completed.command.kind}\0${completed.command.nodeId ?? ''}`;
    const expectedAttempt = (priorAttempts.get(attemptKey) ?? 0) + 1;
    priorAttempts.set(attemptKey, completed.command.attempt);
    const planBinding = completed.protectedPayload.bindings.find(binding => binding.name === 'plan');
    const graphBinding = completed.protectedPayload.bindings.find(binding => binding.name === 'graph');
    const expectedStageBindings = exactStageBindings(
      completed.command.kind, completed.command.transitionSequence
    );
    const completionReport = reportFacts(completed)?.reportDigest ?? null;
    if (completed.command.runId !== state.runId || completed.command.projectId !== state.projectId ||
        completed.command.nodeId !== expectedCommandNode(completed.command.kind) ||
        completed.command.attempt !== expectedAttempt ||
        validationReportBindingMismatch(completed, completionReport) ||
        completed.command.expectedControllerEpoch > state.controllerEpoch ||
        completed.command.expectedLeaseFence !== expectedFenceAt(
          completed.command.kind, completed.command.transitionSequence
        ) ||
        completed.protectedPayload.graphEpoch > state.graphEpoch ||
        completed.protectedPayload.cancellationGeneration > state.cancellationGeneration ||
        (expectedStageBindings !== null &&
         canonicalizeJson(completed.protectedPayload.bindings) !== canonicalizeJson(expectedStageBindings)) ||
        planBinding?.digest !== state.model.planDigest || graphBinding?.digest !== state.model.graphDigest ||
        completed.command.payloadDigest !== computeRunControllerPayloadDigest(
          completed.protectedPayload as import('./algebra').ProtectedRunControllerCommandPayload
        ) ||
        completed.command.id !== computeRunControllerCommandId({
          runId: completed.command.runId,
          projectId: completed.command.projectId,
          controllerEpoch: completed.command.expectedControllerEpoch,
          expectedLeaseFence: completed.command.expectedLeaseFence,
          graphEpoch: completed.protectedPayload.graphEpoch,
          transitionSequence: completed.command.transitionSequence,
          ordinal: completed.command.ordinal,
          kind: completed.command.kind,
          nodeId: completed.command.nodeId,
          attempt: completed.command.attempt,
          payloadDigest: completed.command.payloadDigest as import('./algebra').Digest
        })) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completed command integrity mismatch' });
    }
    if (index > 0 && state.completedCommands[index - 1].command.transitionSequence >=
        completed.command.transitionSequence) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completed commands not canonical' });
    }
  }
  let auditHead = `sha256:${'0'.repeat(64)}`;
  for (const [index, processed] of state.processedEvents.entries()) {
    const transitionSequence = index + 1;
    const expectedNext = computeRunControllerAuditHead(
      auditHead as import('./algebra').Digest,
      processed.eventDigest as import('./algebra').Digest,
      transitionSequence
    );
    if (processed.transitionSequence !== transitionSequence || processed.priorAuditHash !== auditHead ||
        processed.nextAuditHash !== expectedNext ||
        processed.result.commandIds.some((id, commandIndex, ids) => commandIndex > 0 && ids[commandIndex - 1] >= id)) {
      context.addIssue({ code: 'custom', path: ['processedEvents', index], message: 'Processed event audit chain mismatch' });
    }
    for (const commandId of processed.result.commandIds) {
      const command = state.outbox.find(entry => entry.command.id === commandId)?.command ??
        state.completedCommands.find(entry => entry.command.id === commandId)?.command;
      if (!command || command.transitionSequence !== transitionSequence) {
        context.addIssue({ code: 'custom', path: ['processedEvents', index], message: 'Processed command link mismatch' });
      }
    }
    auditHead = expectedNext;
  }
  if (state.auditHashHead !== auditHead) {
    context.addIssue({ code: 'custom', path: ['auditHashHead'], message: 'Audit hash head mismatch' });
  }
  for (const entry of [...state.outbox, ...state.completedCommands]) {
    const issuance = state.processedEvents[entry.command.transitionSequence - 1];
    if (!issuance?.result.commandIds.includes(entry.command.id)) {
      context.addIssue({ code: 'custom', message: 'Command has no processed issuance event' });
    }
  }
  for (const completed of state.completedCommands) {
    const event = completed.completionEvent;
    const processedCompletion = state.processedEvents.find(item => item.eventId === completed.completionEventId);
    const reconstructedDigest = computeRunControllerEventDigest(event as RunControllerEvent);
    if (event.eventId !== completed.completionEventId || completed.completedAt !== event.occurredAt ||
        completed.completionDigest !== reconstructedDigest ||
        !processedCompletion || processedCompletion.eventDigest !== reconstructedDigest) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completion event link missing' });
    }
    const commandBindingMatches = 'commandId' in event &&
      event.commandId === completed.command.id &&
      event.controllerEpoch === completed.command.expectedControllerEpoch &&
      event.leaseFence === completed.command.expectedLeaseFence &&
      event.attempt === completed.command.attempt;
    if ('commandId' in event && event.commandId !== completed.command.id) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completion event binding mismatch' });
    }
    let expectedOutcome: typeof completed.outcome = completed.outcome;
    let expectedResultDigest: string = completed.resultDigest;
    let expectedProof: typeof completed.proof = null;
    if (event.type === 'command-completion') {
      expectedOutcome = commandBindingMatches ? event.outcome : 'uncertain';
      expectedResultDigest = event.resultDigest;
      expectedProof = commandBindingMatches ? event.proof : null;
      if (event.outcome === 'succeeded' && ['fidelity.preflight',
        'evidence.validate-preliminary-report', 'evidence.validate-final-report']
        .includes(completed.command.kind)) {
        context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Typed command used generic success completion' });
      }
    } else if (event.type === 'preflight-result') {
      expectedOutcome = 'succeeded';
      expectedResultDigest = event.assessmentDigest;
      if (completed.command.kind !== 'fidelity.preflight') {
        context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Preflight completion kind mismatch' });
      }
      if (!commandBindingMatches) {
        context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completion event binding mismatch' });
      }
    } else if (event.type === 'preliminary-report-outcome' || event.type === 'final-report-outcome') {
      expectedOutcome = event.classification;
      expectedResultDigest = event.evidenceDigest;
      const expectedKind = event.type === 'preliminary-report-outcome'
        ? 'evidence.validate-preliminary-report' : 'evidence.validate-final-report';
      if (completed.command.kind !== expectedKind) {
        context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Report completion kind mismatch' });
      }
      if (!commandBindingMatches) {
        context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completion event binding mismatch' });
      }
    } else if (event.type === 'cancel') {
      expectedOutcome = 'uncertain';
      expectedResultDigest = event.reasonDigest;
      if (!state.drainSummary.interruptedCommandIds.includes(completed.command.id)) {
        context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Cancel interruption link missing' });
      }
    }
    const originalOutcome = expectedOutcome;
    const reconciliation = completed.reconciliationEvent;
    if ((reconciliation === null) !== (completed.reconciliationDigest === null)) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Recovery event/digest pairing mismatch' });
    }
    if (reconciliation !== null) {
      const reconciliationDigest = computeRunControllerEventDigest(reconciliation as RunControllerEvent);
      const processedReconciliation = state.processedEvents.find(
        item => item.eventId === reconciliation.eventId
      );
      if (completed.reconciliationDigest !== reconciliationDigest ||
          !processedReconciliation || processedReconciliation.eventDigest !== reconciliationDigest ||
          reconciliation.disposition === 'still-uncertain' ||
          reconciliation.targetCommandId !== completed.command.id ||
          (reconciliation.disposition === 'applied' && originalOutcome !== 'uncertain') ||
          (originalOutcome !== 'uncertain' &&
           !(originalOutcome === 'failed' && ['authority.cancel', 'descendant.signal',
             'descendant.force', 'checkpoint.persist', 'controller.recover-pending-command']
             .includes(completed.command.kind)))) {
        context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Recovery completion link mismatch' });
      }
      if ((reconciliation.disposition === 'not-applied' &&
           reconciliation.quiescenceDigest !== computeRunControllerQuiescenceDigest(
             completed.command as RunControllerCommand
           )) ||
          (reconciliation.disposition !== 'not-applied' && reconciliation.quiescenceDigest !== null)) {
        context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Recovery quiescence proof mismatch' });
      }
      const reconciliationProof = reconciliation.disposition === 'applied' ? reconciliation.proof : null;
      expectedOutcome = reconciliation.disposition === 'applied' && reconciliationProof !== null &&
        (reconciliationProof.kind === 'evidence.validate-preliminary-report' ||
         reconciliationProof.kind === 'evidence.validate-final-report')
        ? reconciliationProof.classification
        : reconciliation.disposition === 'applied' ? 'succeeded' : 'not-applied';
      expectedResultDigest = reconciliation.disposition === 'applied'
        ? reconciliation.resultDigest! : reconciliation.reconciliationDigest;
      expectedProof = reconciliation.disposition === 'applied' ? reconciliation.proof : null;
    }
    if (completed.outcome !== expectedOutcome || completed.resultDigest !== expectedResultDigest ||
        canonicalizeJson(completed.proof) !== canonicalizeJson(expectedProof)) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completion facts mismatch' });
    }
    const reportOutcome = RUN_CONTROLLER_REPORT_OUTCOMES.includes(
      completed.outcome as typeof RUN_CONTROLLER_REPORT_OUTCOMES[number]
    );
    const reportCommand = completed.command.kind === 'evidence.validate-preliminary-report' ||
      completed.command.kind === 'evidence.validate-final-report';
    if (reportOutcome !== reportCommand && completed.outcome !== 'failed' &&
        completed.outcome !== 'uncertain' && completed.outcome !== 'not-applied' &&
        !(completed.outcome === 'succeeded' && reconciliation !== null)) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completion outcome kind mismatch' });
    }
    const proof = completed.proof;
    const typedOutcomeCompletion = reconciliation === null && (event.type === 'preflight-result' ||
      event.type === 'preliminary-report-outcome' || event.type === 'final-report-outcome');
    const recoveredReportCompletion = reconciliation?.disposition === 'applied' && proof !== null &&
      (proof.kind === 'evidence.validate-preliminary-report' ||
       proof.kind === 'evidence.validate-final-report');
    if ((completed.outcome === 'succeeded' && !typedOutcomeCompletion && proof?.kind !== completed.command.kind) ||
        (completed.outcome !== 'succeeded' && proof !== null && !recoveredReportCompletion) ||
        (typedOutcomeCompletion && proof !== null)) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completion proof mismatch' });
    }
    if (proof?.kind === 'mediator.finalize-receipts' &&
        completed.resultDigest !== computeRunControllerBindingDigest(
          'finalized-projections', proof.finalizedProjectionDigests
        )) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Finalized projection proof mismatch' });
    }
    if (proof?.kind === 'fidelity.preflight' && completed.resultDigest !== proof.assessmentDigest) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Preflight proof/result mismatch' });
    }
    if ((proof?.kind === 'evidence.validate-preliminary-report' ||
         proof?.kind === 'evidence.validate-final-report') &&
        completed.resultDigest !== proof.evidenceDigest) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Report proof/result mismatch' });
    }
    if (proof?.kind === 'evidence.validate-preliminary-report' ||
        proof?.kind === 'evidence.validate-final-report') {
      const reportBindingName = proof.kind === 'evidence.validate-preliminary-report'
        ? 'report' : 'report-input';
      const reportBinding = completed.protectedPayload.bindings
        .find(binding => binding.name === reportBindingName)?.digest;
      if (proof.kind !== completed.command.kind || proof.reportDigest !== reportBinding ||
          proof.authority !== false ||
          (proof.kind === 'evidence.validate-preliminary-report' && proof.classification === 'accepted') ||
          (proof.classification === 'exact-replay' &&
           !state.reportDigestIndex.includes(proof.reportDigest))) {
        context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Report recovery proof mismatch' });
      }
    }
    const completedReport = reportFacts(completed);
    if (completedReport?.classification === 'exact-replay') {
      const material = state.completedCommands.map(candidate => ({
        completed: candidate,
        report: reportFacts(candidate)
      })).filter(candidate => candidate.completed.command.id !== completed.command.id &&
        candidate.completed.command.kind === completed.command.kind &&
        !(state.terminalIntent !== null &&
          state.drainSummary.interruptedCommandIds.includes(candidate.completed.command.id) &&
          candidate.completed.reconciliationEvent !== null) &&
        effectiveCompletionSequence(candidate.completed) < effectiveCompletionSequence(completed) &&
        candidate.report !== null && candidate.report.classification !== 'exact-replay' &&
        candidate.report.reportDigest === completedReport.reportDigest)
        .sort((left, right) =>
          effectiveCompletionSequence(right.completed) - effectiveCompletionSequence(left.completed))[0]?.report;
      if (material === null || material === undefined ||
          material.authority !== completedReport.authority ||
          material.evidenceDigest !== completedReport.evidenceDigest ||
          material.requestedDisposition !== completedReport.requestedDisposition) {
        context.addIssue({
          code: 'custom', path: ['completedCommands'],
          message: 'Exact replay lacks identical prior same-kind material report'
        });
      }
    }
    if (proof?.kind === 'checkpoint.persist' && completed.resultDigest !== proof.checkpointDigest) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Checkpoint proof/result mismatch' });
    }
    const expectedLeaseFence = proof !== null &&
      (proof.kind === 'authority.acquire-controller' || proof.kind === 'authority.claim-workstream')
      ? proof.leaseFence : null;
    if (completed.resultLeaseFence !== expectedLeaseFence) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completion lease proof mismatch' });
    }
    const expectedCount = proof !== null &&
      (proof.kind === 'descendant.signal' || proof.kind === 'descendant.force')
      ? proof.pendingDescendants : null;
    if (completed.resultCount !== expectedCount) {
      context.addIssue({ code: 'custom', path: ['completedCommands'], message: 'Completion count proof mismatch' });
    }
  }
  if ((state.controllerLeaseRefDigest === null) !== (state.controllerLeaseFence === null)) {
    context.addIssue({ code: 'custom', message: 'Controller lease ref/fence must be paired' });
  }
  if (state.authorityAcquired && (!state.authorityInitialized || state.controllerLeaseRefDigest === null)) {
    context.addIssue({ code: 'custom', message: 'Acquired authority lacks initialization/lease proof' });
  }
  if (!state.authorityAcquired && state.controllerLeaseRefDigest !== null) {
    context.addIssue({ code: 'custom', message: 'Inactive controller authority retains live lease' });
  }
  if (state.workstreamActive && (!state.authorityAcquired ||
      state.execution.workstreamLeaseRefDigest === null || state.execution.workstreamLeaseFence === null)) {
    context.addIssue({ code: 'custom', message: 'Active workstream lacks controller/lease proof' });
  }
  if (!state.workstreamActive &&
      (state.execution.workstreamLeaseRefDigest !== null || state.execution.workstreamLeaseFence !== null)) {
    context.addIssue({ code: 'custom', message: 'Inactive workstream retains live lease' });
  }
  if ((state.approvalDigests.approval === null) !== (state.approvalDigests.modeSelection === null) ||
      (state.mode === 'unselected') !== (state.approvalDigests.approval === null)) {
    context.addIssue({ code: 'custom', message: 'Mode and approval digest binding mismatch' });
  }
  if (state.requestedMode !== null && state.mode !== 'unselected' && state.requestedMode !== state.mode) {
    context.addIssue({ code: 'custom', message: 'Requested and approved modes differ' });
  }
  const materialPreflight = state.completedCommands.map(completed => ({
    completed,
    facts: completed.outcome === 'succeeded' && completed.completionEvent.type === 'preflight-result'
      ? completed.completionEvent
      : completed.outcome === 'succeeded' && completed.reconciliationEvent?.disposition === 'applied' &&
        completed.proof?.kind === 'fidelity.preflight' ? completed.proof : null
  })).filter(item => item.completed.command.kind === 'fidelity.preflight' && item.facts !== null &&
    !(state.terminalIntent !== null &&
      state.drainSummary.interruptedCommandIds.includes(item.completed.command.id) &&
      item.completed.reconciliationEvent !== null))
    .sort((left, right) => left.completed.command.attempt - right.completed.command.attempt ||
      left.completed.command.transitionSequence - right.completed.command.transitionSequence)
    .at(-1);
  const preflightFacts = materialPreflight?.facts;
  if ((preflightFacts === null || preflightFacts === undefined)
    ? state.fidelity.result !== 'pending' || state.fidelity.assessmentDigest !== null ||
      state.requestedMode !== null
    : state.fidelity.result !== preflightFacts.fidelity ||
      state.fidelity.assessmentDigest !== preflightFacts.assessmentDigest ||
      state.requestedMode !== preflightFacts.requestedMode) {
    context.addIssue({ code: 'custom', message: 'Preflight state does not match completion history' });
  }
  const materialReports = state.completedCommands.map(completed => ({ completed, report: reportFacts(completed) }))
    .filter(item => item.report !== null && item.report.classification !== 'exact-replay' &&
      !(state.terminalIntent !== null &&
        state.drainSummary.interruptedCommandIds.includes(item.completed.command.id) &&
        item.completed.reconciliationEvent !== null))
    .sort((left, right) =>
      effectiveCompletionSequence(left.completed) - effectiveCompletionSequence(right.completed));
  for (const item of materialReports) {
    if (!state.reportDigestIndex.includes(item.report!.reportDigest) ||
        !state.evidenceDigestIndex.includes(item.report!.evidenceDigest)) {
      context.addIssue({ code: 'custom', message: 'Report indexes do not match completion history' });
    }
  }
  const latestMaterialReport = materialReports.at(-1)?.report;
  if (latestMaterialReport !== null && latestMaterialReport !== undefined &&
      (state.execution.reportDigest !== latestMaterialReport.reportDigest ||
       state.execution.evidenceDigest !== latestMaterialReport.evidenceDigest)) {
    context.addIssue({ code: 'custom', message: 'Execution report state does not match completion history' });
  }
  const terminal = ['completed', 'failed', 'cancelled'].includes(state.publicState);
  if (terminal && (state.phase !== state.publicState || state.outbox.length !== 0 ||
      state.authorityInitialized || state.authorityAcquired || state.workstreamActive ||
      state.controllerLeaseRefDigest !== null || state.execution.workstreamLeaseRefDigest !== null ||
      state.terminalIntent !== state.publicState)) {
    context.addIssue({ code: 'custom', message: 'Terminal state must have matching phase and empty outbox' });
  }
  const expectedPublicState = state.phase === 'preflight'
    ? 'preparing'
    : state.phase === 'approval'
      ? 'awaiting-approval'
      : state.phase.startsWith('cancellation-')
        ? 'cancelling'
        : ['milestone-hold', 'supervised-checkpoint', 'host-paused',
          'report-resolution', 'recovery-required'].includes(state.phase)
          ? 'paused'
          : state.phase === 'completed' || state.phase === 'failed' || state.phase === 'cancelled'
            ? state.phase
            : 'running';
  if (state.publicState !== expectedPublicState) {
    context.addIssue({ code: 'custom', message: 'Internal phase/public state mismatch' });
  }
  const commandKinds = state.outbox.map(entry => entry.command.kind);
  const exactCommandByPhase: Partial<Record<typeof state.phase, string>> = {
    preflight: 'fidelity.preflight',
    'authority-initializing': 'authority.initialize',
    'controller-acquiring': 'authority.acquire-controller',
    'dispatch-ticket': 'authority.issue-eo-ticket',
    'dispatch-spawn': 'mediator.spawn-eo',
    'dispatch-claim': 'authority.claim-workstream',
    'preliminary-report-validating': 'evidence.validate-preliminary-report',
    'usage-settling': 'authority.settle-usage',
    'receipts-finalizing': 'mediator.finalize-receipts',
    'final-report-validating': 'evidence.validate-final-report',
    'milestone-integrating': 'integration.root-milestone',
    'global-integrating': 'integration.root-global-seal-verdict',
    'cancellation-authority': 'authority.cancel',
    'cancellation-signalling': 'descendant.signal',
    'cancellation-forcing': 'descendant.force',
    'cancellation-checkpoint': 'checkpoint.persist'
  };
  const exactCommand = exactCommandByPhase[state.phase];
  if (exactCommand !== undefined && (commandKinds.length !== 1 || commandKinds[0] !== exactCommand)) {
    context.addIssue({ code: 'custom', path: ['outbox'], message: 'Phase requires matching active command' });
  }
  if (['approval', 'eo-running', 'host-paused',
    'completed', 'failed', 'cancelled'].includes(state.phase) &&
      commandKinds.length !== 0) {
    context.addIssue({ code: 'custom', path: ['outbox'], message: 'Phase forbids active command' });
  }
  if (state.phase === 'recovery-required' && commandKinds.some(
    kind => kind !== 'controller.recover-pending-command')) {
    context.addIssue({ code: 'custom', path: ['outbox'], message: 'Recovery phase has non-recovery command' });
  }
  const uncertainIds = state.recoverySummary.uncertainCommandIds;
  if (uncertainIds.some(id => !state.completedCommands.some(
    command => command.command.id === id &&
      (command.outcome === 'uncertain' ||
       (command.outcome === 'failed' && ['authority.cancel', 'descendant.signal',
         'descendant.force', 'checkpoint.persist', 'controller.recover-pending-command']
          .includes(command.command.kind)))))) {
    context.addIssue({ code: 'custom', message: 'Recovery target does not resolve to recoverable command' });
  }
  if (state.recoverySummary.required && uncertainIds.length === 0) {
    context.addIssue({ code: 'custom', message: 'Recovery-required state lacks target command' });
  }
  if (['milestone-hold', 'supervised-checkpoint', 'report-resolution'].includes(state.phase) && commandKinds.some(
    kind => kind !== 'checkpoint.persist')) {
    context.addIssue({ code: 'custom', path: ['outbox'], message: 'Checkpoint phase has wrong command' });
  }
  const continuationPhase = ['milestone-hold', 'supervised-checkpoint',
    'host-paused', 'report-resolution'].includes(state.phase);
  const continuationCheckpointPending = commandKinds[0] === 'checkpoint.persist';
  const persistedContinuationCheckpoint = state.completedCommands.filter(completed =>
    completed.outcome === 'succeeded' && completed.proof?.kind === 'checkpoint.persist')
    .sort((left, right) => effectiveCompletionSequence(right) - effectiveCompletionSequence(left))[0];
  if ((continuationPhase && continuationCheckpointPending && state.continuationCheckpointDigest !== null) ||
      (continuationPhase && !continuationCheckpointPending && state.continuationCheckpointDigest === null) ||
      (continuationPhase && state.phase !== 'host-paused' && !continuationCheckpointPending &&
       state.continuationCheckpointDigest !== persistedContinuationCheckpoint?.resultDigest) ||
      (!continuationPhase && state.continuationCheckpointDigest !== null)) {
    context.addIssue({ code: 'custom', message: 'Continuation checkpoint binding mismatch' });
  }
  if (state.cancellationGeneration > 0 && state.outbox.some(entry =>
    !['authority.cancel', 'descendant.signal', 'descendant.force', 'checkpoint.persist',
      'controller.recover-pending-command'].includes(entry.command.kind))) {
    context.addIssue({ code: 'custom', message: 'Non-cancellation command exists after cancellation' });
  }
  if ((state.cancellationGeneration === 0 &&
       (state.phase.startsWith('cancellation-') || state.publicState === 'cancelled')) ||
      (state.cancellationGeneration > 0 &&
       !(state.phase.startsWith('cancellation-') || state.phase === 'cancelled' ||
         state.phase === 'completed' || state.phase === 'failed' ||
         state.phase === 'recovery-required' || state.phase === 'host-paused'))) {
    context.addIssue({ code: 'custom', message: 'Cancellation generation/state mismatch' });
  }
  if ((state.execution.state === 'running' && !state.workstreamActive) ||
      ((state.execution.state === 'running' || state.execution.state === 'accepted') &&
       (state.execution.attempt < 1 || state.execution.ticketRefDigest === null ||
        state.execution.spawnRefDigest === null))) {
    context.addIssue({ code: 'custom', message: 'Active/accepted EO lacks dispatch proof' });
  }
  if (state.execution.state === 'accepted' &&
      (state.execution.reportDigest === null || state.execution.evidenceDigest === null)) {
    context.addIssue({ code: 'custom', message: 'Accepted EO lacks report/evidence digest' });
  }
  if (state.milestone.state === 'accepted' &&
      (state.execution.state !== 'accepted' || state.milestone.reportDigest === null ||
       state.milestone.evidenceDigest === null)) {
    context.addIssue({ code: 'custom', message: 'Accepted milestone lacks accepted EO/integration evidence' });
  }
  if (state.globalIntegration.state === 'accepted' &&
      (state.milestone.state !== 'accepted' || state.globalIntegration.reportDigest === null ||
       state.globalIntegration.evidenceDigest === null)) {
    context.addIssue({ code: 'custom', message: 'Accepted global integration lacks milestone/verdict evidence' });
  }
  const authorityWasInitialized = state.completedCommands.some(command =>
    command.command.kind === 'authority.initialize' && command.outcome === 'succeeded');
  if (terminal && (state.publicState !== 'failed' || authorityWasInitialized) &&
      (!state.drainSummary.authorityCancelled || !state.drainSummary.descendantsSignalled ||
       (state.drainSummary.forceRequired && !state.drainSummary.descendantsForced) ||
       state.drainSummary.pendingDescendants !== 0 || state.pendingUsageRefs.length !== 0 ||
       state.pendingProjectionRefs.length !== 0)) {
    context.addIssue({ code: 'custom', message: 'Terminal state lacks completed authority drain' });
  }
  if (state.phase.startsWith('cancellation-') && state.terminalIntent === null) {
    context.addIssue({ code: 'custom', message: 'Cancellation phase lacks terminal intent' });
  }
  if (state.terminalIntent !== null && !terminal && !state.phase.startsWith('cancellation-') &&
      state.phase !== 'recovery-required' && state.phase !== 'host-paused') {
    context.addIssue({ code: 'custom', message: 'Terminal intent exists outside closure path' });
  }
  if (state.phase === 'report-resolution' &&
      (state.recoverySummary.required || state.recoverySummary.resumePhase === null ||
       state.recoverySummary.uncertainCommandIds.length !== 0)) {
    context.addIssue({ code: 'custom', message: 'Report resolution state is not safely resumable' });
  }
  if (state.phase === 'cancellation-authority' &&
      (state.drainSummary.authorityCancelled || state.drainSummary.descendantsSignalled ||
       state.drainSummary.descendantsForced || commandKinds[0] !== 'authority.cancel')) {
    context.addIssue({ code: 'custom', message: 'Cancellation authority phase order invalid' });
  }
  if (state.phase === 'cancellation-signalling' &&
      (!state.drainSummary.authorityCancelled || state.drainSummary.descendantsSignalled ||
       state.drainSummary.descendantsForced ||
       state.drainSummary.signalPendingDescendants !== null || commandKinds[0] !== 'descendant.signal')) {
    context.addIssue({ code: 'custom', message: 'Cancellation signalling phase order invalid' });
  }
  if (state.phase === 'cancellation-forcing' &&
      (!state.drainSummary.authorityCancelled || !state.drainSummary.descendantsSignalled ||
       !state.drainSummary.forceRequired || (state.drainSummary.signalPendingDescendants ?? 0) <= 0 ||
       state.drainSummary.pendingDescendants <= 0 || commandKinds[0] !== 'descendant.force')) {
    context.addIssue({ code: 'custom', message: 'Cancellation forcing phase order invalid' });
  }
  if (state.phase === 'cancellation-checkpoint' &&
      (!state.drainSummary.authorityCancelled || !state.drainSummary.descendantsSignalled ||
       (state.drainSummary.forceRequired && !state.drainSummary.descendantsForced) ||
       state.drainSummary.pendingDescendants !== 0 || uncertainIds.length !== 0 ||
       commandKinds[0] !== 'checkpoint.persist')) {
    context.addIssue({ code: 'custom', message: 'Cancellation checkpoint phase order invalid' });
  }
  if (state.phase === 'milestone-hold' &&
      (state.mode !== 'milestone' || state.milestone.state !== 'accepted' || state.publicState !== 'paused')) {
    context.addIssue({ code: 'custom', message: 'Milestone hold invariant failed' });
  }
  if (['milestone-hold', 'supervised-checkpoint', 'host-paused',
    'report-resolution', 'recovery-required'].includes(state.phase) &&
      state.publicState !== 'paused') {
    context.addIssue({ code: 'custom', message: 'Paused phase/public state mismatch' });
  }
  const completionModeAuthorized = state.mode === 'autonomous' ||
    (state.mode === 'milestone' && state.completedCommands.some(completed =>
      completed.command.kind === 'checkpoint.persist' && completed.outcome === 'succeeded' &&
      completed.protectedPayload.bindings.some(binding => binding.name === 'milestone-evidence')));
  if (state.publicState === 'completed' &&
      (!completionModeAuthorized || state.fidelity.result !== 'exact' ||
       state.execution.state !== 'accepted' || state.milestone.state !== 'accepted' ||
       state.globalIntegration.state !== 'accepted' || state.recoverySummary.required ||
       state.pendingUsageRefs.length !== 0 || state.pendingProjectionRefs.length !== 0 ||
       state.drainSummary.pendingDescendants !== 0)) {
    context.addIssue({ code: 'custom', message: 'Completed run invariant failed' });
  }
  const expectedCommittedProjections = [...new Set(state.completedCommands.flatMap(completed =>
    completed.outcome === 'succeeded' && completed.proof?.kind === 'mediator.finalize-receipts' &&
    !(state.terminalIntent !== null &&
      state.drainSummary.interruptedCommandIds.includes(completed.command.id) &&
      completed.reconciliationEvent !== null)
      ? completed.proof.finalizedProjectionDigests : []
  ))].sort();
  if (state.committedProjectionDigests.join('\0') !== expectedCommittedProjections.join('\0') ||
      state.committedProjectionDigests.some(digest => !state.evidenceDigestIndex.includes(digest))) {
    context.addIssue({ code: 'custom', message: 'Committed projection lacks evidence index entry' });
  }
  const appliedSettlement = state.completedCommands.filter(completed =>
    completed.outcome === 'succeeded' && completed.proof?.kind === 'authority.settle-usage' &&
    !(state.terminalIntent !== null &&
      state.drainSummary.interruptedCommandIds.includes(completed.command.id) &&
      completed.reconciliationEvent !== null))
    .sort((left, right) => effectiveCompletionSequence(right) - effectiveCompletionSequence(left))[0];
  const expectedSettledUsage = appliedSettlement?.proof?.kind === 'authority.settle-usage'
    ? appliedSettlement.proof.settledUsageDigest : null;
  if (state.settledUsageDigest !== expectedSettledUsage) {
    context.addIssue({ code: 'custom', message: 'Settled usage digest does not match completion history' });
  }
  const expectedBudget = appliedSettlement?.proof?.kind === 'authority.settle-usage'
    ? appliedSettlement.proof.budgetSummary : null;
  if (canonicalizeJson(state.budgetSummary) !== canonicalizeJson(expectedBudget)) {
    context.addIssue({ code: 'custom', message: 'Budget summary does not match settlement history' });
  }
  if (state.drainSummary.interruptedCommandIds.some(id =>
    !state.completedCommands.some(command => command.command.id === id))) {
    context.addIssue({ code: 'custom', message: 'Interrupted command link missing' });
  }
  if (terminal && (state.recoverySummary.required || state.recoverySummary.uncertainCommandIds.length !== 0 ||
      state.drainSummary.interruptedCommandIds.some(id => state.completedCommands.some(
        command => command.command.id === id && command.outcome === 'uncertain'
      )))) {
    context.addIssue({ code: 'custom', message: 'Terminal state retains unresolved interrupted command' });
  }
  if (state.recoverySummary.required !== (state.recoverySummary.reasonCode !== null) ||
      (state.phase === 'recovery-required') !== state.recoverySummary.required) {
    context.addIssue({ code: 'custom', message: 'Recovery summary invariant failed' });
  }
  if (state.counters.commandsIssued !== state.completedCommands.length + state.outbox.length) {
    context.addIssue({ code: 'custom', message: 'Command counter mismatch' });
  }
  if (state.counters.eventsApplied !== state.processedEvents.length ||
      state.counters.transitionSequence !== state.processedEvents.length) {
    context.addIssue({ code: 'custom', message: 'Event counter mismatch' });
  }
});

export const runControllerEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...eventBase,
    type: z.literal('create'),
    runId: boundedIdentifierSchema,
    projectId: boundedIdentifierSchema,
    model: compiledRunModelSchema,
    modelDigest: digestSchema,
    fidelityRequirementsDigest: digestSchema
  }).strict().superRefine((event, context) => {
    if (event.modelDigest !== computeRunControllerModelDigest(event.model as import('./model').CompiledRunModel)) {
      context.addIssue({ code: 'custom', path: ['modelDigest'], message: 'Model digest mismatch' });
    }
  }),
  preflightResultEventSchema,
  z.object({
    ...eventBase,
    type: z.literal('trusted-approval-mode-accepted'),
    mode: z.enum(['milestone', 'autonomous']),
    approvalDigest: digestSchema,
    modeSelectionDigest: digestSchema
  }).strict(),
  z.object({ ...eventBase, type: z.literal('drive'), inputDigest: digestSchema.nullable() }).strict(),
  commandCompletionEventSchema,
  preliminaryReportEventSchema,
  finalReportEventSchema,
  z.object({
    ...eventBase, type: z.literal('pause'), reasonDigest: digestSchema, checkpointDigest: digestSchema
  }).strict(),
  z.object({ ...eventBase, type: z.literal('trusted-continuation'), checkpointDigest: digestSchema }).strict(),
  cancelEventSchema,
  recoveryEventSchema
]);

function issues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`).sort().join('; ');
}

function snapshot(value: unknown, code: 'invalid-event' | 'invalid-state'): unknown {
  try {
    return snapshotAuthorityData(value);
  } catch (error) {
    const message = error instanceof TicketAuthorityError ? error.message : String(error);
    const failureCode = /exceeds|limit|too (?:large|many|deep)/i.test(message) ? 'resource-limit' : code;
    throw new RunControllerDataError(failureCode, message);
  }
}

function assertBytes(value: unknown, code: 'invalid-event' | 'invalid-state'): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalizeJson(value), 'utf8');
  } catch (error) {
    throw new RunControllerDataError(code, error instanceof Error ? error.message : String(error));
  }
  if (bytes > RUN_CONTROLLER_MAX_BYTES) {
    throw new RunControllerDataError('resource-limit',
      `RunController data exceeds ${RUN_CONTROLLER_MAX_BYTES} canonical UTF-8 bytes`);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseRunControllerEvent(value: unknown): Readonly<RunControllerEvent> {
  const copied = snapshot(value, 'invalid-event');
  assertBytes(copied, 'invalid-event');
  const result = runControllerEventSchema.safeParse(copied);
  if (!result.success) throw new RunControllerDataError('invalid-event', `Invalid RunController event: ${issues(result.error)}`);
  return deepFreeze(result.data) as Readonly<RunControllerEvent>;
}

export function parseRunControllerCommandCompletionProof(
  value: unknown,
  expectedKind: RunControllerCommandKind
): Readonly<RunControllerCommandCompletionProof> {
  const copied = snapshot(value, 'invalid-event');
  assertBytes(copied, 'invalid-event');
  const result = commandCompletionProofSchema.safeParse(copied);
  if (!result.success) {
    throw new RunControllerDataError('invalid-event',
      `Invalid RunController command completion proof: ${issues(result.error)}`);
  }
  if (result.data.kind !== expectedKind) {
    throw new RunControllerDataError('invalid-event',
      `RunController command completion proof kind ${result.data.kind} does not match ${expectedKind}`);
  }
  return deepFreeze(result.data) as Readonly<RunControllerCommandCompletionProof>;
}

export function parseRunControllerState(value: unknown): Readonly<RunControllerState> {
  const copied = snapshot(value, 'invalid-state') as { format?: unknown; schemaVersion?: unknown };
  assertBytes(copied, 'invalid-state');
  if (copied?.format === RUN_CONTROLLER_FORMAT && copied.schemaVersion !== RUN_CONTROLLER_SCHEMA_VERSION) {
    throw new RunControllerDataError('invalid-state',
      `RunController schemaVersion ${String(copied.schemaVersion)} is unsupported; expected ${RUN_CONTROLLER_SCHEMA_VERSION}`);
  }
  const result = runControllerStateSchema.safeParse(copied);
  if (!result.success) throw new RunControllerDataError('invalid-state', `Invalid RunController state: ${issues(result.error)}`);
  return deepFreeze(result.data) as Readonly<RunControllerState>;
}

export function canonicalRunControllerSnapshot<T>(value: T): Readonly<T> {
  const copied = snapshot(value, 'invalid-state');
  assertBytes(copied, 'invalid-state');
  return deepFreeze(copied) as Readonly<T>;
}

export { digestSchema as runControllerDigestSchema, compiledRunModelSchema };
