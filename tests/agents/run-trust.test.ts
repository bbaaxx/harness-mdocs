import {
  CasConflictError,
  createFakeTrustedControlPlane,
  createOpaqueHandle,
  createRunKillSwitch,
  evaluateRunFidelity,
  HandleIssueParams,
  StructuredAction,
  TrustComponentId
} from '../../src/agents';

const PLAN_DIGEST = 'sha256:plan';
const GRAPH_DIGEST = 'sha256:graph';

function challengeParams() {
  return {
    planDigest: PLAN_DIGEST,
    graphDigest: GRAPH_DIGEST,
    planRevision: 1,
    projectId: 'project:fake',
    hostSessionRef: 'host-session:fake',
    principalRef: 'principal:fake'
  } as const;
}

function expectedBinding() {
  return {
    planDigest: PLAN_DIGEST,
    graphDigest: GRAPH_DIGEST,
    planRevision: 1,
    principalRef: 'principal:fake',
    projectId: 'project:fake',
    hostSessionRef: 'host-session:fake'
  } as const;
}

function issueParams(): HandleIssueParams {
  return {
    runId: 'run:1',
    graphId: 'graph:1',
    nodeId: 'node:1',
    generation: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    cancellationGeneration: 0,
    scopeSummary: 'node scope',
    writeSetSummary: ['src/**']
  };
}

const writeAction: StructuredAction = {
  operation: 'fs.write',
  path: 'src/file.ts',
  contentDigest: `sha256:${'0'.repeat(64)}`,
  declaredBytes: 0,
  writeSet: ['src/file.ts'],
  sideEffectClass: 'workspace'
};

describe('forged attestation', () => {
  test('tampered plan or graph digest fails verification with digest-mismatch', async () => {
    const controlPlane = createFakeTrustedControlPlane();

    const planChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const planEvent = await controlPlane.attestation.recordApproval(planChallenge.challengeId, 'approved');
    expect(controlPlane.attestation.verifyApproval(
      { ...planEvent, planDigest: 'sha256:forged' },
      expectedBinding()
    )).toEqual({ ok: false, reason: 'untrusted-origin' });

    const graphChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const graphEvent = await controlPlane.attestation.recordApproval(graphChallenge.challengeId, 'approved');
    expect(controlPlane.attestation.verifyApproval(
      { ...graphEvent, graphDigest: 'sha256:forged' },
      expectedBinding()
    )).toEqual({ ok: false, reason: 'untrusted-origin' });
  });

  test('wrong project binding fails verification with project-mismatch', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const challenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const event = await controlPlane.attestation.recordApproval(challenge.challengeId, 'approved');

    expect(controlPlane.attestation.verifyApproval(event, {
      ...expectedBinding(),
      projectId: 'project:other'
    })).toEqual({ ok: false, reason: 'project-mismatch' });
  });

  test('wrong revision and principal bindings fail verification', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const revisionChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const revisionEvent = await controlPlane.attestation.recordApproval(
      revisionChallenge.challengeId,
      'approved'
    );
    expect(controlPlane.attestation.verifyApproval(revisionEvent, {
      ...expectedBinding(),
      planRevision: 2
    })).toEqual({ ok: false, reason: 'revision-mismatch' });

    const principalChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const principalEvent = await controlPlane.attestation.recordApproval(
      principalChallenge.challengeId,
      'approved'
    );
    expect(controlPlane.attestation.verifyApproval(principalEvent, {
      ...expectedBinding(),
      principalRef: 'principal:other'
    })).toEqual({ ok: false, reason: 'principal-mismatch' });
  });

  test('copied, synthetic, wrong-kind, and rejected issued events fail closed', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const approvedChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const approved = await controlPlane.attestation.recordApproval(approvedChallenge.challengeId, 'approved');
    expect(controlPlane.attestation.verifyApproval({ ...approved }, expectedBinding()))
      .toEqual({ ok: false, reason: 'untrusted-origin' });
    expect(controlPlane.attestation.verifyApproval({
      ...approved,
      eventId: 'event:synthetic'
    }, expectedBinding())).toEqual({ ok: false, reason: 'untrusted-origin' });

    const modeChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const mode = await controlPlane.attestation.recordModeSelection(modeChallenge.challengeId, 'milestone');
    expect(controlPlane.attestation.verifyApproval(mode as any, expectedBinding()))
      .toEqual({ ok: false, reason: 'kind-mismatch' });

    const rejectedChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const rejected = await controlPlane.attestation.recordApproval(rejectedChallenge.challengeId, 'rejected');
    expect(controlPlane.attestation.verifyApproval(rejected, expectedBinding()))
      .toEqual({ ok: false, reason: 'decision-rejected' });
  });

  test('clone, proxy, and getter events fail identity gate without reads or consumption', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const approvalChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const approval = await controlPlane.attestation.recordApproval(approvalChallenge.challengeId, 'approved');
    const modeChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const mode = await controlPlane.attestation.recordModeSelection(modeChallenge.challengeId, 'autonomous');
    const getTrap = jest.fn(Reflect.get);
    const proxy = new Proxy(mode, { get: getTrap });
    const getter = jest.fn(() => approval.eventId);
    const getterEvent: Record<string, unknown> = {};
    Object.defineProperty(getterEvent, 'eventId', { enumerable: true, get: getter });

    expect(controlPlane.attestation.verifyApproval({ ...approval }, expectedBinding()))
      .toEqual({ ok: false, reason: 'untrusted-origin' });
    expect(controlPlane.attestation.verifyApproval(getterEvent as any, expectedBinding()))
      .toEqual({ ok: false, reason: 'untrusted-origin' });
    expect(controlPlane.attestation.verifyPair(approval, proxy, expectedBinding()))
      .toEqual({ ok: false, target: 'mode-selection', reason: 'untrusted-origin' });
    expect(getter).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
    expect(controlPlane.attestation.verifyPair(approval, mode, expectedBinding())).toEqual({ ok: true });
  });

  test('second approval on the same challenge is rejected as replay', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const challenge = await controlPlane.attestation.beginChallenge(challengeParams());
    await controlPlane.attestation.recordApproval(challenge.challengeId, 'approved');

    await expect(controlPlane.attestation.recordApproval(challenge.challengeId, 'approved'))
      .rejects.toThrow(/replay/i);
  });

  test('verifying the same event twice is rejected as replayed', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const challenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const event = await controlPlane.attestation.recordApproval(challenge.challengeId, 'approved');

    expect(controlPlane.attestation.verifyApproval(event, expectedBinding())).toEqual({ ok: true });
    expect(controlPlane.attestation.verifyApproval(event, expectedBinding()))
      .toEqual({ ok: false, reason: 'replayed' });
  });

  test('expired challenge cannot record and expired event fails verification', async () => {
    let current = new Date('2026-09-08T00:00:00.000Z');
    const controlPlane = createFakeTrustedControlPlane({ now: () => current });

    const expiredChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const event = await controlPlane.attestation.recordApproval(
      expiredChallenge.challengeId,
      'approved'
    );

    current = new Date('2026-09-08T01:00:00.000Z');
    expect(controlPlane.attestation.verifyApproval(event, expectedBinding()))
      .toEqual({ ok: false, reason: 'expired' });

    const staleChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    current = new Date('2026-09-08T02:00:00.000Z');
    await expect(controlPlane.attestation.recordApproval(staleChallenge.challengeId, 'approved'))
      .rejects.toThrow(/expired/i);
  });

  test('challenge and event expire exactly at expiresAt', async () => {
    let current = new Date('2026-09-08T00:00:00.000Z');
    const controlPlane = createFakeTrustedControlPlane({
      now: () => current,
      challengeTtlMs: 60_000
    });
    const eventChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const event = await controlPlane.attestation.recordApproval(eventChallenge.challengeId, 'approved');
    current = new Date(event.expiresAt);
    expect(controlPlane.attestation.verifyApproval(event, expectedBinding()))
      .toEqual({ ok: false, reason: 'expired' });

    current = new Date('2026-09-08T01:00:00.000Z');
    const recordChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    current = new Date(recordChallenge.expiresAt);
    await expect(controlPlane.attestation.recordModeSelection(recordChallenge.challengeId, 'milestone'))
      .rejects.toThrow(/expired/i);
  });

  test('revoked event fails verification with revoked', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const challenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const event = await controlPlane.attestation.recordApproval(challenge.challengeId, 'approved');

    await controlPlane.attestation.revoke(event.eventId, 2);
    expect(controlPlane.attestation.verifyApproval(event, expectedBinding()))
      .toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('forged identity', () => {
  test('identityForHandle returns null for unbound and unknown handles', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const handle = controlPlane.handles.issue(issueParams());

    expect(controlPlane.identity.identityForHandle(createOpaqueHandle())).toBeNull();
    expect(controlPlane.identity.identityForHandle(handle)).toBeNull();
  });

  test('caller-constructed identity cannot associate with a handle without bindHandle', () => {
    const controlPlane = createFakeTrustedControlPlane();
    const handle = controlPlane.handles.issue(issueParams());
    const fakeIdentity = {
      providerId: 'attacker',
      sessionRef: 'forged-session',
      principalRef: 'forged-principal'
    };

    // Merely constructing an identity object creates no association.
    expect(controlPlane.identity.identityForHandle(handle)).toBeNull();

    // Binding to a handle this broker never issued is rejected.
    expect(() => controlPlane.identity.bindHandle(fakeIdentity, createOpaqueHandle()))
      .toThrow(/not issued/i);

    // Only control-plane bindHandle creates the association.
    controlPlane.identity.bindHandle(fakeIdentity, handle);
    expect(controlPlane.identity.identityForHandle(handle)).toEqual(fakeIdentity);
  });
});

describe('fidelity truth table', () => {
  test.each<TrustComponentId>([
    'attestation',
    'host-identity',
    'controller-store',
    'action-mediation',
    'cancellation'
  ])('missing %s yields plan-only, never supervised', component => {
    const controlPlane = createFakeTrustedControlPlane();
    controlPlane.failComponent(component);

    const assessment = evaluateRunFidelity({
      contractRendering: 'available',
      components: controlPlane.componentStatus(),
      hardBudgetDimensions: [],
      continuation: 'autonomous'
    });

    expect(assessment.fidelity).toBe('plan-only');
    expect(assessment.fidelity).not.toBe('supervised');
    expect(assessment.reasons.some(reason => reason.includes(component))).toBe(true);
  });

  test('missing metering with hard budgets yields plan-only; without hard budgets stays exact', () => {
    const controlPlane = createFakeTrustedControlPlane();
    controlPlane.failComponent('usage-metering');

    const withBudgets = evaluateRunFidelity({
      contractRendering: 'available',
      components: controlPlane.componentStatus(),
      hardBudgetDimensions: ['tokens', 'cost'],
      continuation: 'autonomous'
    });
    expect(withBudgets.fidelity).toBe('plan-only');
    expect(withBudgets.reasons.some(reason => reason.includes('usage-metering'))).toBe(true);

    const withoutBudgets = evaluateRunFidelity({
      contractRendering: 'available',
      components: controlPlane.componentStatus(),
      hardBudgetDimensions: [],
      continuation: 'autonomous'
    });
    expect(withoutBudgets.fidelity).toBe('exact');
  });

  test('unavailable contract rendering yields unsupported', () => {
    const controlPlane = createFakeTrustedControlPlane();
    const assessment = evaluateRunFidelity({
      contractRendering: 'unavailable',
      components: controlPlane.componentStatus(),
      hardBudgetDimensions: [],
      continuation: 'autonomous'
    });

    expect(assessment.fidelity).toBe('unsupported');
  });

  test('all enforced yields exact for autonomous and supervised for human checkpoint', () => {
    const controlPlane = createFakeTrustedControlPlane();
    const components = controlPlane.componentStatus();

    expect(evaluateRunFidelity({
      contractRendering: 'available',
      components,
      hardBudgetDimensions: ['tokens', 'cost'],
      continuation: 'autonomous'
    }).fidelity).toBe('exact');

    expect(evaluateRunFidelity({
      contractRendering: 'available',
      components,
      hardBudgetDimensions: ['tokens', 'cost'],
      continuation: 'human-checkpoint'
    }).fidelity).toBe('supervised');
  });
});

describe('kill switch', () => {
  test('disableEffects makes mediator authorize fail with kill-switch code', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const handle = controlPlane.handles.issue(issueParams());

    const allowed = await controlPlane.mediator.authorize(handle, writeAction);
    expect(allowed.allowed).toBe(true);

    controlPlane.killSwitch.disableEffects('rollout halt');
    const denied = await controlPlane.mediator.authorize(handle, writeAction);
    expect(denied).toEqual({
      allowed: false,
      code: 'kill-switch',
      reason: 'Run effects disabled'
    });
  });

  test('disableEffects is idempotent and runEnabled false blocks effects', () => {
    const killSwitch = createRunKillSwitch({ routeEnabled: true, runEnabled: true });
    killSwitch.disableEffects('first');
    killSwitch.disableEffects('second');
    expect(killSwitch.effectsAllowed()).toBe(false);
    expect(killSwitch.disableReason()).toContain('first');
    expect(killSwitch.disableReason()).not.toContain('second');

    expect(createRunKillSwitch({ routeEnabled: true, runEnabled: false }).effectsAllowed())
      .toBe(false);
    expect(createRunKillSwitch().effectsAllowed()).toBe(false);
  });
});

describe('controller store CAS', () => {
  test('compareAndSwap enforces generation and increments atomically', async () => {
    const controlPlane = createFakeTrustedControlPlane();

    await expect(controlPlane.store.compareAndSwap('checkpoint/run:1', { state: 'a' }, 1))
      .rejects.toThrow(CasConflictError);

    await expect(controlPlane.store.compareAndSwap('checkpoint/run:1', { state: 'a' }, 0))
      .resolves.toBe(1);
    await expect(controlPlane.store.compareAndSwap('checkpoint/run:1', { state: 'b' }, 0))
      .rejects.toThrow(CasConflictError);
    await expect(controlPlane.store.compareAndSwap('checkpoint/run:1', { state: 'b' }, 1))
      .resolves.toBe(2);

    const record = await controlPlane.store.get<{ state: string }>('checkpoint/run:1');
    expect(record?.generation).toBe(2);
    expect(record?.value).toEqual({ state: 'b' });
    expect(record?.checksum).toMatch(/^sha256:/);
  });
});

describe('mode selection is a separate trusted event', () => {
  test('mode selection binds to its own challenge, separate from approval', async () => {
    const controlPlane = createFakeTrustedControlPlane();

    const approvalChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const approval = await controlPlane.attestation.recordApproval(
      approvalChallenge.challengeId,
      'approved'
    );

    const modeChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const modeEvent = await controlPlane.attestation.recordModeSelection(
      modeChallenge.challengeId,
      'autonomous'
    );

    expect(approval.kind).toBe('plan-approval/v1');
    expect(modeEvent.kind).toBe('execution-mode-selection/v1');
    expect(modeEvent.challengeNonce).toBe(modeChallenge.nonce);
    expect(modeEvent.challengeNonce).not.toBe(approvalChallenge.nonce);
    expect(modeEvent.mode).toBe('autonomous');

    expect(controlPlane.attestation.verifyModeSelection(modeEvent, expectedBinding()))
      .toEqual({ ok: true });

    // Second mode selection on the same challenge is replay.
    await expect(controlPlane.attestation.recordModeSelection(modeChallenge.challengeId, 'milestone'))
      .rejects.toThrow(/replay/i);
  });

  test('one challenge cannot mint approval then mode or mode then approval', async () => {
    const approvalFirst = createFakeTrustedControlPlane();
    const firstChallenge = await approvalFirst.attestation.beginChallenge(challengeParams());
    await approvalFirst.attestation.recordApproval(firstChallenge.challengeId, 'approved');
    await expect(approvalFirst.attestation.recordModeSelection(firstChallenge.challengeId, 'milestone'))
      .rejects.toThrow(/already minted an event/i);

    const modeFirst = createFakeTrustedControlPlane();
    const secondChallenge = await modeFirst.attestation.beginChallenge(challengeParams());
    await modeFirst.attestation.recordModeSelection(secondChallenge.challengeId, 'autonomous');
    await expect(modeFirst.attestation.recordApproval(secondChallenge.challengeId, 'approved'))
      .rejects.toThrow(/already minted an event/i);
  });

  test('challenge binding comes from configured trusted host context and digest view is deeply frozen', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    for (const changed of [
      { principalRef: 'principal:other' },
      { projectId: 'project:other' },
      { hostSessionRef: 'host-session:other' }
    ]) {
      await expect(controlPlane.attestation.beginChallenge({ ...challengeParams(), ...changed }))
        .rejects.toThrow(/binding mismatch/i);
    }

    const challenge = await controlPlane.attestation.beginChallenge(challengeParams());
    expect(Object.isFrozen(challenge)).toBe(true);
    expect(Object.isFrozen(challenge.presentedDigests)).toBe(true);
  });

  test('runtime rejects invalid recording mode and forged invalid mode event', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const challenge = await controlPlane.attestation.beginChallenge(challengeParams());
    await expect(controlPlane.attestation.recordModeSelection(challenge.challengeId, 'invalid' as any))
      .rejects.toThrow(/invalid execution mode/i);
    const mode = await controlPlane.attestation.recordModeSelection(challenge.challengeId, 'milestone');
    expect(controlPlane.attestation.verifyModeSelection(
      { ...mode, mode: 'invalid' } as any,
      expectedBinding()
    )).toEqual({ ok: false, reason: 'untrusted-origin' });
  });

  test('atomic pair marks both replayed only after both preflight successfully', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const approvalChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const approval = await controlPlane.attestation.recordApproval(approvalChallenge.challengeId, 'approved');
    const modeChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const mode = await controlPlane.attestation.recordModeSelection(modeChallenge.challengeId, 'autonomous');

    expect(controlPlane.attestation.verifyPair(approval, mode as any, expectedBinding()))
      .toEqual({ ok: true });
    expect(controlPlane.attestation.verifyApproval(approval, expectedBinding()))
      .toEqual({ ok: false, reason: 'replayed' });
    expect(controlPlane.attestation.verifyModeSelection(mode, expectedBinding()))
      .toEqual({ ok: false, reason: 'replayed' });
  });

  test('atomic pair preflight failure consumes neither event', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const approvalChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const approval = await controlPlane.attestation.recordApproval(approvalChallenge.challengeId, 'approved');
    const modeChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const mode = await controlPlane.attestation.recordModeSelection(modeChallenge.challengeId, 'autonomous');

    expect(controlPlane.attestation.verifyPair(mode as any, approval as any, expectedBinding()))
      .toEqual({ ok: false, target: 'approval', reason: 'kind-mismatch' });
    expect(controlPlane.attestation.verifyApproval(approval, expectedBinding())).toEqual({ ok: true });
    expect(controlPlane.attestation.verifyModeSelection(mode, expectedBinding())).toEqual({ ok: true });
  });
});

describe('mediator happy path', () => {
  test('authorize persists intent before execute returns a receipt', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const handle = controlPlane.handles.issue(issueParams());

    const decision = await controlPlane.mediator.authorize(handle, writeAction);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;

    expect(await controlPlane.store.list('intent/')).toEqual(['intent/run:1']);

    const receipt = await controlPlane.mediator.execute(decision.reservationId);
    expect(receipt.resultClass).toBe('success');
    expect(receipt.receiptRef).toMatch(/^receipt:/);
    expect(receipt.receiptDigest).toMatch(/^sha256:/);
    expect(receipt).not.toHaveProperty('receipt');
  });

  test('unissued handle is denied with no-handle', async () => {
    const controlPlane = createFakeTrustedControlPlane();
    const decision = await controlPlane.mediator.authorize(createOpaqueHandle(), writeAction);
    expect(decision).toEqual({
      allowed: false,
      code: 'no-handle',
      reason: expect.any(String)
    });
  });

  test('expired fake handle is denied using trusted current time', async () => {
    let now = new Date('2026-09-13T00:00:00.000Z');
    const controlPlane = createFakeTrustedControlPlane({ now: () => new Date(now) });
    const handle = controlPlane.handles.issue({
      ...issueParams(), expiresAt: '2026-09-13T00:01:00.000Z'
    });
    now = new Date('2026-09-13T00:01:00.000Z');
    expect(await controlPlane.mediator.authorize(handle, writeAction)).toMatchObject({
      allowed: false, code: 'stale-generation', reason: 'Authority verification denied (stale-generation)'
    });
  });
});
