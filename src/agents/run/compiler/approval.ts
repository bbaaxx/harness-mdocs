import {
  executionModeSelectionPayloadSchema,
  planApprovalPayloadSchema
} from '../../contracts';
import {
  ExecutionModeSelectionEvent,
  HumanAttestationProvider,
  PlanApprovalEvent,
  AttestationExpectedBinding
} from '../trust';
import { CompiledPlanGraph, validateCompiledPlanGraph } from './compiler';

export type ApprovalBindingResult =
  | {
      ok: true;
      mode: 'milestone' | 'autonomous';
      approvalRef: string;
      modeSelectionRef: string;
    }
  | { ok: false; reasons: string[] };

export interface VerifyApprovalBindingParams {
  compiled: CompiledPlanGraph;
  projectId: string;
  hostSessionRef: string;
  principalRef: string;
  approval: PlanApprovalEvent;
  modeSelection: ExecutionModeSelectionEvent;
  provider: HumanAttestationProvider;
}

/** Authenticates and atomically consumes pair before reading and validating event fields. */
export function verifyApprovalBinding(params: VerifyApprovalBindingParams): ApprovalBindingResult {
  const reasons: string[] = [];
  try {
    const compiledValidation = validateCompiledPlanGraph(params.compiled);
    if (!compiledValidation.ok) {
      reasons.push(...compiledValidation.reasons.map(reason => `compiled: ${reason}`));
      return { ok: false, reasons: [...new Set(reasons)].sort() };
    }

    const expected: AttestationExpectedBinding = {
      planDigest: params.compiled.plan.digest as AttestationExpectedBinding['planDigest'],
      graphDigest: params.compiled.graph.digest as AttestationExpectedBinding['graphDigest'],
      planRevision: params.compiled.planRevision,
      principalRef: params.principalRef,
      projectId: params.projectId,
      hostSessionRef: params.hostSessionRef
    };
    // Events stay opaque until provider authentication succeeds.
    const pairVerification = params.provider.verifyPair(
      params.approval,
      params.modeSelection,
      expected
    );
    if (!pairVerification.ok) {
      return {
        ok: false,
        reasons: [`${pairVerification.target}: ${pairVerification.reason}`]
      };
    }

    const approvalRecord = params.approval && typeof params.approval === 'object'
      ? params.approval as unknown as Record<string, unknown>
      : {};
    const modeRecord = params.modeSelection && typeof params.modeSelection === 'object'
      ? params.modeSelection as unknown as Record<string, unknown>
      : {};
    const { kind: approvalKind, ...approvalBody } = approvalRecord;
    const { kind: modeKind, ...modeBody } = modeRecord;
    const approvalResult = planApprovalPayloadSchema.safeParse(approvalBody);
    const modeResult = executionModeSelectionPayloadSchema.safeParse(modeBody);
    if (!approvalResult.success) {
      reasons.push(...approvalResult.error.issues.map(
        issue => `approval.${issue.path.join('.')}: ${issue.message}`
      ));
    }
    if (!modeResult.success) {
      reasons.push(...modeResult.error.issues.map(
        issue => `modeSelection.${issue.path.join('.')}: ${issue.message}`
      ));
    }
    if (approvalKind !== 'plan-approval/v1') reasons.push('approval: kind mismatch');
    if (modeKind !== 'execution-mode-selection/v1') reasons.push('modeSelection: kind mismatch');
    if (!approvalResult.success || !modeResult.success) {
      return { ok: false, reasons: [...new Set(reasons)].sort() };
    }

    const approval = approvalResult.data;
    const mode = modeResult.data;
    if (approval.decision !== 'approved') reasons.push('approval: decision rejected');
    const expectedFields = {
      planDigest: params.compiled.plan.digest,
      graphDigest: params.compiled.graph.digest,
      planRevision: params.compiled.planRevision,
      principalRef: params.principalRef,
      projectId: params.projectId,
      hostSessionRef: params.hostSessionRef
    } as const;
    for (const [name, expected] of Object.entries(expectedFields)) {
      if (approval[name as keyof typeof expectedFields] !== expected) {
        reasons.push(`approval: ${name} mismatch`);
      }
      if (mode[name as keyof typeof expectedFields] !== expected) {
        reasons.push(`modeSelection: ${name} mismatch`);
      }
    }
    if (approval.eventId === mode.eventId) reasons.push('approval/modeSelection: event IDs must differ');
    if (approval.challengeNonce === mode.challengeNonce) {
      reasons.push('approval/modeSelection: challenge nonces must differ');
    }
    if (approval.verificationRef === mode.verificationRef) {
      reasons.push('approval/modeSelection: verification refs must differ');
    }
    if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)].sort() };

    return {
      ok: true,
      mode: mode.mode,
      approvalRef: approval.verificationRef,
      modeSelectionRef: mode.verificationRef
    };
  } catch (error) {
    return {
      ok: false,
      reasons: [`approval binding invalid: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}
