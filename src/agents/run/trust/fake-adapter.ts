import * as crypto from 'crypto';

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
  ActionReceiptSummary,
  MediationDecision,
  StructuredAction
} from './mediator';
import { UsageEstimate, UsageMeter, UsageReservation, UsageSample } from './meter';
import { CasConflictError, CasRecord, ControllerStore } from './store';

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
 * Fully in-memory trusted control plane for controller-core validation and
 * dogfooding. This adapter IS trusted; `failComponent` scripts individual
 * component outages to prove deterministic plan-only downgrades.
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
  const records = new Map<string, CasRecord<unknown>>();
  const logs = new Map<string, unknown[]>();
  const store: ControllerStore = {
    get: async <T>(key: string) => records.get(key) as CasRecord<T> | undefined,
    compareAndSwap: async <T>(key: string, value: T, expectedGeneration: number) => {
      const current = records.get(key)?.generation ?? 0;
      if (current !== expectedGeneration) {
        throw new CasConflictError(
          `CAS conflict on "${key}": expected generation ${expectedGeneration}, found ${current}`
        );
      }
      const generation = current + 1;
      const checksum = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
      records.set(key, { value, generation, checksum: `sha256:${checksum}` });
      return generation;
    },
    append: async <T>(key: string, entry: T) => {
      const log = logs.get(key) ?? [];
      log.push(entry);
      logs.set(key, log);
    },
    list: async (prefix: string) =>
      [...records.keys(), ...logs.keys()].filter(key => key.startsWith(prefix)).sort()
  };

  // --- mediator --------------------------------------------------------------
  const reservations = new Map<string, { handle: OpaqueHandle; action: StructuredAction }>();
  const mediator: ActionMediator = {
    authorize: async (handle: OpaqueHandle, action: StructuredAction): Promise<MediationDecision> => {
      if (!killSwitch.effectsAllowed()) {
        return {
          allowed: false,
          code: 'kill-switch',
          reason: killSwitch.disableReason() ?? 'Run effects are disabled by feature flags'
        };
      }
      if (!inspections.has(handle)) {
        return { allowed: false, code: 'no-handle', reason: 'Unknown or unissued opaque handle' };
      }
      const reservationId = crypto.randomUUID();
      reservations.set(reservationId, { handle, action });
      // Intent is persisted BEFORE any effect.
      await store.append(`intent/${inspections.get(handle)!.runId}`, {
        reservationId,
        operation: action.operation,
        persistedAt: now().toISOString()
      });
      return { allowed: true, reservationId };
    },
    execute: async (reservationId: string): Promise<ActionReceiptSummary> => {
      const reservation = reservations.get(reservationId);
      if (!reservation) throw new Error(`Unknown action reservation "${reservationId}"`);
      const startedAt = now().toISOString();
      const receipt: ActionReceiptSummary = {
        actionId: `action:${crypto.randomUUID()}`,
        idempotencyId: reservationId,
        resultClass: 'success',
        startedAt,
        endedAt: now().toISOString()
      };
      await store.append(`receipt/${inspections.get(reservation.handle)!.runId}`, receipt);
      return receipt;
    },
    cancel: async (runId: string, generation: number) => {
      await store.append(`cancellation/${runId}`, { generation, at: now().toISOString() });
    }
  };

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
