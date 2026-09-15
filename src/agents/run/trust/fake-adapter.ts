import * as crypto from 'crypto';

import {
  InMemoryProtectedStoreAdapter,
  ProtectedControllerStore,
  ProtectedControllerStoreWriter
} from '../store';
import { deriveOperationMetadataBindings } from '../evidence';

import {
  AttestationChallenge,
  AttestationChallengeParams,
  AttestationExpectedBinding,
  AttestationPairVerification,
  AttestationVerification,
  ExecutionModeSelectionEvent,
  HumanAttestationProvider,
  PlanApprovalEvent
} from './attestation';
import { TrustComponentId, TrustComponentObservation } from './fidelity';
import { createOpaqueHandle, HandleBroker, HandleInspection, HandleIssueParams, OpaqueHandle } from './handles';
import { HostIdentity, HostIdentityProvider } from './identity';
import { createRunKillSwitch, RunFeatureFlags, RunKillSwitch } from './kill-switch';
import {
  ActionMediator,
  ActionOperation,
  ResolvedActionAuthority,
  StructuredActionExecutor
} from './mediator';
import { createActionMediator } from './mediator-internal';
import { UsageEstimate, UsageMeter, UsageReservation, UsageSample } from './meter';
import { ControllerStore, createLegacyControllerStore } from './store';

export interface FakeTrustedControlPlaneOverrides {
  providerId?: string;
  providerVersion?: string;
  principalRef?: string;
  projectId?: string;
  hostSessionRef?: string;
  challengeTtlMs?: number;
  now?: () => Date;
  featureFlags?: RunFeatureFlags;
}

export interface FakeTrustedControlPlane {
  attestation: HumanAttestationProvider;
  identity: HostIdentityProvider;
  store: ControllerStore;
  mediator: ActionMediator;
  meter: UsageMeter;
  handles: HandleBroker;
  killSwitch: RunKillSwitch;
  /** Marks a component unavailable so `componentStatus` reports it not-enforced. */
  failComponent(component: TrustComponentId): void;
  componentStatus(): TrustComponentObservation[];
}

const ALL_COMPONENTS: readonly TrustComponentId[] = Object.freeze([
  'attestation',
  'host-identity',
  'controller-store',
  'action-mediation',
  'cancellation',
  'usage-metering'
]);

interface FakeChallenge {
  nonce: string;
  params: AttestationChallengeParams;
  expiresAt: Date;
  used: boolean;
}

interface IssuedEventRecord {
  kind: PlanApprovalEvent['kind'] | ExecutionModeSelectionEvent['kind'];
  snapshot: Readonly<Record<string, unknown>>;
}

/**
 * TEST-ONLY in-memory control-plane emulator for controller-core validation.
 * It does not provide process isolation, durable rollback protection, or proof
 * of production fidelity. `failComponent` scripts component outages.
 *
 * Unlike the production conservative defaults, this adapter defaults its kill
 * switch flags to enabled so effect paths are exercisable in tests; pass
 * `featureFlags` to override.
 */
export function createFakeTrustedControlPlane(
  overrides: FakeTrustedControlPlaneOverrides = {}
): FakeTrustedControlPlane {
  const providerId = overrides.providerId ?? 'fake-trusted-control-plane';
  const providerVersion = overrides.providerVersion ?? '1';
  const principalRef = overrides.principalRef ?? 'principal:fake';
  const projectId = overrides.projectId ?? 'project:fake';
  const hostSessionRef = overrides.hostSessionRef ?? 'host-session:fake';
  const challengeTtlMs = overrides.challengeTtlMs ?? 5 * 60 * 1000;
  const now = overrides.now ?? (() => new Date());

  const failed = new Set<TrustComponentId>();

  // --- handles -------------------------------------------------------------
  const inspections = new Map<OpaqueHandle, HandleInspection>();
  const handles: HandleBroker = {
    issue: (params: HandleIssueParams) => {
      const handle = createOpaqueHandle();
      inspections.set(handle, Object.freeze({ ...params, writeSetSummary: Object.freeze([...params.writeSetSummary]) }));
      return handle;
    },
    inspect: (handle: OpaqueHandle) => {
      const inspection = inspections.get(handle);
      if (!inspection) throw new Error('Unknown opaque handle');
      return inspection;
    }
  };

  // --- kill switch -----------------------------------------------------------
  const killSwitch = createRunKillSwitch(
    overrides.featureFlags ?? { routeEnabled: true, runEnabled: true }
  );

  // --- attestation -----------------------------------------------------------
  const challenges = new Map<string, FakeChallenge>();
  const revoked = new Map<string, number>();
  const issuedEventIdentities = new WeakSet<object>();
  const issuedEvents = new WeakMap<object, IssuedEventRecord>();
  const verifiedEventIds = new Set<string>();
  let revocationGeneration = 0;

  function issueEventId(): string {
    return `event:${crypto.randomUUID()}`;
  }

  function bindingFrom(challenge: FakeChallenge) {
    return {
      providerId,
      providerVersion,
      principalRef: challenge.params.principalRef,
      challengeNonce: challenge.nonce,
      planDigest: challenge.params.planDigest,
      graphDigest: challenge.params.graphDigest,
      planRevision: challenge.params.planRevision,
      projectId: challenge.params.projectId,
      hostSessionRef: challenge.params.hostSessionRef,
      issuedAt: now().toISOString(),
      expiresAt: challenge.expiresAt.toISOString(),
      revocationGeneration,
      verificationRef: `verify:${crypto.randomUUID()}`
    };
  }

  function liveChallenge(challengeId: string): FakeChallenge {
    const challenge = challenges.get(challengeId);
    if (!challenge) throw new Error(`Unknown attestation challenge "${challengeId}"`);
    if (now().getTime() >= challenge.expiresAt.getTime()) {
      throw new Error(`Attestation challenge "${challengeId}" expired`);
    }
    return challenge;
  }

  function preflightEvent(
    event: PlanApprovalEvent | ExecutionModeSelectionEvent,
    expected: AttestationExpectedBinding,
    expectedKind: PlanApprovalEvent['kind'] | ExecutionModeSelectionEvent['kind']
  ): AttestationVerification {
    if (!event || typeof event !== 'object') return { ok: false, reason: 'untrusted-origin' };
    if (!issuedEventIdentities.has(event)) return { ok: false, reason: 'untrusted-origin' };
    const issued = issuedEvents.get(event);
    if (!issued) return { ok: false, reason: 'untrusted-origin' };
    if (issued.kind !== expectedKind) return { ok: false, reason: 'kind-mismatch' };

    const eventRecord = event as unknown as Record<string, unknown>;
    const snapshotKeys = Object.keys(issued.snapshot);
    const eventKeys = Object.keys(eventRecord);
    if (
      eventKeys.length !== snapshotKeys.length ||
      snapshotKeys.some(key => eventRecord[key] !== issued.snapshot[key])
    ) {
      return { ok: false, reason: 'invalid-event' };
    }
    if (event.providerId !== providerId || event.providerVersion !== providerVersion) {
      return { ok: false, reason: 'untrusted-origin' };
    }
    if (event.kind !== issued.kind) return { ok: false, reason: 'invalid-event' };
    if (event.kind === 'plan-approval/v1' && event.decision !== 'approved') {
      return { ok: false, reason: 'decision-rejected' };
    }
    if (
      event.kind === 'execution-mode-selection/v1' &&
      event.mode !== 'milestone' && event.mode !== 'autonomous'
    ) {
      return { ok: false, reason: 'invalid-event' };
    }
    if (revoked.has(event.eventId)) return { ok: false, reason: 'revoked' };
    if (event.planDigest !== expected.planDigest || event.graphDigest !== expected.graphDigest) {
      return { ok: false, reason: 'digest-mismatch' };
    }
    if (event.planRevision !== expected.planRevision) return { ok: false, reason: 'revision-mismatch' };
    if (event.principalRef !== expected.principalRef) return { ok: false, reason: 'principal-mismatch' };
    if (event.projectId !== expected.projectId) return { ok: false, reason: 'project-mismatch' };
    if (event.hostSessionRef !== expected.hostSessionRef) {
      return { ok: false, reason: 'session-mismatch' };
    }
    if (now().getTime() >= Date.parse(event.expiresAt)) return { ok: false, reason: 'expired' };
    if (verifiedEventIds.has(event.eventId)) return { ok: false, reason: 'replayed' };
    return { ok: true };
  }

  function verifyEvent(
    event: PlanApprovalEvent | ExecutionModeSelectionEvent,
    expected: AttestationExpectedBinding,
    expectedKind: PlanApprovalEvent['kind'] | ExecutionModeSelectionEvent['kind']
  ): AttestationVerification {
    const result = preflightEvent(event, expected, expectedKind);
    if (result.ok) verifiedEventIds.add(event.eventId);
    return result;
  }

  function verifyPair(
    approval: PlanApprovalEvent,
    modeSelection: ExecutionModeSelectionEvent,
    expected: AttestationExpectedBinding
  ): AttestationPairVerification {
    const approvalResult = preflightEvent(approval, expected, 'plan-approval/v1');
    if (!approvalResult.ok) return { ...approvalResult, target: 'approval' };
    const modeResult = preflightEvent(modeSelection, expected, 'execution-mode-selection/v1');
    if (!modeResult.ok) return { ...modeResult, target: 'mode-selection' };
    if (
      approval.eventId === modeSelection.eventId ||
      approval.challengeNonce === modeSelection.challengeNonce ||
      approval.verificationRef === modeSelection.verificationRef
    ) {
      return { ok: false, target: 'pair', reason: 'invalid-event' };
    }
    verifiedEventIds.add(approval.eventId);
    verifiedEventIds.add(modeSelection.eventId);
    return { ok: true };
  }

  const attestation: HumanAttestationProvider = {
    beginChallenge: async (params: AttestationChallengeParams) => {
      if (
        params.principalRef !== principalRef ||
        params.projectId !== projectId ||
        params.hostSessionRef !== hostSessionRef
      ) {
        throw new Error('Attestation challenge identity/project/session binding mismatch');
      }
      const challengeId = crypto.randomUUID();
      const nonce = crypto.randomUUID();
      const expiresAt = new Date(now().getTime() + challengeTtlMs);
      challenges.set(challengeId, {
        nonce,
        params: { ...params },
        expiresAt,
        used: false
      });
      const challenge: AttestationChallenge = {
        challengeId,
        nonce,
        presentedDigests: Object.freeze({
          planDigest: params.planDigest,
          graphDigest: params.graphDigest
        }),
        expiresAt: expiresAt.toISOString()
      };
      return Object.freeze(challenge);
    },
    recordApproval: async (challengeId, decision) => {
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new Error(`Invalid approval decision "${String(decision)}"`);
      }
      const challenge = liveChallenge(challengeId);
      if (challenge.used) {
        throw new Error(`Replay rejected: challenge "${challengeId}" already minted an event`);
      }
      challenge.used = true;
      const event: PlanApprovalEvent = {
        kind: 'plan-approval/v1',
        eventId: issueEventId(),
        ...bindingFrom(challenge),
        decision
      };
      const frozen = Object.freeze(event);
      issuedEventIdentities.add(frozen);
      issuedEvents.set(frozen, Object.freeze({
        kind: frozen.kind,
        snapshot: Object.freeze({ ...frozen })
      }));
      return frozen;
    },
    recordModeSelection: async (challengeId, mode) => {
      if (mode !== 'milestone' && mode !== 'autonomous') {
        throw new Error(`Invalid execution mode "${String(mode)}"`);
      }
      const challenge = liveChallenge(challengeId);
      if (challenge.used) {
        throw new Error(`Replay rejected: challenge "${challengeId}" already minted an event`);
      }
      challenge.used = true;
      const event: ExecutionModeSelectionEvent = {
        kind: 'execution-mode-selection/v1',
        eventId: issueEventId(),
        ...bindingFrom(challenge),
        mode
      };
      const frozen = Object.freeze(event);
      issuedEventIdentities.add(frozen);
      issuedEvents.set(frozen, Object.freeze({
        kind: frozen.kind,
        snapshot: Object.freeze({ ...frozen })
      }));
      return frozen;
    },
    verifyApproval: (event, expected) => verifyEvent(event, expected, 'plan-approval/v1'),
    verifyModeSelection: (event, expected) =>
      verifyEvent(event, expected, 'execution-mode-selection/v1'),
    verifyPair,
    revoke: async (eventId: string, generation: number) => {
      revoked.set(eventId, generation);
      revocationGeneration = Math.max(revocationGeneration, generation);
    }
  };

  // --- identity --------------------------------------------------------------
  const bindings = new Map<OpaqueHandle, HostIdentity>();
  const identity: HostIdentityProvider = {
    currentHostIdentity: async () =>
      Object.freeze({ providerId: 'fake-host-identity', sessionRef: hostSessionRef, principalRef }),
    bindHandle: (hostIdentity: HostIdentity, handle: OpaqueHandle) => {
      if (!inspections.has(handle)) {
        throw new Error('Cannot bind identity to a handle not issued by this broker');
      }
      bindings.set(handle, Object.freeze({ ...hostIdentity }));
    },
    identityForHandle: (handle: OpaqueHandle) => bindings.get(handle) ?? null
  };

  // --- store -----------------------------------------------------------------
  const protectedStore = new ProtectedControllerStore({
    storeId: `fake:${providerId}:${projectId}`,
    adapter: new InMemoryProtectedStoreAdapter()
  });
  const writerPromise = protectedStore.openWriter();
  const sharedWriter: ProtectedControllerStoreWriter = {
    writerGeneration: 1,
    compareAndSwap: async input => (await writerPromise).compareAndSwap(input),
    append: async input => (await writerPromise).append(input),
    recover: async input => (await writerPromise).recover(input),
    resolveRecovery: async input => (await writerPromise).resolveRecovery(input)
  };
  const store: ControllerStore = createLegacyControllerStore(protectedStore, writerPromise);

  // --- mediator --------------------------------------------------------------
  const files = new Map<string, { digest: string; size: number }>();
  const operations: ActionOperation[] = [
    'fs.write', 'fs.delete', 'process.exec', 'network.request', 'git.mutate',
    'package.hook', 'agent.spawn', 'tool.invoke'
  ];
  const fakeExecutor: StructuredActionExecutor = {
    kind: 'fake-structured',
    operations,
    validate: () => true,
    requiredCredentialClasses: () => [],
    async execute(request, guard) {
      const at = now().toISOString();
      const action = request.action;
      const scope = [...action.writeSet].sort();
      const path = action.operation === 'fs.write' || action.operation === 'fs.delete'
        ? action.path : null;
      const prior = path ? files.get(path) : undefined;
      const beforeEntries = path ? [{
        path,
        kind: prior ? 'file' as const : 'missing' as const,
        contentDigest: prior?.digest ?? null,
        target: null,
        size: prior?.size ?? 0
      }] : [];
      let changed = false;
      await guard.assertCurrent();
      if (action.operation === 'fs.write') {
        changed = prior?.digest !== action.contentDigest || prior.size !== action.declaredBytes;
        files.set(action.path, { digest: action.contentDigest, size: action.declaredBytes });
      } else if (action.operation === 'fs.delete') {
        changed = files.delete(action.path);
      }
      const after = path ? files.get(path) : undefined;
      const afterEntries = path ? [{
        path,
        kind: after ? 'file' as const : 'missing' as const,
        contentDigest: after?.digest ?? null,
        target: null,
        size: after?.size ?? 0
      }] : [];
      const bindings = deriveOperationMetadataBindings(action);
      const safeBindings = Object.fromEntries(Object.entries(bindings).filter(([key]) =>
        key.endsWith('Digest') || key === 'declaredBytes' || key === 'method' || key === 'path'));
      const inputMetadata = { ...safeBindings };
      const resultMetadata = action.operation === 'fs.write' ? {
        changed, bytesWritten: action.declaredBytes,
        ...(changed ? { artifactHash: action.contentDigest } : {})
      } : action.operation === 'fs.delete' ? { changed, deleted: changed }
        : action.operation === 'agent.spawn' ? { childTicketRef: request.spawnChildTicketRef }
          : {};
      return {
        resultClass: 'success', startedAt: at, endedAt: now().toISOString(),
        actualTargets: path ? [path] : [], actualResources: [...request.declaredResources],
        inputMetadata, resultMetadata,
        workspaceBefore: { scope, entries: beforeEntries },
        workspaceAfter: { scope, entries: afterEntries },
        mutations: changed && path ? [path] : [],
        artifactHashes: action.operation === 'fs.write' && changed ? [action.contentDigest] : []
      };
    }
  };

  const mediatorHost = createActionMediator({
    reader: protectedStore.reader(),
    writer: sharedWriter,
    killSwitch,
    now,
    executors: [fakeExecutor],
    authority: {
      async verifyAndReserve(request): Promise<ResolvedActionAuthority> {
        const inspection = inspections.get(request.handle as OpaqueHandle);
        if (!inspection) {
          const error = new Error('Unknown or unissued opaque handle');
          Object.assign(error, { code: 'unknown-handle' });
          throw error;
        }
        const expiresAt = inspection.expiresAt;
        const currentMs = now().getTime();
        if (!Number.isFinite(currentMs) || currentMs >= Date.parse(expiresAt)) {
          const error = new Error('Opaque authority expired');
          Object.assign(error, { code: 'expired-ticket' });
          throw error;
        }
        const at = new Date(Date.parse(expiresAt) - 60_000).toISOString();
        return {
          runId: inspection.runId,
          projectId,
          approvedPlanDigest: `sha256:${'1'.repeat(64)}`,
          approvedGraphDigest: `sha256:${'2'.repeat(64)}`,
          graphId: inspection.graphId,
          graphRevision: 1,
          graphEpoch: inspection.generation,
          cancellationGeneration: inspection.cancellationGeneration,
          authorityKind: 'delegation-ticket',
          authorityRef: request.handle,
          parentAuthorityRef: null,
          authorityGeneration: inspection.generation,
          authorityExpiresAt: expiresAt,
          nodeId: inspection.nodeId,
          parentNodeId: 'node:root',
          issuerRole: 'PLAN_ROOT',
          recipientRole: 'EXECUTION',
          handleLineage: [request.handle],
          spawnChildTicketRef: null,
          reportDestination: `controller:${inspection.nodeId}`,
          reportSchemaRef: 'execution-report/v1',
          lease: {
            kind: 'workstream', ref: `fake-lease:${inspection.nodeId}`,
            generation: inspection.generation, fence: inspection.generation,
            acquiredAt: at, expiresAt
          },
          operationClasses: [...operations].sort(),
          toolClasses: request.operation === 'tool.invoke' ? [(request as any).tool ?? 'fake-tool'] : [],
          credentialClasses: [],
          approvalRefs: ['fake-approval'],
          approvalsCurrent: true,
          writeSet: [...inspection.writeSetSummary].sort(),
          criteria: ['fake-criterion'],
          globalActionLimit: 1024,
          localActionLimit: 1024,
          eoLineageKey: request.handle,
          eoLineageActionLimit: 1024,
          usage: {
            reservationId: `fake-budget:${request.handle}`,
            authorityInstanceId: `sha256:${'4'.repeat(64)}`,
            usageBindingDigest: `sha256:${'3'.repeat(64)}`,
            status: 'pending', startedAt: at, deadlineAt: expiresAt,
            final: null, sampleDigest: null, amounts: { toolActionsEo: 1024 },
            currency: 'USD', descendantCommitted: {}, actual: {}, measuredUsageRequired: false
          }
        };
      }
    }
  });
  const mediator: ActionMediator = mediatorHost.mediator;

  // --- meter -----------------------------------------------------------------
  const usageReservations = new Map<string, UsageReservation>();
  const committed = new Map<string, UsageSample>();
  const meter: UsageMeter = {
    reserve: async (estimate: UsageEstimate) => {
      const reservation: UsageReservation = {
        reservationId: crypto.randomUUID(),
        boundedMax: { ...estimate },
        toleratedOvershoot: 0
      };
      usageReservations.set(reservation.reservationId, reservation);
      return Object.freeze(reservation);
    },
    commit: async (reservationId: string, sample: UsageSample) => {
      if (!usageReservations.has(reservationId)) {
        throw new Error(`Unknown usage reservation "${reservationId}"`);
      }
      committed.set(reservationId, { ...sample });
    },
    sample: async (scope: string): Promise<UsageSample> => ({
      source: 'fake-trusted-control-plane',
      provider: 'fake',
      model: scope,
      inputTokens: 0,
      outputTokens: 0,
      priceTableVersion: '0',
      actionCount: 0,
      confidence: 'authoritative',
      timestamp: now().toISOString()
    })
  };

  return {
    attestation,
    identity,
    store,
    mediator,
    meter,
    handles,
    killSwitch,
    failComponent: (component: TrustComponentId) => {
      failed.add(component);
    },
    componentStatus: (): TrustComponentObservation[] =>
      ALL_COMPONENTS.map(component =>
        failed.has(component)
          ? { component, status: 'missing', reason: `scripted failure: ${component}` }
          : { component, status: 'enforced' }
      )
  };
}
