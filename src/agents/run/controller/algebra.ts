import * as crypto from 'crypto';

import { canonicalizeJson } from '../../contracts';
import { SurfaceFidelity } from '../../schema';
import { CompiledRunModel } from './model';

export const RUN_CONTROLLER_FORMAT = 'harness-mdocs/run-controller' as const;
export const RUN_CONTROLLER_SCHEMA_VERSION = 1 as const;
export const RUN_CONTROLLER_MAX_BYTES = 896 * 1024;

export const RUN_CONTROLLER_PUBLIC_STATES = Object.freeze([
  'preparing', 'awaiting-approval', 'running', 'paused', 'cancelling',
  'completed', 'failed', 'cancelled'
] as const);
export type RunControllerPublicState = typeof RUN_CONTROLLER_PUBLIC_STATES[number];

export const RUN_CONTROLLER_PHASES = Object.freeze([
  'preflight', 'approval', 'authority-initializing',
  'controller-acquiring', 'dispatch-ticket', 'dispatch-spawn', 'dispatch-claim',
  'eo-running', 'preliminary-report-validating', 'usage-settling',
  'receipts-finalizing', 'final-report-validating', 'milestone-integrating',
  'milestone-hold', 'supervised-checkpoint', 'host-paused', 'report-resolution',
  'global-integrating', 'recovery-required',
  'cancellation-authority', 'cancellation-signalling', 'cancellation-forcing',
  'cancellation-checkpoint', 'completed', 'failed', 'cancelled'
] as const);
export type RunControllerPhase = typeof RUN_CONTROLLER_PHASES[number];

export const RUN_CONTROLLER_REASON_CODES = Object.freeze([
  'awaiting-approval', 'supervised-checkpoint', 'milestone-hold',
  'fidelity-insufficient', 'effect-failed', 'report-rejected',
  'report-quarantined', 'report-completion-blocked', 'recovery-required',
  'paused-by-host', 'cancel-requested', 'descendant-drain-incomplete'
] as const);
export type RunControllerReasonCode = typeof RUN_CONTROLLER_REASON_CODES[number];

export const RUN_CONTROLLER_COMMAND_KINDS = Object.freeze([
  'fidelity.preflight',
  'authority.initialize',
  'authority.acquire-controller',
  'authority.issue-eo-ticket',
  'mediator.spawn-eo',
  'authority.claim-workstream',
  'evidence.validate-preliminary-report',
  'authority.settle-usage',
  'mediator.finalize-receipts',
  'evidence.validate-final-report',
  'integration.root-milestone',
  'integration.root-global-seal-verdict',
  'checkpoint.persist',
  'authority.cancel',
  'descendant.signal',
  'descendant.force',
  'controller.recover-pending-command'
] as const);
export type RunControllerCommandKind = typeof RUN_CONTROLLER_COMMAND_KINDS[number];

export const RUN_CONTROLLER_EVENT_TYPES = Object.freeze([
  'create', 'preflight-result', 'trusted-approval-mode-accepted', 'drive',
  'command-completion', 'preliminary-report-outcome', 'final-report-outcome',
  'pause', 'trusted-continuation', 'cancel', 'recovery'
] as const);
export type RunControllerEventType = typeof RUN_CONTROLLER_EVENT_TYPES[number];

export const RUN_CONTROLLER_REPORT_OUTCOMES = Object.freeze([
  'accepted', 'rejected', 'quarantined', 'valid-completion-blocked', 'exact-replay'
] as const);
export type RunControllerReportOutcome = typeof RUN_CONTROLLER_REPORT_OUTCOMES[number];
export type RunControllerMode = 'unselected' | 'milestone' | 'autonomous';
export type RunControllerFidelity = 'pending' | SurfaceFidelity;
export type Digest = `sha256:${string}`;

export interface RunControllerCommand {
  readonly id: string;
  readonly kind: RunControllerCommandKind;
  readonly runId: string;
  readonly projectId: string;
  readonly nodeId: string | null;
  readonly transitionSequence: number;
  readonly ordinal: number;
  readonly attempt: number;
  readonly expectedControllerEpoch: number;
  readonly expectedLeaseFence: number | null;
  readonly payloadDigest: Digest;
}

/** Internal command data. Values are bindings/digests, never reusable authority. */
export interface ProtectedRunControllerCommandPayload {
  readonly bindings: readonly Readonly<{ name: string; digest: Digest }>[];
  readonly graphEpoch: number;
  readonly cancellationGeneration: number;
}

export interface RunControllerOutboxEntry {
  readonly command: RunControllerCommand;
  readonly protectedPayload: ProtectedRunControllerCommandPayload;
  readonly insertedAt: string;
}

export interface CompletedRunControllerCommand {
  readonly command: RunControllerCommand;
  readonly protectedPayload: ProtectedRunControllerCommandPayload;
  readonly completionEventId: string;
  readonly completionDigest: Digest;
  readonly completionEvent: RunControllerCompletionRecordEvent;
  readonly reconciliationDigest: Digest | null;
  readonly reconciliationEvent: RunControllerRecoveryEvent | null;
  readonly outcome: 'succeeded' | 'failed' | 'uncertain' | 'not-applied' | RunControllerReportOutcome;
  readonly resultDigest: Digest;
  readonly proof: RunControllerCommandCompletionProof | null;
  readonly resultLeaseFence: number | null;
  readonly resultCount: number | null;
  readonly completedAt: string;
}

export interface ProcessedRunControllerEvent {
  readonly eventId: string;
  readonly eventDigest: Digest;
  readonly transitionSequence: number;
  readonly priorAuditHash: Digest;
  readonly nextAuditHash: Digest;
  readonly result: Readonly<{
    code: 'applied';
    commandIds: readonly string[];
  }>;
}

export interface RunControllerNodeRuntime {
  readonly nodeId: string;
  readonly state: 'pending' | 'running' | 'accepted' | 'failed' | 'cancelled';
  readonly attempt: number;
  readonly reportDigest: Digest | null;
  readonly evidenceDigest: Digest | null;
}

export interface RunControllerExecutionRuntime extends RunControllerNodeRuntime {
  readonly ticketRefDigest: Digest | null;
  readonly spawnRefDigest: Digest | null;
  readonly workstreamLeaseRefDigest: Digest | null;
  readonly workstreamLeaseFence: number | null;
}

export interface RunControllerBudgetSummary {
  readonly trusted: true;
  readonly reserved: number;
  readonly committed: number;
  readonly currency: string | null;
}

export interface RunControllerState {
  readonly format: typeof RUN_CONTROLLER_FORMAT;
  readonly schemaVersion: typeof RUN_CONTROLLER_SCHEMA_VERSION;
  readonly runId: string;
  readonly projectId: string;
  readonly model: CompiledRunModel;
  readonly modelDigest: Digest;
  readonly mode: RunControllerMode;
  readonly requestedMode: Exclude<RunControllerMode, 'unselected'> | null;
  readonly fidelity: Readonly<{
    result: RunControllerFidelity;
    requirementsDigest: Digest;
    assessmentDigest: Digest | null;
  }>;
  readonly approvalDigests: Readonly<{
    approval: Digest | null;
    modeSelection: Digest | null;
  }>;
  readonly publicState: RunControllerPublicState;
  readonly phase: RunControllerPhase;
  readonly reasonCode: RunControllerReasonCode | null;
  readonly terminalIntent: 'completed' | 'failed' | 'cancelled' | null;
  readonly authorityInitialized: boolean;
  readonly authorityAcquired: boolean;
  readonly workstreamActive: boolean;
  readonly controllerEpoch: number;
  readonly controllerLeaseRefDigest: Digest | null;
  readonly controllerLeaseFence: number | null;
  readonly graphEpoch: number;
  readonly cancellationGeneration: number;
  readonly execution: RunControllerExecutionRuntime;
  readonly milestone: RunControllerNodeRuntime;
  readonly globalIntegration: RunControllerNodeRuntime;
  readonly outbox: readonly RunControllerOutboxEntry[];
  readonly completedCommands: readonly CompletedRunControllerCommand[];
  readonly processedEvents: readonly ProcessedRunControllerEvent[];
  readonly reportDigestIndex: readonly Digest[];
  readonly evidenceDigestIndex: readonly Digest[];
  readonly pendingUsageRefs: readonly Digest[];
  readonly pendingProjectionRefs: readonly Digest[];
  readonly settledUsageDigest: Digest | null;
  readonly committedProjectionDigests: readonly Digest[];
  readonly continuationCheckpointDigest: Digest | null;
  readonly drainSummary: Readonly<{
    authorityCancelled: boolean;
    descendantsSignalled: boolean;
    descendantsForced: boolean;
    signalPendingDescendants: number | null;
    forceRequired: boolean;
    pendingDescendants: number;
    interruptedCommandIds: readonly string[];
  }>;
  readonly recoverySummary: Readonly<{
    required: boolean;
    reasonCode: RunControllerReasonCode | null;
    uncertainCommandIds: readonly string[];
    resumePhase: RunControllerPhase | null;
  }>;
  readonly counters: Readonly<{
    transitionSequence: number;
    eventsApplied: number;
    commandsIssued: number;
  }>;
  readonly budgetSummary: RunControllerBudgetSummary | null;
  readonly auditHashHead: Digest;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface EventBase {
  readonly eventId: string;
  readonly type: RunControllerEventType;
  readonly occurredAt: string;
}

interface CompletionBinding {
  readonly commandId: string;
  readonly controllerEpoch: number;
  readonly leaseFence: number | null;
  readonly attempt: number;
}

export interface RunControllerCreateEvent extends EventBase {
  readonly type: 'create';
  readonly runId: string;
  readonly projectId: string;
  readonly model: CompiledRunModel;
  readonly modelDigest: Digest;
  readonly fidelityRequirementsDigest: Digest;
}

export interface RunControllerPreflightResultEvent extends EventBase, CompletionBinding {
  readonly type: 'preflight-result';
  readonly fidelity: SurfaceFidelity;
  readonly requestedMode: 'milestone' | 'autonomous';
  readonly assessmentDigest: Digest;
}

export interface RunControllerApprovalEvent extends EventBase {
  readonly type: 'trusted-approval-mode-accepted';
  readonly mode: 'milestone' | 'autonomous';
  readonly approvalDigest: Digest;
  readonly modeSelectionDigest: Digest;
}

export interface RunControllerDriveEvent extends EventBase {
  readonly type: 'drive';
  readonly inputDigest: Digest | null;
}

export type RunControllerCommandCompletionProof =
  | Readonly<{
      kind: 'fidelity.preflight'; fidelity: SurfaceFidelity;
      requestedMode: 'milestone' | 'autonomous'; assessmentDigest: Digest;
    }>
  | Readonly<{ kind: 'authority.initialize'; authorityStateDigest: Digest; authorityInitialized: true }>
  | Readonly<{
      kind: 'authority.acquire-controller'; controllerLeaseRefDigest: Digest;
      controllerEpoch: number; leaseFence: number;
    }>
  | Readonly<{ kind: 'authority.issue-eo-ticket'; ticketRefDigest: Digest }>
  | Readonly<{ kind: 'mediator.spawn-eo'; spawnRefDigest: Digest }>
  | Readonly<{
      kind: 'authority.claim-workstream'; workstreamLeaseRefDigest: Digest; leaseFence: number;
    }>
  | Readonly<{
      kind: 'authority.settle-usage'; settledUsageDigest: Digest;
      projectionDigests: readonly Digest[]; budgetSummary: RunControllerBudgetSummary;
    }>
  | Readonly<{
      kind: 'mediator.finalize-receipts'; finalizedProjectionDigests: readonly Digest[];
    }>
  | Readonly<{
      kind: 'evidence.validate-preliminary-report' | 'evidence.validate-final-report';
      authority: false; classification: RunControllerReportOutcome;
      reportDigest: Digest; evidenceDigest: Digest;
      requestedDisposition: 'continue' | 'pause' | 'escalate' | 'complete' | null;
    }>
  | Readonly<{
      kind: 'integration.root-milestone'; integrationAccepted: true; evidenceDigest: Digest;
    }>
  | Readonly<{
      kind: 'integration.root-global-seal-verdict'; accepted: true;
      reportKind: 'goal-verdict/v1'; verdictDigest: Digest; finalState: 'completed';
      unresolvedCount: 0; pendingCount: 0;
    }>
  | Readonly<{ kind: 'checkpoint.persist'; checkpointDigest: Digest }>
  | Readonly<{
      kind: 'authority.cancel'; authorityCancelled: true; cancellationGeneration: number;
    }>
  | Readonly<{
      kind: 'descendant.signal' | 'descendant.force'; pendingDescendants: number;
    }>;

export interface RunControllerCommandCompletionEvent extends EventBase, CompletionBinding {
  readonly type: 'command-completion';
  readonly outcome: 'succeeded' | 'failed' | 'uncertain';
  readonly resultDigest: Digest;
  readonly proof: RunControllerCommandCompletionProof | null;
}

interface ReportOutcomeEvent extends EventBase, CompletionBinding {
  readonly authority: false;
  readonly classification: RunControllerReportOutcome;
  readonly reportDigest: Digest;
  readonly evidenceDigest: Digest;
  readonly requestedDisposition: 'continue' | 'pause' | 'escalate' | 'complete' | null;
}

export interface RunControllerPreliminaryReportEvent extends ReportOutcomeEvent {
  readonly type: 'preliminary-report-outcome';
}

export interface RunControllerFinalReportEvent extends ReportOutcomeEvent {
  readonly type: 'final-report-outcome';
}

export interface RunControllerPauseEvent extends EventBase {
  readonly type: 'pause';
  readonly reasonDigest: Digest;
  readonly checkpointDigest: Digest;
}

export interface RunControllerContinuationEvent extends EventBase {
  readonly type: 'trusted-continuation';
  readonly checkpointDigest: Digest;
}

export interface RunControllerCancelEvent extends EventBase {
  readonly type: 'cancel';
  readonly reasonDigest: Digest;
}

export interface RunControllerRecoveryEvent extends EventBase {
  readonly type: 'recovery';
  readonly targetCommandId: string;
  readonly reconciliationDigest: Digest;
  readonly disposition: 'applied' | 'not-applied' | 'still-uncertain';
  readonly quiescenceDigest: Digest | null;
  readonly resultDigest: Digest | null;
  readonly proof: RunControllerCommandCompletionProof | null;
}

export type RunControllerEvent =
  | RunControllerCreateEvent
  | RunControllerPreflightResultEvent
  | RunControllerApprovalEvent
  | RunControllerDriveEvent
  | RunControllerCommandCompletionEvent
  | RunControllerPreliminaryReportEvent
  | RunControllerFinalReportEvent
  | RunControllerPauseEvent
  | RunControllerContinuationEvent
  | RunControllerCancelEvent
  | RunControllerRecoveryEvent;

export type RunControllerCompletionRecordEvent =
  | RunControllerPreflightResultEvent
  | RunControllerCommandCompletionEvent
  | RunControllerPreliminaryReportEvent
  | RunControllerFinalReportEvent
  | RunControllerCancelEvent;

export type RunControllerRejectionCode =
  | 'invalid-event'
  | 'invalid-state'
  | 'not-created'
  | 'already-created'
  | 'event-id-conflict'
  | 'illegal-transition'
  | 'terminal-immutable'
  | 'stale-observation'
  | 'stale-effect-completion'
  | 'command-completion-conflict'
  | 'resource-limit';

export type RunControllerTransitionResult =
  | Readonly<{
      ok: true;
      code: 'applied' | 'noop';
      state: Readonly<RunControllerState>;
      commands: readonly RunControllerCommand[];
    }>
  | Readonly<{
      ok: false;
      code: RunControllerRejectionCode;
      reason: string;
      state: Readonly<RunControllerState> | undefined;
      commands: readonly [];
    }>;

export interface RunControllerCommandIdInput {
  runId: string;
  projectId: string;
  controllerEpoch: number;
  expectedLeaseFence: number | null;
  graphEpoch: number;
  transitionSequence: number;
  ordinal: number;
  kind: RunControllerCommandKind;
  nodeId: string | null;
  attempt: number;
  payloadDigest: Digest;
}

function domainDigest(domain: string, value: unknown): Digest {
  const hash = crypto.createHash('sha256')
    .update(domain, 'utf8')
    .update(Buffer.from([0]))
    .update(canonicalizeJson(value), 'utf8')
    .digest('hex');
  return `sha256:${hash}` as Digest;
}

export function computeRunControllerCommandId(input: RunControllerCommandIdInput): string {
  return `rcmd:${domainDigest('harness-mdocs/run-controller/command-id/v1', input).slice(7)}`;
}

export function computeRunControllerPayloadDigest(
  payload: ProtectedRunControllerCommandPayload
): Digest {
  return domainDigest('harness-mdocs/run-controller/command-payload/v1', payload);
}

export function computeRunControllerQuiescenceDigest(
  command: Readonly<RunControllerCommand>
): Digest {
  return domainDigest('harness-mdocs/run-controller/quiescence/v1', {
    commandId: command.id,
    kind: command.kind,
    projectId: command.projectId,
    runId: command.runId,
    controllerEpoch: command.expectedControllerEpoch,
    leaseFence: command.expectedLeaseFence,
    attempt: command.attempt,
    payloadDigest: command.payloadDigest
  });
}

export function computeRunControllerEventDigest(event: RunControllerEvent): Digest {
  return domainDigest('harness-mdocs/run-controller/event/v1', event);
}

export function computeRunControllerAuditHead(
  previous: Digest,
  eventDigest: Digest,
  transitionSequence: number
): Digest {
  return domainDigest('harness-mdocs/run-controller/audit/v1', {
    previous, eventDigest, transitionSequence
  });
}

export function computeRunControllerBindingDigest(name: string, value: unknown): Digest {
  return domainDigest(`harness-mdocs/run-controller/binding/${name}/v1`, value);
}

/** Integrity checksum only. Human approval remains bound by trusted authority in WP-230C2. */
export function computeRunControllerModelDigest(model: CompiledRunModel): Digest {
  return domainDigest('harness-mdocs/run-controller/model/v1', model);
}
