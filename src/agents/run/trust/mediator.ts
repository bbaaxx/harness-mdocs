import type { ControllerLeaseProof, WorkstreamLeaseProof } from '../authority';
import type { WorkspaceSnapshotInput } from '../evidence';
import type { ProtectedControllerStoreReader, ProtectedControllerStoreWriter } from '../store/types';

import { RunKillSwitch } from './kill-switch';
import { UsageSample } from './meter';

export type SideEffectClass = 'none' | 'workspace' | 'external' | 'credential';
export type ActionOperation =
  | 'fs.write'
  | 'fs.delete'
  | 'process.exec'
  | 'network.request'
  | 'git.mutate'
  | 'package.hook'
  | 'agent.spawn'
  | 'tool.invoke';

interface StructuredActionBase {
  writeSet: string[];
  sideEffectClass: SideEffectClass;
}

export type StructuredAction =
  | (StructuredActionBase & {
      operation: 'fs.write'; path: string; contentDigest: string; declaredBytes: number
    })
  | (StructuredActionBase & { operation: 'fs.delete'; path: string })
  | (StructuredActionBase & { operation: 'process.exec'; argv: string[] })
  | (StructuredActionBase & {
      operation: 'network.request'; url: string; method: string; payloadDigest: string
    })
  | (StructuredActionBase & { operation: 'git.mutate'; args: string[] })
  | (StructuredActionBase & { operation: 'package.hook'; hook: string })
  | (StructuredActionBase & { operation: 'agent.spawn'; agentRef: string; requestDigest: string })
  | (StructuredActionBase & { operation: 'tool.invoke'; tool: string; argumentsDigest: string });

export type ActionLeaseProof = ControllerLeaseProof | WorkstreamLeaseProof;

export interface ActionAuthorizationOptions {
  /** Caller-stable key. Reuse with different action or bindings is rejected. */
  idempotencyKey?: string;
  actionId?: string;
  adapterKind?: string;
  leaseProof?: ActionLeaseProof;
  graphEpoch?: number;
  cancellationGeneration?: number;
  approvalRefs?: readonly string[];
  credentialClasses?: readonly string[];
  declaredPaths?: readonly string[];
  declaredResources?: readonly string[];
  /** Required controller-root graph node; delegated authority already binds its node. */
  nodeId?: string;
  targetNodeId?: string;
  budgetCharge?: number;
}

export type MediationDenialCode =
  | 'invalid-request'
  | 'no-handle'
  | 'stale-generation'
  | 'policy-denied'
  | 'write-set-violation'
  | 'budget-exceeded'
  | 'approval-invalid'
  | 'cancelled'
  | 'kill-switch'
  | 'unknown-operation'
  | 'idempotency-conflict'
  | 'store-unavailable'
  | 'uncertain';

export type MediationDecision =
  | { allowed: true; reservationId: string }
  | { allowed: false; reason: string; code: MediationDenialCode };

export interface ActionUsageAuthority {
  readonly reservationId: string;
  readonly authorityInstanceId: string;
  readonly usageBindingDigest: string;
  readonly status: 'pending' | 'committed' | 'released' | 'unresolved';
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly final: UsageSample | null;
  readonly sampleDigest: string | null;
  readonly amounts: Readonly<Record<string, number>>;
  readonly currency: string;
  readonly descendantCommitted: Readonly<Record<string, number>>;
  readonly actual: Readonly<Record<string, number>>;
  readonly measuredUsageRequired: boolean;
}

export interface ResolvedActionAuthority {
  readonly runId: string;
  readonly projectId: string;
  readonly approvedPlanDigest: string;
  readonly approvedGraphDigest: string;
  readonly graphId: string;
  readonly graphRevision: number;
  readonly graphEpoch: number;
  readonly cancellationGeneration: number;
  readonly authorityKind: 'controller-root' | 'delegation-ticket';
  /** Protected opaque reference. Never projected by ActionMediator public results. */
  readonly authorityRef: string;
  readonly parentAuthorityRef: string | null;
  readonly authorityGeneration: number | null;
  readonly authorityExpiresAt: string;
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly issuerRole: 'PLAN_ROOT' | 'EXECUTION' | null;
  readonly recipientRole: 'PLAN_ROOT' | 'EXECUTION' | 'LEAF';
  readonly handleLineage: readonly string[];
  /** Protected pre-issued WP-210 child binding. Null for non-spawn actions. */
  readonly spawnChildTicketRef: string | null;
  readonly reportDestination: string;
  readonly reportSchemaRef: 'execution-report/v1';
  readonly lease: Readonly<{
    kind: 'controller' | 'workstream';
    ref: string;
    generation: number;
    fence: number;
    acquiredAt: string;
    expiresAt: string;
  }>;
  readonly operationClasses: readonly string[];
  readonly toolClasses: readonly string[];
  readonly credentialClasses: readonly string[];
  readonly approvalRefs: readonly string[];
  readonly approvalsCurrent: boolean;
  readonly writeSet: readonly string[];
  readonly criteria: readonly string[];
  readonly globalActionLimit: number;
  readonly localActionLimit: number;
  readonly eoLineageKey: string | null;
  readonly eoLineageActionLimit: number;
  readonly usage: ActionUsageAuthority;
}

export interface ActionAuthorityVerificationRequest {
  readonly phase: 'authorize' | 'pre-execute' | 'effect' | 'post-effect';
  readonly handle: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly actionDigest: string;
  readonly operation: ActionOperation;
  readonly adapterKind: string;
  readonly leaseProof?: ActionLeaseProof;
  readonly nodeId?: string;
  readonly targetNodeId?: string;
}

/** Host-only port. Implementations resolve live WP-210 authority; persisted mediator intent reserves action count. */
export interface ActionAuthorityVerifier {
  verifyAndReserve(request: ActionAuthorityVerificationRequest): Promise<ResolvedActionAuthority>;
}

export interface ActionExecutorRequest {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly actionDigest: string;
  readonly action: StructuredAction;
  readonly declaredPaths: readonly string[];
  readonly declaredResources: readonly string[];
  /** Host-only pre-issued ticket binding. Never supplied by model or descendant input. */
  readonly spawnChildTicketRef: string | null;
}

export interface ActionEffectGuard {
  /**
   * Call exactly once after preparation and immediately before protected effect.
   * Adapter must perform no await or effect between successful return and protected primitive.
   */
  assertCurrent(): Promise<void>;
}

export interface ActionExecutorResult {
  readonly resultClass: 'success' | 'failure' | 'uncertain';
  readonly uncertaintyStatus?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly actualTargets: readonly string[];
  readonly actualResources: readonly string[];
  readonly inputMetadata: Readonly<Record<string, unknown>>;
  readonly resultMetadata: Readonly<Record<string, unknown>>;
  readonly workspaceBefore: WorkspaceSnapshotInput;
  readonly workspaceAfter: WorkspaceSnapshotInput;
  readonly mutations: readonly string[];
  readonly artifactHashes: readonly string[];
}

/** Structured host adapter. Registration, not model text, selects executable implementation. */
export interface StructuredActionExecutor {
  readonly kind: string;
  readonly operations: readonly ActionOperation[];
  /** Host-owned exact request policy/schema. Model text cannot register or replace it. */
  validate(request: ActionExecutorRequest): boolean;
  /** Host-owned credential policy. Returned classes are canonicalized and bound into intent. */
  requiredCredentialClasses(request: ActionExecutorRequest): readonly string[];
  execute(request: ActionExecutorRequest, guard: ActionEffectGuard): Promise<ActionExecutorResult>;
  /** Must query authoritative external state. Absence means executing state is unrecoverably uncertain. */
  reconcile?(request: ActionExecutorRequest): Promise<ActionExecutorResult | null>;
}

export interface ActionMediatorOptions {
  readonly reader: ProtectedControllerStoreReader;
  readonly writer: ProtectedControllerStoreWriter;
  readonly authority: ActionAuthorityVerifier;
  readonly executors: readonly StructuredActionExecutor[];
  readonly killSwitch: RunKillSwitch;
  readonly now?: () => Date;
  readonly maxCasRetries?: number;
  readonly idempotencySource?: () => string;
}

export interface ActionReceiptSummary {
  readonly actionRef: string;
  readonly resultClass: 'success' | 'failure' | 'uncertain';
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly receiptRef?: string;
  readonly receiptDigest?: string;
  readonly failureReason?: string;
  readonly uncertaintyStatus?: string;
}

/**
 * Mandatory pre-effect broker. Every spawn and effect path goes through
 * `authorize` and `execute`. Both phases fail closed; `execute` revalidates
 * current authority immediately before its one allowlisted adapter call.
 */
export interface ActionMediator {
  authorize(
    handle: string,
    action: StructuredAction,
    options?: ActionAuthorizationOptions
  ): Promise<MediationDecision>;
  execute(reservationId: string): Promise<ActionReceiptSummary>;
}
