import {
  CompletedRunControllerCommand,
  computeRunControllerAuditHead,
  computeRunControllerBindingDigest,
  computeRunControllerCommandId,
  computeRunControllerEventDigest,
  computeRunControllerPayloadDigest,
  computeRunControllerQuiescenceDigest,
  Digest,
  ProtectedRunControllerCommandPayload,
  RUN_CONTROLLER_FORMAT,
  RUN_CONTROLLER_SCHEMA_VERSION,
  RunControllerCommand,
  RunControllerCommandCompletionEvent,
  RunControllerCommandCompletionProof,
  RunControllerCommandKind,
  RunControllerEvent,
  RunControllerPhase,
  RunControllerReportOutcome,
  RunControllerState,
  RunControllerTransitionResult
} from './algebra';
import {
  canonicalRunControllerSnapshot,
  hasRunControllerNormalJournalCapacity,
  parseRunControllerEvent,
  parseRunControllerState,
  runControllerCanonicalBytes,
  RunControllerDataError,
  RUN_CONTROLLER_LIMITS
} from './schema';

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}` as Digest;
const CANCELLATION_COMMANDS: readonly RunControllerCommandKind[] = Object.freeze([
  'authority.cancel', 'descendant.signal', 'descendant.force', 'checkpoint.persist',
  'controller.recover-pending-command'
]);
const WORKSTREAM_FENCE_COMMANDS: readonly RunControllerCommandKind[] = Object.freeze([
  'evidence.validate-preliminary-report', 'authority.settle-usage',
  'mediator.finalize-receipts', 'evidence.validate-final-report'
]);
const PRE_CONTROLLER_COMMANDS: readonly RunControllerCommandKind[] = Object.freeze([
  'fidelity.preflight', 'authority.initialize', 'authority.acquire-controller'
]);
const TYPED_OUTCOME_COMMANDS: readonly RunControllerCommandKind[] = Object.freeze([
  'fidelity.preflight', 'evidence.validate-preliminary-report', 'evidence.validate-final-report'
]);

type MutableState = { -readonly [K in keyof RunControllerState]: any };
type CompletionEvent = Extract<RunControllerEvent, {
  commandId: string;
  controllerEpoch: number;
  leaseFence: number | null;
  attempt: number;
}>;
type PreflightProof = Extract<RunControllerCommandCompletionProof, { kind: 'fidelity.preflight' }>;
type ReportProof = Extract<RunControllerCommandCompletionProof, {
  kind: 'evidence.validate-preliminary-report' | 'evidence.validate-final-report';
}>;

function reject(
  state: Readonly<RunControllerState> | undefined,
  code: Extract<RunControllerTransitionResult, { ok: false }>['code'],
  reason: string
): RunControllerTransitionResult {
  return Object.freeze({
    ok: false, code, reason, state,
    commands: Object.freeze([]) as readonly []
  });
}

function success(
  state: Readonly<RunControllerState>,
  code: 'applied' | 'noop',
  commands: readonly RunControllerCommand[]
): RunControllerTransitionResult {
  const safeCommands = canonicalRunControllerSnapshot([...commands]) as readonly RunControllerCommand[];
  return Object.freeze({ ok: true, code, state, commands: safeCommands });
}

function mutable(state: Readonly<RunControllerState>): MutableState {
  return JSON.parse(JSON.stringify(state)) as MutableState;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function nodeFor(state: MutableState, kind: RunControllerCommandKind): string | null {
  if (['authority.issue-eo-ticket', 'mediator.spawn-eo', 'authority.claim-workstream',
    'evidence.validate-preliminary-report', 'authority.settle-usage',
    'mediator.finalize-receipts', 'evidence.validate-final-report'].includes(kind)) {
    return state.execution.nodeId;
  }
  if (kind === 'integration.root-milestone') return state.model.milestones[0].integrationNodeId;
  if (kind === 'integration.root-global-seal-verdict') return state.globalIntegration.nodeId;
  return null;
}

function leaseFenceFor(state: MutableState, kind: RunControllerCommandKind): number | null {
  if (PRE_CONTROLLER_COMMANDS.includes(kind)) return null;
  if (WORKSTREAM_FENCE_COMMANDS.includes(kind)) return state.execution.workstreamLeaseFence;
  return state.authorityAcquired ? state.controllerLeaseFence : null;
}

function digestSet(name: string, values: readonly Digest[]): Digest {
  return computeRunControllerBindingDigest(name, values);
}

function stageBindings(
  state: MutableState,
  kind: RunControllerCommandKind
): ReadonlyArray<Readonly<{ name: string; digest: Digest }>> {
  const settled = state.settledUsageDigest as Digest | null;
  const committed = state.committedProjectionDigests as readonly Digest[];
  const budget = state.budgetSummary === null
    ? null : computeRunControllerBindingDigest('budget-summary', state.budgetSummary);
  if (kind === 'mediator.finalize-receipts') {
    if (settled === null || state.pendingProjectionRefs.length === 0) {
      throw new Error('Receipt finalization lacks settled usage/projection inputs');
    }
    return [
      { name: 'pending-projection-inputs', digest: digestSet('pending-projection-inputs', state.pendingProjectionRefs) },
      { name: 'settled-usage', digest: settled }
    ];
  }
  if (kind === 'evidence.validate-final-report') {
    if (settled === null || committed.length === 0 || state.execution.reportDigest === null) {
      throw new Error('Final report validation lacks committed stage inputs');
    }
    return [
      { name: 'committed-projections', digest: digestSet('committed-projections', committed) },
      { name: 'report-input', digest: state.execution.reportDigest },
      { name: 'settled-usage', digest: settled }
    ];
  }
  if (kind === 'integration.root-milestone' || kind === 'integration.root-global-seal-verdict') {
    if (settled === null || committed.length === 0 || budget === null) {
      throw new Error('Integration lacks settled completion inputs');
    }
    if (kind === 'integration.root-milestone') {
      if (state.execution.reportDigest === null || state.execution.evidenceDigest === null) {
        throw new Error('Milestone integration lacks accepted EO inputs');
      }
      return [
        { name: 'budget-summary', digest: budget },
        { name: 'committed-projections', digest: digestSet('committed-projections', committed) },
        { name: 'eo-final-evidence', digest: state.execution.evidenceDigest },
        { name: 'eo-final-report', digest: state.execution.reportDigest },
        { name: 'settled-usage', digest: settled }
      ];
    }
    if (state.milestone.reportDigest === null || state.milestone.evidenceDigest === null) {
      throw new Error('Global integration lacks accepted milestone inputs');
    }
    return [
      { name: 'budget-summary', digest: budget },
      { name: 'committed-projections', digest: digestSet('committed-projections', committed) },
      { name: 'milestone-evidence', digest: state.milestone.evidenceDigest },
      { name: 'milestone-report', digest: state.milestone.reportDigest },
      { name: 'settled-usage', digest: settled }
    ];
  }
  return [];
}

function commandBindings(
  state: MutableState,
  kind: RunControllerCommandKind,
  extra: readonly Readonly<{ name: string; digest: Digest }>[]
): ReadonlyArray<Readonly<{ name: string; digest: Digest }>> {
  return [...extra, ...stageBindings(state, kind),
    { name: 'graph', digest: state.model.graphDigest as Digest },
    { name: 'plan', digest: state.model.planDigest as Digest }]
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function issueCommand(
  state: MutableState,
  kind: RunControllerCommandKind,
  occurredAt: string,
  transitionSequence: number,
  extraBindings: readonly Readonly<{ name: string; digest: Digest }>[] = [],
  requestedAttempt?: number
): RunControllerCommand {
  if (state.outbox.length !== 0) throw new Error('RunController permits one active command');
  if (state.completedCommands.length >= RUN_CONTROLLER_LIMITS.completedCommands) {
    throw new RunControllerDataError('resource-limit', 'Completed command limit leaves no issuance capacity');
  }
  if (state.cancellationGeneration > 0 && !CANCELLATION_COMMANDS.includes(kind)) {
    throw new Error('RunController forbids normal commands after cancellation');
  }
  const protectedPayload: ProtectedRunControllerCommandPayload = {
    bindings: commandBindings(state, kind, extraBindings),
    graphEpoch: state.graphEpoch,
    cancellationGeneration: state.cancellationGeneration
  };
  const payloadDigest = computeRunControllerPayloadDigest(protectedPayload);
  const priorAttempt = state.completedCommands
    .filter((entry: CompletedRunControllerCommand) =>
      entry.command.kind === kind && entry.command.nodeId === nodeFor(state, kind))
    .reduce((highest: number, entry: CompletedRunControllerCommand) =>
      Math.max(highest, entry.command.attempt), 0);
  const attempt = requestedAttempt ?? priorAttempt + 1;
  const expectedLeaseFence = leaseFenceFor(state, kind);
  const commandInput = {
    kind,
    runId: state.runId,
    projectId: state.projectId,
    nodeId: nodeFor(state, kind),
    transitionSequence,
    ordinal: 0,
    attempt,
    expectedControllerEpoch: state.controllerEpoch,
    expectedLeaseFence,
    payloadDigest
  };
  const command: RunControllerCommand = {
    id: computeRunControllerCommandId({
      runId: commandInput.runId,
      projectId: commandInput.projectId,
      controllerEpoch: commandInput.expectedControllerEpoch,
      expectedLeaseFence: commandInput.expectedLeaseFence,
      graphEpoch: protectedPayload.graphEpoch,
      transitionSequence: commandInput.transitionSequence,
      ordinal: commandInput.ordinal,
      kind: commandInput.kind,
      nodeId: commandInput.nodeId,
      attempt: commandInput.attempt,
      payloadDigest: commandInput.payloadDigest
    }),
    ...commandInput
  };
  state.outbox = [{ command, protectedPayload, insertedAt: occurredAt }];
  state.counters.commandsIssued += 1;
  return command;
}

function completionSignature(event: CompletionEvent): Digest {
  return computeRunControllerEventDigest(event as RunControllerEvent);
}

function completionFacts(event: CompletionEvent): {
  outcome: CompletedRunControllerCommand['outcome'];
  resultDigest: Digest;
  resultLeaseFence: number | null;
  resultCount: number | null;
} {
  if (event.type === 'command-completion') return {
    outcome: event.outcome,
    resultDigest: event.resultDigest,
    resultLeaseFence: event.proof !== null &&
      (event.proof.kind === 'authority.acquire-controller' ||
       event.proof.kind === 'authority.claim-workstream') ? event.proof.leaseFence : null,
    resultCount: event.proof !== null &&
      (event.proof.kind === 'descendant.signal' || event.proof.kind === 'descendant.force')
      ? event.proof.pendingDescendants : null
  };
  if (event.type === 'preflight-result') return {
    outcome: 'succeeded', resultDigest: event.assessmentDigest,
    resultLeaseFence: null, resultCount: null
  };
  return {
    outcome: event.classification,
    resultDigest: event.evidenceDigest,
    resultLeaseFence: null,
    resultCount: null
  };
}

function bindingMatches(command: RunControllerCommand, event: CompletionEvent): boolean {
  return command.id === event.commandId &&
    command.expectedControllerEpoch === event.controllerEpoch &&
    command.expectedLeaseFence === event.leaseFence &&
    command.attempt === event.attempt;
}

function finishCommand(
  state: MutableState,
  event: CompletionEvent,
  completionDigest = completionSignature(event)
): CompletedRunControllerCommand {
  const entry = state.outbox[0];
  if (!entry || !bindingMatches(entry.command, event)) throw new Error('Completion binding mismatch');
  const facts = completionFacts(event);
  const completed: CompletedRunControllerCommand = {
    command: entry.command,
    protectedPayload: entry.protectedPayload,
    completionEventId: event.eventId,
    completionDigest,
    completionEvent: event,
    reconciliationDigest: null,
    reconciliationEvent: null,
    outcome: facts.outcome,
    resultDigest: facts.resultDigest,
    proof: event.type === 'command-completion' ? event.proof : null,
    resultLeaseFence: facts.resultLeaseFence,
    resultCount: facts.resultCount,
    completedAt: event.occurredAt
  };
  state.outbox = [];
  state.completedCommands.push(completed);
  return completed;
}

function interruptCommand(state: MutableState, event: CompletionEvent, digest: Digest): void {
  const entry = state.outbox[0];
  if (!entry) return;
  state.outbox = [];
  state.completedCommands.push({
    command: entry.command,
    protectedPayload: entry.protectedPayload,
    completionEventId: event.eventId,
    completionDigest: completionSignature(event),
    completionEvent: event,
    reconciliationDigest: null,
    reconciliationEvent: null,
    outcome: 'uncertain',
    resultDigest: digest,
    proof: null,
    resultLeaseFence: null,
    resultCount: null,
    completedAt: event.occurredAt
  });
  state.recoverySummary.uncertainCommandIds = sortedUnique([
    ...state.recoverySummary.uncertainCommandIds, entry.command.id
  ]);
}

function interruptCommandForCancellation(
  state: MutableState,
  event: Extract<RunControllerEvent, { type: 'cancel' }>
): void {
  const entry = state.outbox[0];
  if (!entry) return;
  const eventDigest = computeRunControllerEventDigest(event);
  state.outbox = [];
  state.completedCommands.push({
    command: entry.command,
    protectedPayload: entry.protectedPayload,
    completionEventId: event.eventId,
    completionDigest: eventDigest,
    completionEvent: event,
    reconciliationDigest: null,
    reconciliationEvent: null,
    outcome: 'uncertain',
    resultDigest: event.reasonDigest,
    proof: null,
    resultLeaseFence: null,
    resultCount: null,
    completedAt: event.occurredAt
  });
  state.drainSummary.interruptedCommandIds = sortedUnique([
    ...state.drainSummary.interruptedCommandIds, entry.command.id
  ]);
}

function enterRecovery(
  state: MutableState,
  reasonCode: RunControllerState['reasonCode'],
  resumePhase: RunControllerPhase | null
): void {
  state.publicState = 'paused';
  state.phase = 'recovery-required';
  state.reasonCode = reasonCode ?? 'recovery-required';
  state.recoverySummary.required = true;
  state.recoverySummary.reasonCode = state.reasonCode;
  state.recoverySummary.resumePhase = resumePhase;
}

function commandReplay(
  state: Readonly<RunControllerState>,
  event: CompletionEvent
): RunControllerTransitionResult | undefined {
  const completed = state.completedCommands.find(item => item.command.id === event.commandId);
  if (!completed) return undefined;
  if (completed.completionDigest === completionSignature(event)) return success(state, 'noop', []);
  return reject(state, 'command-completion-conflict',
    `Command ${event.commandId} already completed with different facts`);
}

function apply(
  current: Readonly<RunControllerState>,
  event: Readonly<RunControllerEvent>,
  eventDigest: Digest,
  mutateState: (state: MutableState, sequence: number, commands: RunControllerCommand[]) => void
): RunControllerTransitionResult {
  if (current.processedEvents.length >= RUN_CONTROLLER_LIMITS.processedEvents) {
    return reject(current, 'resource-limit', 'Processed event limit reached');
  }
  const state = mutable(current);
  const sequence = current.counters.transitionSequence + 1;
  const commands: RunControllerCommand[] = [];
  try {
    mutateState(state, sequence, commands);
    if (state.completedCommands.length > RUN_CONTROLLER_LIMITS.completedCommands) {
      throw new RunControllerDataError('resource-limit', 'Completed command limit reached');
    }
    state.counters.transitionSequence = sequence;
    state.counters.eventsApplied += 1;
    state.updatedAt = event.occurredAt;
    state.auditHashHead = computeRunControllerAuditHead(current.auditHashHead, eventDigest, sequence);
    state.processedEvents.push({
      eventId: event.eventId,
      eventDigest,
      transitionSequence: sequence,
      priorAuditHash: current.auditHashHead,
      nextAuditHash: state.auditHashHead,
      result: { code: 'applied', commandIds: commands.map(command => command.id) }
    });
    const aggregateBytes = runControllerCanonicalBytes(state);
    const closureReserveEligible = state.terminalIntent !== null ||
      ['completed', 'failed', 'cancelled'].includes(state.publicState) ||
      ['milestone-hold', 'supervised-checkpoint', 'report-resolution', 'recovery-required']
        .includes(state.phase);
    if (aggregateBytes > RUN_CONTROLLER_LIMITS.aggregateBytes) {
      throw new RunControllerDataError('resource-limit', 'RunController aggregate byte limit reached');
    }
    if (aggregateBytes > RUN_CONTROLLER_LIMITS.normalOperationAggregateBytes && !closureReserveEligible) {
      throw new RunControllerDataError('resource-limit', 'Normal transition would consume closure byte reserve');
    }
    return success(parseRunControllerState(state), 'applied', commands);
  } catch (error) {
    if (error instanceof RunControllerDataError) {
      return reject(current, error.code, error.message);
    }
    return reject(current, 'invalid-state', error instanceof Error ? error.message : String(error));
  }
}

function create(event: Extract<RunControllerEvent, { type: 'create' }>, eventDigest: Digest):
RunControllerTransitionResult {
  const milestone = event.model.milestones[0];
  const initial: MutableState = {
    format: RUN_CONTROLLER_FORMAT,
    schemaVersion: RUN_CONTROLLER_SCHEMA_VERSION,
    runId: event.runId,
    projectId: event.projectId,
    model: event.model,
    modelDigest: event.modelDigest,
    mode: 'unselected',
    requestedMode: null,
    fidelity: {
      result: 'pending',
      requirementsDigest: event.fidelityRequirementsDigest,
      assessmentDigest: null
    },
    approvalDigests: { approval: null, modeSelection: null },
    publicState: 'preparing',
    phase: 'preflight',
    reasonCode: null,
    terminalIntent: null,
    authorityInitialized: false,
    authorityAcquired: false,
    workstreamActive: false,
    controllerEpoch: 0,
    controllerLeaseRefDigest: null,
    controllerLeaseFence: null,
    graphEpoch: 0,
    cancellationGeneration: 0,
    execution: {
      nodeId: milestone.executionOrchestratorNodeId,
      state: 'pending', attempt: 0, reportDigest: null, evidenceDigest: null,
      ticketRefDigest: null, spawnRefDigest: null,
      workstreamLeaseRefDigest: null, workstreamLeaseFence: null
    },
    milestone: {
      nodeId: milestone.milestoneId,
      state: 'pending', attempt: 0, reportDigest: null, evidenceDigest: null
    },
    globalIntegration: {
      nodeId: event.model.globalIntegrationNodeId,
      state: 'pending', attempt: 0, reportDigest: null, evidenceDigest: null
    },
    outbox: [], completedCommands: [], processedEvents: [],
    reportDigestIndex: [], evidenceDigestIndex: [],
    pendingUsageRefs: [], pendingProjectionRefs: [], settledUsageDigest: null,
    committedProjectionDigests: [], continuationCheckpointDigest: null,
    drainSummary: {
      authorityCancelled: false, descendantsSignalled: false, descendantsForced: false,
      signalPendingDescendants: null, forceRequired: false,
      pendingDescendants: 0, interruptedCommandIds: []
    },
    recoverySummary: {
      required: false, reasonCode: null, uncertainCommandIds: [], resumePhase: null
    },
    counters: { transitionSequence: 1, eventsApplied: 1, commandsIssued: 0 },
    budgetSummary: null,
    auditHashHead: computeRunControllerAuditHead(ZERO_DIGEST, eventDigest, 1),
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt
  };
  const command = issueCommand(initial, 'fidelity.preflight', event.occurredAt, 1, [
    { name: 'requirements', digest: event.fidelityRequirementsDigest }
  ]);
  initial.processedEvents.push({
    eventId: event.eventId,
    eventDigest,
    transitionSequence: 1,
    priorAuditHash: ZERO_DIGEST,
    nextAuditHash: initial.auditHashHead,
    result: { code: 'applied', commandIds: [command.id] }
  });
  try {
    const parsed = parseRunControllerState(initial);
    if (runControllerCanonicalBytes(parsed) > RUN_CONTROLLER_LIMITS.normalOperationAggregateBytes) {
      return reject(undefined, 'resource-limit', 'Create exceeds normal-operation aggregate byte ceiling');
    }
    return success(parsed, 'applied', [command]);
  } catch (error) {
    const code = error instanceof RunControllerDataError ? error.code : 'invalid-state';
    return reject(undefined, code, error instanceof Error ? error.message : String(error));
  }
}

function reportIndex(state: MutableState, reportDigest: Digest, evidenceDigest: Digest): void {
  state.reportDigestIndex = sortedUnique([...state.reportDigestIndex, reportDigest]);
  state.evidenceDigestIndex = sortedUnique([...state.evidenceDigestIndex, evidenceDigest]);
}

function materialReportProof(completed: CompletedRunControllerCommand): ReportProof | null {
  if (completed.command.kind !== 'evidence.validate-preliminary-report' &&
      completed.command.kind !== 'evidence.validate-final-report') return null;
  const completion = completed.completionEvent;
  let proof: ReportProof | null = null;
  if (completion.type === 'preliminary-report-outcome' || completion.type === 'final-report-outcome') {
    proof = {
      kind: completion.type === 'preliminary-report-outcome'
        ? 'evidence.validate-preliminary-report' : 'evidence.validate-final-report',
      authority: completion.authority,
      classification: completion.classification,
      reportDigest: completion.reportDigest,
      evidenceDigest: completion.evidenceDigest,
      requestedDisposition: completion.requestedDisposition
    };
  } else if (completed.reconciliationEvent?.disposition === 'applied' &&
      (completed.proof?.kind === 'evidence.validate-preliminary-report' ||
       completed.proof?.kind === 'evidence.validate-final-report')) {
    proof = completed.proof;
  }
  return proof?.classification === 'exact-replay' ? null : proof;
}

function latestMaterialReportProof(
  state: Readonly<RunControllerState>,
  kind: ReportProof['kind'],
  reportDigest: Digest,
  excludedCommandId?: string
): ReportProof | null {
  let latest: ReportProof | null = null;
  let latestSequence = -1;
  for (const completed of state.completedCommands) {
    if (completed.command.id === excludedCommandId || completed.command.kind !== kind ||
        (state.terminalIntent !== null &&
         state.drainSummary.interruptedCommandIds.includes(completed.command.id) &&
         completed.reconciliationEvent !== null)) continue;
    const proof = materialReportProof(completed);
    if (proof?.kind !== kind || proof.reportDigest !== reportDigest) continue;
    const eventId = completed.reconciliationEvent?.eventId ?? completed.completionEventId;
    const sequence = state.processedEvents.find(event => event.eventId === eventId)?.transitionSequence ?? -1;
    if (sequence > latestSequence) {
      latest = proof;
      latestSequence = sequence;
    }
  }
  return latest;
}

function exactReplayFactsMatch(replay: ReportProof, material: ReportProof): boolean {
  return replay.kind === material.kind && replay.authority === material.authority &&
    replay.reportDigest === material.reportDigest && replay.evidenceDigest === material.evidenceDigest &&
    replay.requestedDisposition === material.requestedDisposition;
}

function publicStateForPhase(phase: RunControllerPhase): RunControllerState['publicState'] {
  if (phase === 'approval') return 'awaiting-approval';
  if (phase === 'preflight') return 'preparing';
  if (phase.startsWith('cancellation-')) return 'cancelling';
  if (['milestone-hold', 'supervised-checkpoint', 'host-paused', 'recovery-required'].includes(phase)) {
    return 'paused';
  }
  if (['completed', 'failed', 'cancelled'].includes(phase)) return phase as 'completed' | 'failed' | 'cancelled';
  return 'running';
}

function commandKindForPhase(phase: RunControllerPhase): RunControllerCommandKind | null {
  const kinds: Partial<Record<RunControllerPhase, RunControllerCommandKind>> = {
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
  return kinds[phase] ?? null;
}

function applyPreflightOutcome(
  state: MutableState,
  outcome: Pick<PreflightProof, 'fidelity' | 'requestedMode' | 'assessmentDigest'>,
  occurredAt: string,
  sequence: number,
  commands: RunControllerCommand[]
): void {
  state.fidelity = {
    ...state.fidelity,
    result: outcome.fidelity,
    assessmentDigest: outcome.assessmentDigest
  };
  state.requestedMode = outcome.requestedMode;
  if (outcome.fidelity === 'plan-only' || outcome.fidelity === 'unsupported') {
    terminalFailure(state, 'fidelity-insufficient');
    return;
  }
  if (!hasRunControllerNormalJournalCapacity(state)) {
    terminalFailure(state, 'effect-failed');
    return;
  }
  if (outcome.fidelity === 'supervised' && outcome.requestedMode === 'autonomous') {
    state.publicState = 'paused';
    state.phase = 'supervised-checkpoint';
    state.reasonCode = 'supervised-checkpoint';
    commands.push(issueCommand(state, 'checkpoint.persist', occurredAt, sequence, [
      { name: 'assessment', digest: outcome.assessmentDigest }
    ]));
    return;
  }
  state.publicState = 'awaiting-approval';
  state.phase = 'approval';
  state.reasonCode = 'awaiting-approval';
}

function applyReportOutcome(
  state: MutableState,
  proof: ReportProof,
  validationPhase: 'preliminary-report-validating' | 'final-report-validating',
  occurredAt: string,
  sequence: number,
  commands: RunControllerCommand[]
): void {
  reportIndex(state, proof.reportDigest, proof.evidenceDigest);
  state.execution.reportDigest = proof.reportDigest;
  state.execution.evidenceDigest = proof.evidenceDigest;
  if (proof.classification === 'rejected') {
    state.execution.state = 'failed';
    beginClosure(state, sequence, commands, occurredAt, 'failed',
      'report-rejected', proof.evidenceDigest);
    return;
  }
  if (proof.classification === 'quarantined') {
    state.publicState = 'paused';
    state.phase = 'report-resolution';
    state.reasonCode = 'report-quarantined';
    state.recoverySummary.resumePhase = validationPhase;
    commands.push(issueCommand(state, 'checkpoint.persist', occurredAt, sequence, [
      { name: 'report-evidence', digest: proof.evidenceDigest }
    ]));
    return;
  }
  if (proof.classification === 'valid-completion-blocked') {
    if (proof.kind === 'evidence.validate-final-report') {
      state.publicState = 'paused';
      state.phase = 'report-resolution';
      state.reasonCode = 'report-completion-blocked';
      state.recoverySummary.resumePhase = validationPhase;
      commands.push(issueCommand(state, 'checkpoint.persist', occurredAt, sequence, [
        { name: 'report-evidence', digest: proof.evidenceDigest }
      ]));
      return;
    }
    state.pendingUsageRefs = sortedUnique([...state.pendingUsageRefs, proof.evidenceDigest]);
    state.phase = 'usage-settling';
    issueNormalOrClose(state, 'authority.settle-usage', occurredAt, sequence, commands,
      proof.evidenceDigest, [
        { name: 'preliminary-evidence', digest: proof.evidenceDigest },
        { name: 'report', digest: proof.reportDigest }
      ]);
    return;
  }
  if (proof.classification === 'accepted' && proof.kind === 'evidence.validate-final-report') {
    state.execution.state = 'accepted';
    state.phase = 'milestone-integrating';
    issueNormalOrClose(state, 'integration.root-milestone', occurredAt, sequence, commands,
      proof.evidenceDigest);
    return;
  }
  throw new RunControllerDataError('invalid-event', 'Report classification is not legal for validation stage');
}

function handlePreflight(
  state: Readonly<RunControllerState>,
  event: Extract<RunControllerEvent, { type: 'preflight-result' }>,
  digest: Digest
): RunControllerTransitionResult {
  const replay = commandReplay(state, event);
  if (replay) return replay;
  const command = state.outbox[0]?.command;
  if (state.phase !== 'preflight' || command?.kind !== 'fidelity.preflight' || !bindingMatches(command, event)) {
    return reject(state, 'stale-observation', 'Preflight result does not bind active preflight command');
  }
  return apply(state, event, digest, (next, sequence, commands) => {
    finishCommand(next, event);
    applyPreflightOutcome(next, event, event.occurredAt, sequence, commands);
  });
}

function beginClosure(
  state: MutableState,
  sequence: number,
  commands: RunControllerCommand[],
  occurredAt: string,
  intent: 'completed' | 'failed' | 'cancelled',
  reasonCode: RunControllerState['reasonCode'],
  reasonDigest: Digest
): void {
  state.terminalIntent = intent;
  state.reasonCode = reasonCode;
  state.continuationCheckpointDigest = null;
  state.cancellationGeneration += 1;
  state.drainSummary = {
    authorityCancelled: false,
    descendantsSignalled: false,
    descendantsForced: false,
    signalPendingDescendants: null,
    forceRequired: false,
    pendingDescendants: 0,
    interruptedCommandIds: state.drainSummary.interruptedCommandIds
  };
  state.recoverySummary = {
    required: false, reasonCode: null, uncertainCommandIds: [], resumePhase: null
  };
  state.publicState = 'cancelling';
  state.phase = 'cancellation-authority';
  commands.push(issueCommand(state, 'authority.cancel', occurredAt, sequence, [
    { name: 'closure-reason', digest: reasonDigest }
  ]));
}

function continueCancellationAfterDrain(
  state: MutableState,
  occurredAt: string,
  sequence: number,
  commands: RunControllerCommand[]
): void {
  const unresolvedInterruptions = state.drainSummary.interruptedCommandIds.filter(
    (id: string) => state.completedCommands.some(
      (completed: CompletedRunControllerCommand) =>
        completed.command.id === id && completed.outcome === 'uncertain'
    )
  );
  if (unresolvedInterruptions.length > 0) {
    state.recoverySummary.uncertainCommandIds = unresolvedInterruptions;
    enterRecovery(state, 'recovery-required', 'cancellation-checkpoint');
    return;
  }
  state.phase = 'cancellation-checkpoint';
  commands.push(issueCommand(state, 'checkpoint.persist', occurredAt, sequence));
}

function terminalFailure(state: MutableState, reasonCode: RunControllerState['reasonCode']): void {
  state.terminalIntent = 'failed';
  state.publicState = 'failed';
  state.phase = 'failed';
  state.reasonCode = reasonCode;
  state.authorityInitialized = false;
  state.authorityAcquired = false;
  state.workstreamActive = false;
  state.controllerLeaseRefDigest = null;
  state.controllerLeaseFence = null;
  state.execution.workstreamLeaseRefDigest = null;
  state.execution.workstreamLeaseFence = null;
}

function issueNormalOrClose(
  state: MutableState,
  kind: RunControllerCommandKind,
  occurredAt: string,
  sequence: number,
  commands: RunControllerCommand[],
  reasonDigest: Digest,
  bindings: readonly Readonly<{ name: string; digest: Digest }>[] = []
): void {
  if (hasRunControllerNormalJournalCapacity(state)) {
    commands.push(issueCommand(state, kind, occurredAt, sequence, bindings));
  } else if (state.authorityInitialized || state.authorityAcquired || state.workstreamActive) {
    beginClosure(state, sequence, commands, occurredAt, 'failed', 'effect-failed', reasonDigest);
  } else {
    terminalFailure(state, 'effect-failed');
  }
}

function proofProblem(
  state: Readonly<RunControllerState>,
  command: RunControllerCommand,
  proof: RunControllerCommandCompletionProof | null,
  resultDigest: Digest
): string | null {
  if (proof === null || proof.kind !== command.kind) return 'Completion proof kind does not match command';
  switch (proof.kind) {
    case 'fidelity.preflight':
      return proof.assessmentDigest === resultDigest ? null : 'Preflight proof/result mismatch';
    case 'authority.acquire-controller':
      return proof.controllerEpoch === state.controllerEpoch + 1 ? null : 'Controller epoch proof mismatch';
    case 'authority.settle-usage':
      return state.pendingUsageRefs.length > 0 && proof.projectionDigests.length > 0 &&
        proof.budgetSummary.committed <= proof.budgetSummary.reserved
        ? null : 'Usage settlement proof is incomplete';
    case 'mediator.finalize-receipts':
      return state.pendingUsageRefs.length > 0 && state.pendingProjectionRefs.length > 0 &&
        proof.finalizedProjectionDigests.length > 0 &&
        resultDigest === computeRunControllerBindingDigest(
          'finalized-projections', proof.finalizedProjectionDigests
        )
        ? null : 'Finalized projection proof mismatch';
    case 'evidence.validate-preliminary-report':
    case 'evidence.validate-final-report':
      return proof.evidenceDigest === resultDigest ? null : 'Report proof/result mismatch';
    case 'integration.root-global-seal-verdict':
      return state.execution.state === 'accepted' && state.milestone.state === 'accepted' &&
        state.pendingUsageRefs.length === 0 && state.pendingProjectionRefs.length === 0 &&
        !state.recoverySummary.required
        ? null : 'Global verdict has unresolved controller facts';
    case 'checkpoint.persist':
      return proof.checkpointDigest === resultDigest ? null : 'Checkpoint proof/result mismatch';
    case 'authority.cancel':
      return proof.cancellationGeneration === state.cancellationGeneration
        ? null : 'Cancellation generation proof mismatch';
    case 'descendant.force':
      return state.drainSummary.forceRequired && state.drainSummary.pendingDescendants > 0
        ? null : 'Force proof arrived without positive signal count';
    default:
      return null;
  }
}

function reconciliationProofProblem(
  state: Readonly<RunControllerState>,
  target: CompletedRunControllerCommand,
  proof: RunControllerCommandCompletionProof | null,
  resultDigest: Digest,
  terminalInterruption: boolean
): string | null {
  if (proof === null || proof.kind !== target.command.kind) {
    return 'Completion proof kind does not match interrupted command';
  }
  if (proof.kind === 'evidence.validate-preliminary-report' ||
      proof.kind === 'evidence.validate-final-report') {
    const bindingName = proof.kind === 'evidence.validate-preliminary-report' ? 'report' : 'report-input';
    const expectedReportDigest = target.protectedPayload.bindings
      .find(binding => binding.name === bindingName)?.digest;
    if (proof.reportDigest !== expectedReportDigest) {
      return 'Recovered report digest does not match validation command input';
    }
    if (proof.evidenceDigest !== resultDigest) return 'Report proof/result mismatch';
    return null;
  }
  if (!terminalInterruption) return proofProblem(state, target.command, proof, resultDigest);
  if (proof.kind === 'fidelity.preflight' && proof.assessmentDigest !== resultDigest) {
    return 'Preflight proof/result mismatch';
  }
  if (proof.kind === 'mediator.finalize-receipts' &&
      resultDigest !== computeRunControllerBindingDigest(
        'finalized-projections', proof.finalizedProjectionDigests
      )) {
    return 'Finalized projection proof mismatch';
  }
  if (proof.kind === 'authority.cancel' &&
      proof.cancellationGeneration !== target.protectedPayload.cancellationGeneration) {
    return 'Cancellation generation proof mismatch';
  }
  return null;
}

function applySuccessfulCommand(
  state: MutableState,
  priorPhase: RunControllerPhase,
  command: RunControllerCommand,
  proof: RunControllerCommandCompletionProof,
  resultDigest: Digest,
  occurredAt: string,
  sequence: number,
  commands: RunControllerCommand[]
): void {
  switch (proof.kind) {
    case 'fidelity.preflight':
    case 'evidence.validate-preliminary-report':
    case 'evidence.validate-final-report':
      throw new Error('Typed command proof requires shared typed transition semantics');
    case 'authority.initialize':
      state.authorityInitialized = true;
      state.phase = 'controller-acquiring';
      issueNormalOrClose(state, 'authority.acquire-controller', occurredAt, sequence, commands, resultDigest, [
        { name: 'authority-state', digest: proof.authorityStateDigest }
      ]);
      return;
    case 'authority.acquire-controller':
      state.authorityAcquired = true;
      state.controllerEpoch = proof.controllerEpoch;
      state.controllerLeaseRefDigest = proof.controllerLeaseRefDigest;
      state.controllerLeaseFence = proof.leaseFence;
      state.phase = 'dispatch-ticket';
      issueNormalOrClose(state, 'authority.issue-eo-ticket', occurredAt, sequence, commands, resultDigest);
      return;
    case 'authority.issue-eo-ticket':
      state.execution.ticketRefDigest = proof.ticketRefDigest;
      state.phase = 'dispatch-spawn';
      issueNormalOrClose(state, 'mediator.spawn-eo', occurredAt, sequence, commands, resultDigest, [
        { name: 'ticket-ref', digest: proof.ticketRefDigest }
      ]);
      return;
    case 'mediator.spawn-eo':
      state.execution.spawnRefDigest = proof.spawnRefDigest;
      state.phase = 'dispatch-claim';
      issueNormalOrClose(state, 'authority.claim-workstream', occurredAt, sequence, commands, resultDigest, [
        { name: 'spawn-ref', digest: proof.spawnRefDigest },
        { name: 'ticket-ref', digest: state.execution.ticketRefDigest }
      ]);
      return;
    case 'authority.claim-workstream':
      state.workstreamActive = true;
      state.execution.workstreamLeaseRefDigest = proof.workstreamLeaseRefDigest;
      state.execution.workstreamLeaseFence = proof.leaseFence;
      state.execution.state = 'running';
      state.execution.attempt = command.attempt;
      state.milestone.state = 'running';
      state.milestone.attempt = 1;
      state.phase = 'eo-running';
      state.publicState = 'running';
      if (!hasRunControllerNormalJournalCapacity(state)) {
        beginClosure(state, sequence, commands, occurredAt, 'failed', 'effect-failed', resultDigest);
      }
      return;
    case 'authority.settle-usage':
      state.budgetSummary = proof.budgetSummary;
      state.settledUsageDigest = proof.settledUsageDigest;
      state.pendingProjectionRefs = sortedUnique([
        ...state.pendingProjectionRefs, ...proof.projectionDigests, proof.settledUsageDigest
      ]);
      state.phase = 'receipts-finalizing';
      issueNormalOrClose(state, 'mediator.finalize-receipts', occurredAt, sequence, commands, resultDigest);
      return;
    case 'mediator.finalize-receipts':
      state.committedProjectionDigests = sortedUnique([
        ...state.committedProjectionDigests, ...proof.finalizedProjectionDigests
      ]);
      state.evidenceDigestIndex = sortedUnique([
        ...state.evidenceDigestIndex, ...proof.finalizedProjectionDigests
      ]);
      state.pendingProjectionRefs = [];
      state.pendingUsageRefs = [];
      state.phase = 'final-report-validating';
      issueNormalOrClose(state, 'evidence.validate-final-report', occurredAt, sequence, commands, resultDigest);
      return;
    case 'integration.root-milestone':
      state.milestone.state = 'accepted';
      state.milestone.reportDigest = resultDigest;
      state.milestone.evidenceDigest = proof.evidenceDigest;
      if (state.mode === 'milestone') {
        state.publicState = 'paused';
        state.phase = 'milestone-hold';
        state.reasonCode = 'milestone-hold';
        commands.push(issueCommand(state, 'checkpoint.persist', occurredAt, sequence, [
          { name: 'milestone-evidence', digest: proof.evidenceDigest }
        ]));
      } else if (state.fidelity.result === 'exact') {
        state.phase = 'global-integrating';
        issueNormalOrClose(state, 'integration.root-global-seal-verdict', occurredAt, sequence,
          commands, resultDigest);
      } else {
        state.publicState = 'paused';
        state.phase = 'supervised-checkpoint';
        state.reasonCode = 'supervised-checkpoint';
        commands.push(issueCommand(state, 'checkpoint.persist', occurredAt, sequence, [
          { name: 'milestone-evidence', digest: proof.evidenceDigest }
        ]));
      }
      return;
    case 'integration.root-global-seal-verdict':
      state.globalIntegration.state = 'accepted';
      state.globalIntegration.attempt = command.attempt;
      state.globalIntegration.reportDigest = proof.verdictDigest;
      state.globalIntegration.evidenceDigest = resultDigest;
      beginClosure(state, sequence, commands, occurredAt, 'completed', null, proof.verdictDigest);
      return;
    case 'checkpoint.persist':
      if (priorPhase !== 'cancellation-checkpoint') {
        state.continuationCheckpointDigest = proof.checkpointDigest;
        return;
      }
      if (state.drainSummary.pendingDescendants !== 0 || state.recoverySummary.uncertainCommandIds.length !== 0) {
        throw new Error('Cancellation checkpoint cannot close unresolved state');
      }
      for (const runtime of [state.execution, state.milestone, state.globalIntegration]) {
        if (runtime.state === 'pending' || runtime.state === 'running') runtime.state = 'cancelled';
      }
      state.publicState = state.terminalIntent!;
      state.phase = state.terminalIntent!;
      if (state.terminalIntent !== 'failed') state.reasonCode = null;
      return;
    case 'authority.cancel':
      state.drainSummary.authorityCancelled = true;
      state.authorityInitialized = false;
      state.authorityAcquired = false;
      state.workstreamActive = false;
      state.controllerLeaseRefDigest = null;
      state.controllerLeaseFence = null;
      state.execution.workstreamLeaseRefDigest = null;
      state.execution.workstreamLeaseFence = null;
      if (state.terminalIntent !== 'completed') {
        for (const runtime of [state.execution, state.milestone, state.globalIntegration]) {
          if (runtime.state === 'pending' || runtime.state === 'running') runtime.state = 'cancelled';
        }
      }
      state.pendingUsageRefs = [];
      state.pendingProjectionRefs = [];
      state.phase = 'cancellation-signalling';
      commands.push(issueCommand(state, 'descendant.signal', occurredAt, sequence));
      return;
    case 'descendant.signal':
      state.drainSummary.descendantsSignalled = true;
      state.drainSummary.signalPendingDescendants = proof.pendingDescendants;
      state.drainSummary.pendingDescendants = proof.pendingDescendants;
      state.drainSummary.forceRequired = proof.pendingDescendants > 0;
      if (proof.pendingDescendants > 0) {
        state.phase = 'cancellation-forcing';
        commands.push(issueCommand(state, 'descendant.force', occurredAt, sequence));
      } else {
        continueCancellationAfterDrain(state, occurredAt, sequence, commands);
      }
      return;
    case 'descendant.force':
      state.drainSummary.descendantsForced = true;
      state.drainSummary.pendingDescendants = proof.pendingDescendants;
      if (proof.pendingDescendants > 0) {
        state.publicState = 'paused';
        state.phase = 'host-paused';
        state.reasonCode = 'descendant-drain-incomplete';
        state.continuationCheckpointDigest = resultDigest;
        state.recoverySummary.resumePhase = 'cancellation-forcing';
      } else {
        continueCancellationAfterDrain(state, occurredAt, sequence, commands);
      }
      return;
  }
}

function failEffect(
  state: MutableState,
  event: RunControllerCommandCompletionEvent,
  resumePhase: RunControllerPhase,
  sequence: number,
  commands: RunControllerCommand[]
): void {
  const activeId = state.outbox[0]?.command.id;
  const commandKind = state.outbox[0]?.command.kind;
  finishCommand(state, event);
  if (event.outcome === 'uncertain' || (commandKind && CANCELLATION_COMMANDS.includes(commandKind))) {
    if (activeId) state.recoverySummary.uncertainCommandIds = sortedUnique([
      ...state.recoverySummary.uncertainCommandIds, activeId
    ]);
    enterRecovery(state, 'recovery-required', resumePhase);
    return;
  }
  if (state.execution.state === 'running') state.execution.state = 'failed';
  if (state.authorityInitialized || state.authorityAcquired || state.workstreamActive) {
    beginClosure(state, sequence, commands, event.occurredAt, 'failed', 'effect-failed', event.resultDigest);
  } else {
    terminalFailure(state, 'effect-failed');
  }
}

function handleCompletion(
  state: Readonly<RunControllerState>,
  event: RunControllerCommandCompletionEvent,
  digest: Digest
): RunControllerTransitionResult {
  const completed = state.completedCommands.find(item => item.command.id === event.commandId);
  if (completed) {
    if (completed.completionDigest === completionSignature(event)) return success(state, 'noop', []);
    return reject(state, 'command-completion-conflict',
      `Command ${event.commandId} already completed with different facts`);
  }
  const command = state.outbox[0]?.command;
  if (!command || command.id !== event.commandId) {
    return reject(state, 'stale-effect-completion', 'Completion does not target active command');
  }
  if (TYPED_OUTCOME_COMMANDS.includes(command.kind) && event.outcome === 'succeeded') {
    return reject(state, 'illegal-transition', `${command.kind} requires its typed outcome event`);
  }
  if (!bindingMatches(command, event)) {
    return apply(state, event, digest, next => {
      interruptCommand(next, event, event.resultDigest);
      enterRecovery(next, 'recovery-required', state.phase);
    });
  }
  if (event.outcome === 'succeeded') {
    const problem = proofProblem(state, command, event.proof, event.resultDigest);
    if (problem !== null) return reject(state, 'invalid-event', problem);
  }
  return apply(state, event, digest, (next, sequence, commands) => {
    if (event.outcome !== 'succeeded') {
      failEffect(next, event, state.phase, sequence, commands);
      return;
    }
    finishCommand(next, event);
    applySuccessfulCommand(next, state.phase, command, event.proof!, event.resultDigest,
      event.occurredAt, sequence, commands);
  });
}

function handleReport(
  state: Readonly<RunControllerState>,
  event: Extract<RunControllerEvent, { type: 'preliminary-report-outcome' | 'final-report-outcome' }>,
  digest: Digest
): RunControllerTransitionResult {
  const completed = state.completedCommands.find(item => item.command.id === event.commandId);
  const expectedKind = event.type === 'preliminary-report-outcome'
    ? 'evidence.validate-preliminary-report' : 'evidence.validate-final-report';
  if (completed?.command.kind === expectedKind) {
    const replay = commandReplay(state, event);
    if (replay) return replay;
  }
  const command = state.outbox[0]?.command;
  const eventProof: ReportProof = {
    kind: expectedKind,
    authority: event.authority,
    classification: event.classification,
    reportDigest: event.reportDigest,
    evidenceDigest: event.evidenceDigest,
    requestedDisposition: event.requestedDisposition
  };
  if (event.classification === 'exact-replay' && command?.kind !== expectedKind) {
    const material = latestMaterialReportProof(state, expectedKind, event.reportDigest);
    return material !== null && exactReplayFactsMatch(eventProof, material)
      ? success(state, 'noop', [])
      : reject(state, 'stale-observation',
        'Exact replay lacks identical same-kind material report facts');
  }
  if (command?.kind !== expectedKind || !bindingMatches(command, event)) {
    return reject(state, 'stale-observation', 'Report outcome does not bind active validation command');
  }
  const reportBindingName = expectedKind === 'evidence.validate-preliminary-report'
    ? 'report' : 'report-input';
  const expectedReportDigest = state.outbox[0].protectedPayload.bindings
    .find(binding => binding.name === reportBindingName)?.digest;
  if (event.reportDigest !== expectedReportDigest) {
    return reject(state, 'invalid-event', 'Report outcome digest does not match validation command input');
  }
  const semanticProof = event.classification === 'exact-replay'
    ? latestMaterialReportProof(state, expectedKind, event.reportDigest) : eventProof;
  if (semanticProof === null ||
      (event.classification === 'exact-replay' && !exactReplayFactsMatch(eventProof, semanticProof))) {
    return reject(state, 'invalid-event', 'Exact replay facts lack an identical same-kind material report');
  }
  if (event.type === 'preliminary-report-outcome' && event.classification === 'accepted') {
    return reject(state, 'illegal-transition', 'Preliminary report cannot directly accept execution');
  }
  return apply(state, event, digest, (next, sequence, commands) => {
    finishCommand(next, event);
    applyReportOutcome(next, semanticProof,
      state.phase as 'preliminary-report-validating' | 'final-report-validating',
      event.occurredAt, sequence, commands);
  });
}

function allowedAtNormalJournalLimit(
  state: Readonly<RunControllerState>,
  event: Readonly<RunControllerEvent>
): boolean {
  if (event.type === 'cancel' || event.type === 'recovery') return true;
  if (event.type === 'trusted-continuation') {
    const resume = state.recoverySummary.resumePhase;
    return state.terminalIntent !== null &&
      (state.phase === 'host-paused' || state.phase === 'report-resolution') &&
      resume !== null &&
      (resume.startsWith('cancellation-') || resume === 'recovery-required') &&
      state.continuationCheckpointDigest !== null &&
      event.checkpointDigest === state.continuationCheckpointDigest;
  }
  if (event.type !== 'command-completion' && event.type !== 'preflight-result' &&
      event.type !== 'preliminary-report-outcome' && event.type !== 'final-report-outcome') return false;
  return state.outbox[0]?.command.id === event.commandId;
}

/** Pure transition core. It performs no clock, I/O, provider, process, or adapter calls. */
export function reduceRunController(
  stateValue: unknown | undefined,
  eventValue: unknown
): RunControllerTransitionResult {
  let state: Readonly<RunControllerState> | undefined;
  try {
    state = stateValue === undefined ? undefined : parseRunControllerState(stateValue);
  } catch (error) {
    const data = error instanceof RunControllerDataError ? error : undefined;
    return reject(undefined, data?.code ?? 'invalid-state', error instanceof Error ? error.message : String(error));
  }
  let event: Readonly<RunControllerEvent>;
  try {
    event = parseRunControllerEvent(eventValue);
  } catch (error) {
    const data = error instanceof RunControllerDataError ? error : undefined;
    return reject(state, data?.code ?? 'invalid-event', error instanceof Error ? error.message : String(error));
  }
  const eventDigest = computeRunControllerEventDigest(event);
  if (!state) {
    return event.type === 'create' ? create(event, eventDigest) :
      reject(undefined, 'not-created', 'RunController must receive create first');
  }
  const prior = state.processedEvents.find(item => item.eventId === event.eventId);
  if (prior) {
    if (prior.eventDigest !== eventDigest) {
      return reject(state, 'event-id-conflict', `Event ID ${event.eventId} has different content`);
    }
    const commands = prior.result.commandIds.flatMap(id => {
      const pending = state!.outbox.find(item => item.command.id === id)?.command;
      return pending ?? [];
    });
    return success(state, prior.result.code, commands as RunControllerCommand[]);
  }
  if (event.type === 'create') return reject(state, 'already-created', 'RunController already exists');
  if (Date.parse(event.occurredAt) < Date.parse(state.updatedAt)) {
    return reject(state, 'stale-observation', 'Event timestamp predates current aggregate');
  }
  if (['completed', 'failed', 'cancelled'].includes(state.publicState)) {
    return reject(state, 'terminal-immutable', `Terminal state ${state.publicState} is immutable`);
  }
  if (!hasRunControllerNormalJournalCapacity(state) && !allowedAtNormalJournalLimit(state, event)) {
    return reject(state, 'resource-limit', 'Normal journal capacity reserved for safe closure');
  }

  switch (event.type) {
    case 'preflight-result':
      return handlePreflight(state, event, eventDigest);
    case 'trusted-approval-mode-accepted':
      if (state.phase !== 'approval' || state.mode !== 'unselected' ||
          state.requestedMode !== event.mode || state.outbox.length !== 0) {
        return reject(state, 'illegal-transition', 'Approval/mode event is not legal in current phase');
      }
      return apply(state, event, eventDigest, (next, sequence, commands) => {
        next.mode = event.mode;
        next.approvalDigests = { approval: event.approvalDigest, modeSelection: event.modeSelectionDigest };
        next.publicState = 'running';
        next.phase = 'authority-initializing';
        next.reasonCode = null;
        commands.push(issueCommand(next, 'authority.initialize', event.occurredAt, sequence, [
          { name: 'approval', digest: event.approvalDigest },
          { name: 'mode-selection', digest: event.modeSelectionDigest }
        ]));
      });
    case 'drive':
      if (state.phase !== 'eo-running' || state.outbox.length !== 0 || event.inputDigest === null) {
        return reject(state, 'illegal-transition', 'Drive requires idle EO-running phase and report digest');
      }
      return apply(state, event, eventDigest, (next, sequence, commands) => {
        next.phase = 'preliminary-report-validating';
        next.pendingProjectionRefs = sortedUnique([...next.pendingProjectionRefs, event.inputDigest!]);
        commands.push(issueCommand(next, 'evidence.validate-preliminary-report', event.occurredAt, sequence, [
          { name: 'report', digest: event.inputDigest! }
        ]));
      });
    case 'command-completion':
      return handleCompletion(state, event, eventDigest);
    case 'preliminary-report-outcome':
    case 'final-report-outcome':
      return handleReport(state, event, eventDigest);
    case 'pause':
      if (state.outbox.length !== 0 || state.publicState !== 'running') {
        return reject(state, 'illegal-transition', 'Pause requires running state without active command');
      }
      return apply(state, event, eventDigest, next => {
        next.recoverySummary.resumePhase = state.phase;
        next.continuationCheckpointDigest = event.checkpointDigest;
        next.publicState = 'paused';
        next.phase = 'host-paused';
        next.reasonCode = 'paused-by-host';
      });
    case 'trusted-continuation':
      if (state.outbox.length !== 0 ||
          !['supervised-checkpoint', 'milestone-hold', 'host-paused', 'report-resolution'].includes(state.phase) ||
          state.continuationCheckpointDigest === null ||
          event.checkpointDigest !== state.continuationCheckpointDigest) {
        return reject(state, 'illegal-transition', 'Trusted continuation requires completed checkpoint or host pause');
      }
      if ((state.phase === 'host-paused' || state.phase === 'report-resolution') &&
          state.recoverySummary.resumePhase === 'cancellation-forcing') {
        const forceAttempts = state.completedCommands
          .filter(completed => completed.command.kind === 'descendant.force')
          .reduce((highest, completed) => Math.max(highest, completed.command.attempt), 0);
        if (forceAttempts >= RUN_CONTROLLER_LIMITS.cancellationCommandAttempts) {
          return reject(state, 'resource-limit', 'Descendant force retry budget exhausted');
        }
      }
      return apply(state, event, eventDigest, (next, sequence, commands) => {
        next.continuationCheckpointDigest = null;
        if (state.phase === 'host-paused' || state.phase === 'report-resolution') {
          const resume = state.recoverySummary.resumePhase;
          if (resume === null) throw new Error('Host pause has no continuation phase');
          next.recoverySummary.resumePhase = null;
          next.phase = resume;
          next.publicState = publicStateForPhase(resume);
          next.reasonCode = next.publicState === 'cancelling' ? 'cancel-requested' : null;
          const retryKind = commandKindForPhase(resume);
          if (retryKind !== null) {
            const retryBindings = retryKind === 'evidence.validate-preliminary-report' &&
              next.execution.reportDigest !== null
              ? [{ name: 'report', digest: next.execution.reportDigest }] : [];
            commands.push(issueCommand(next, retryKind, event.occurredAt, sequence, retryBindings));
          }
        } else if (state.mode === 'unselected') {
          next.publicState = 'awaiting-approval';
          next.phase = 'approval';
          next.reasonCode = 'awaiting-approval';
        } else if (state.milestone.state === 'accepted' && state.globalIntegration.state === 'pending') {
          next.publicState = 'running';
          next.phase = 'global-integrating';
          next.reasonCode = null;
          commands.push(issueCommand(next, 'integration.root-global-seal-verdict', event.occurredAt, sequence));
        } else {
          throw new Error('No supervised continuation target');
        }
      });
    case 'cancel':
      if (state.terminalIntent !== null) return success(state, 'noop', []);
      return apply(state, event, eventDigest, (next, sequence, commands) => {
        const preexistingUncertainty = [...next.recoverySummary.uncertainCommandIds];
        interruptCommandForCancellation(next, event);
        next.drainSummary.interruptedCommandIds = sortedUnique([
          ...next.drainSummary.interruptedCommandIds,
          ...preexistingUncertainty
        ]);
        beginClosure(next, sequence, commands, event.occurredAt, 'cancelled',
          'cancel-requested', event.reasonDigest);
      });
    case 'recovery':
      if (state.phase !== 'recovery-required' || state.outbox.length !== 0 ||
          !state.recoverySummary.uncertainCommandIds.includes(event.targetCommandId)) {
        return reject(state, 'illegal-transition', 'Recovery event does not target uncertain command');
      }
      const target = state.completedCommands.find(item => item.command.id === event.targetCommandId);
      const cancellationCommand = target !== undefined && CANCELLATION_COMMANDS.includes(target.command.kind);
      if (!target || (target.outcome !== 'uncertain' && !(target.outcome === 'failed' && cancellationCommand))) {
        return reject(state, 'illegal-transition', 'Recovery target is not a recoverable completed command');
      }
      const terminalInterruption = state.terminalIntent !== null &&
        state.drainSummary.interruptedCommandIds.includes(target.command.id);
      const willIssueRetry = event.disposition === 'not-applied' && !terminalInterruption &&
        state.recoverySummary.uncertainCommandIds.length === 1;
      if (event.disposition === 'still-uncertain') return success(state, 'noop', []);
      if (event.disposition === 'not-applied' &&
          event.quiescenceDigest !== computeRunControllerQuiescenceDigest(target.command)) {
        return reject(state, 'invalid-event', 'Not-applied recovery lacks exact command quiescence proof');
      }
      if (willIssueRetry && cancellationCommand &&
          target.command.attempt >= RUN_CONTROLLER_LIMITS.cancellationCommandAttempts) {
        return reject(state, 'resource-limit', 'Cancellation command retry budget exhausted');
      }
      if (willIssueRetry && !hasRunControllerNormalJournalCapacity(state) && !cancellationCommand) {
        return reject(state, 'resource-limit', 'Normal recovery retry would consume closure reserve');
      }
      let exactReplayMaterial: ReportProof | null = null;
      if (event.disposition === 'applied') {
        if (target.outcome !== 'uncertain') {
          return reject(state, 'invalid-event', 'Known failed command cannot be reconciled as applied');
        }
        const problem = reconciliationProofProblem(
          state, target, event.proof, event.resultDigest!, terminalInterruption
        );
        if (problem !== null) return reject(state, 'invalid-event', problem);
        if (event.proof?.kind === 'evidence.validate-preliminary-report' &&
            event.proof.classification === 'accepted') {
          return reject(state, 'illegal-transition', 'Preliminary report cannot directly accept execution');
        }
        if ((event.proof?.kind === 'evidence.validate-preliminary-report' ||
             event.proof?.kind === 'evidence.validate-final-report') &&
            event.proof.classification === 'exact-replay') {
          exactReplayMaterial = latestMaterialReportProof(
            state, event.proof.kind, event.proof.reportDigest, target.command.id
          );
          if (exactReplayMaterial === null || !exactReplayFactsMatch(event.proof, exactReplayMaterial)) {
            return reject(state, 'invalid-event',
              'Exact replay facts lack an identical same-kind material report');
          }
        }
      }
      return apply(state, event, eventDigest, (next, sequence, commands) => {
        const completedIndex = next.completedCommands.findIndex(
          (item: CompletedRunControllerCommand) => item.command.id === event.targetCommandId
        );
        const proof = event.disposition === 'applied' ? event.proof : null;
        const recoveredOutcome = proof !== null &&
          (proof.kind === 'evidence.validate-preliminary-report' ||
           proof.kind === 'evidence.validate-final-report')
          ? proof.classification : 'succeeded';
        const reconciledCompletion = {
          ...next.completedCommands[completedIndex],
          reconciliationDigest: eventDigest,
          reconciliationEvent: event,
          outcome: event.disposition === 'applied' ? recoveredOutcome : 'not-applied',
          resultDigest: event.disposition === 'applied' ? event.resultDigest! : event.reconciliationDigest,
          proof,
          resultLeaseFence: proof !== null &&
            (proof.kind === 'authority.acquire-controller' ||
             proof.kind === 'authority.claim-workstream') ? proof.leaseFence : null,
          resultCount: proof !== null &&
            (proof.kind === 'descendant.signal' || proof.kind === 'descendant.force')
            ? proof.pendingDescendants : null
        };
        const reconciliationGrowth = runControllerCanonicalBytes(reconciledCompletion) -
          runControllerCanonicalBytes(next.completedCommands[completedIndex]);
        if (reconciliationGrowth > RUN_CONTROLLER_LIMITS.recoveryCompletionGrowthBytes) {
          throw new RunControllerDataError('resource-limit', 'Recovery completion growth exceeds closure reserve');
        }
        next.completedCommands[completedIndex] = reconciledCompletion;
        next.recoverySummary.uncertainCommandIds = next.recoverySummary.uncertainCommandIds
          .filter((id: string) => id !== event.targetCommandId);
        if (next.recoverySummary.uncertainCommandIds.length > 0) return;
        const resume = next.recoverySummary.resumePhase;
        if (resume === null) throw new Error('Recovery target has no resume phase');
        next.recoverySummary = {
          required: false, reasonCode: null, uncertainCommandIds: [], resumePhase: null
        };
        if (terminalInterruption) {
          next.publicState = 'cancelling';
          next.reasonCode = 'cancel-requested';
          continueCancellationAfterDrain(next, event.occurredAt, sequence, commands);
          return;
        }
        next.phase = resume;
        next.publicState = publicStateForPhase(resume);
        next.reasonCode = next.publicState === 'cancelling' ? 'cancel-requested' : null;
        if (event.disposition === 'not-applied') {
          const stageBindingNames = new Set(stageBindings(next, target.command.kind)
            .map(binding => binding.name));
          const extra = target.protectedPayload.bindings.filter(
            binding => binding.name !== 'plan' && binding.name !== 'graph' &&
              !stageBindingNames.has(binding.name)
          );
          commands.push(issueCommand(next, target.command.kind, event.occurredAt, sequence,
            extra, target.command.attempt + 1));
          return;
        }
        if (proof?.kind === 'fidelity.preflight') {
          if (resume !== 'preflight') throw new Error('Recovered preflight has wrong resume phase');
          applyPreflightOutcome(next, proof, event.occurredAt, sequence, commands);
          return;
        }
        if (proof?.kind === 'evidence.validate-preliminary-report' ||
            proof?.kind === 'evidence.validate-final-report') {
          const validationPhase = proof.kind === 'evidence.validate-preliminary-report'
            ? 'preliminary-report-validating' : 'final-report-validating';
          if (resume !== validationPhase) throw new Error('Recovered report has wrong resume phase');
          if (proof.classification === 'exact-replay') {
            if (exactReplayMaterial === null) throw new Error('Exact replay lacks material report');
            applyReportOutcome(next, exactReplayMaterial, validationPhase,
              event.occurredAt, sequence, commands);
            return;
          }
          applyReportOutcome(next, proof, validationPhase, event.occurredAt, sequence, commands);
          return;
        }
        applySuccessfulCommand(next, resume, target.command, event.proof!, event.resultDigest!,
          event.occurredAt, sequence, commands);
      });
  }
}

export function isRunControllerTerminal(state: Readonly<RunControllerState>): boolean {
  return state.publicState === 'completed' || state.publicState === 'failed' || state.publicState === 'cancelled';
}

export { canonicalRunControllerSnapshot };
