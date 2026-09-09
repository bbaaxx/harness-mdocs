import { z } from 'zod';

import {
  projectCapabilityObservationSchema,
  surfaceFidelitySchema
} from '../schema';
import { contractDigestSchema, rfc3339UtcSchema } from './envelope';
import { delegationEdgeSchema, isLegalDelegationEdge, semanticRoleSchema } from './roles';

/** Lowercase kebab-case stable identifier (plan/milestone/node keys). */
export const kebabIdSchema = z.string().regex(
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  'Expected a lowercase kebab-case identifier'
);

const stringList = z.array(z.string().min(1));
const optionalPositiveNumber = z.number().positive().optional();
const nonNegativeInt = z.number().int().nonnegative();

/**
 * execution-blueprint/v1 — output of pure Route.
 * Invariant: generated through side-effect-free Route only; carries no
 * authority and no mode selection. A blueprint can never authorize a Run.
 */
export const executionBlueprintPayloadSchema = z.object({
  requestDigest: contractDigestSchema,
  projectIdentity: z.string().min(1),
  projectRoot: z.string().min(1),
  inventoryDigest: contractDigestSchema,
  capabilityObservations: z.array(projectCapabilityObservationSchema),
  selectedRoutes: z.array(z.object({
    id: kebabIdSchema,
    reasons: stringList
  }).strict()),
  rejectedRoutes: z.array(z.object({
    id: kebabIdSchema,
    reasons: stringList
  }).strict()),
  topology: z.array(delegationEdgeSchema),
  fidelityRequirements: z.array(surfaceFidelitySchema),
  fidelityResult: surfaceFidelitySchema,
  sideEffects: stringList,
  approvalForecast: z.object({
    requiresApproval: z.boolean(),
    notes: stringList
  }).strict(),
  verification: stringList,
  fallbacks: stringList,
  unresolvedPreflightChecks: stringList
}).strict();

/**
 * execution-plan/v1 — the immutable human-approved plan.
 * Invariant: no mutable progress lives here; progress is Run state. Any
 * payload change is a material change and invalidates approval (digest).
 */
export const executionPlanPayloadSchema = z.object({
  objective: z.string().min(1),
  scope: stringList,
  outOfScope: stringList,
  milestones: z.array(z.object({
    milestoneId: kebabIdSchema,
    dependencies: z.array(kebabIdSchema),
    criteria: stringList.min(1),
    verification: z.string().min(1)
  }).strict()),
  integrationCriteria: stringList,
  regressionCriteria: stringList,
  writeSets: stringList,
  expectedSideEffects: stringList,
  policy: z.record(z.string(), z.unknown()),
  // Conservative-defaults budget table. An approved plan may lower these;
  // raising any dimension requires a new approved revision.
  budgets: z.object({
    maxActiveExecutionOrchestrators: optionalPositiveNumber,
    maxLeavesPerEO: optionalPositiveNumber,
    maxGlobalDescendants: optionalPositiveNumber,
    maxCumulativeSpawns: optionalPositiveNumber,
    retryPerNode: optionalPositiveNumber,
    globalRetries: optionalPositiveNumber,
    localFixLoops: optionalPositiveNumber,
    wallTimeMinutesRun: optionalPositiveNumber,
    wallTimeMinutesEo: optionalPositiveNumber,
    wallTimeMinutesLeaf: optionalPositiveNumber,
    toolActionsGlobal: optionalPositiveNumber,
    toolActionsEo: optionalPositiveNumber,
    toolActionsLeaf: optionalPositiveNumber,
    tokensGlobal: optionalPositiveNumber,
    tokensEo: optionalPositiveNumber,
    tokensLeaf: optionalPositiveNumber,
    costUsdGlobal: optionalPositiveNumber,
    costUsdEo: optionalPositiveNumber
  }).strict(),
  pauseRules: stringList,
  failureRules: stringList,
  cancelRules: stringList,
  completionRules: stringList
}).strict();

const orchestrationNodeSchema = z.object({
  nodeId: kebabIdSchema,
  nodeType: z.enum(['milestone', 'workstream', 'integration']),
  ownerRole: semanticRoleSchema,
  writeSet: stringList,
  isolation: z.string().min(1),
  localCriteria: stringList,
  expectedReportKind: z.string().min(1)
}).strict();

/**
 * orchestration-artifact/v1 — the delegation DAG compiled from a plan.
 * Invariants (fail-closed, all named): acyclic; no dangling edges; node
 * owner role consistent with node type (integration/milestone -> PLAN_ROOT,
 * workstream -> EXECUTION, leaf-level work -> LEAF); edges only
 * PLAN_ROOT->EXECUTION->LEAF via owner roles; every workstream bounded by
 * exactly one milestone (EO workstreams) or exactly one EO parent (leaf
 * work); integration nodes are owned by PLAN_ROOT.
 */
export const orchestrationArtifactPayloadSchema = z.object({
  planDigest: contractDigestSchema,
  nodes: z.array(orchestrationNodeSchema).min(1),
  edges: z.array(z.object({
    fromNodeId: kebabIdSchema,
    toNodeId: kebabIdSchema
  }).strict()),
  fanout: z.number().int().positive(),
  budgets: z.record(z.string(), z.number().positive()),
  adapterRequirements: stringList
}).strict().superRefine((artifact, context) => {
  const nodesById = new Map(artifact.nodes.map(node => [node.nodeId, node]));

  for (const [index, node] of artifact.nodes.entries()) {
    if (artifact.nodes.findIndex(other => other.nodeId === node.nodeId) !== index) {
      context.addIssue({
        code: 'custom',
        path: ['nodes', index, 'nodeId'],
        message: `Duplicate node id "${node.nodeId}"`
      });
    }
    const expectedOwners: Record<string, readonly string[]> = {
      milestone: ['PLAN_ROOT'],
      integration: ['PLAN_ROOT'],
      workstream: ['EXECUTION', 'LEAF']
    };
    if (!expectedOwners[node.nodeType].includes(node.ownerRole)) {
      context.addIssue({
        code: 'custom',
        path: ['nodes', index, 'ownerRole'],
        message:
          `Node "${node.nodeId}" of type "${node.nodeType}" has illegal owner ${node.ownerRole}: ` +
          'integration/milestone nodes are owned by PLAN_ROOT, workstreams by EXECUTION, ' +
          'leaf-level work by LEAF'
      });
    }
  }

  const resolvedEdges: { from: string; to: string }[] = [];
  for (const [index, edge] of artifact.edges.entries()) {
    const fromNode = nodesById.get(edge.fromNodeId);
    const toNode = nodesById.get(edge.toNodeId);
    if (!fromNode || !toNode) {
      context.addIssue({
        code: 'custom',
        path: ['edges', index],
        message:
          `Dangling edge ${edge.fromNodeId}->${edge.toNodeId}: ` +
          `${!fromNode ? edge.fromNodeId : edge.toNodeId} is not a declared node`
      });
      continue;
    }
    resolvedEdges.push({ from: edge.fromNodeId, to: edge.toNodeId });
    if (!isLegalDelegationEdge(fromNode.ownerRole, toNode.ownerRole)) {
      context.addIssue({
        code: 'custom',
        path: ['edges', index],
        message:
          `Illegal delegation edge ${edge.fromNodeId}->${edge.toNodeId} ` +
          `(${fromNode.ownerRole}->${toNode.ownerRole}): only PLAN_ROOT->EXECUTION->LEAF exists`
      });
    }
  }

  // Workstream milestone-bounding: an EO workstream has exactly one incoming
  // edge from its milestone; leaf-level work has exactly one EO parent.
  for (const node of artifact.nodes) {
    if (node.nodeType !== 'workstream') continue;
    const incoming = resolvedEdges.filter(edge => edge.to === node.nodeId);
    if (node.ownerRole === 'EXECUTION') {
      const milestoneParents = incoming.filter(
        edge => nodesById.get(edge.from)?.nodeType === 'milestone'
      );
      if (milestoneParents.length !== 1) {
        context.addIssue({
          code: 'custom',
          message:
            `Workstream "${node.nodeId}" must be bounded by exactly one milestone; ` +
            `found ${milestoneParents.length}`
        });
      }
    } else {
      const eoParents = incoming.filter(
        edge => nodesById.get(edge.from)?.ownerRole === 'EXECUTION'
      );
      if (eoParents.length !== 1) {
        context.addIssue({
          code: 'custom',
          message:
            `Leaf work node "${node.nodeId}" must have exactly one EXECUTION parent; ` +
            `found ${eoParents.length}`
        });
      }
    }
  }

  // Acyclicity (Kahn's algorithm) over edges with declared endpoints.
  const indegree = new Map<string, number>(artifact.nodes.map(node => [node.nodeId, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of resolvedEdges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const queue = artifact.nodes
    .map(node => node.nodeId)
    .filter(nodeId => (indegree.get(nodeId) ?? 0) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    visited += 1;
    for (const next of outgoing.get(nodeId) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (visited !== artifact.nodes.length) {
    context.addIssue({
      code: 'custom',
      message: 'Orchestration graph contains a cycle: delegation edges must form a DAG'
    });
  }
});

/**
 * Trusted attestation binding shared by plan-approval and mode selection.
 * NEGATIVE ORACLE: repository/wiki/model/tool output, webhooks,
 * model-callable MCP/custom tools, model-launched shell/CLI, copied JSON,
 * and forged host metadata CANNOT mint these events.
 */
const attestationBindingFields = {
  eventId: z.string().min(1),
  providerId: z.string().min(1),
  providerVersion: z.string().min(1),
  principalRef: z.string().min(1),
  challengeNonce: z.string().min(1),
  planDigest: contractDigestSchema,
  graphDigest: contractDigestSchema,
  planRevision: nonNegativeInt,
  projectId: z.string().min(1),
  hostSessionRef: z.string().min(1),
  issuedAt: rfc3339UtcSchema,
  expiresAt: rfc3339UtcSchema,
  revocationGeneration: nonNegativeInt,
  /** Host-verifiable opaque reference; workers cannot recompute or forge it. */
  verificationRef: z.string().min(1)
} as const;

/**
 * plan-approval/v1 — the trusted human approval gesture binding exact
 * plan+graph digests. Strict: a `mode` field here is rejected; mode is a
 * separate event.
 */
export const planApprovalPayloadSchema = z.object({
  ...attestationBindingFields,
  decision: z.enum(['approved', 'rejected'])
}).strict();

/**
 * execution-mode-selection/v1 — MUST be a separate trusted event from
 * approval: the same human may perform both, but each gesture has its own
 * challenge nonce and binding. There is NO DEFAULT mode. Strict: a
 * `decision` field here is rejected.
 */
export const executionModeSelectionPayloadSchema = z.object({
  ...attestationBindingFields,
  mode: z.enum(['milestone', 'autonomous'])
}).strict();

/**
 * run-record/v1 — control-plane authority record for one Run.
 * Project-local copies are non-authoritative mirrors only.
 */
export const runRecordPayloadSchema = z.object({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  approvedPlanDigest: contractDigestSchema,
  approvedGraphDigest: contractDigestSchema,
  approvalRef: z.string().min(1),
  modeSelectionRef: z.string().min(1),
  controllerIdentity: z.string().min(1),
  controllerLease: z.string().min(1),
  policySnapshot: z.record(z.string(), z.unknown()),
  capabilitySnapshot: z.record(z.string(), z.unknown()),
  adapterSnapshot: z.record(z.string(), z.unknown()),
  state: z.enum([
    'preparing',
    'awaiting-approval',
    'running',
    'paused',
    'cancelling',
    'completed',
    'failed',
    'cancelled'
  ]),
  graphEpoch: nonNegativeInt,
  cancellationGeneration: nonNegativeInt,
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema
}).strict();

/**
 * delegation-ticket/v1 — CONTROL-PLANE-ONLY authority record. The model
 * receives only the opaque handle (`ticketHandleId`); it never sees this
 * body and cannot derive scope, digests, or lineage from the handle.
 */
export const delegationTicketPayloadSchema = z.object({
  ticketHandleId: z.string().min(1),
  runId: z.string().min(1),
  graphId: z.string().min(1),
  nodeId: kebabIdSchema,
  parentNodeId: kebabIdSchema,
  generation: nonNegativeInt,
  issuerRole: semanticRoleSchema,
  recipientRole: semanticRoleSchema,
  hostIdentityRef: z.string().min(1),
  scope: z.string().min(1),
  writeSet: stringList,
  criteria: stringList,
  operationClasses: stringList,
  toolClasses: stringList,
  /** Credential grants default to EMPTY: none unless explicitly approved. */
  credentialClasses: stringList.default([]),
  approvalRefs: stringList,
  budgets: z.record(z.string(), z.number().positive()),
  allowedChildRole: semanticRoleSchema.optional(),
  maxChildDepth: nonNegativeInt,
  maxFanout: z.number().int().positive(),
  nonce: z.string().min(1),
  expiresAt: rfc3339UtcSchema,
  cancellationGeneration: nonNegativeInt,
  reportDestination: z.string().min(1),
  reportSchemaRef: z.string().min(1)
}).strict().superRefine((ticket, context) => {
  if (!isLegalDelegationEdge(ticket.issuerRole, ticket.recipientRole)) {
    context.addIssue({
      code: 'custom',
      path: ['recipientRole'],
      message:
        `Illegal delegation edge ${ticket.issuerRole}->${ticket.recipientRole}: ` +
        'only PLAN_ROOT->EXECUTION and EXECUTION->LEAF exist'
    });
  }
});

/**
 * action-receipt/v1 — post-execution evidence. Receipts are EVIDENCE, not
 * prevention. Redaction oracle: only schema-allowlisted redacted fields may
 * be persisted in input/result metadata; an unknown or sensitive field
 * causes persistence REJECTION, never best-effort masking.
 */
export const actionReceiptPayloadSchema = z.object({
  actionId: z.string().min(1),
  idempotencyId: z.string().min(1),
  handleLineage: z.array(z.string().min(1)),
  normalizedOperationDigest: contractDigestSchema,
  intentTimestamp: rfc3339UtcSchema,
  startedAt: rfc3339UtcSchema,
  endedAt: rfc3339UtcSchema,
  resultClass: z.enum(['success', 'failure', 'uncertain']),
  inputMetadata: z.record(z.string(), z.unknown()),
  resultMetadata: z.record(z.string(), z.unknown()),
  beforeFingerprint: z.string().min(1),
  afterFingerprint: z.string().min(1),
  usageReservationId: z.string().min(1),
  usageFinal: z.record(z.string(), z.unknown()).optional(),
  uncertaintyStatus: z.string().min(1).optional(),
  artifactHashes: z.array(contractDigestSchema)
}).strict();

/**
 * execution-report/v1 — a report is a CLAIM until the controller validates
 * it against tickets, leases, budgets, and receipts. Claimed success is not
 * accepted success.
 */
export const executionReportPayloadSchema = z.object({
  ticketRef: z.string().min(1),
  leaseRef: z.string().min(1),
  childLineage: z.array(z.string().min(1)),
  mutations: stringList,
  actions: z.array(z.string().min(1)),
  criterionResults: z.array(z.object({
    criterionId: z.string().min(1),
    outcome: z.enum(['met', 'unmet', 'uncertain']),
    evidenceRef: z.string().min(1).optional()
  }).strict()),
  receiptRefs: z.array(z.string().min(1)),
  evidenceRefs: z.array(z.string().min(1)),
  budgetReconciliation: z.record(z.string(), z.unknown()),
  assumptions: stringList,
  unresolvedItems: stringList,
  uncertainOutcomes: stringList,
  requestedDisposition: z.enum(['continue', 'pause', 'escalate', 'complete'])
}).strict();

/**
 * run-checkpoint/v1 — controller-owned CAS checkpoint. Written only by the
 * single continuation lease holder; workers cannot read or write it.
 */
export const runCheckpointPayloadSchema = z.object({
  casGeneration: nonNegativeInt,
  graphEpoch: nonNegativeInt,
  cancellationGeneration: nonNegativeInt,
  nodeStates: z.array(z.object({
    nodeId: kebabIdSchema,
    state: z.enum([
      'pending',
      'leased',
      'running',
      'reported',
      'accepted',
      'rejected',
      'cancelled',
      'failed'
    ])
  }).strict()),
  controllerLease: z.string().min(1),
  workstreamLeases: z.record(z.string(), z.string()),
  reservations: z.record(z.string(), z.unknown()),
  usageCommitted: z.record(z.string(), z.unknown()),
  ticketRefs: z.array(z.string().min(1)),
  completedActionIds: z.array(z.string().min(1)),
  pendingEffects: stringList,
  fingerprints: z.record(z.string(), z.string()),
  evidenceRefs: z.array(z.string().min(1)),
  reportRefs: z.array(z.string().min(1)),
  blockers: stringList,
  nextTransition: z.string().min(1),
  checksum: contractDigestSchema
}).strict();

/** goal-verdict/v1 — the controller's final accepted/rejected verdict. */
export const goalVerdictPayloadSchema = z.object({
  acceptedNodeIds: z.array(kebabIdSchema),
  integrationEvidenceRefs: z.array(z.string().min(1)),
  regressionEvidenceRefs: z.array(z.string().min(1)),
  independentReview: z.object({
    ref: z.string().min(1),
    outcome: z.string().min(1)
  }).strict().optional(),
  unresolvedItems: stringList,
  uncertainItems: stringList,
  budgetTotals: z.record(z.string(), z.number().nonnegative()),
  finalState: z.enum(['completed', 'failed', 'cancelled']),
  finalReason: z.string().min(1),
  completedAt: rfc3339UtcSchema
}).strict();

export type ExecutionBlueprintPayload = z.infer<typeof executionBlueprintPayloadSchema>;
export type ExecutionPlanPayload = z.infer<typeof executionPlanPayloadSchema>;
export type OrchestrationArtifactPayload = z.infer<typeof orchestrationArtifactPayloadSchema>;
export type PlanApprovalPayload = z.infer<typeof planApprovalPayloadSchema>;
export type ExecutionModeSelectionPayload = z.infer<typeof executionModeSelectionPayloadSchema>;
export type RunRecordPayload = z.infer<typeof runRecordPayloadSchema>;
export type DelegationTicketPayload = z.infer<typeof delegationTicketPayloadSchema>;
export type ActionReceiptPayload = z.infer<typeof actionReceiptPayloadSchema>;
export type ExecutionReportPayload = z.infer<typeof executionReportPayloadSchema>;
export type RunCheckpointPayload = z.infer<typeof runCheckpointPayloadSchema>;
export type GoalVerdictPayload = z.infer<typeof goalVerdictPayloadSchema>;
