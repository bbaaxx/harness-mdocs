import * as publicAgents from '../../src/agents';
import {
  computeRunControllerCommandId,
  computeRunControllerAuditHead,
  computeRunControllerBindingDigest,
  computeRunControllerModelDigest,
  computeRunControllerPayloadDigest,
  computeRunControllerQuiescenceDigest,
  Digest,
  RunControllerCommandCompletionEvent,
  RunControllerCommandCompletionProof,
  RunControllerEvent,
  RunControllerState
} from '../../src/agents/run/controller/algebra';
import { compileRunModel } from '../../src/agents/run/controller/model';
import { projectRunController } from '../../src/agents/run/controller/projection';
import { reduceRunController } from '../../src/agents/run/controller/reducer';
import {
  hasRunControllerNormalJournalCapacity,
  parseRunControllerCommandCompletionProof,
  parseRunControllerState,
  runControllerCanonicalBytes,
  RUN_CONTROLLER_LIMITS
} from '../../src/agents/run/controller/schema';
import { compilePlanGraph } from '../../src/agents/run/compiler';

const digest = (hex: string): Digest => `sha256:${hex.repeat(64).slice(0, 64)}` as Digest;
const D = Array.from({ length: 16 }, (_, index) => digest(index.toString(16)));

function model() {
  return compileRunModel(compilePlanGraph({
    planKey: 'controller-core', planRevision: 1, objective: 'Test pure controller',
    scope: ['src/**'], outOfScope: [],
    milestones: [{
      key: 'core', dependsOn: [], criteria: ['complete'], verification: 'npm test',
      writeSet: ['src/**'], integrationCriteria: ['integrated'],
      workstreams: [{ key: 'runtime', criteria: ['works'], writeSet: ['src/**'], leaves: [] }]
    }],
    integrationCriteria: ['all'], regressionCriteria: ['none'],
    expectedSideEffects: ['writes'], policy: { ignored: 'free-form' },
    adapterRequirements: ['trusted'], pauseRules: ['uncertain'], failureRules: ['fail'],
    cancelRules: ['cancel'], completionRules: ['accepted']
  }));
}

let tick: number;
function at(): string {
  return `2026-09-14T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function createEvent(overrides: Record<string, unknown> = {}): RunControllerEvent {
  const compiled = model();
  return {
    type: 'create', eventId: 'event-create', occurredAt: at(), runId: 'run-1', projectId: 'project-1',
    model: compiled, modelDigest: computeRunControllerModelDigest(compiled),
    fidelityRequirementsDigest: D[1], ...overrides
  } as RunControllerEvent;
}

function applied(result: ReturnType<typeof reduceRunController>): Readonly<RunControllerState> {
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  return result.state;
}

function complete(
  state: Readonly<RunControllerState>,
  overrides: Partial<RunControllerCommandCompletionEvent> = {}
): { state: Readonly<RunControllerState>; event: RunControllerCommandCompletionEvent } {
  const command = state.outbox[0]?.command;
  if (!command) throw new Error('Expected active command');
  const defaultProof = (): RunControllerCommandCompletionProof => {
    switch (command.kind) {
      case 'authority.initialize':
        return { kind: command.kind, authorityStateDigest: D[5], authorityInitialized: true };
      case 'authority.acquire-controller':
        return { kind: command.kind, controllerLeaseRefDigest: D[6],
          controllerEpoch: state.controllerEpoch + 1, leaseFence: 11 };
      case 'authority.issue-eo-ticket':
        return { kind: command.kind, ticketRefDigest: D[7] };
      case 'mediator.spawn-eo':
        return { kind: command.kind, spawnRefDigest: D[8] };
      case 'authority.claim-workstream':
        return { kind: command.kind, workstreamLeaseRefDigest: D[9], leaseFence: 13 };
      case 'authority.settle-usage':
        return { kind: command.kind, settledUsageDigest: D[13], projectionDigests: [D[14]],
          budgetSummary: { trusted: true, reserved: 10, committed: 7, currency: 'USD' } };
      case 'mediator.finalize-receipts':
        return { kind: command.kind, finalizedProjectionDigests: [D[15]] };
      case 'integration.root-milestone':
        return { kind: command.kind, integrationAccepted: true, evidenceDigest: D[13] };
      case 'integration.root-global-seal-verdict':
        return { kind: command.kind, accepted: true, reportKind: 'goal-verdict/v1',
          verdictDigest: D[14], finalState: 'completed', unresolvedCount: 0, pendingCount: 0 };
      case 'checkpoint.persist':
        return { kind: command.kind, checkpointDigest: D[15] };
      case 'authority.cancel':
        return { kind: command.kind, authorityCancelled: true,
          cancellationGeneration: state.cancellationGeneration };
      case 'descendant.signal':
      case 'descendant.force':
        return { kind: command.kind, pendingDescendants: 0 };
      default:
        throw new Error(`No completion proof for ${command.kind}`);
    }
  };
  const outcome = overrides.outcome ?? 'succeeded';
  const proof = overrides.proof === undefined
    ? (outcome === 'succeeded' ? defaultProof() : null)
    : overrides.proof;
  const resultDigest = overrides.resultDigest ??
    (proof?.kind === 'mediator.finalize-receipts'
      ? computeRunControllerBindingDigest('finalized-projections', proof.finalizedProjectionDigests)
      : proof?.kind === 'checkpoint.persist' ? proof.checkpointDigest : D[(tick % 10) + 1]);
  const event: RunControllerCommandCompletionEvent = {
    type: 'command-completion', eventId: `event-complete-${tick}`, occurredAt: at(),
    commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
    leaseFence: command.expectedLeaseFence, attempt: command.attempt,
    outcome, resultDigest,
    proof,
    ...overrides
  };
  return { state: applied(reduceRunController(state, event)), event };
}

function preflight(
  state: Readonly<RunControllerState>,
  fidelity: 'exact' | 'supervised' | 'plan-only' | 'unsupported' = 'exact',
  requestedMode: 'milestone' | 'autonomous' = 'autonomous'
): Readonly<RunControllerState> {
  const command = state.outbox[0].command;
  return applied(reduceRunController(state, {
    type: 'preflight-result', eventId: `event-preflight-${fidelity}-${requestedMode}`, occurredAt: at(),
    commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
    leaseFence: command.expectedLeaseFence, attempt: command.attempt,
    fidelity, requestedMode, assessmentDigest: D[2]
  }));
}

function approve(state: Readonly<RunControllerState>, mode: 'milestone' | 'autonomous') {
  return applied(reduceRunController(state, {
    type: 'trusted-approval-mode-accepted', eventId: `event-approval-${mode}`, occurredAt: at(),
    mode, approvalDigest: D[3], modeSelectionDigest: D[4]
  }));
}

function dispatch(state: Readonly<RunControllerState>): Readonly<RunControllerState> {
  state = complete(state).state;
  state = complete(state).state;
  state = complete(state).state;
  state = complete(state).state;
  return complete(state).state;
}

function toFinalValidation(mode: 'milestone' | 'autonomous' = 'autonomous'):
Readonly<RunControllerState> {
  let state = applied(reduceRunController(undefined, createEvent()));
  state = approve(preflight(state, 'exact', mode), mode);
  state = dispatch(state);
  state = applied(reduceRunController(state, {
    type: 'drive', eventId: 'event-drive-report', occurredAt: at(), inputDigest: D[9]
  }));
  const preliminary = state.outbox[0].command;
  state = applied(reduceRunController(state, {
    type: 'preliminary-report-outcome', eventId: 'event-preliminary', occurredAt: at(),
    commandId: preliminary.id, controllerEpoch: preliminary.expectedControllerEpoch,
    leaseFence: preliminary.expectedLeaseFence, attempt: preliminary.attempt,
    authority: false, classification: 'valid-completion-blocked',
    reportDigest: D[9], evidenceDigest: D[10], requestedDisposition: 'complete'
  }));
  expect(state.outbox[0].command.kind).toBe('authority.settle-usage');
  state = complete(state).state;
  expect(state.outbox[0].command.kind).toBe('mediator.finalize-receipts');
  state = complete(state).state;
  expect(state.outbox[0].command.kind).toBe('evidence.validate-final-report');
  return state;
}

function acceptFinal(state: Readonly<RunControllerState>): Readonly<RunControllerState> {
  const command = state.outbox[0].command;
  return applied(reduceRunController(state, {
    type: 'final-report-outcome', eventId: 'event-final-report', occurredAt: at(),
    commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
    leaseFence: command.expectedLeaseFence, attempt: command.attempt,
    authority: false, classification: 'accepted', reportDigest: D[9], evidenceDigest: D[12],
    requestedDisposition: 'pause'
  }));
}

function retryQuarantinedFinal(): Readonly<RunControllerState> {
  let state = toFinalValidation();
  const command = state.outbox[0].command;
  state = applied(reduceRunController(state, {
    type: 'final-report-outcome', eventId: 'event-final-quarantine', occurredAt: at(),
    commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
    leaseFence: command.expectedLeaseFence, attempt: command.attempt,
    authority: false, classification: 'quarantined', reportDigest: D[9], evidenceDigest: D[12],
    requestedDisposition: 'pause'
  }));
  state = complete(state, {
    resultDigest: D[15], proof: { kind: 'checkpoint.persist', checkpointDigest: D[15] }
  }).state;
  return applied(reduceRunController(state, {
    type: 'trusted-continuation', eventId: 'continue-final-quarantine', occurredAt: at(),
    checkpointDigest: D[15]
  }));
}

function retryQuarantinedPreliminary(): Readonly<RunControllerState> {
  let state = applied(reduceRunController(undefined, createEvent()));
  state = dispatch(approve(preflight(state), 'autonomous'));
  state = applied(reduceRunController(state, {
    type: 'drive', eventId: 'preliminary-replay-drive', occurredAt: at(), inputDigest: D[9]
  }));
  const command = state.outbox[0].command;
  state = applied(reduceRunController(state, {
    type: 'preliminary-report-outcome', eventId: 'event-preliminary-quarantine', occurredAt: at(),
    commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
    leaseFence: command.expectedLeaseFence, attempt: command.attempt,
    authority: false, classification: 'quarantined', reportDigest: D[9], evidenceDigest: D[10],
    requestedDisposition: 'complete'
  }));
  state = complete(state, {
    resultDigest: D[15], proof: { kind: 'checkpoint.persist', checkpointDigest: D[15] }
  }).state;
  return applied(reduceRunController(state, {
    type: 'trusted-continuation', eventId: 'continue-preliminary-quarantine', occurredAt: at(),
    checkpointDigest: D[15]
  }));
}

function finishClosure(state: Readonly<RunControllerState>, signalled = 0): Readonly<RunControllerState> {
  state = complete(state).state;
  state = complete(state, {
    proof: { kind: 'descendant.signal', pendingDescendants: signalled }
  }).state;
  if (signalled > 0) {
    state = complete(state, {
      proof: { kind: 'descendant.force', pendingDescendants: 0 }
    }).state;
  }
  return complete(state).state;
}

function padProcessedEvents(
  state: Readonly<RunControllerState>,
  target: number
): Readonly<RunControllerState> {
  const padded: any = JSON.parse(JSON.stringify(state));
  while (padded.processedEvents.length < target) {
    const transitionSequence = padded.processedEvents.length + 1;
    const eventDigest = computeRunControllerBindingDigest('test-padding-event', { transitionSequence });
    const nextAuditHash = computeRunControllerAuditHead(
      padded.auditHashHead, eventDigest, transitionSequence
    );
    padded.processedEvents.push({
      eventId: `test-padding-event-${transitionSequence}`,
      eventDigest,
      transitionSequence,
      priorAuditHash: padded.auditHashHead,
      nextAuditHash,
      result: { code: 'applied', commandIds: [] }
    });
    padded.auditHashHead = nextAuditHash;
  }
  padded.counters.transitionSequence = target;
  padded.counters.eventsApplied = target;
  return parseRunControllerState(padded);
}

function padProcessedEventsToBytes(
  state: Readonly<RunControllerState>,
  targetBytes: number
): Readonly<RunControllerState> {
  let padded = state;
  while (runControllerCanonicalBytes(padded) < targetBytes) {
    padded = padProcessedEvents(padded, padded.processedEvents.length + 1);
  }
  return padded;
}

beforeEach(() => { tick = 0; });

describe('WP-230C1 pure RunController core', () => {
  test.each([
    ['unknown property', 'fidelity.preflight', {
      kind: 'fidelity.preflight', fidelity: 'exact', requestedMode: 'autonomous',
      assessmentDigest: D[1], extra: true
    }],
    ['omitted field', 'authority.initialize', {
      kind: 'authority.initialize', authorityStateDigest: D[1]
    }],
    ['wrong enum', 'fidelity.preflight', {
      kind: 'fidelity.preflight', fidelity: 'approximate', requestedMode: 'autonomous', assessmentDigest: D[1]
    }],
    ['malformed digest', 'authority.issue-eo-ticket', {
      kind: 'authority.issue-eo-ticket', ticketRefDigest: 'not-a-digest'
    }],
    ['malformed count', 'descendant.signal', {
      kind: 'descendant.signal', pendingDescendants: -1
    }],
    ['malformed budget', 'authority.settle-usage', {
      kind: 'authority.settle-usage', settledUsageDigest: D[1], projectionDigests: [D[2]],
      budgetSummary: { trusted: true, reserved: 1, committed: 2, currency: 'USD' }
    }],
    ['malformed projection array', 'mediator.finalize-receipts', {
      kind: 'mediator.finalize-receipts', finalizedProjectionDigests: [D[2], D[2]]
    }],
    ['wrong expected kind', 'authority.initialize', {
      kind: 'authority.issue-eo-ticket', ticketRefDigest: D[1]
    }]
  ] as const)('strict proof parser rejects %s', (_label, expectedKind, proof) => {
    expect(() => parseRunControllerCommandCompletionProof(proof, expectedKind)).toThrow();
  });

  test('strict proof parser returns a detached frozen canonical proof', () => {
    const proof = {
      kind: 'authority.issue-eo-ticket' as const,
      ticketRefDigest: D[1]
    };
    const parsed = parseRunControllerCommandCompletionProof(proof, proof.kind);
    expect(parsed).toEqual(proof);
    expect(parsed).not.toBe(proof);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test.each([
    ['aliased node ID', (value: any) => {
      value.model.milestones[0].integrationNodeId = value.model.milestones[0].milestoneId;
    }],
    ['noncanonical nodes', (value: any) => value.model.nodes.reverse()],
    ['noncanonical write set', (value: any) => { value.model.nodes[0].writeSet = ['z/**', 'a/**']; }],
    ['duplicate criteria', (value: any) => { value.model.nodes[0].localCriteria = ['x', 'x']; }],
    ['wrong role', (value: any) => {
      value.model.nodes.find((node: any) => node.ownerRole === 'EXECUTION').ownerRole = 'PLAN_ROOT';
    }],
    ['wrong type', (value: any) => {
      value.model.nodes.find((node: any) => node.ownerRole === 'EXECUTION').nodeType = 'integration';
    }],
    ['wrong report', (value: any) => {
      value.model.nodes.find((node: any) => node.nodeId === value.model.globalIntegrationNodeId)
        .expectedReportKind = 'execution-report/v1';
    }],
    ['forged policy', (value: any) => { value.model.controllerPolicy.onNodeFailure = 'continue'; }],
    ['forged profile', (value: any) => { value.model.profileId = 'other/v1'; }]
  ])('rejects %s first-profile model even with recomputed integrity digest', (_name, mutate) => {
    const event: any = JSON.parse(JSON.stringify(createEvent()));
    mutate(event);
    event.modelDigest = computeRunControllerModelDigest(event.model);
    expect(reduceRunController(undefined, event)).toMatchObject({ ok: false, code: 'invalid-event' });
  });

  test('rejects wrong create digest and stored model tamper', () => {
    expect(reduceRunController(undefined, { ...createEvent(), modelDigest: D[15] }))
      .toMatchObject({ ok: false, code: 'invalid-event' });
    const state: any = JSON.parse(JSON.stringify(applied(reduceRunController(undefined, createEvent()))));
    state.model.planKey = 'tampered';
    expect(() => parseRunControllerState(state)).toThrow(/Model digest mismatch/);
  });

  test('creates deterministic detached frozen preflight intent before completion', () => {
    const source = createEvent({ model: JSON.parse(JSON.stringify(model())) }) as any;
    const first = reduceRunController(undefined, source);
    tick = 0;
    const second = reduceRunController(undefined, createEvent());
    expect(first).toEqual(second);
    if (!first.ok || !second.ok) throw new Error('Expected create');
    expect(first.state).not.toBe(source);
    expect(first.state.publicState).toBe('preparing');
    expect(first.state.phase).toBe('preflight');
    expect(first.commands).toEqual([first.state.outbox[0].command]);
    expect(first.commands[0].kind).toBe('fidelity.preflight');
    expect(Object.isFrozen(first.state)).toBe(true);
    expect(Object.isFrozen(first.state.model.nodes[0].writeSet)).toBe(true);
    source.model.nodes[0].writeSet[0] = 'hostile/**';
    expect(first.state.model.nodes[0].writeSet).not.toContain('hostile/**');
    expect(first.state.model.controllerPolicy).toEqual({
      milestoneSelection: 'first-eligible', onUncertainty: 'pause', onUnexpectedEvent: 'pause',
      onNodeFailure: 'fail-run', maxConcurrentMilestones: 1,
      maxConcurrentExecutionOrchestrators: 1, leafExecution: 'unsupported'
    });
  });

  test('matches deterministic command ID golden vector', () => {
    const input = {
      runId: 'run-1', projectId: 'project-1', controllerEpoch: 2, graphEpoch: 3, transitionSequence: 4,
      ordinal: 0, kind: 'authority.issue-eo-ticket', nodeId: 'node-1', attempt: 1,
      expectedLeaseFence: 5, payloadDigest: D[1]
    } as const;
    expect(computeRunControllerCommandId(input))
      .toBe('rcmd:566a71e702dcdc5701bbe090389a223da08ca2d978dda487a1706043c676a46b');
    expect(computeRunControllerCommandId({ ...input, expectedLeaseFence: 6 }))
      .not.toBe(computeRunControllerCommandId(input));
    expect(computeRunControllerCommandId({ ...input, projectId: 'project-2' }))
      .not.toBe(computeRunControllerCommandId(input));
    const payload = { bindings: [{ name: 'plan', digest: D[1] }], graphEpoch: 0, cancellationGeneration: 0 };
    expect(computeRunControllerPayloadDigest(payload)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('project binding prevents cross-project command completion', () => {
    tick = 0;
    const left = applied(reduceRunController(undefined, createEvent({ projectId: 'project-left' })));
    tick = 0;
    const right = applied(reduceRunController(undefined, createEvent({ projectId: 'project-right' })));
    expect(left.outbox[0].command.id).not.toBe(right.outbox[0].command.id);
    const command = right.outbox[0].command;
    const before = JSON.stringify(left);
    const forged = reduceRunController(left, {
      type: 'command-completion', eventId: 'cross-project-completion', occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      outcome: 'failed', resultDigest: D[5], proof: null
    });
    expect(forged).toMatchObject({ ok: false, code: 'stale-effect-completion' });
    expect(JSON.stringify((forged as any).state)).toBe(before);
  });

  test.each(['plan-only', 'unsupported'] as const)('%s preflight fails without effects', fidelity => {
    const created = applied(reduceRunController(undefined, createEvent()));
    const state = preflight(created, fidelity);
    expect(state).toMatchObject({ publicState: 'failed', phase: 'failed', reasonCode: 'fidelity-insufficient' });
    expect(state.outbox).toEqual([]);
  });

  test('supervised autonomous requires persisted checkpoint and trusted continuation', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = preflight(state, 'supervised', 'autonomous');
    expect(state).toMatchObject({ publicState: 'paused', phase: 'supervised-checkpoint' });
    expect(state.outbox[0].command.kind).toBe('checkpoint.persist');
    expect(reduceRunController(state, {
      type: 'trusted-continuation', eventId: 'too-early', occurredAt: at(), checkpointDigest: D[3]
    })).toMatchObject({ ok: false, code: 'illegal-transition' });
    state = complete(state, {
      resultDigest: D[3], proof: { kind: 'checkpoint.persist', checkpointDigest: D[3] }
    }).state;
    const before = JSON.stringify(state);
    expect(reduceRunController(state, {
      type: 'trusted-continuation', eventId: 'wrong-checkpoint', occurredAt: at(), checkpointDigest: D[4]
    })).toMatchObject({ ok: false, code: 'illegal-transition' });
    expect(JSON.stringify(state)).toBe(before);
    state = applied(reduceRunController(state, {
      type: 'trusted-continuation', eventId: 'continued', occurredAt: at(), checkpointDigest: D[3]
    }));
    expect(state).toMatchObject({ publicState: 'awaiting-approval', phase: 'approval' });
  });

  test('supervised milestone can await approval directly', () => {
    const created = applied(reduceRunController(undefined, createEvent()));
    const state = preflight(created, 'supervised', 'milestone');
    expect(state).toMatchObject({
      publicState: 'awaiting-approval', phase: 'approval', requestedMode: 'milestone'
    });
    expect(state.outbox).toEqual([]);
  });

  test('runs full autonomous exact trace and ignores requested report disposition', () => {
    let state = acceptFinal(toFinalValidation());
    expect(state.execution.state).toBe('accepted');
    expect(state.outbox[0].command.kind).toBe('integration.root-milestone');
    state = complete(state).state;
    expect(state.milestone.state).toBe('accepted');
    expect(state.outbox[0].command.kind).toBe('integration.root-global-seal-verdict');
    state = complete(state).state;
    expect(state).toMatchObject({ publicState: 'cancelling', terminalIntent: 'completed' });
    expect(state.outbox[0].command.kind).toBe('authority.cancel');
    state = complete(state).state;
    state = complete(state).state;
    const finalCompletion = complete(state);
    state = finalCompletion.state;
    expect(state).toMatchObject({ publicState: 'completed', phase: 'completed' });
    expect(state.globalIntegration.state).toBe('accepted');
    expect(state.outbox).toEqual([]);
    expect(state.pendingUsageRefs).toEqual([]);
    expect(state.pendingProjectionRefs).toEqual([]);
    expect(state.committedProjectionDigests).toEqual([D[15]]);
    expect(state.evidenceDigestIndex).toContain(D[15]);

    const replay = reduceRunController(state, finalCompletion.event);
    expect(replay).toMatchObject({ ok: true, code: 'applied', state });
    expect((replay as any).state).toEqual(state);
    expect(reduceRunController(state, { ...finalCompletion.event, eventId: 'late-different' }))
      .toMatchObject({ ok: false, code: 'terminal-immutable', state });
    expect(reduceRunController(state, {
      type: 'drive', eventId: 'terminal-drive', occurredAt: at(), inputDigest: D[1]
    })).toMatchObject({ ok: false, code: 'terminal-immutable' });
  });

  test('targets exact model nodes and selects controller versus workstream lease fences', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    expect(state.outbox[0].command).toMatchObject({ kind: 'fidelity.preflight', nodeId: null, expectedLeaseFence: null });
    state = approve(preflight(state), 'autonomous');
    expect(state.outbox[0].command).toMatchObject({ kind: 'authority.initialize', nodeId: null, expectedLeaseFence: null });
    state = complete(state).state;
    expect(state.outbox[0].command).toMatchObject({
      kind: 'authority.acquire-controller', nodeId: null, expectedLeaseFence: null
    });
    state = complete(state).state;
    for (const kind of ['authority.issue-eo-ticket', 'mediator.spawn-eo', 'authority.claim-workstream'] as const) {
      expect(state.outbox[0].command).toMatchObject({
        kind, nodeId: state.execution.nodeId, expectedLeaseFence: 11
      });
      state = complete(state).state;
    }
    state = applied(reduceRunController(state, {
      type: 'drive', eventId: 'scope-drive', occurredAt: at(), inputDigest: D[9]
    }));
    expect(state.outbox[0].command).toMatchObject({
      kind: 'evidence.validate-preliminary-report', nodeId: state.execution.nodeId,
      expectedLeaseFence: 13
    });
    const preliminary = state.outbox[0].command;
    state = applied(reduceRunController(state, {
      type: 'preliminary-report-outcome', eventId: 'scope-preliminary', occurredAt: at(),
      commandId: preliminary.id, controllerEpoch: preliminary.expectedControllerEpoch,
      leaseFence: preliminary.expectedLeaseFence, attempt: preliminary.attempt,
      authority: false, classification: 'valid-completion-blocked',
      reportDigest: D[9], evidenceDigest: D[10], requestedDisposition: null
    }));
    expect(state.outbox[0].command).toMatchObject({ kind: 'authority.settle-usage', expectedLeaseFence: 13 });
    state = complete(state).state;
    const projectionInputs = [...state.pendingProjectionRefs];
    expect(state.outbox[0].command).toMatchObject({ kind: 'mediator.finalize-receipts', expectedLeaseFence: 13 });
    state = complete(state).state;
    expect(projectionInputs).not.toContain(D[15]);
    expect(state.committedProjectionDigests).toEqual([D[15]]);
    expect(state.outbox[0].command).toMatchObject({
      kind: 'evidence.validate-final-report', expectedLeaseFence: 13
    });
    state = acceptFinal(state);
    expect(state.outbox[0].command).toMatchObject({
      kind: 'integration.root-milestone',
      nodeId: state.model.milestones[0].integrationNodeId,
      expectedLeaseFence: 11
    });
    expect(state.outbox[0].command.nodeId).not.toBe(state.milestone.nodeId);
    state = complete(state).state;
    expect(state.outbox[0].command).toMatchObject({
      kind: 'integration.root-global-seal-verdict',
      nodeId: state.model.globalIntegrationNodeId,
      expectedLeaseFence: 11
    });
  });

  test('stage command identity binds exact settlement, projection, report, and milestone outputs', () => {
    const beforeSettlement = (reportInput: Digest = D[9]): Readonly<RunControllerState> => {
      tick = 0;
      let state = applied(reduceRunController(undefined, createEvent()));
      state = dispatch(approve(preflight(state), 'autonomous'));
      state = applied(reduceRunController(state, {
        type: 'drive', eventId: 'stage-drive', occurredAt: at(), inputDigest: reportInput
      }));
      const preliminary = state.outbox[0].command;
      return applied(reduceRunController(state, {
        type: 'preliminary-report-outcome', eventId: 'stage-preliminary', occurredAt: at(),
        commandId: preliminary.id, controllerEpoch: preliminary.expectedControllerEpoch,
        leaseFence: preliminary.expectedLeaseFence, attempt: preliminary.attempt,
        authority: false, classification: 'valid-completion-blocked',
        reportDigest: reportInput, evidenceDigest: D[10], requestedDisposition: null
      }));
    };
    const afterSettlement = (
      settledUsageDigest: Digest, projectionDigests: Digest[], reportInput: Digest = D[9]
    ) => complete(beforeSettlement(reportInput), {
        resultDigest: D[5], proof: {
          kind: 'authority.settle-usage', settledUsageDigest, projectionDigests,
          budgetSummary: { trusted: true, reserved: 10, committed: 7, currency: 'USD' }
        }
      }).state;
    const receipt = afterSettlement(D[13], [D[14]]);
    expect(receipt.outbox[0].protectedPayload.bindings.map(binding => binding.name)).toEqual([
      'graph', 'pending-projection-inputs', 'plan', 'settled-usage'
    ]);
    expect(receipt.outbox[0].command.id)
      .not.toBe(afterSettlement(D[12], [D[14]]).outbox[0].command.id);
    expect(receipt.outbox[0].command.id)
      .not.toBe(afterSettlement(D[13], [D[15]]).outbox[0].command.id);

    const afterFinalization = (
      finalizedProjectionDigests: Digest[], reportInput: Digest = D[9]
    ) => complete(afterSettlement(D[13], [D[14]], reportInput), {
        proof: { kind: 'mediator.finalize-receipts', finalizedProjectionDigests },
        resultDigest: computeRunControllerBindingDigest('finalized-projections', finalizedProjectionDigests)
      }
    ).state;
    const finalValidation = afterFinalization([D[15]]);
    expect(finalValidation.outbox[0].protectedPayload.bindings.map(binding => binding.name)).toEqual([
      'committed-projections', 'graph', 'plan', 'report-input', 'settled-usage'
    ]);
    expect(finalValidation.outbox[0].command.id)
      .not.toBe(afterFinalization([D[14]]).outbox[0].command.id);

    const afterFinalReport = (reportInput: Digest, evidenceDigest: Digest) => {
      const state = afterFinalization([D[15]], reportInput);
      const command = state.outbox[0].command;
      return applied(reduceRunController(state, {
        type: 'final-report-outcome', eventId: 'stage-final-report', occurredAt: at(),
        commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
        leaseFence: command.expectedLeaseFence, attempt: command.attempt,
        authority: false, classification: 'accepted', reportDigest: reportInput, evidenceDigest,
        requestedDisposition: null
      }));
    };
    const milestone = afterFinalReport(D[9], D[12]);
    expect(milestone.outbox[0].protectedPayload.bindings.map(binding => binding.name)).toEqual([
      'budget-summary', 'committed-projections', 'eo-final-evidence', 'eo-final-report',
      'graph', 'plan', 'settled-usage'
    ]);
    expect(milestone.outbox[0].command.id)
      .not.toBe(afterFinalReport(D[10], D[12]).outbox[0].command.id);
    expect(milestone.outbox[0].command.id)
      .not.toBe(afterFinalReport(D[9], D[13]).outbox[0].command.id);

    const afterMilestone = (resultDigest: Digest, evidenceDigest: Digest) => complete(
      afterFinalReport(D[9], D[12]), {
        resultDigest,
        proof: { kind: 'integration.root-milestone', integrationAccepted: true, evidenceDigest }
      }
    ).state;
    const global = afterMilestone(D[6], D[13]);
    expect(global.outbox[0].protectedPayload.bindings.map(binding => binding.name)).toEqual([
      'budget-summary', 'committed-projections', 'graph', 'milestone-evidence',
      'milestone-report', 'plan', 'settled-usage'
    ]);
    expect(global.outbox[0].command.id)
      .not.toBe(afterMilestone(D[7], D[13]).outbox[0].command.id);
    expect(global.outbox[0].command.id)
      .not.toBe(afterMilestone(D[6], D[14]).outbox[0].command.id);
  });

  test('receipt finalization requires result digest bound to independently produced projections', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = dispatch(approve(preflight(state), 'autonomous'));
    state = applied(reduceRunController(state, {
      type: 'drive', eventId: 'projection-drive', occurredAt: at(), inputDigest: D[9]
    }));
    const preliminary = state.outbox[0].command;
    state = applied(reduceRunController(state, {
      type: 'preliminary-report-outcome', eventId: 'projection-preliminary', occurredAt: at(),
      commandId: preliminary.id, controllerEpoch: preliminary.expectedControllerEpoch,
      leaseFence: preliminary.expectedLeaseFence, attempt: preliminary.attempt,
      authority: false, classification: 'valid-completion-blocked',
      reportDigest: D[9], evidenceDigest: D[10], requestedDisposition: null
    }));
    state = complete(state).state;
    const command = state.outbox[0].command;
    const before = JSON.stringify(state);
    const rejected = reduceRunController(state, {
      type: 'command-completion', eventId: 'projection-wrong-result', occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      outcome: 'succeeded', resultDigest: D[1],
      proof: { kind: 'mediator.finalize-receipts', finalizedProjectionDigests: [D[15]] }
    });
    expect(rejected).toMatchObject({ ok: false, code: 'invalid-event' });
    expect((rejected as any).reason).toMatch(/Finalized projection proof mismatch/);
    expect(JSON.stringify((rejected as any).state)).toBe(before);
  });

  test('preliminary and final report outcomes cannot substitute command-bound report input', () => {
    let preliminaryState = applied(reduceRunController(undefined, createEvent()));
    preliminaryState = dispatch(approve(preflight(preliminaryState), 'autonomous'));
    preliminaryState = applied(reduceRunController(preliminaryState, {
      type: 'drive', eventId: 'bound-preliminary-drive', occurredAt: at(), inputDigest: D[9]
    }));
    const preliminary = preliminaryState.outbox[0].command;
    const beforePreliminary = JSON.stringify(preliminaryState);
    const preliminaryMismatch = reduceRunController(preliminaryState, {
      type: 'preliminary-report-outcome', eventId: 'bound-preliminary-mismatch', occurredAt: at(),
      commandId: preliminary.id, controllerEpoch: preliminary.expectedControllerEpoch,
      leaseFence: preliminary.expectedLeaseFence, attempt: preliminary.attempt,
      authority: false, classification: 'valid-completion-blocked',
      reportDigest: D[10], evidenceDigest: D[11], requestedDisposition: null
    });
    expect(preliminaryMismatch).toMatchObject({ ok: false, code: 'invalid-event' });
    expect(JSON.stringify((preliminaryMismatch as any).state)).toBe(beforePreliminary);

    const finalState = toFinalValidation();
    const final = finalState.outbox[0].command;
    const beforeFinal = JSON.stringify(finalState);
    const finalMismatch = reduceRunController(finalState, {
      type: 'final-report-outcome', eventId: 'bound-final-mismatch', occurredAt: at(),
      commandId: final.id, controllerEpoch: final.expectedControllerEpoch,
      leaseFence: final.expectedLeaseFence, attempt: final.attempt,
      authority: false, classification: 'accepted', reportDigest: D[11], evidenceDigest: D[12],
      requestedDisposition: null
    });
    expect(finalMismatch).toMatchObject({ ok: false, code: 'invalid-event' });
    expect(JSON.stringify((finalMismatch as any).state)).toBe(beforeFinal);
  });

  test('milestone mode stops at durable milestone hold bound to checkpoint proof', () => {
    let state = acceptFinal(toFinalValidation('milestone'));
    state = complete(state).state;
    expect(state).toMatchObject({ publicState: 'paused', phase: 'milestone-hold', reasonCode: 'milestone-hold' });
    expect(state.outbox[0].command.kind).toBe('checkpoint.persist');
    const checkpointCommand = state.outbox[0].command;
    const beforeCheckpoint = JSON.stringify(state);
    const mismatchedProof = reduceRunController(state, {
      type: 'command-completion', eventId: 'milestone-bad-checkpoint-proof', occurredAt: at(),
      commandId: checkpointCommand.id, controllerEpoch: checkpointCommand.expectedControllerEpoch,
      leaseFence: checkpointCommand.expectedLeaseFence, attempt: checkpointCommand.attempt,
      outcome: 'succeeded', resultDigest: D[5],
      proof: { kind: 'checkpoint.persist', checkpointDigest: D[6] }
    });
    expect(mismatchedProof).toMatchObject({ ok: false, code: 'invalid-event' });
    expect(JSON.stringify((mismatchedProof as any).state)).toBe(beforeCheckpoint);
    state = complete(state, {
      resultDigest: D[6], proof: { kind: 'checkpoint.persist', checkpointDigest: D[6] }
    }).state;
    expect(state).toMatchObject({ publicState: 'paused', phase: 'milestone-hold' });
    expect(state.outbox).toEqual([]);
    const checkpoint = state.completedCommands.at(-1);
    expect(checkpoint).toMatchObject({
      command: { kind: 'checkpoint.persist' }, resultDigest: D[6],
      proof: { kind: 'checkpoint.persist', checkpointDigest: D[6] }
    });
    const tampered: any = JSON.parse(JSON.stringify(state));
    tampered.continuationCheckpointDigest = D[7];
    expect(() => parseRunControllerState(tampered)).toThrow(/Continuation checkpoint binding mismatch/);
    const before = JSON.stringify(state);
    expect(reduceRunController(state, {
      type: 'trusted-continuation', eventId: 'milestone-wrong-checkpoint', occurredAt: at(),
      checkpointDigest: D[7]
    })).toMatchObject({ ok: false, code: 'illegal-transition' });
    expect(JSON.stringify(state)).toBe(before);
    state = applied(reduceRunController(state, {
      type: 'trusted-continuation', eventId: 'milestone-continue', occurredAt: at(),
      checkpointDigest: D[6]
    }));
    expect(state.outbox[0].command.kind).toBe('integration.root-global-seal-verdict');
  });

  test.each([
    ['rejected', 'cancelling', 'report-rejected', 'cancellation-authority'],
    ['quarantined', 'paused', 'report-quarantined', 'report-resolution'],
    ['valid-completion-blocked', 'paused', 'report-completion-blocked', 'report-resolution']
  ] as const)('final report %s never accepts EO', (classification, publicState, reasonCode, phase) => {
    let state = toFinalValidation();
    const command = state.outbox[0].command;
    state = applied(reduceRunController(state, {
      type: 'final-report-outcome', eventId: `final-${classification}`, occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
    authority: false, classification, reportDigest: D[9], evidenceDigest: D[12],
      requestedDisposition: 'complete'
    }));
    expect(state.publicState).toBe(publicState);
    expect(state.phase).toBe(phase);
    expect(state.reasonCode).toBe(reasonCode);
    expect(state.execution.state).not.toBe('accepted');
    expect(state.outbox.map(item => item.command.kind)).toEqual(
      classification === 'rejected' ? ['authority.cancel'] : ['checkpoint.persist']
    );
  });

  test('inactive cross-kind exact replay rejects byte-identically', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = dispatch(approve(preflight(state), 'autonomous'));
    state = applied(reduceRunController(state, {
      type: 'drive', eventId: 'inactive-replay-drive', occurredAt: at(), inputDigest: D[9]
    }));
    const validation = state.outbox[0].command;
    state = applied(reduceRunController(state, {
      type: 'preliminary-report-outcome', eventId: 'inactive-replay-preliminary', occurredAt: at(),
      commandId: validation.id, controllerEpoch: validation.expectedControllerEpoch,
      leaseFence: validation.expectedLeaseFence, attempt: validation.attempt,
      authority: false, classification: 'valid-completion-blocked',
      reportDigest: D[9], evidenceDigest: D[10], requestedDisposition: 'complete'
    }));
    const prior = state.completedCommands.find(completed =>
      completed.command.kind === 'evidence.validate-preliminary-report')!;
    const before = JSON.stringify(state);
    const result = reduceRunController(state, {
      type: 'final-report-outcome', eventId: 'exact-report-replay', occurredAt: at(),
      commandId: prior.command.id, controllerEpoch: prior.command.expectedControllerEpoch,
      leaseFence: prior.command.expectedLeaseFence, attempt: prior.command.attempt,
      authority: false, classification: 'exact-replay', reportDigest: D[9], evidenceDigest: D[10],
      requestedDisposition: 'complete'
    });
    expect(result).toMatchObject({ ok: false, code: 'stale-observation' });
    expect(JSON.stringify((result as any).state)).toBe(before);
  });

  test('inactive preliminary replay cannot acknowledge final material proof', () => {
    const state = acceptFinal(toFinalValidation());
    const active = state.outbox[0].command;
    const before = JSON.stringify(state);
    const result = reduceRunController(state, {
      type: 'preliminary-report-outcome', eventId: 'cross-kind-preliminary-replay', occurredAt: at(),
      commandId: active.id, controllerEpoch: active.expectedControllerEpoch,
      leaseFence: active.expectedLeaseFence, attempt: active.attempt,
      authority: false, classification: 'exact-replay', reportDigest: D[9], evidenceDigest: D[12],
      requestedDisposition: 'pause'
    });
    expect(result).toMatchObject({ ok: false, code: 'stale-observation' });
    expect(JSON.stringify((result as any).state)).toBe(before);
  });

  test('inactive same-kind exact replay with identical material facts is an observational no-op', () => {
    const state = acceptFinal(toFinalValidation());
    const active = state.outbox[0].command;
    const before = JSON.stringify(state);
    const result = reduceRunController(state, {
      type: 'final-report-outcome', eventId: 'inactive-same-kind-replay', occurredAt: at(),
      commandId: active.id, controllerEpoch: active.expectedControllerEpoch,
      leaseFence: active.expectedLeaseFence, attempt: active.attempt,
      authority: false, classification: 'exact-replay', reportDigest: D[9], evidenceDigest: D[12],
      requestedDisposition: 'pause'
    });
    expect(result).toMatchObject({ ok: true, code: 'noop' });
    expect(JSON.stringify((result as any).state)).toBe(before);
  });

  test.each([
    ['evidence', D[10], 'pause'],
    ['disposition', D[12], 'complete']
  ] as const)('inactive exact replay with mismatched %s rejects byte-identically',
    (_label, evidenceDigest, requestedDisposition) => {
      const state = acceptFinal(toFinalValidation());
      const active = state.outbox[0].command;
      const before = JSON.stringify(state);
      const result = reduceRunController(state, {
        type: 'final-report-outcome', eventId: `inactive-replay-mismatch-${_label}`, occurredAt: at(),
        commandId: active.id, controllerEpoch: active.expectedControllerEpoch,
        leaseFence: active.expectedLeaseFence, attempt: active.attempt,
        authority: false, classification: 'exact-replay', reportDigest: D[9], evidenceDigest,
        requestedDisposition
      });
      expect(result).toMatchObject({ ok: false, code: 'stale-observation' });
      expect(JSON.stringify((result as any).state)).toBe(before);
    });

  test('active exact replay without same-kind material proof rejects without mutation', () => {
    const state = toFinalValidation();
    const before = JSON.stringify(state);
    const command = state.outbox[0].command;
    const result = reduceRunController(state, {
      type: 'final-report-outcome', eventId: 'exact-report-without-final-proof', occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      authority: false, classification: 'exact-replay', reportDigest: D[9], evidenceDigest: D[10],
      requestedDisposition: 'complete'
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid-event' });
    expect(JSON.stringify((result as any).state)).toBe(before);
  });

  test('active exact replay consumes command using same-kind material semantics', () => {
    let state = retryQuarantinedFinal();
    const command = state.outbox[0].command;
    const reportsBefore = [...state.reportDigestIndex];
    const evidenceBefore = [...state.evidenceDigestIndex];
    state = applied(reduceRunController(state, {
      type: 'final-report-outcome', eventId: 'active-final-exact-replay', occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      authority: false, classification: 'exact-replay', reportDigest: D[9], evidenceDigest: D[12],
      requestedDisposition: 'pause'
    }));
    expect(state).toMatchObject({ publicState: 'paused', phase: 'report-resolution' });
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0].command.kind).toBe('checkpoint.persist');
    expect(state.reportDigestIndex).toEqual(reportsBefore);
    expect(state.evidenceDigestIndex).toEqual(evidenceBefore);
    expect(state.completedCommands.find(completed => completed.command.id === command.id))
      .toMatchObject({ outcome: 'exact-replay', completionEvent: { eventId: 'active-final-exact-replay' } });
  });

  test('active preliminary exact replay consumes validator and reapplies material semantics', () => {
    let state = retryQuarantinedPreliminary();
    const command = state.outbox[0].command;
    state = applied(reduceRunController(state, {
      type: 'preliminary-report-outcome', eventId: 'active-preliminary-exact-replay', occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      authority: false, classification: 'exact-replay', reportDigest: D[9], evidenceDigest: D[10],
      requestedDisposition: 'complete'
    }));
    expect(state).toMatchObject({ publicState: 'paused', phase: 'report-resolution' });
    expect(state.outbox[0].command.kind).toBe('checkpoint.persist');
    expect(state.completedCommands.find(completed => completed.command.id === command.id))
      .toMatchObject({ outcome: 'exact-replay' });
  });

  test('active exact replay with changed material facts rejects byte-identically', () => {
    const state = retryQuarantinedFinal();
    const command = state.outbox[0].command;
    const before = JSON.stringify(state);
    const result = reduceRunController(state, {
      type: 'final-report-outcome', eventId: 'active-final-exact-replay-mismatch', occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      authority: false, classification: 'exact-replay', reportDigest: D[9], evidenceDigest: D[10],
      requestedDisposition: 'pause'
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid-event' });
    expect(JSON.stringify((result as any).state)).toBe(before);
  });

  test.each([
    ['failed', 'failed'],
    ['uncertain', 'paused']
  ] as const)('%s effect completion cannot advance a node', (outcome, publicState) => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = approve(preflight(state), 'autonomous');
    state = complete(state, { outcome }).state;
    expect(state.publicState).toBe(publicState);
    expect(state.execution.state).toBe('pending');
    expect(state.outbox).toEqual([]);
  });

  test('host pause resumes exact prior idle phase only through trusted continuation', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = dispatch(approve(preflight(state), 'autonomous'));
    state = applied(reduceRunController(state, {
      type: 'pause', eventId: 'pause', occurredAt: at(), reasonDigest: D[1], checkpointDigest: D[2]
    }));
    expect(state).toMatchObject({ publicState: 'paused', phase: 'host-paused' });
    const before = JSON.stringify(state);
    expect(reduceRunController(state, {
      type: 'trusted-continuation', eventId: 'wrong-resume', occurredAt: at(), checkpointDigest: D[3]
    })).toMatchObject({ ok: false, code: 'illegal-transition' });
    expect(JSON.stringify(state)).toBe(before);
    state = applied(reduceRunController(state, {
      type: 'trusted-continuation', eventId: 'resume', occurredAt: at(), checkpointDigest: D[2]
    }));
    expect(state).toMatchObject({ publicState: 'running', phase: 'eo-running' });
    expect(state.outbox).toEqual([]);
  });

  test('event replay is counter-free and same ID with different digest conflicts', () => {
    const event = createEvent();
    const state = applied(reduceRunController(undefined, event));
    const replay = reduceRunController(state, event);
    expect(replay).toMatchObject({ ok: true, code: 'applied', state });
    expect((replay as any).state.counters).toEqual(state.counters);
    expect(reduceRunController(state, { ...event, occurredAt: at() }))
      .toMatchObject({ ok: false, code: 'event-id-conflict', state });
    const advanced = preflight(state);
    const oldReplay = reduceRunController(advanced, event);
    expect(oldReplay).toMatchObject({ ok: true, commands: [] });
  });

  test('stale effect completion pauses recovery-required while observational stale report does not mutate', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = approve(preflight(state), 'autonomous');
    const command = state.outbox[0].command;
    const stale = complete(state, { controllerEpoch: command.expectedControllerEpoch + 1 }).state;
    expect(stale).toMatchObject({ publicState: 'paused', phase: 'recovery-required' });
    expect(stale.outbox).toEqual([]);
    expect(stale.recoverySummary.uncertainCommandIds).toEqual([command.id]);

    const before = JSON.stringify(stale);
    const report = reduceRunController(stale, {
      type: 'final-report-outcome', eventId: 'stale-report', occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      authority: false, classification: 'accepted', reportDigest: D[8], evidenceDigest: D[9],
      requestedDisposition: null
    });
    expect(report).toMatchObject({ ok: false, code: 'stale-observation' });
    expect(JSON.stringify((report as any).state)).toBe(before);
  });

  test.each(['preliminary', 'final'] as const)(
    'recovered %s report proof cannot substitute command-bound report digest', stage => {
      let state: Readonly<RunControllerState>;
      if (stage === 'preliminary') {
        state = applied(reduceRunController(undefined, createEvent()));
        state = dispatch(approve(preflight(state), 'autonomous'));
        state = applied(reduceRunController(state, {
          type: 'drive', eventId: 'recovery-report-drive', occurredAt: at(), inputDigest: D[9]
        }));
      } else {
        state = toFinalValidation();
      }
      const target = state.outbox[0].command;
      state = complete(state, {
        outcome: 'uncertain', controllerEpoch: target.expectedControllerEpoch + 1
      }).state;
      const before = JSON.stringify(state);
      const result = reduceRunController(state, {
        type: 'recovery', eventId: `substituted-${stage}-report`, occurredAt: at(),
        targetCommandId: target.id, reconciliationDigest: D[6], disposition: 'applied', quiescenceDigest: null,
        resultDigest: D[12], proof: {
          kind: stage === 'preliminary'
            ? 'evidence.validate-preliminary-report' : 'evidence.validate-final-report',
          authority: false, classification: stage === 'preliminary'
            ? 'valid-completion-blocked' : 'accepted',
          reportDigest: D[10], evidenceDigest: D[12], requestedDisposition: null
        }
      });
      expect(result).toMatchObject({ ok: false, code: 'invalid-event' });
      expect(JSON.stringify((result as any).state)).toBe(before);
      const strict = reduceRunController(state, {
        type: 'recovery', eventId: `extra-${stage}-report-proof`, occurredAt: at(),
        targetCommandId: target.id, reconciliationDigest: D[7], disposition: 'applied', quiescenceDigest: null,
        resultDigest: D[12], proof: {
          kind: stage === 'preliminary'
            ? 'evidence.validate-preliminary-report' : 'evidence.validate-final-report',
          authority: false, classification: stage === 'preliminary'
            ? 'valid-completion-blocked' : 'accepted',
          reportDigest: D[9], evidenceDigest: D[12], requestedDisposition: null,
          unexpected: true
        }
      });
      expect(strict).toMatchObject({ ok: false, code: 'invalid-event' });
      expect(JSON.stringify((strict as any).state)).toBe(before);
      const wrongResult = reduceRunController(state, {
        type: 'recovery', eventId: `result-${stage}-report-proof`, occurredAt: at(),
        targetCommandId: target.id, reconciliationDigest: D[8], disposition: 'applied', quiescenceDigest: null,
        resultDigest: D[11], proof: {
          kind: stage === 'preliminary'
            ? 'evidence.validate-preliminary-report' : 'evidence.validate-final-report',
          authority: false, classification: stage === 'preliminary'
            ? 'valid-completion-blocked' : 'accepted',
          reportDigest: D[9], evidenceDigest: D[12], requestedDisposition: null
        }
      });
      expect(wrongResult).toMatchObject({ ok: false, code: 'invalid-event' });
      expect(JSON.stringify((wrongResult as any).state)).toBe(before);
    }
  );

  test.each([
    ['exact', 'autonomous', 'awaiting-approval', 'approval', null],
    ['supervised', 'milestone', 'awaiting-approval', 'approval', null],
    ['supervised', 'autonomous', 'paused', 'supervised-checkpoint', 'checkpoint.persist'],
    ['plan-only', 'autonomous', 'failed', 'failed', null],
    ['unsupported', 'autonomous', 'failed', 'failed', null]
  ] as const)(
    'applied preflight recovery preserves %s/%s semantics',
    (fidelity, requestedMode, publicState, phase, nextKind) => {
      let state = applied(reduceRunController(undefined, createEvent()));
      const target = state.outbox[0].command;
      const interruption = complete(state, {
        outcome: 'uncertain', controllerEpoch: target.expectedControllerEpoch + 1,
        resultDigest: D[5]
      });
      state = interruption.state;
      state = applied(reduceRunController(state, {
        type: 'recovery', eventId: `recover-preflight-${fidelity}-${requestedMode}`, occurredAt: at(),
        targetCommandId: target.id, reconciliationDigest: D[6], disposition: 'applied', quiescenceDigest: null,
        resultDigest: D[2], proof: {
          kind: 'fidelity.preflight', fidelity, requestedMode, assessmentDigest: D[2]
        }
      }));
      expect(state).toMatchObject({
        publicState, phase, requestedMode,
        fidelity: { result: fidelity, assessmentDigest: D[2] }
      });
      expect(state.outbox.map(entry => entry.command.kind)).toEqual(nextKind === null ? [] : [nextKind]);
      const completed = state.completedCommands.find(entry => entry.command.id === target.id)!;
      expect(completed.completionEvent).toEqual(interruption.event);
      expect(completed.completionEventId).toBe(interruption.event.eventId);
      expect(completed.reconciliationEvent).toMatchObject({
        type: 'recovery', disposition: 'applied', targetCommandId: target.id
      });
      expect(new Set(state.processedEvents.map(event => event.eventId)).size)
        .toBe(state.processedEvents.length);
    }
  );

  test.each([
    ['preliminary', 'rejected', 'cancelling', 'cancellation-authority', 'authority.cancel'],
    ['preliminary', 'quarantined', 'paused', 'report-resolution', 'checkpoint.persist'],
    ['preliminary', 'valid-completion-blocked', 'running', 'usage-settling', 'authority.settle-usage'],
    ['final', 'accepted', 'running', 'milestone-integrating', 'integration.root-milestone'],
    ['final', 'rejected', 'cancelling', 'cancellation-authority', 'authority.cancel'],
    ['final', 'quarantined', 'paused', 'report-resolution', 'checkpoint.persist'],
    ['final', 'valid-completion-blocked', 'paused', 'report-resolution', 'checkpoint.persist']
  ] as const)(
    'applied %s report recovery preserves %s semantics',
    (stage, classification, publicState, phase, nextKind) => {
      let state: Readonly<RunControllerState>;
      if (stage === 'preliminary') {
        state = applied(reduceRunController(undefined, createEvent()));
        state = dispatch(approve(preflight(state), 'autonomous'));
        state = applied(reduceRunController(state, {
          type: 'drive', eventId: `recover-${classification}-drive`, occurredAt: at(), inputDigest: D[9]
        }));
      } else {
        state = toFinalValidation();
      }
      const target = state.outbox[0].command;
      const interruption = complete(state, {
        outcome: 'uncertain', controllerEpoch: target.expectedControllerEpoch + 1,
        resultDigest: D[5]
      });
      state = interruption.state;
      state = applied(reduceRunController(state, {
        type: 'recovery', eventId: `recover-${stage}-${classification}`, occurredAt: at(),
        targetCommandId: target.id, reconciliationDigest: D[6], disposition: 'applied', quiescenceDigest: null,
        resultDigest: D[12], proof: {
          kind: stage === 'preliminary'
            ? 'evidence.validate-preliminary-report' : 'evidence.validate-final-report',
          authority: false, classification, reportDigest: D[9], evidenceDigest: D[12],
          requestedDisposition: 'complete'
        }
      }));
      expect(state).toMatchObject({ publicState, phase });
      expect(state.outbox[0].command.kind).toBe(nextKind);
      expect(state.reportDigestIndex).toContain(D[9]);
      expect(state.evidenceDigestIndex).toContain(D[12]);
      const completed = state.completedCommands.find(entry => entry.command.id === target.id)!;
      expect(completed).toMatchObject({
        outcome: classification, resultDigest: D[12],
        completionEvent: interruption.event,
        reconciliationEvent: { type: 'recovery', disposition: 'applied' },
        proof: { classification, reportDigest: D[9], evidenceDigest: D[12] }
      });
    }
  );

  test('applied final report recovery handles legal exact replay without material duplication', () => {
    let state = retryQuarantinedFinal();
    const target = state.outbox[0].command;
    const reportsBefore = [...state.reportDigestIndex];
    const evidenceBefore = [...state.evidenceDigestIndex];
    state = complete(state, {
      outcome: 'uncertain', controllerEpoch: target.expectedControllerEpoch + 1,
      resultDigest: D[5]
    }).state;
    state = applied(reduceRunController(state, {
      type: 'recovery', eventId: 'recover-final-exact-replay', occurredAt: at(),
      targetCommandId: target.id, reconciliationDigest: D[6], disposition: 'applied', quiescenceDigest: null,
      resultDigest: D[12], proof: {
        kind: 'evidence.validate-final-report', authority: false, classification: 'exact-replay',
        reportDigest: D[9], evidenceDigest: D[12], requestedDisposition: 'pause'
      }
    }));
    expect(state).toMatchObject({ publicState: 'paused', phase: 'report-resolution' });
    expect(state.outbox[0].command).toMatchObject({ kind: 'checkpoint.persist' });
    expect(state.reportDigestIndex).toEqual(reportsBefore);
    expect(state.evidenceDigestIndex).toEqual(evidenceBefore);
    expect(state.completedCommands.find(entry => entry.command.id === target.id))
      .toMatchObject({
        outcome: 'exact-replay', resultDigest: D[12],
        reconciliationEvent: { eventId: 'recover-final-exact-replay', disposition: 'applied' }
      });
  });

  test('applied recovery exact replay mismatch rejects byte-identically', () => {
    let state = retryQuarantinedFinal();
    const target = state.outbox[0].command;
    state = complete(state, {
      outcome: 'uncertain', controllerEpoch: target.expectedControllerEpoch + 1,
      resultDigest: D[5]
    }).state;
    const before = JSON.stringify(state);
    const result = reduceRunController(state, {
      type: 'recovery', eventId: 'recover-final-exact-replay-mismatch', occurredAt: at(),
      targetCommandId: target.id, reconciliationDigest: D[6], disposition: 'applied', quiescenceDigest: null,
      resultDigest: D[10], proof: {
        kind: 'evidence.validate-final-report', authority: false, classification: 'exact-replay',
        reportDigest: D[9], evidenceDigest: D[10], requestedDisposition: 'pause'
      }
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid-event' });
    expect(JSON.stringify((result as any).state)).toBe(before);
  });

  test.each(['preflight', 'preliminary-report'] as const)(
    'cancellation reconciliation of interrupted %s records proof without resuming workflow', kind => {
      let state = applied(reduceRunController(undefined, createEvent()));
      if (kind === 'preliminary-report') {
        state = dispatch(approve(preflight(state), 'autonomous'));
        state = applied(reduceRunController(state, {
          type: 'drive', eventId: 'cancel-typed-drive', occurredAt: at(), inputDigest: D[9]
        }));
      }
      const target = state.outbox[0].command;
      state = applied(reduceRunController(state, {
        type: 'cancel', eventId: `cancel-interrupted-${kind}`, occurredAt: at(), reasonDigest: D[1]
      }));
      state = complete(state).state;
      state = complete(state).state;
      expect(state.phase).toBe('recovery-required');
      const reportsBefore = [...state.reportDigestIndex];
      state = applied(reduceRunController(state, {
        type: 'recovery', eventId: `cancel-reconcile-${kind}`, occurredAt: at(),
        targetCommandId: target.id, reconciliationDigest: D[6], disposition: 'applied', quiescenceDigest: null,
        resultDigest: kind === 'preflight' ? D[2] : D[12],
        proof: kind === 'preflight' ? {
          kind: 'fidelity.preflight', fidelity: 'exact', requestedMode: 'autonomous', assessmentDigest: D[2]
        } : {
          kind: 'evidence.validate-preliminary-report', authority: false,
          classification: 'valid-completion-blocked', reportDigest: D[9], evidenceDigest: D[12],
          requestedDisposition: null
        }
      }));
      expect(state).toMatchObject({
        publicState: 'cancelling', phase: 'cancellation-checkpoint', terminalIntent: 'cancelled'
      });
      expect(state.outbox[0].command.kind).toBe('checkpoint.persist');
      expect(state.outbox.some(entry => ['authority.settle-usage', 'integration.root-milestone']
        .includes(entry.command.kind))).toBe(false);
      if (kind === 'preflight') {
        expect(state.fidelity).toMatchObject({ result: 'pending', assessmentDigest: null });
      } else {
        expect(state.reportDigestIndex).toEqual(reportsBefore);
        expect(state.execution.reportDigest).toBeNull();
      }
    }
  );

  test('targeted not-applied recovery emits fresh retry without replaying old command', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = approve(preflight(state), 'autonomous');
    const interrupted = state.outbox[0].command;
    state = complete(state, { controllerEpoch: interrupted.expectedControllerEpoch + 1 }).state;
    state = applied(reduceRunController(state, {
      type: 'recovery', eventId: 'recover', occurredAt: at(),
      targetCommandId: interrupted.id, reconciliationDigest: D[6],
      disposition: 'not-applied', quiescenceDigest: computeRunControllerQuiescenceDigest(interrupted),
      resultDigest: null, proof: null
    }));
    expect(state.outbox[0].command).toMatchObject({ kind: 'authority.initialize', attempt: 2 });
    expect(state.outbox[0].command.id).not.toBe(interrupted.id);
    expect(state.recoverySummary.uncertainCommandIds).toEqual([]);
    expect(state.completedCommands.find(completed => completed.command.id === interrupted.id))
      .toMatchObject({
        outcome: 'not-applied',
        reconciliationEvent: {
          disposition: 'not-applied',
          quiescenceDigest: computeRunControllerQuiescenceDigest(interrupted)
        }
      });
  });

  test.each([
    ['missing', (_command: any): Digest | null => null],
    ['random', (_command: any): Digest | null => D[15]],
    ['stale attempt', (command: any): Digest | null =>
      computeRunControllerQuiescenceDigest({ ...command, attempt: command.attempt + 1 })]
  ] as const)('not-applied recovery rejects %s quiescence proof byte-identically',
    (_label, digestFor) => {
      let state = applied(reduceRunController(undefined, createEvent()));
      state = approve(preflight(state), 'autonomous');
      const interrupted = state.outbox[0].command;
      state = complete(state, { controllerEpoch: interrupted.expectedControllerEpoch + 1 }).state;
      const before = JSON.stringify(state);
      const result = reduceRunController(state, {
        type: 'recovery', eventId: `invalid-quiescence-${_label}`, occurredAt: at(),
        targetCommandId: interrupted.id, reconciliationDigest: D[6], disposition: 'not-applied',
        quiescenceDigest: digestFor(interrupted), resultDigest: null, proof: null
      });
      expect(result).toMatchObject({ ok: false, code: 'invalid-event' });
      expect(JSON.stringify((result as any).state)).toBe(before);
    });

  test('preflight retry state binds fidelity to latest material success', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    const first = state.outbox[0].command;
    state = complete(state, { outcome: 'uncertain', resultDigest: D[5], proof: null }).state;
    state = applied(reduceRunController(state, {
      type: 'recovery', eventId: 'preflight-not-applied', occurredAt: at(),
      targetCommandId: first.id, reconciliationDigest: D[6],
      disposition: 'not-applied', quiescenceDigest: computeRunControllerQuiescenceDigest(first),
      resultDigest: null, proof: null
    }));
    expect(state.outbox[0].command).toMatchObject({ kind: 'fidelity.preflight', attempt: 2 });
    state = preflight(state, 'supervised', 'milestone');
    expect(() => parseRunControllerState(state)).not.toThrow();
    expect(state).toMatchObject({
      fidelity: { result: 'supervised', assessmentDigest: D[2] },
      requestedMode: 'milestone', publicState: 'awaiting-approval', phase: 'approval'
    });
    expect(state.completedCommands.map(item => [item.command.attempt, item.outcome]))
      .toEqual([[1, 'not-applied'], [2, 'succeeded']]);

    const staleAssessment: any = JSON.parse(JSON.stringify(state));
    staleAssessment.fidelity.assessmentDigest = D[6];
    expect(() => parseRunControllerState(staleAssessment))
      .toThrow(/Preflight state does not match completion history/);

    const staleAutonomy: any = JSON.parse(JSON.stringify(state));
    staleAutonomy.fidelity.result = 'exact';
    staleAutonomy.fidelity.assessmentDigest = D[6];
    staleAutonomy.requestedMode = 'autonomous';
    expect(() => parseRunControllerState(staleAutonomy))
      .toThrow(/Preflight state does not match completion history/);
  });

  test.each(['failed', 'uncertain'] as const)(
    '%s preflight without material success cannot authorize fidelity', outcome => {
      let state = applied(reduceRunController(undefined, createEvent()));
      state = complete(state, { outcome, resultDigest: D[5], proof: null }).state;
      expect(() => parseRunControllerState(state)).not.toThrow();
      const tampered: any = JSON.parse(JSON.stringify(state));
      tampered.fidelity.result = 'exact';
      tampered.fidelity.assessmentDigest = D[5];
      tampered.requestedMode = 'autonomous';
      expect(() => parseRunControllerState(tampered))
        .toThrow(/Preflight state does not match completion history/);
    }
  );

  test('targeted applied and still-uncertain recovery dispositions are command-bound', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = approve(preflight(state), 'autonomous');
    const interrupted = state.outbox[0].command;
    state = complete(state, { controllerEpoch: 99 }).state;
    const beforeStill = JSON.stringify(state);
    const stillResult = reduceRunController(state, {
      type: 'recovery', eventId: 'still', occurredAt: at(), targetCommandId: interrupted.id,
      reconciliationDigest: D[5], disposition: 'still-uncertain', quiescenceDigest: null,
      resultDigest: null, proof: null
    });
    expect(stillResult).toMatchObject({ ok: true, code: 'noop' });
    expect(JSON.stringify((stillResult as any).state)).toBe(beforeStill);
    const repeated = reduceRunController(state, {
      type: 'recovery', eventId: 'still-again', occurredAt: at(), targetCommandId: interrupted.id,
      reconciliationDigest: D[6], disposition: 'still-uncertain', quiescenceDigest: null,
      resultDigest: null, proof: null
    });
    expect(repeated).toMatchObject({ ok: true, code: 'noop' });
    expect(JSON.stringify((repeated as any).state)).toBe(beforeStill);
    const still = applied(stillResult);
    expect(still.recoverySummary.uncertainCommandIds).toEqual([interrupted.id]);
    state = applied(reduceRunController(still, {
      type: 'recovery', eventId: 'applied', occurredAt: at(), targetCommandId: interrupted.id,
      reconciliationDigest: D[6], disposition: 'applied', quiescenceDigest: null, resultDigest: D[7],
      proof: { kind: 'authority.initialize', authorityStateDigest: D[8], authorityInitialized: true }
    }));
    expect(state.authorityInitialized).toBe(true);
    expect(state.outbox[0].command.kind).toBe('authority.acquire-controller');
    expect(state.recoverySummary.uncertainCommandIds).toEqual([]);
    const tampered: any = JSON.parse(JSON.stringify(state));
    const reconciled = tampered.completedCommands.find(
      (item: any) => item.command.id === interrupted.id
    );
    reconciled.reconciliationEvent.proof.authorityStateDigest = D[15];
    expect(() => parseRunControllerState(tampered)).toThrow(/Recovery completion link mismatch/);
  });

  test('unknown completion with empty or unrelated outbox is stale and byte-identical', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = preflight(state);
    const unknown = `rcmd:${'f'.repeat(64)}`;
    const event = {
      type: 'command-completion', eventId: 'unknown', occurredAt: at(), commandId: unknown,
      controllerEpoch: 0, leaseFence: null, attempt: 1, outcome: 'failed', resultDigest: D[1], proof: null
    } as const;
    const before = JSON.stringify(state);
    expect(reduceRunController(state, event)).toMatchObject({ ok: false, code: 'stale-effect-completion' });
    expect(JSON.stringify((reduceRunController(state, event) as any).state)).toBe(before);

    state = approve(state, 'autonomous');
    const withOutbox = JSON.stringify(state);
    expect(reduceRunController(state, { ...event, eventId: 'unrelated', occurredAt: at() }))
      .toMatchObject({ ok: false, code: 'stale-effect-completion' });
    expect(JSON.stringify(state)).toBe(withOutbox);
  });

  test('successful command proof is mandatory, exact-kind, and byte-preserving on rejection', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = approve(preflight(state), 'autonomous');
    const command = state.outbox[0].command;
    const base = {
      type: 'command-completion', eventId: 'bad-proof', occurredAt: at(), commandId: command.id,
      controllerEpoch: command.expectedControllerEpoch, leaseFence: command.expectedLeaseFence,
      attempt: command.attempt, outcome: 'succeeded', resultDigest: D[5]
    } as const;
    const before = JSON.stringify(state);
    expect(reduceRunController(state, { ...base, proof: null }))
      .toMatchObject({ ok: false, code: 'invalid-event' });
    expect(reduceRunController(state, {
      ...base, eventId: 'wrong-proof', proof: { kind: 'checkpoint.persist', checkpointDigest: D[6] }
    })).toMatchObject({ ok: false, code: 'invalid-event' });
    expect(JSON.stringify(state)).toBe(before);
  });

  test.each([
    'fidelity.preflight',
    'evidence.validate-preliminary-report',
    'evidence.validate-final-report'
  ] as const)('generic success cannot complete typed command %s', kind => {
    let state = applied(reduceRunController(undefined, createEvent()));
    if (kind !== 'fidelity.preflight') {
      state = dispatch(approve(preflight(state), 'autonomous'));
      state = kind === 'evidence.validate-preliminary-report'
        ? applied(reduceRunController(state, {
          type: 'drive', eventId: `generic-success-${kind}-drive`, occurredAt: at(), inputDigest: D[9]
        }))
        : toFinalValidation();
    }
    const before = JSON.stringify(state);
    const command = state.outbox[0].command;
    const result = reduceRunController(state, {
      type: 'command-completion', eventId: `generic-success-${kind}`, occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      outcome: 'succeeded', resultDigest: D[5], proof: {
        kind: 'fidelity.preflight', fidelity: 'exact', requestedMode: 'autonomous', assessmentDigest: D[5]
      }
    });
    expect(result).toMatchObject({ ok: false, code: 'illegal-transition' });
    expect(JSON.stringify((result as any).state)).toBe(before);
  });

  test.each([
    ['fidelity.preflight', 'failed'],
    ['fidelity.preflight', 'uncertain'],
    ['evidence.validate-preliminary-report', 'failed'],
    ['evidence.validate-preliminary-report', 'uncertain'],
    ['evidence.validate-final-report', 'failed'],
    ['evidence.validate-final-report', 'uncertain']
  ] as const)('generic %s %s completion consumes exact-bound active command', (kind, outcome) => {
    let state = applied(reduceRunController(undefined, createEvent()));
    if (kind === 'evidence.validate-preliminary-report') {
      state = dispatch(approve(preflight(state), 'autonomous'));
      state = applied(reduceRunController(state, {
        type: 'drive', eventId: `generic-${kind}-${outcome}-drive`, occurredAt: at(), inputDigest: D[9]
      }));
    } else if (kind === 'evidence.validate-final-report') {
      state = toFinalValidation();
    }
    const target = state.outbox[0].command;
    expect(target.kind).toBe(kind);
    state = complete(state, { outcome, resultDigest: D[5], proof: null }).state;
    expect(state.completedCommands.find(item => item.command.id === target.id))
      .toMatchObject({ outcome, resultDigest: D[5], proof: null });
    if (outcome === 'uncertain') {
      expect(state).toMatchObject({ publicState: 'paused', phase: 'recovery-required' });
      expect(state.outbox).toEqual([]);
      expect(state.recoverySummary.uncertainCommandIds).toEqual([target.id]);
    } else if (kind === 'fidelity.preflight') {
      expect(state).toMatchObject({ publicState: 'failed', phase: 'failed', terminalIntent: 'failed' });
      expect(state.outbox).toEqual([]);
    } else {
      expect(state).toMatchObject({
        publicState: 'cancelling', phase: 'cancellation-authority', terminalIntent: 'failed'
      });
      expect(state.outbox[0].command.kind).toBe('authority.cancel');
    }
  });

  test('failure after authority initialization revokes and drains before terminal failed', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = approve(preflight(state), 'autonomous');
    state = complete(state).state;
    expect(state.authorityInitialized).toBe(true);
    state = complete(state, { outcome: 'failed' }).state;
    expect(state).toMatchObject({
      publicState: 'cancelling', phase: 'cancellation-authority', terminalIntent: 'failed'
    });
    expect(state.authorityInitialized).toBe(true);
    state = finishClosure(state);
    expect(state).toMatchObject({ publicState: 'failed', phase: 'failed', terminalIntent: 'failed' });
    expect(state.authorityInitialized).toBe(false);
    expect(state.authorityAcquired).toBe(false);
    expect(state.workstreamActive).toBe(false);
    expect(state.outbox).toEqual([]);
  });

  test('quarantined report uses trusted retry with fresh deterministic command', () => {
    let state = toFinalValidation();
    const first = state.outbox[0].command;
    state = applied(reduceRunController(state, {
      type: 'final-report-outcome', eventId: 'quarantine', occurredAt: at(),
      commandId: first.id, controllerEpoch: first.expectedControllerEpoch,
      leaseFence: first.expectedLeaseFence, attempt: first.attempt,
      authority: false, classification: 'quarantined', reportDigest: D[9], evidenceDigest: D[12],
      requestedDisposition: 'complete'
    }));
    expect(state).toMatchObject({ publicState: 'paused', phase: 'report-resolution' });
    expect(reduceRunController(state, {
      type: 'trusted-continuation', eventId: 'retry-before-checkpoint', occurredAt: at(), checkpointDigest: D[13]
    })).toMatchObject({ ok: false, code: 'illegal-transition' });
    state = complete(state, {
      resultDigest: D[13], proof: { kind: 'checkpoint.persist', checkpointDigest: D[13] }
    }).state;
    const before = JSON.stringify(state);
    expect(reduceRunController(state, {
      type: 'trusted-continuation', eventId: 'retry-wrong-checkpoint', occurredAt: at(), checkpointDigest: D[14]
    })).toMatchObject({ ok: false, code: 'illegal-transition' });
    expect(JSON.stringify(state)).toBe(before);
    state = applied(reduceRunController(state, {
      type: 'trusted-continuation', eventId: 'retry-report', occurredAt: at(), checkpointDigest: D[13]
    }));
    expect(state.outbox[0].command).toMatchObject({
      kind: 'evidence.validate-final-report', attempt: 2
    });
    expect(state.outbox[0].command.id).not.toBe(first.id);
  });

  test('unrelated or conflicting completed effect facts reject without interrupting active command', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = approve(preflight(state), 'autonomous');
    const first = complete(state);
    state = first.state;
    const newer = state.outbox[0].command;
    const before = JSON.stringify(state);
    const result = reduceRunController(state, {
      ...first.event, eventId: 'conflicting-completion', occurredAt: at(), resultDigest: D[15]
    });
    expect(result).toMatchObject({ ok: false, code: 'command-completion-conflict' });
    expect(JSON.stringify((result as any).state)).toBe(before);
    expect((result as any).state.outbox[0].command.id).toBe(newer.id);
  });

  test('cancellation orders authority revoke, signal, force, checkpoint, then terminal', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = dispatch(approve(preflight(state), 'autonomous'));
    state = applied(reduceRunController(state, {
      type: 'cancel', eventId: 'cancel', occurredAt: at(), reasonDigest: D[1]
    }));
    expect(state.outbox[0].command.kind).toBe('authority.cancel');
    state = complete(state).state;
    expect(state.outbox[0].command.kind).toBe('descendant.signal');
    state = complete(state, {
      proof: { kind: 'descendant.signal', pendingDescendants: 1 }
    }).state;
    expect(state.outbox[0].command.kind).toBe('descendant.force');
    state = complete(state, {
      proof: { kind: 'descendant.force', pendingDescendants: 0 }
    }).state;
    expect(state.outbox[0].command.kind).toBe('checkpoint.persist');
    state = complete(state).state;
    expect(state).toMatchObject({ publicState: 'cancelled', phase: 'cancelled' });
    expect(state.completedCommands.slice(-4).map(item => item.command.kind)).toEqual([
      'authority.cancel', 'descendant.signal', 'descendant.force', 'checkpoint.persist'
    ]);
  });

  test('successful incomplete descendant force retries stop at bounded fail-closed hold', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = dispatch(approve(preflight(state), 'autonomous'));
    state = applied(reduceRunController(state, {
      type: 'cancel', eventId: 'force-loop-cancel', occurredAt: at(), reasonDigest: D[1]
    }));
    state = complete(state).state;
    state = complete(state, {
      proof: { kind: 'descendant.signal', pendingDescendants: 1 }
    }).state;
    for (let attempt = 1; attempt <= RUN_CONTROLLER_LIMITS.cancellationCommandAttempts; attempt += 1) {
      expect(state.outbox[0].command).toMatchObject({ kind: 'descendant.force', attempt });
      state = complete(state, {
        resultDigest: D[attempt + 4],
        proof: { kind: 'descendant.force', pendingDescendants: 1 }
      }).state;
      expect(state).toMatchObject({
        publicState: 'paused', phase: 'host-paused', terminalIntent: 'cancelled',
        authorityInitialized: false, authorityAcquired: false,
        drainSummary: { pendingDescendants: 1 }
      });
      expect(state.outbox).toEqual([]);
      const checkpointDigest = state.continuationCheckpointDigest!;
      if (attempt < RUN_CONTROLLER_LIMITS.cancellationCommandAttempts) {
        state = applied(reduceRunController(state, {
          type: 'trusted-continuation', eventId: `force-loop-continue-${attempt}`,
          occurredAt: at(), checkpointDigest
        }));
      } else {
        const before = JSON.stringify(state);
        for (const eventId of ['force-loop-exhausted', 'force-loop-exhausted-again']) {
          const exhausted = reduceRunController(state, {
            type: 'trusted-continuation', eventId, occurredAt: at(), checkpointDigest
          });
          expect(exhausted).toMatchObject({ ok: false, code: 'resource-limit' });
          expect(JSON.stringify((exhausted as any).state)).toBe(before);
        }
      }
    }
    expect(state.publicState).not.toBe('cancelled');
    expect(state.phase).toBe('host-paused');
    expect(state.processedEvents.length).toBeLessThan(RUN_CONTROLLER_LIMITS.processedEvents);
    expect(state.completedCommands.length).toBeLessThan(RUN_CONTROLLER_LIMITS.completedCommands);
  });

  test('soft cap permits exact cancellation continuation but blocks normal continuation', () => {
    let closure = applied(reduceRunController(undefined, createEvent()));
    closure = dispatch(approve(preflight(closure), 'autonomous'));
    closure = applied(reduceRunController(closure, {
      type: 'cancel', eventId: 'soft-continuation-cancel', occurredAt: at(), reasonDigest: D[1]
    }));
    closure = complete(closure).state;
    closure = complete(closure, {
      proof: { kind: 'descendant.signal', pendingDescendants: 1 }
    }).state;
    closure = complete(closure, {
      resultDigest: D[6], proof: { kind: 'descendant.force', pendingDescendants: 1 }
    }).state;
    closure = padProcessedEvents(closure, RUN_CONTROLLER_LIMITS.normalOperationProcessedEvents);
    const closureBefore = JSON.stringify(closure);
    const wrongClosureDigest = reduceRunController(closure, {
      type: 'trusted-continuation', eventId: 'soft-continuation-wrong', occurredAt: at(),
      checkpointDigest: D[7]
    });
    expect(wrongClosureDigest).toMatchObject({ ok: false, code: 'resource-limit' });
    expect(JSON.stringify((wrongClosureDigest as any).state)).toBe(closureBefore);
    closure = applied(reduceRunController(closure, {
      type: 'trusted-continuation', eventId: 'soft-continuation-exact', occurredAt: at(),
      checkpointDigest: D[6]
    }));
    expect(closure.outbox[0].command).toMatchObject({ kind: 'descendant.force', attempt: 2 });

    let normal = acceptFinal(toFinalValidation('milestone'));
    normal = complete(normal).state;
    normal = complete(normal, {
      resultDigest: D[8], proof: { kind: 'checkpoint.persist', checkpointDigest: D[8] }
    }).state;
    normal = padProcessedEvents(normal, RUN_CONTROLLER_LIMITS.normalOperationProcessedEvents);
    const normalBefore = JSON.stringify(normal);
    const blocked = reduceRunController(normal, {
      type: 'trusted-continuation', eventId: 'soft-normal-continuation', occurredAt: at(),
      checkpointDigest: D[8]
    });
    expect(blocked).toMatchObject({ ok: false, code: 'resource-limit' });
    expect(JSON.stringify((blocked as any).state)).toBe(normalBefore);
  });

  test.each(['applied', 'not-applied'] as const)(
    'cancel during active effect reconciles %s interruption before checkpoint', disposition => {
      let state = applied(reduceRunController(undefined, createEvent()));
      state = approve(preflight(state), 'autonomous');
      const interrupted = state.outbox[0].command;
      state = applied(reduceRunController(state, {
        type: 'cancel', eventId: `active-cancel-${disposition}`, occurredAt: at(), reasonDigest: D[1]
      }));
      expect(state.drainSummary.interruptedCommandIds).toEqual([interrupted.id]);
      expect(state.recoverySummary.uncertainCommandIds).toEqual([]);
      expect(state.outbox[0].command.kind).toBe('authority.cancel');
      state = complete(state).state;
      state = complete(state).state;
      expect(state).toMatchObject({ publicState: 'paused', phase: 'recovery-required' });
      expect(state.outbox).toEqual([]);
      state = applied(reduceRunController(state, {
        type: 'recovery', eventId: `active-reconcile-${disposition}`, occurredAt: at(),
        targetCommandId: interrupted.id, reconciliationDigest: D[6], disposition,
        quiescenceDigest: disposition === 'not-applied'
          ? computeRunControllerQuiescenceDigest(interrupted) : null,
        resultDigest: disposition === 'applied' ? D[7] : null,
        proof: disposition === 'applied'
          ? { kind: 'authority.initialize', authorityStateDigest: D[8], authorityInitialized: true }
          : null
      }));
      expect(state.phase).toBe('cancellation-checkpoint');
      expect(state.outbox[0].command.kind).toBe('checkpoint.persist');
      expect(state.outbox.some(item => item.command.kind === 'authority.acquire-controller')).toBe(false);
      expect(state.recoverySummary.uncertainCommandIds).toEqual([]);
      state = complete(state).state;
      expect(state.publicState).toBe('cancelled');
    }
  );

  test('cancel interruption remains blocked for still-uncertain reconciliation', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = approve(preflight(state), 'autonomous');
    const interrupted = state.outbox[0].command;
    state = applied(reduceRunController(state, {
      type: 'cancel', eventId: 'active-cancel-still', occurredAt: at(), reasonDigest: D[1]
    }));
    state = complete(state).state;
    state = complete(state).state;
    state = applied(reduceRunController(state, {
      type: 'recovery', eventId: 'active-still', occurredAt: at(),
      targetCommandId: interrupted.id, reconciliationDigest: D[6],
      disposition: 'still-uncertain', quiescenceDigest: null, resultDigest: null, proof: null
    }));
    expect(state).toMatchObject({ publicState: 'paused', phase: 'recovery-required' });
    expect(state.recoverySummary.uncertainCommandIds).toEqual([interrupted.id]);
    expect(state.outbox).toEqual([]);
  });

  test('terminal not-applied clears max-attempt interrupted checkpoint and continues closure', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = preflight(state, 'supervised', 'autonomous');
    for (let attempt = 1; attempt < RUN_CONTROLLER_LIMITS.cancellationCommandAttempts; attempt += 1) {
      const checkpoint = state.outbox[0].command;
      expect(checkpoint).toMatchObject({ kind: 'checkpoint.persist', attempt });
      state = complete(state, { outcome: 'uncertain', resultDigest: D[5], proof: null }).state;
      state = applied(reduceRunController(state, {
        type: 'recovery', eventId: `checkpoint-retry-${attempt}`, occurredAt: at(),
        targetCommandId: checkpoint.id, reconciliationDigest: D[attempt + 5],
        disposition: 'not-applied', quiescenceDigest: computeRunControllerQuiescenceDigest(checkpoint),
        resultDigest: null, proof: null
      }));
    }
    const interrupted = state.outbox[0].command;
    expect(interrupted).toMatchObject({
      kind: 'checkpoint.persist', attempt: RUN_CONTROLLER_LIMITS.cancellationCommandAttempts
    });
    state = applied(reduceRunController(state, {
      type: 'cancel', eventId: 'cancel-max-checkpoint', occurredAt: at(), reasonDigest: D[1]
    }));
    state = complete(state).state;
    state = complete(state).state;
    expect(state).toMatchObject({ publicState: 'paused', phase: 'recovery-required' });
    state = applied(reduceRunController(state, {
      type: 'recovery', eventId: 'clear-max-checkpoint', occurredAt: at(),
      targetCommandId: interrupted.id, reconciliationDigest: D[9],
      disposition: 'not-applied', quiescenceDigest: computeRunControllerQuiescenceDigest(interrupted),
      resultDigest: null, proof: null
    }));
    expect(state).toMatchObject({
      publicState: 'cancelling', phase: 'cancellation-checkpoint', terminalIntent: 'cancelled'
    });
    expect(state.completedCommands.find(item => item.command.id === interrupted.id)?.outcome)
      .toBe('not-applied');
    expect(state.outbox[0].command).toMatchObject({
      kind: 'checkpoint.persist', attempt: RUN_CONTROLLER_LIMITS.cancellationCommandAttempts + 1
    });
    expect(state.outbox[0].command.id).not.toBe(interrupted.id);
    state = complete(state).state;
    expect(state).toMatchObject({ publicState: 'cancelled', phase: 'cancelled' });
  });

  test('failed authority cancellation requires recovery retry and cannot be asserted applied', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = dispatch(approve(preflight(state), 'autonomous'));
    state = applied(reduceRunController(state, {
      type: 'cancel', eventId: 'failed-revoke-cancel', occurredAt: at(), reasonDigest: D[1]
    }));
    const failed = state.outbox[0].command;
    state = complete(state, { outcome: 'failed' }).state;
    expect(state.recoverySummary.uncertainCommandIds).toEqual([failed.id]);
    expect(state.completedCommands.find(item => item.command.id === failed.id)?.outcome).toBe('failed');
    expect(reduceRunController(state, {
      type: 'recovery', eventId: 'failed-revoke-applied', occurredAt: at(),
      targetCommandId: failed.id, reconciliationDigest: D[6], disposition: 'applied', quiescenceDigest: null,
      resultDigest: D[7], proof: {
        kind: 'authority.cancel', authorityCancelled: true,
        cancellationGeneration: state.cancellationGeneration
      }
    })).toMatchObject({ ok: false, code: 'invalid-event' });
    state = applied(reduceRunController(state, {
      type: 'recovery', eventId: 'failed-revoke-still', occurredAt: at(),
      targetCommandId: failed.id, reconciliationDigest: D[6],
      disposition: 'still-uncertain', quiescenceDigest: null, resultDigest: null, proof: null
    }));
    expect(state.recoverySummary.uncertainCommandIds).toEqual([failed.id]);
    state = applied(reduceRunController(state, {
      type: 'recovery', eventId: 'failed-revoke-retry', occurredAt: at(),
      targetCommandId: failed.id, reconciliationDigest: D[7],
      disposition: 'not-applied', quiescenceDigest: computeRunControllerQuiescenceDigest(failed),
      resultDigest: null, proof: null
    }));
    expect(state.outbox[0].command).toMatchObject({ kind: 'authority.cancel', attempt: 2 });
    expect(state.outbox[0].command.id).not.toBe(failed.id);
    expect(state.authorityAcquired).toBe(true);
  });

  test('cancellation retries are bounded and exhaust fail closed without mutation', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = dispatch(approve(preflight(state), 'autonomous'));
    state = applied(reduceRunController(state, {
      type: 'cancel', eventId: 'bounded-retry-cancel', occurredAt: at(), reasonDigest: D[1]
    }));
    for (let attempt = 1; attempt < RUN_CONTROLLER_LIMITS.cancellationCommandAttempts; attempt += 1) {
      const failed = state.outbox[0].command;
      state = complete(state, { outcome: 'failed' }).state;
      state = applied(reduceRunController(state, {
        type: 'recovery', eventId: `bounded-retry-${attempt}`, occurredAt: at(),
        targetCommandId: failed.id, reconciliationDigest: D[attempt + 5],
        disposition: 'not-applied', quiescenceDigest: computeRunControllerQuiescenceDigest(failed),
        resultDigest: null, proof: null
      }));
      expect(state.outbox[0].command.attempt).toBe(attempt + 1);
    }
    const exhausted = state.outbox[0].command;
    state = complete(state, { outcome: 'failed' }).state;
    const before = JSON.stringify(state);
    const result = reduceRunController(state, {
      type: 'recovery', eventId: 'bounded-retry-exhausted', occurredAt: at(),
      targetCommandId: exhausted.id, reconciliationDigest: D[9],
      disposition: 'not-applied', quiescenceDigest: computeRunControllerQuiescenceDigest(exhausted),
      resultDigest: null, proof: null
    });
    expect(result).toMatchObject({ ok: false, code: 'resource-limit' });
    expect(JSON.stringify((result as any).state)).toBe(before);
  });

  test('soft journal cap stops normal work while preserving bounded cancellation closure', () => {
    expect(RUN_CONTROLLER_LIMITS.normalOperationProcessedEvents +
      RUN_CONTROLLER_LIMITS.closureEventReserve).toBe(RUN_CONTROLLER_LIMITS.processedEvents);
    expect(RUN_CONTROLLER_LIMITS.normalOperationCompletedCommands +
      RUN_CONTROLLER_LIMITS.closureCompletionReserve).toBe(RUN_CONTROLLER_LIMITS.completedCommands);
    expect(RUN_CONTROLLER_LIMITS.interruptedCommands)
      .toBeLessThanOrEqual(RUN_CONTROLLER_LIMITS.closureCompletionReserve);
    expect(RUN_CONTROLLER_LIMITS.closureEventReserve).toBe(
      1 + RUN_CONTROLLER_LIMITS.interruptedCommands +
      4 * (2 * RUN_CONTROLLER_LIMITS.cancellationCommandAttempts - 1)
    );
    expect(1 + 4 * RUN_CONTROLLER_LIMITS.cancellationCommandAttempts)
      .toBeLessThanOrEqual(RUN_CONTROLLER_LIMITS.closureCompletionReserve);
    const worstCaseClosureBytes =
      RUN_CONTROLLER_LIMITS.closureEventReserve * RUN_CONTROLLER_LIMITS.processedEventRecordBytes +
      RUN_CONTROLLER_LIMITS.closureCompletionReserve * RUN_CONTROLLER_LIMITS.completedCommandRecordBytes +
      RUN_CONTROLLER_LIMITS.interruptedCommands * RUN_CONTROLLER_LIMITS.recoveryCompletionGrowthBytes +
      RUN_CONTROLLER_LIMITS.outboxEntryBytes;
    expect(worstCaseClosureBytes).toBeLessThanOrEqual(RUN_CONTROLLER_LIMITS.closureByteReserve);
    expect(RUN_CONTROLLER_LIMITS.processedEventRecordBytes +
      RUN_CONTROLLER_LIMITS.completedCommandRecordBytes + RUN_CONTROLLER_LIMITS.outboxEntryBytes)
      .toBeLessThanOrEqual(RUN_CONTROLLER_LIMITS.normalTransitionBytes);

    let idle = applied(reduceRunController(undefined, createEvent()));
    idle = dispatch(approve(preflight(idle), 'autonomous'));
    idle = padProcessedEvents(idle, RUN_CONTROLLER_LIMITS.normalOperationProcessedEvents);
    expect(hasRunControllerNormalJournalCapacity(idle)).toBe(false);
    const beforeDrive = JSON.stringify(idle);
    const blocked = reduceRunController(idle, {
      type: 'drive', eventId: 'over-soft-cap-drive', occurredAt: at(), inputDigest: D[9]
    });
    expect(blocked).toMatchObject({ ok: false, code: 'resource-limit' });
    expect(JSON.stringify((blocked as any).state)).toBe(beforeDrive);
    idle = applied(reduceRunController(idle, {
      type: 'cancel', eventId: 'soft-cap-cancel', occurredAt: at(), reasonDigest: D[1]
    }));
    idle = finishClosure(idle);
    expect(idle).toMatchObject({ publicState: 'cancelled', phase: 'cancelled' });
    expect(idle.processedEvents.length).toBeLessThanOrEqual(RUN_CONTROLLER_LIMITS.processedEvents);
    expect(idle.completedCommands.length).toBeLessThanOrEqual(RUN_CONTROLLER_LIMITS.completedCommands);

    let active = applied(reduceRunController(undefined, createEvent()));
    active = approve(preflight(active), 'autonomous');
    active = padProcessedEvents(active, RUN_CONTROLLER_LIMITS.normalOperationProcessedEvents);
    active = complete(active).state;
    expect(active).toMatchObject({ publicState: 'cancelling', phase: 'cancellation-authority' });
    expect(active.outbox[0].command.kind).toBe('authority.cancel');
    active = finishClosure(active);
    expect(active.publicState).toBe('failed');

    let recovering = applied(reduceRunController(undefined, createEvent()));
    recovering = approve(preflight(recovering), 'autonomous');
    const interrupted = recovering.outbox[0].command;
    recovering = complete(recovering, {
      controllerEpoch: interrupted.expectedControllerEpoch + 1
    }).state;
    recovering = padProcessedEvents(recovering, RUN_CONTROLLER_LIMITS.normalOperationProcessedEvents);
    recovering = applied(reduceRunController(recovering, {
      type: 'recovery', eventId: 'soft-cap-recovery', occurredAt: at(),
      targetCommandId: interrupted.id, reconciliationDigest: D[6], disposition: 'applied', quiescenceDigest: null,
      resultDigest: D[7],
      proof: { kind: 'authority.initialize', authorityStateDigest: D[8], authorityInitialized: true }
    }));
    expect(recovering).toMatchObject({ publicState: 'cancelling', phase: 'cancellation-authority' });

    const hard = padProcessedEvents(
      applied(reduceRunController(undefined, createEvent())), RUN_CONTROLLER_LIMITS.processedEvents
    );
    const beforeHard = JSON.stringify(hard);
    const hardResult = reduceRunController(hard, {
      type: 'cancel', eventId: 'hard-cap-cancel', occurredAt: at(), reasonDigest: D[1]
    });
    expect(hardResult).toMatchObject({ ok: false, code: 'resource-limit' });
    expect(JSON.stringify((hardResult as any).state)).toBe(beforeHard);
  });

  test('byte ceiling rejects normal expansion while preserving parseable cancellation reserve', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = dispatch(approve(preflight(state), 'autonomous'));
    state = padProcessedEventsToBytes(
      state,
      RUN_CONTROLLER_LIMITS.normalOperationAggregateBytes - RUN_CONTROLLER_LIMITS.processedEventRecordBytes
    );
    expect(runControllerCanonicalBytes(state)).toBeLessThanOrEqual(
      RUN_CONTROLLER_LIMITS.normalOperationAggregateBytes
    );
    expect(runControllerCanonicalBytes(state)).toBeGreaterThan(
      RUN_CONTROLLER_LIMITS.normalOperationAggregateBytes - RUN_CONTROLLER_LIMITS.normalTransitionBytes
    );
    expect(state.processedEvents.length).toBeLessThan(
      RUN_CONTROLLER_LIMITS.normalOperationProcessedEvents
    );
    const before = JSON.stringify(state);
    const normal = reduceRunController(state, {
      type: 'drive', eventId: 'byte-ceiling-drive', occurredAt: at(), inputDigest: D[9]
    });
    expect(normal).toMatchObject({ ok: false, code: 'resource-limit' });
    expect(JSON.stringify((normal as any).state)).toBe(before);
    state = applied(reduceRunController(state, {
      type: 'cancel', eventId: 'byte-ceiling-cancel', occurredAt: at(), reasonDigest: D[1]
    }));
    expect(() => parseRunControllerState(state)).not.toThrow();
    expect(runControllerCanonicalBytes(state)).toBeLessThanOrEqual(RUN_CONTROLLER_LIMITS.aggregateBytes);
    state = finishClosure(state);
    expect(state.publicState).toBe('cancelled');
  });

  test('oversized valid create is rejected before authority work', () => {
    const event: any = JSON.parse(JSON.stringify(createEvent()));
    const largeWriteSet = Array.from({ length: 64 }, (_, index) =>
      `${String(index).padStart(4, '0')}-${'x'.repeat(1000)}`);
    for (const node of event.model.nodes) node.writeSet = [...largeWriteSet];
    event.modelDigest = computeRunControllerModelDigest(event.model);
    const result = reduceRunController(undefined, event);
    expect(result).toMatchObject({ ok: false, code: 'resource-limit', state: undefined, commands: [] });
  });

  test('revocation failure is resolved before an interrupted active effect is reconciled', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = approve(preflight(state), 'autonomous');
    const interrupted = state.outbox[0].command;
    state = applied(reduceRunController(state, {
      type: 'cancel', eventId: 'ordered-active-cancel', occurredAt: at(), reasonDigest: D[1]
    }));
    const revoke = state.outbox[0].command;
    state = complete(state, { outcome: 'failed' }).state;
    expect(state.recoverySummary.uncertainCommandIds).toEqual([revoke.id]);
    expect(state.recoverySummary.uncertainCommandIds).not.toContain(interrupted.id);
    state = applied(reduceRunController(state, {
      type: 'recovery', eventId: 'ordered-revoke-retry', occurredAt: at(),
      targetCommandId: revoke.id, reconciliationDigest: D[6],
      disposition: 'not-applied', quiescenceDigest: computeRunControllerQuiescenceDigest(revoke),
      resultDigest: null, proof: null
    }));
    expect(state.outbox[0].command.kind).toBe('authority.cancel');
    state = complete(state).state;
    expect(state.drainSummary.authorityCancelled).toBe(true);
    expect(state.outbox[0].command.kind).toBe('descendant.signal');
    state = complete(state).state;
    expect(state).toMatchObject({ publicState: 'paused', phase: 'recovery-required' });
    expect(state.recoverySummary.uncertainCommandIds).toEqual([interrupted.id]);
    state = applied(reduceRunController(state, {
      type: 'recovery', eventId: 'ordered-interruption-clear', occurredAt: at(),
      targetCommandId: interrupted.id, reconciliationDigest: D[7],
      disposition: 'not-applied', quiescenceDigest: computeRunControllerQuiescenceDigest(interrupted),
      resultDigest: null, proof: null
    }));
    expect(state.outbox[0].command.kind).toBe('checkpoint.persist');
  });

  test('stored cancellation state cannot skip revoke, signal, force, or zero-count proof', () => {
    let authority = applied(reduceRunController(undefined, createEvent()));
    authority = dispatch(approve(preflight(authority), 'autonomous'));
    authority = applied(reduceRunController(authority, {
      type: 'cancel', eventId: 'cancel-invariants', occurredAt: at(), reasonDigest: D[1]
    }));
    const authoritySkip: any = JSON.parse(JSON.stringify(authority));
    authoritySkip.drainSummary.authorityCancelled = true;
    expect(() => parseRunControllerState(authoritySkip)).toThrow(/Cancellation authority phase order/);

    const signalling = complete(authority).state;
    const signalSkip: any = JSON.parse(JSON.stringify(signalling));
    signalSkip.drainSummary.descendantsForced = true;
    expect(() => parseRunControllerState(signalSkip)).toThrow(/Cancellation signalling phase order/);

    const forcing = complete(signalling, {
      proof: { kind: 'descendant.signal', pendingDescendants: 2 }
    }).state;
    const forceSkip: any = JSON.parse(JSON.stringify(forcing));
    forceSkip.drainSummary.forceRequired = false;
    expect(() => parseRunControllerState(forceSkip)).toThrow(/Cancellation forcing phase order/);

    const checkpoint = complete(forcing, {
      proof: { kind: 'descendant.force', pendingDescendants: 0 }
    }).state;
    const checkpointSkip: any = JSON.parse(JSON.stringify(checkpoint));
    checkpointSkip.drainSummary.descendantsForced = false;
    expect(() => parseRunControllerState(checkpointSkip)).toThrow(/Cancellation checkpoint phase order/);
  });

  test('stored outbox, links, and audit chain reject semantic tamper', () => {
    const created = applied(reduceRunController(undefined, createEvent()));
    const outboxTamper: Array<(state: any) => void> = [
      state => { state.outbox[0].command.projectId = 'other-project'; },
      state => { state.outbox[0].command.expectedControllerEpoch += 1; },
      state => { state.outbox[0].command.expectedLeaseFence = 1; },
      state => { state.outbox[0].command.nodeId = state.execution.nodeId; },
      state => { state.outbox[0].command.attempt += 1; },
      state => { state.outbox[0].protectedPayload.graphEpoch += 1; },
      state => { state.outbox[0].protectedPayload.cancellationGeneration += 1; },
      state => {
        state.outbox[0].protectedPayload.bindings.find((item: any) => item.name === 'plan').digest = D[15];
      },
      state => { state.processedEvents[0].transitionSequence = 2; },
      state => { state.processedEvents[0].priorAuditHash = D[15]; },
      state => { state.processedEvents[0].nextAuditHash = D[15]; },
      state => { state.auditHashHead = D[15]; },
      state => { state.processedEvents[0].result.commandIds = []; }
    ];
    for (const tamper of outboxTamper) {
      const value = JSON.parse(JSON.stringify(created));
      tamper(value);
      expect(() => parseRunControllerState(value)).toThrow();
    }

    let validating = dispatch(approve(preflight(created), 'autonomous'));
    validating = applied(reduceRunController(validating, {
      type: 'drive', eventId: 'semantic-report-binding-drive', occurredAt: at(), inputDigest: D[9]
    }));
    const semanticBinding: any = JSON.parse(JSON.stringify(validating));
    const semanticEntry = semanticBinding.outbox[0];
    semanticEntry.protectedPayload.bindings.find((item: any) => item.name === 'report').digest = D[10];
    semanticEntry.command.payloadDigest = computeRunControllerPayloadDigest(semanticEntry.protectedPayload);
    semanticEntry.command.id = computeRunControllerCommandId({
      runId: semanticEntry.command.runId,
      projectId: semanticEntry.command.projectId,
      controllerEpoch: semanticEntry.command.expectedControllerEpoch,
      expectedLeaseFence: semanticEntry.command.expectedLeaseFence,
      graphEpoch: semanticEntry.protectedPayload.graphEpoch,
      transitionSequence: semanticEntry.command.transitionSequence,
      ordinal: semanticEntry.command.ordinal,
      kind: semanticEntry.command.kind,
      nodeId: semanticEntry.command.nodeId,
      attempt: semanticEntry.command.attempt,
      payloadDigest: semanticEntry.command.payloadDigest
    });
    semanticBinding.processedEvents[semanticEntry.command.transitionSequence - 1]
      .result.commandIds[0] = semanticEntry.command.id;
    expect(() => parseRunControllerState(semanticBinding)).toThrow(/Outbox command integrity mismatch/);

    const completed = preflight(created);
    const completedTamper: Array<(state: any) => void> = [
      state => { state.completedCommands[0].command.projectId = 'other-project'; },
      state => { state.completedCommands[0].command.attempt = 2; },
      state => { state.completedCommands[0].protectedPayload.graphEpoch = 1; },
      state => { state.completedCommands[0].completionEventId = 'missing'; },
      state => { state.completedCommands[0].completionDigest = D[15]; },
      state => { state.completedCommands[0].completionEvent.assessmentDigest = D[15]; },
      state => { state.completedCommands[0].completionEvent.occurredAt = '2026-09-14T00:00:59.000Z'; },
      state => { state.completedCommands[0].proof = {
        kind: 'authority.initialize', authorityStateDigest: D[5], authorityInitialized: true
      }; },
      state => { state.processedEvents[0].result.code = 'noop'; },
      state => { state.processedEvents[0].result.commandIds[0] = `rcmd:${'e'.repeat(64)}`; }
    ];
    for (const tamper of completedTamper) {
      const value = JSON.parse(JSON.stringify(completed));
      tamper(value);
      expect(() => parseRunControllerState(value)).toThrow();
    }

    let initialized = approve(completed, 'autonomous');
    initialized = complete(initialized).state;
    const proofTamper: any = JSON.parse(JSON.stringify(initialized));
    const initialization = proofTamper.completedCommands.find(
      (item: any) => item.command.kind === 'authority.initialize'
    );
    initialization.proof = { kind: 'authority.issue-eo-ticket', ticketRefDigest: D[7] };
    expect(() => parseRunControllerState(proofTamper)).toThrow(/Completion proof mismatch/);

    for (const mutate of [
      (item: any) => { item.completionEvent.proof.authorityStateDigest = D[15]; },
      (item: any) => { item.completionEvent.resultDigest = D[15]; }
    ]) {
      const value: any = JSON.parse(JSON.stringify(initialized));
      mutate(value.completedCommands.find((item: any) => item.command.kind === 'authority.initialize'));
      expect(() => parseRunControllerState(value)).toThrow(/Completion event link missing/);
    }

    const reportState: any = JSON.parse(JSON.stringify(toFinalValidation()));
    const reportCompletion = reportState.completedCommands.find(
      (item: any) => item.command.kind === 'evidence.validate-preliminary-report'
    );
    reportCompletion.completionEvent.classification = 'quarantined';
    expect(() => parseRunControllerState(reportState)).toThrow(/Completion event link missing/);
  });

  test('missing descendant count and premature force/checkpoint facts reject byte-identically', () => {
    let state = applied(reduceRunController(undefined, createEvent()));
    state = dispatch(approve(preflight(state), 'autonomous'));
    state = applied(reduceRunController(state, {
      type: 'cancel', eventId: 'cancel-counts', occurredAt: at(), reasonDigest: D[1]
    }));
    state = complete(state).state;
    const command = state.outbox[0].command;
    const before = JSON.stringify(state);
    const missingCount = reduceRunController(state, {
      type: 'command-completion', eventId: 'missing-count', occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      outcome: 'succeeded', resultDigest: D[2], proof: { kind: 'descendant.signal' }
    });
    expect(missingCount).toMatchObject({ ok: false, code: 'invalid-event' });
    expect((missingCount as any).reason).toMatch(/pendingDescendants/);
    expect(JSON.stringify((missingCount as any).state)).toBe(before);
    expect(reduceRunController(state, {
      type: 'command-completion', eventId: 'premature-force', occurredAt: at(),
      commandId: command.id, controllerEpoch: command.expectedControllerEpoch,
      leaseFence: command.expectedLeaseFence, attempt: command.attempt,
      outcome: 'succeeded', resultDigest: D[2],
      proof: { kind: 'descendant.force', pendingDescendants: 0 }
    })).toMatchObject({ ok: false, code: 'invalid-event' });
    expect(JSON.stringify(state)).toBe(before);
  });

  test('rejects unknown, illegal, accessor, proxy, oversized, and collection-hostile inputs', () => {
    const state = applied(reduceRunController(undefined, createEvent()));
    const before = JSON.stringify(state);
    expect(reduceRunController(state, { type: 'future-event', eventId: 'x', occurredAt: at() }))
      .toMatchObject({ ok: false, code: 'invalid-event' });
    expect(reduceRunController(state, {
      type: 'drive', eventId: 'illegal-drive', occurredAt: at(), inputDigest: D[1]
    })).toMatchObject({ ok: false, code: 'illegal-transition' });
    let invoked = false;
    const accessor = Object.defineProperty({}, 'type', { enumerable: true, get() { invoked = true; return 'drive'; } });
    expect(reduceRunController(state, accessor)).toMatchObject({ ok: false, code: 'invalid-event' });
    expect(invoked).toBe(false);
    expect(reduceRunController(state, new Proxy({}, {}))).toMatchObject({ ok: false, code: 'invalid-event' });
    expect(reduceRunController(state, {
      type: 'drive', eventId: 'huge', occurredAt: at(), inputDigest: D[1],
      extra: 'x'.repeat(RUN_CONTROLLER_LIMITS.aggregateBytes)
    })).toMatchObject({ ok: false });
    expect(JSON.stringify(state)).toBe(before);

    const corrupt: any = JSON.parse(JSON.stringify(state));
    corrupt.processedEvents = Array.from({ length: RUN_CONTROLLER_LIMITS.processedEvents + 1 },
      (_, index) => ({ ...corrupt.processedEvents[0], eventId: `event-${index}` }));
    expect(() => parseRunControllerState(corrupt)).toThrow(/too_big|Too big|processedEvents/i);

    const oversized: any = JSON.parse(JSON.stringify(state));
    oversized.model.nodes[0].localCriteria = Array.from({ length: 1024 },
      (_, index) => `${String(index).padStart(4, '0')}-${'x'.repeat(1000)}`);
    expect(() => parseRunControllerState(oversized)).toThrow(/exceeds 917504 canonical UTF-8 bytes/);
  });

  test('safe projection is frozen, detached, serializable, and excludes protected internals', () => {
    const state = toFinalValidation();
    const view = projectRunController(state);
    expect(view).toMatchObject({
      authority: false, runId: 'run-1', projectId: 'project-1', state: 'running',
      mode: 'autonomous', fidelity: 'exact', graphRevision: 1,
      pendingCommandCount: 1, budgetSummary: { reserved: 10, committed: 7, currency: 'USD' }
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.nodeCounts)).toBe(true);
    const serialized = JSON.stringify(view);
    for (const forbidden of [
      'phase', 'ticket', 'lease', 'fence', 'approval', 'provider',
      'reservation', 'credential', 'payload', 'receipt'
    ]) expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    expect(publicAgents).not.toHaveProperty('reduceRunController');
    expect(publicAgents).not.toHaveProperty('createProtectedRunControllerRepository');
    expect(publicAgents).not.toHaveProperty('projectRunController');
  });
});
