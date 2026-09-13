import {
  AttestationExpectedBinding,
  ExecutionModeSelectionEvent,
  PlanApprovalEvent,
  UsageEstimate,
  UsageSample
} from '../trust';

export interface AuthorityAttestationReservation {
  reservationId: string;
  idempotencyKey: string;
  expiresAt: string;
}

export type AuthorityAttestationResult =
  | {
      ok: true;
      reservationId: string;
      approvalEventId: string;
      modeSelectionEventId: string;
      approvalRef: string;
      modeSelectionRef: string;
      mode: 'milestone' | 'autonomous';
      initializationRequestDigest: string;
      projectId: string;
      hostSessionRef: string;
      principalRef: string;
      planDigest: string;
      graphDigest: string;
      planRevision: number;
    }
  | {
      ok: false;
      reservationId: string;
      reason: string;
    };

export interface AuthorityAttestationReservationRequest {
  idempotencyKey: string;
  initializationRequestDigest: string;
  approval: PlanApprovalEvent;
  modeSelection: ExecutionModeSelectionEvent;
  expected: AttestationExpectedBinding;
}

/**
 * Host-only adapter. `reservePair` authenticates both event origins before
 * returning and is idempotent by key. Verification results remain
 * reconcilable after pair consumption or process failure.
 */
export interface RecoverableAuthorityAttestationProvider {
  reservePair(
    request: AuthorityAttestationReservationRequest
  ): Promise<AuthorityAttestationReservation>;
  verifyReservedPair(reservationId: string): Promise<AuthorityAttestationResult>;
  reconcileReservedPair(reservationId: string): Promise<AuthorityAttestationResult | null>;
}

export interface AuthorityUsageScope {
  opaqueScope: string;
  runId: string;
  projectId: string;
  operationId: string;
  ticketRequestDigest: string;
  reservationId: string;
  nodeId: string;
}

export interface AuthorityUsageReservationRequest {
  idempotencyKey: string;
  scope: AuthorityUsageScope;
  estimate: UsageEstimate;
}

export interface AuthorityUsageReservation {
  providerReservationId: string;
  idempotencyKey: string;
  opaqueScope: string;
}

/**
 * Host-only hard-budget meter. Reserve and commit are idempotent; finalize is
 * stable for a provider reservation ID and never accepts caller usage data.
 */
export interface AuthorityUsageMeter {
  reserve(request: AuthorityUsageReservationRequest): Promise<AuthorityUsageReservation>;
  finalize(providerReservationId: string): Promise<UsageSample>;
  commit(providerReservationId: string, sampleDigest: string): Promise<void>;
  release(providerReservationId: string, idempotencyKey: string): Promise<void>;
}
