import type {
  ActionAuthorityVerificationRequest,
  ActionAuthorityVerifier,
  ResolvedActionAuthority
} from '../trust/mediator';
import { canonicalizeJson } from '../../contracts';

import { canonicalAuthoritySnapshot } from './state';
import {
  runAuthorityActionBackend,
  RunAuthorityManager
} from './manager';

export interface CurrentApprovalAuthority {
  /** Host trust source. Unknown, expired, or revoked refs return false or reject. */
  areCurrent(approvalRefs: readonly string[]): Promise<boolean>;
}

export interface RunAuthorityActionVerifierOptions {
  manager: RunAuthorityManager;
  approvals: CurrentApprovalAuthority;
}

function verificationBinding(authority: ResolvedActionAuthority): unknown {
  return {
    ...authority,
    approvalsCurrent: false,
    lease: { ...authority.lease, expiresAt: null },
    usage: {
      reservationId: authority.usage.reservationId,
      status: authority.usage.status,
      startedAt: authority.usage.startedAt,
      deadlineAt: authority.usage.deadlineAt,
      amounts: authority.usage.amounts,
      currency: authority.usage.currency,
      measuredUsageRequired: authority.usage.measuredUsageRequired
    }
  };
}

function bindingMatches(
  preview: ResolvedActionAuthority,
  current: ResolvedActionAuthority
): boolean {
  return canonicalizeJson(verificationBinding(preview)) ===
      canonicalizeJson(verificationBinding(current)) &&
    Date.parse(current.lease.expiresAt) >= Date.parse(preview.lease.expiresAt);
}

/** Host assembly only. Deliberately omitted from safe authority/package barrels. */
export function createRunAuthorityActionVerifier(
  options: RunAuthorityActionVerifierOptions
): ActionAuthorityVerifier {
  const backend = runAuthorityActionBackend(options.manager);
  return Object.freeze({
    async verifyAndReserve(request: ActionAuthorityVerificationRequest) {
      const previewRequest: ActionAuthorityVerificationRequest = request.phase === 'effect'
        ? { ...request, phase: 'pre-execute' }
        : request;
      const authority = await backend.verify(previewRequest);
      let approvalsCurrent = false;
      try { approvalsCurrent = await options.approvals.areCurrent(authority.approvalRefs); } catch {
        approvalsCurrent = false;
      }
      // Denied approvals never consume a LEAF ticket; the final preview still
      // closes cancellation/revocation races around the awaited provider call.
      const finalRequest = request.phase === 'effect' && !approvalsCurrent
        ? previewRequest : request;
      const current = await backend.verify(finalRequest);
      if (!bindingMatches(authority, current)) {
        throw new Error('Authority changed while approval state was checked');
      }
      let finalApprovalsCurrent = false;
      try { finalApprovalsCurrent = await options.approvals.areCurrent(current.approvalRefs); } catch {
        finalApprovalsCurrent = false;
      }
      return canonicalAuthoritySnapshot({
        ...current, approvalsCurrent: finalApprovalsCurrent
      }) as ResolvedActionAuthority;
    }
  });
}
