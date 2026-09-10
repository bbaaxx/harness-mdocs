/** SHA-256 digest of a canonicalized contract payload (RFC 8785 preimage). */
export type Digest = `sha256:${string}`;

/** RFC3339 UTC timestamp with `Z` suffix. */
export type Rfc3339Utc = string;

interface AttestationBinding {
  eventId: string;
  providerId: string;
  providerVersion: string;
  principalRef: string;
  challengeNonce: string;
  planDigest: Digest;
  graphDigest: Digest;
  planRevision: number;
  projectId: string;
  hostSessionRef: string;
  issuedAt: Rfc3339Utc;
  expiresAt: Rfc3339Utc;
  revocationGeneration: number;
  /** Host-verifiable opaque reference; workers cannot recompute or forge it. */
  verificationRef: string;
}

export interface PlanApprovalEvent extends AttestationBinding {
  kind: 'plan-approval/v1';
  decision: 'approved' | 'rejected';
}

/**
 * Mode selection MUST be a separate trusted event from approval: the same
 * human may perform both, but each requires its own gesture, nonce, and
 * binding. There is no default mode.
 */
export interface ExecutionModeSelectionEvent extends AttestationBinding {
  kind: 'execution-mode-selection/v1';
  mode: 'milestone' | 'autonomous';
}

export interface AttestationChallenge {
  challengeId: string;
  nonce: string;
  presentedDigests: { planDigest: Digest; graphDigest: Digest };
  expiresAt: Rfc3339Utc;
}

export interface AttestationChallengeParams {
  planDigest: Digest;
  graphDigest: Digest;
  planRevision: number;
  projectId: string;
  hostSessionRef: string;
  principalRef: string;
}

export interface AttestationExpectedBinding {
  planDigest: Digest;
  graphDigest: Digest;
  planRevision: number;
  principalRef: string;
  projectId: string;
  hostSessionRef: string;
}

export type AttestationVerificationFailureReason =
  | 'digest-mismatch'
  | 'revision-mismatch'
  | 'principal-mismatch'
  | 'project-mismatch'
  | 'session-mismatch'
  | 'kind-mismatch'
  | 'decision-rejected'
  | 'invalid-event'
  | 'expired'
  | 'revoked'
  | 'replayed'
  | 'untrusted-origin';

export type AttestationVerification =
  | { ok: true }
  | {
      ok: false;
      reason: AttestationVerificationFailureReason;
    };

export type AttestationPairVerification =
  | { ok: true }
  | {
      ok: false;
      target: 'approval' | 'mode-selection' | 'pair';
      reason: AttestationVerificationFailureReason;
    };

/**
 * Trusted human attestation. NEGATIVE ORACLE: repository/wiki/model/tool
 * output, webhooks, model-callable MCP or custom tools, shell/CLI launched by
 * the model, copied JSON, and forged host metadata CANNOT mint attestation.
 * Only the trusted host UI/control channel implementing this interface can.
 * Material plan/graph/policy change, project change, expiry, revocation, or
 * replay invalidates an event.
 */
export interface HumanAttestationProvider {
  beginChallenge(params: AttestationChallengeParams): Promise<AttestationChallenge>;
  recordApproval(
    challengeId: string,
    decision: 'approved' | 'rejected'
  ): Promise<PlanApprovalEvent>;
  recordModeSelection(
    challengeId: string,
    mode: 'milestone' | 'autonomous'
  ): Promise<ExecutionModeSelectionEvent>;
  verifyApproval(
    event: PlanApprovalEvent,
    expected: AttestationExpectedBinding
  ): AttestationVerification;
  verifyModeSelection(
    event: ExecutionModeSelectionEvent,
    expected: AttestationExpectedBinding
  ): AttestationVerification;
  /**
   * Atomically verifies and consumes both gestures, or consumes neither.
   * Implementations MUST authenticate opaque/signature/object identity before
   * reflecting on or reading any fields from untrusted event arguments.
   */
  verifyPair(
    approval: PlanApprovalEvent,
    modeSelection: ExecutionModeSelectionEvent,
    expected: AttestationExpectedBinding
  ): AttestationPairVerification;
  revoke(eventId: string, generation: number): Promise<void>;
}
