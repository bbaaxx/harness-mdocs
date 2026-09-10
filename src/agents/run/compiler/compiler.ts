import { z } from 'zod';

import {
  canonicalizeJson,
  ContractEnvelope,
  ExecutionPlanPayload,
  executionPlanPayloadSchema,
  kebabIdSchema,
  OrchestrationArtifactPayload,
  orchestrationArtifactPayloadSchema,
  parseCanonicalJson,
  parseContract,
  sealContract
} from '../../contracts';
import {
  assertCompilerData,
  COMPILER_RESOURCE_LIMITS,
  compareUtf16,
  normalizePlanGraphInput,
  NormalizedPlanGraphInput,
  PlanGraphInput
} from './schema';

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

export type SealedExecutionPlan = Omit<ContractEnvelope, 'kind' | 'payload'> & {
  kind: 'execution-plan/v1';
  payload: ExecutionPlanPayload;
};

export type SealedOrchestrationArtifact = Omit<ContractEnvelope, 'kind' | 'payload'> & {
  kind: 'orchestration-artifact/v1';
  payload: OrchestrationArtifactPayload;
};

export type CompiledPlanGraph = Readonly<{
  planKey: string;
  planRevision: number;
  source: NormalizedPlanGraphInput;
  plan: SealedExecutionPlan;
  graph: SealedOrchestrationArtifact;
}>;

export type CompiledPlanGraphValidation =
  | { ok: true }
  | { ok: false; reasons: string[] };

function milestoneNodeId(key: string): string {
  return `milestone-${key.length}-${key}`;
}

function workstreamNodeId(milestoneKey: string, workstreamKey: string): string {
  return `workstream-${milestoneKey.length}-${milestoneKey}-${workstreamKey.length}-${workstreamKey}`;
}

function leafNodeId(milestoneKey: string, workstreamKey: string, leafKey: string): string {
  return `leaf-${milestoneKey.length}-${milestoneKey}-${workstreamKey.length}-${workstreamKey}-${leafKey.length}-${leafKey}`;
}

function milestoneIntegrationNodeId(milestoneKey: string): string {
  return `integration-${milestoneKey.length}-${milestoneKey}`;
}

export const GLOBAL_INTEGRATION_NODE_ID = 'integration-global' as const;

function assertGeneratedId(id: string, seen: Set<string>): void {
  kebabIdSchema.parse(id);
  if (seen.has(id)) throw new Error(`Generated node ID collision: "${id}"`);
  seen.add(id);
}

function compareEdges(
  left: { fromNodeId: string; toNodeId: string },
  right: { fromNodeId: string; toNodeId: string }
): number {
  return compareUtf16(left.fromNodeId, right.fromNodeId) || compareUtf16(left.toNodeId, right.toNodeId);
}

function buildPlan(normalized: NormalizedPlanGraphInput): ExecutionPlanPayload {
  const milestoneIds = new Map(
    normalized.milestones.map(milestone => [milestone.key, milestoneNodeId(milestone.key)])
  );
  return executionPlanPayloadSchema.parse({
    objective: normalized.objective,
    scope: normalized.scope,
    outOfScope: normalized.outOfScope,
    milestones: normalized.milestones.map(milestone => ({
      milestoneId: milestoneIds.get(milestone.key)!,
      dependencies: milestone.dependsOn.map(dependency => milestoneIds.get(dependency)!).sort(compareUtf16),
      criteria: milestone.criteria,
      verification: milestone.verification
    })),
    integrationCriteria: normalized.integrationCriteria,
    regressionCriteria: normalized.regressionCriteria,
    writeSets: [...new Set(normalized.milestones.flatMap(milestone => milestone.writeSet))].sort(compareUtf16),
    expectedSideEffects: normalized.expectedSideEffects,
    policy: normalized.policy,
    budgets: normalized.budgets,
    pauseRules: normalized.pauseRules,
    failureRules: normalized.failureRules,
    cancelRules: normalized.cancelRules,
    completionRules: normalized.completionRules
  });
}

function buildGraph(
  normalized: NormalizedPlanGraphInput,
  planDigest: string
): OrchestrationArtifactPayload {
  const nodes: OrchestrationArtifactPayload['nodes'] = [];
  const edges: OrchestrationArtifactPayload['edges'] = [];
  const seenIds = new Set<string>();
  let fanout = 1;

  for (const milestone of normalized.milestones) {
    const milestoneId = milestoneNodeId(milestone.key);
    assertGeneratedId(milestoneId, seenIds);
    nodes.push({
      nodeId: milestoneId,
      nodeType: 'milestone',
      ownerRole: 'PLAN_ROOT',
      writeSet: milestone.writeSet,
      isolation: 'controller',
      localCriteria: milestone.criteria,
      expectedReportKind: 'execution-report/v1'
    });
    fanout = Math.max(fanout, milestone.workstreams.length);

    for (const workstream of milestone.workstreams) {
      const workstreamId = workstreamNodeId(milestone.key, workstream.key);
      assertGeneratedId(workstreamId, seenIds);
      nodes.push({
        nodeId: workstreamId,
        nodeType: 'workstream',
        ownerRole: 'EXECUTION',
        writeSet: workstream.writeSet,
        isolation: 'serialized',
        localCriteria: workstream.criteria,
        expectedReportKind: 'execution-report/v1'
      });
      edges.push({ fromNodeId: milestoneId, toNodeId: workstreamId });
      fanout = Math.max(fanout, workstream.leaves.length);

      for (const leaf of workstream.leaves) {
        const leafId = leafNodeId(milestone.key, workstream.key, leaf.key);
        assertGeneratedId(leafId, seenIds);
        nodes.push({
          nodeId: leafId,
          nodeType: 'workstream',
          ownerRole: 'LEAF',
          writeSet: leaf.writeSet,
          isolation: 'serialized',
          localCriteria: leaf.criteria,
          expectedReportKind: 'execution-report/v1'
        });
        edges.push({ fromNodeId: workstreamId, toNodeId: leafId });
      }
    }

    const integrationId = milestoneIntegrationNodeId(milestone.key);
    assertGeneratedId(integrationId, seenIds);
    nodes.push({
      nodeId: integrationId,
      nodeType: 'integration',
      ownerRole: 'PLAN_ROOT',
      writeSet: milestone.writeSet,
      isolation: 'controller',
      localCriteria: milestone.integrationCriteria,
      expectedReportKind: 'execution-report/v1'
    });
  }

  assertGeneratedId(GLOBAL_INTEGRATION_NODE_ID, seenIds);
  nodes.push({
    nodeId: GLOBAL_INTEGRATION_NODE_ID,
    nodeType: 'integration',
    ownerRole: 'PLAN_ROOT',
    writeSet: [...new Set(normalized.milestones.flatMap(milestone => milestone.writeSet))].sort(compareUtf16),
    isolation: 'controller',
    localCriteria: [...new Set([
      ...normalized.integrationCriteria,
      ...normalized.regressionCriteria
    ])].sort(compareUtf16),
    expectedReportKind: 'goal-verdict/v1'
  });

  return orchestrationArtifactPayloadSchema.parse({
    planDigest,
    nodes: nodes.sort((left, right) => compareUtf16(left.nodeId, right.nodeId)),
    edges: edges.sort(compareEdges),
    fanout,
    budgets: normalized.budgets,
    adapterRequirements: normalized.adapterRequirements
  });
}

function compileNormalizedPlanGraph(normalized: NormalizedPlanGraphInput): CompiledPlanGraph {
  const planPayload = buildPlan(normalized);
  const plan = sealContract(
    'execution-plan/v1',
    `plan-${normalized.planKey}`,
    planPayload
  ) as SealedExecutionPlan;
  const graphPayload = buildGraph(normalized, plan.digest);
  const graph = sealContract(
    'orchestration-artifact/v1',
    `graph-${normalized.planKey}`,
    graphPayload
  ) as SealedOrchestrationArtifact;

  const compiled: CompiledPlanGraph = {
    planKey: normalized.planKey,
    planRevision: normalized.planRevision,
    source: normalized,
    plan,
    graph
  };
  return compiled;
}

/** Compiles normalized input into sealed, mutually bound execution plan and graph envelopes. */
export function compilePlanGraph(input: unknown): CompiledPlanGraph {
  const compiled = compileNormalizedPlanGraph(normalizePlanGraphInput(input));
  const validation = validateCompiledPlanGraph(compiled);
  if (!validation.ok) throw new Error(`Compiler produced invalid plan/graph: ${validation.reasons.join('; ')}`);
  return deepFreeze(compiled);
}

/** Raw JSON entrypoint rejects duplicate/escape-aliased keys and non-I-JSON before Zod parsing. */
export function compilePlanGraphJson(rawJson: string): CompiledPlanGraph {
  const bytes = Buffer.byteLength(rawJson, 'utf8');
  if (bytes > COMPILER_RESOURCE_LIMITS.rawJsonBytes) {
    throw new Error(
      `Compiler raw JSON exceeds maximum byte length ${COMPILER_RESOURCE_LIMITS.rawJsonBytes}`
    );
  }
  assertRawJsonDepth(rawJson);
  return compilePlanGraph(parseCanonicalJson(rawJson));
}

function assertRawJsonDepth(rawJson: string): void {
  const maximum = COMPILER_RESOURCE_LIMITS.depth + 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of rawJson) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > maximum) throw new Error(`Compiler raw JSON exceeds maximum depth ${maximum}`);
    } else if (character === '}' || character === ']') {
      depth -= 1;
    }
  }
}

function milestoneIntegrationIdFromPlanId(id: string): string | undefined {
  const match = /^milestone-(\d+)-(.+)$/.exec(id);
  if (!match || Number(match[1]) !== match[2].length || !kebabIdSchema.safeParse(match[2]).success) {
    return undefined;
  }
  return milestoneIntegrationNodeId(match[2]);
}

function issueReasons(prefix: string, issues: z.core.$ZodIssue[]): string[] {
  return issues.map(issue => `${prefix}.${issue.path.join('.')}: ${issue.message}`);
}

/** Pure fail-closed validation for an untrusted compiled pair; malformed values never throw. */
export function validateCompiledPlanGraph(compiled: unknown): CompiledPlanGraphValidation {
  const reasons: string[] = [];
  try {
    assertCompilerData(compiled, {
      maxDepth: COMPILER_RESOURCE_LIMITS.depth + 8,
      maxValues: COMPILER_RESOURCE_LIMITS.traversedValues * 5
    });
    if (!compiled || typeof compiled !== 'object' || Array.isArray(compiled)) {
      return { ok: false, reasons: ['compiled: expected object'] };
    }
    const value = compiled as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== ['graph', 'plan', 'planKey', 'planRevision', 'source'].sort().join(',')) {
      reasons.push('compiled: expected exactly graph, plan, planKey, planRevision, and source');
    }
    const keyResult = kebabIdSchema.safeParse(value.planKey);
    if (!keyResult.success) reasons.push(...issueReasons('compiled.planKey', keyResult.error.issues));
    const revisionResult = z.number().int().positive().safe().safeParse(value.planRevision);
    if (!revisionResult.success) {
      reasons.push(...issueReasons('compiled.planRevision', revisionResult.error.issues));
    }

    const normalizedSource = normalizePlanGraphInput(value.source);
    if (canonicalizeJson(normalizedSource) !== canonicalizeJson(value.source)) {
      reasons.push('compiled.source: source is not exactly normalized');
    }
    if (keyResult.success && normalizedSource.planKey !== keyResult.data) {
      reasons.push('compiled.source: planKey does not match compiled planKey');
    }
    if (revisionResult.success && normalizedSource.planRevision !== revisionResult.data) {
      reasons.push('compiled.source: planRevision does not match compiled planRevision');
    }
    const expected = compileNormalizedPlanGraph(normalizedSource);

    const planResult = parseContract(value.plan);
    const graphResult = parseContract(value.graph);
    if (!planResult.ok) reasons.push(...planResult.issues.map(issue => `plan: ${issue}`));
    if (!graphResult.ok) reasons.push(...graphResult.issues.map(issue => `graph: ${issue}`));
    if (!planResult.ok || !graphResult.ok) {
      return { ok: false, reasons: [...new Set(reasons)].sort() };
    }

    const plan = planResult.envelope;
    const graph = graphResult.envelope;
    if (plan.kind !== 'execution-plan/v1') reasons.push('plan: kind must be execution-plan/v1');
    if (graph.kind !== 'orchestration-artifact/v1') {
      reasons.push('graph: kind must be orchestration-artifact/v1');
    }
    if (keyResult.success) {
      if (plan.id !== `plan-${keyResult.data}`) reasons.push('plan: id does not match planKey');
      if (graph.id !== `graph-${keyResult.data}`) reasons.push('graph: id does not match planKey');
    }
    if (plan.kind !== 'execution-plan/v1' || graph.kind !== 'orchestration-artifact/v1') {
      return { ok: false, reasons: [...new Set(reasons)].sort() };
    }

    const planPayloadResult = executionPlanPayloadSchema.safeParse(plan.payload);
    const graphPayloadResult = orchestrationArtifactPayloadSchema.safeParse(graph.payload);
    if (!planPayloadResult.success || !graphPayloadResult.success) {
      if (!planPayloadResult.success) reasons.push(...issueReasons('plan.payload', planPayloadResult.error.issues));
      if (!graphPayloadResult.success) reasons.push(...issueReasons('graph.payload', graphPayloadResult.error.issues));
      return { ok: false, reasons: [...new Set(reasons)].sort() };
    }
    const planPayload = planPayloadResult.data;
    const graphPayload = graphPayloadResult.data;
    if (graphPayload.planDigest !== plan.digest) reasons.push('graph: planDigest does not match plan digest');

    const expectedMilestones = new Set(planPayload.milestones.map(milestone => milestone.milestoneId));
    if (expectedMilestones.size !== planPayload.milestones.length) {
      reasons.push('plan: duplicate milestone id');
    }
    const actualMilestones = graphPayload.nodes
      .filter(node => node.nodeType === 'milestone')
      .map(node => node.nodeId);
    if (
      actualMilestones.length !== expectedMilestones.size ||
      actualMilestones.some(id => !expectedMilestones.has(id))
    ) {
      reasons.push('graph: milestone nodes do not exactly match plan milestones');
    }
    const graphNodesById = new Map(graphPayload.nodes.map(node => [node.nodeId, node]));
    for (const milestone of planPayload.milestones) {
      const graphNode = graphNodesById.get(milestone.milestoneId);
      if (graphNode && canonicalArrayKey(graphNode.localCriteria) !== canonicalArrayKey(milestone.criteria)) {
        reasons.push(`graph: milestone "${milestone.milestoneId}" criteria do not match plan`);
      }
    }

    const expectedIntegrations = new Set<string>([GLOBAL_INTEGRATION_NODE_ID]);
    for (const milestoneId of expectedMilestones) {
      const integrationId = milestoneIntegrationIdFromPlanId(milestoneId);
      if (!integrationId) reasons.push(`plan: invalid generated milestone id "${milestoneId}"`);
      else expectedIntegrations.add(integrationId);
    }
    const actualIntegrations = graphPayload.nodes
      .filter(node => node.nodeType === 'integration')
      .map(node => node.nodeId);
    if (
      actualIntegrations.length !== expectedIntegrations.size ||
      actualIntegrations.some(id => !expectedIntegrations.has(id))
    ) {
      reasons.push('graph: integration nodes do not exactly match required milestone/global integrations');
    }

    const edgeKeys = graphPayload.edges.map(edge => `${edge.fromNodeId}\u0000${edge.toNodeId}`);
    if (new Set(edgeKeys).size !== edgeKeys.length) reasons.push('graph: duplicate edge');

    for (const node of graphPayload.nodes) {
      const expectedIsolation = node.ownerRole === 'PLAN_ROOT' ? 'controller' : 'serialized';
      if (node.isolation !== expectedIsolation) {
        reasons.push(`graph: node "${node.nodeId}" must use ${expectedIsolation} isolation`);
      }
      const expectedReport = node.nodeId === GLOBAL_INTEGRATION_NODE_ID
        ? 'goal-verdict/v1'
        : 'execution-report/v1';
      if (node.expectedReportKind !== expectedReport) {
        reasons.push(`graph: node "${node.nodeId}" must report ${expectedReport}`);
      }
    }
    if (canonicalizeJson(plan) !== canonicalizeJson(expected.plan)) {
      reasons.push('plan: envelope does not exactly match deterministic source derivation');
    }
    if (canonicalizeJson(graph) !== canonicalizeJson(expected.graph)) {
      reasons.push('graph: envelope does not exactly match deterministic source derivation');
    }
  } catch (error) {
    reasons.push(`compiled: invalid value: ${error instanceof Error ? error.message : String(error)}`);
  }
  return reasons.length === 0
    ? { ok: true }
    : { ok: false, reasons: [...new Set(reasons)].sort() };
}

function canonicalArrayKey(values: readonly string[]): string {
  return JSON.stringify([...values].sort(compareUtf16));
}

export type { PlanGraphInput };
