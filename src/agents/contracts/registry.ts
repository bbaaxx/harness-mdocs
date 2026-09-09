import { z, ZodType } from 'zod';

import {
  ContractEnvelope,
  ContractKind,
  contractEnvelopeSchema,
  verifyContractEnvelope
} from './envelope';
import {
  actionReceiptPayloadSchema,
  delegationTicketPayloadSchema,
  executionBlueprintPayloadSchema,
  executionModeSelectionPayloadSchema,
  executionPlanPayloadSchema,
  executionReportPayloadSchema,
  goalVerdictPayloadSchema,
  orchestrationArtifactPayloadSchema,
  planApprovalPayloadSchema,
  runCheckpointPayloadSchema,
  runRecordPayloadSchema
} from './payloads';

/** kind -> payload schema dispatch table. Unknown kinds FAIL CLOSED. */
export const CONTRACT_PAYLOAD_SCHEMAS: Readonly<Record<ContractKind, ZodType>> = Object.freeze({
  'execution-blueprint/v1': executionBlueprintPayloadSchema,
  'execution-plan/v1': executionPlanPayloadSchema,
  'orchestration-artifact/v1': orchestrationArtifactPayloadSchema,
  'plan-approval/v1': planApprovalPayloadSchema,
  'execution-mode-selection/v1': executionModeSelectionPayloadSchema,
  'run-record/v1': runRecordPayloadSchema,
  'delegation-ticket/v1': delegationTicketPayloadSchema,
  'action-receipt/v1': actionReceiptPayloadSchema,
  'execution-report/v1': executionReportPayloadSchema,
  'run-checkpoint/v1': runCheckpointPayloadSchema,
  'goal-verdict/v1': goalVerdictPayloadSchema
});

export type ContractParseResult =
  | { ok: true; envelope: ContractEnvelope }
  | { ok: false; issues: string[] };

/**
 * Validates an untrusted envelope: strict envelope shape, payload schema
 * dispatched by kind, then digest verification. FAIL-CLOSED on every axis:
 * unknown kind, unknown newer schema major, non-strict payload, or a digest
 * that does not match the sealed preimage all reject with named issues.
 */
export function parseContract(envelope: unknown): ContractParseResult {
  const shape = contractEnvelopeSchema.safeParse(envelope);
  if (!shape.success) {
    return {
      ok: false,
      issues: shape.error.issues.map(issue => `envelope.${issue.path.join('.')}: ${issue.message}`)
    };
  }

  const parsed = shape.data;
  const payloadSchema = CONTRACT_PAYLOAD_SCHEMAS[parsed.kind];
  if (!payloadSchema) {
    // Unreachable while contractKindSchema and the dispatch table stay in
    // lockstep; kept as the fail-closed unknown-kind guard.
    return { ok: false, issues: [`unknown contract kind "${parsed.kind}"`] };
  }

  const payload = payloadSchema.safeParse(parsed.payload);
  if (!payload.success) {
    return {
      ok: false,
      issues: payload.error.issues.map(issue => `payload.${issue.path.join('.')}: ${issue.message}`)
    };
  }

  const verification = verifyContractEnvelope(parsed);
  if (!verification.ok) {
    return { ok: false, issues: [verification.reason] };
  }

  return { ok: true, envelope: parsed };
}

/**
 * Compatibility policy for Run-state and contract evolution.
 * FAIL-CLOSED: an unknown newer schema major is never parsed down; state
 * written by a newer binary is preserved untouched, and previous binaries
 * cannot acquire the controller lease or mutate newer state.
 */
export const COMPATIBILITY_POLICY = Object.freeze({
  schemaVersion: 1,
  unknownKind: 'fail-closed',
  unknownNewerSchemaMajor: 'fail-closed: state preserved, never parsed down',
  previousBinary: 'cannot acquire controller lease or mutate newer state'
} as const);
