import { OrchestrationArtifactPayload } from '../../contracts';
import {
  CompiledPlanGraph,
  GLOBAL_INTEGRATION_NODE_ID,
  validateCompiledPlanGraph
} from '../compiler';

export const RUN_CONTROLLER_PROFILE_ID = 'single-milestone-single-eo-no-leaf/v1' as const;

/** Fixed first-slice behavior. Approved free-form plan policy cannot drive transitions. */
export const RUN_CONTROLLER_POLICY = Object.freeze({
  milestoneSelection: 'first-eligible' as const,
  onUncertainty: 'pause' as const,
  onUnexpectedEvent: 'pause' as const,
  onNodeFailure: 'fail-run' as const,
  maxConcurrentMilestones: 1 as const,
  maxConcurrentExecutionOrchestrators: 1 as const,
  leafExecution: 'unsupported' as const
});

export type RunControllerPolicy = typeof RUN_CONTROLLER_POLICY;
type GraphNode = OrchestrationArtifactPayload['nodes'][number];

export type CompiledRunNode = Readonly<{
  nodeId: string;
  nodeType: GraphNode['nodeType'];
  ownerRole: GraphNode['ownerRole'];
  writeSet: readonly string[];
  isolation: string;
  localCriteria: readonly string[];
  expectedReportKind: string;
}>;

export type CompiledRunMilestone = Readonly<{
  milestoneId: string;
  dependencyIds: readonly string[];
  criteria: readonly string[];
  verification: string;
  executionOrchestratorNodeId: string;
  integrationNodeId: string;
}>;

export type CompiledRunModel = Readonly<{
  profileId: typeof RUN_CONTROLLER_PROFILE_ID;
  planKey: string;
  planRevision: number;
  planDigest: string;
  graphDigest: string;
  controllerPolicy: RunControllerPolicy;
  milestones: readonly CompiledRunMilestone[];
  globalIntegrationNodeId: string;
  nodes: readonly CompiledRunNode[];
}>;

export type RunControllerProfileValidation =
  | { ok: true }
  | { ok: false; reasons: string[] };

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function profileReasons(compiled: CompiledPlanGraph): string[] {
  const reasons: string[] = [];
  const planMilestones = compiled.plan.payload.milestones;
  const graphNodes = compiled.graph.payload.nodes;
  const milestoneNodes = graphNodes.filter(node => node.nodeType === 'milestone');
  const executionNodes = graphNodes.filter(node => node.ownerRole === 'EXECUTION');
  const leafNodes = graphNodes.filter(node => node.ownerRole === 'LEAF');
  const globalIntegrationNodes = graphNodes.filter(node => node.nodeId === GLOBAL_INTEGRATION_NODE_ID);
  const milestoneIntegrationNodes = graphNodes.filter(
    node => node.nodeType === 'integration' && node.nodeId !== GLOBAL_INTEGRATION_NODE_ID
  );

  if (planMilestones.length !== 1) {
    reasons.push(`profile requires exactly one plan milestone; found ${planMilestones.length}`);
  }
  if (milestoneNodes.length !== 1) {
    reasons.push(`profile requires exactly one graph milestone; found ${milestoneNodes.length}`);
  }
  if (executionNodes.length !== 1) {
    reasons.push(`profile requires exactly one execution orchestrator; found ${executionNodes.length}`);
  }
  if (leafNodes.length !== 0) {
    reasons.push(`profile does not support leaf nodes; found ${leafNodes.length}`);
  }
  if (milestoneIntegrationNodes.length !== 1) {
    reasons.push(
      `profile requires exactly one milestone integration node; found ${milestoneIntegrationNodes.length}`
    );
  }
  if (globalIntegrationNodes.length !== 1) {
    reasons.push(`profile requires exactly one global integration node; found ${globalIntegrationNodes.length}`);
  }
  if (planMilestones[0]?.dependencies.length !== 0) {
    reasons.push('single supported milestone cannot have dependencies');
  }

  if (milestoneNodes.length === 1 && executionNodes.length === 1 && leafNodes.length === 0) {
    const expectedEdge = `${milestoneNodes[0].nodeId}\u0000${executionNodes[0].nodeId}`;
    const edgeKeys = compiled.graph.payload.edges.map(
      edge => `${edge.fromNodeId}\u0000${edge.toNodeId}`
    );
    if (edgeKeys.length !== 1 || edgeKeys[0] !== expectedEdge) {
      reasons.push('profile requires exactly one milestone-to-execution-orchestrator edge');
    }
  }

  return reasons.sort(compareUtf16);
}

/** Fail-closed admission check for first RunController implementation profile. */
export function validateRunControllerProfile(compiled: unknown): RunControllerProfileValidation {
  const compiledValidation = validateCompiledPlanGraph(compiled);
  if (!compiledValidation.ok) {
    return {
      ok: false,
      reasons: compiledValidation.reasons.map(reason => `compiled graph invalid: ${reason}`)
    };
  }

  const reasons = profileReasons(compiled as CompiledPlanGraph);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function copyNode(node: GraphNode): CompiledRunNode {
  return {
    nodeId: node.nodeId,
    nodeType: node.nodeType,
    ownerRole: node.ownerRole,
    writeSet: [...node.writeSet],
    isolation: node.isolation,
    localCriteria: [...node.localCriteria],
    expectedReportKind: node.expectedReportKind
  };
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

/** Derives detached immutable controller input without granting runtime authority. */
export function compileRunModel(compiled: unknown): CompiledRunModel {
  const validation = validateRunControllerProfile(compiled);
  if (!validation.ok) {
    throw new Error(`Unsupported RunController profile: ${validation.reasons.join('; ')}`);
  }

  const value = compiled as CompiledPlanGraph;
  const milestone = value.plan.payload.milestones[0];
  const graphNodes = value.graph.payload.nodes;
  const executionNode = graphNodes.find(node => node.ownerRole === 'EXECUTION')!;
  const integrationNode = graphNodes.find(
    node => node.nodeType === 'integration' && node.nodeId !== GLOBAL_INTEGRATION_NODE_ID
  )!;

  return deepFreeze({
    profileId: RUN_CONTROLLER_PROFILE_ID,
    planKey: value.planKey,
    planRevision: value.planRevision,
    planDigest: value.plan.digest,
    graphDigest: value.graph.digest,
    controllerPolicy: RUN_CONTROLLER_POLICY,
    milestones: [{
      milestoneId: milestone.milestoneId,
      dependencyIds: [...milestone.dependencies],
      criteria: [...milestone.criteria],
      verification: milestone.verification,
      executionOrchestratorNodeId: executionNode.nodeId,
      integrationNodeId: integrationNode.nodeId
    }],
    globalIntegrationNodeId: GLOBAL_INTEGRATION_NODE_ID,
    nodes: graphNodes.map(copyNode).sort((left, right) => compareUtf16(left.nodeId, right.nodeId))
  });
}
