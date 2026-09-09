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
    )).toEqual({ ok: false, reason: 'digest-mismatch' });

    const graphChallenge = await controlPlane.attestation.beginChallenge(challengeParams());
    const graphEvent = await controlPlane.attestation.recordApproval(graphChallenge.challengeId, 'approved');
    expect(controlPlane.attestation.verifyApproval(
      { ...graphEvent, graphDigest: 'sha256:forged' },
      expectedBinding()
    )).toEqual({ ok: false, reason: 'digest-mismatch' });
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
      reason: expect.stringContaining('rollout halt')
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
    expect(receipt.idempotencyId).toBe(decision.reservationId);
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
});
