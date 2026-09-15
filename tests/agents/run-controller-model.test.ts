import {
  compileRunModel,
  RUN_CONTROLLER_POLICY,
  RUN_CONTROLLER_PROFILE_ID,
  validateRunControllerProfile
} from '../../src/agents/run/controller/model';
import { compilePlanGraph } from '../../src/agents/run/compiler';

function planInput(): any {
  return {
    planKey: 'controller-slice',
    planRevision: 1,
    objective: 'Exercise controller model',
    scope: ['src/**'],
    outOfScope: [],
    milestones: [{
      key: 'core',
      dependsOn: [],
      criteria: ['Core complete'],
      verification: 'npm test',
      writeSet: ['src/**'],
      integrationCriteria: ['Core integrates'],
      workstreams: [{
        key: 'runtime',
        criteria: ['Runtime complete'],
        writeSet: ['src/agents/run/**'],
        leaves: []
      }]
    }],
    integrationCriteria: ['All criteria pass'],
    regressionCriteria: ['No regressions'],
    expectedSideEffects: ['workspace writes'],
    policy: { arbitrary: { untrustedForTransitions: true } },
    adapterRequirements: ['trusted-control-plane'],
    pauseRules: ['Pause on uncertainty'],
    failureRules: ['Fail closed'],
    cancelRules: ['Revoke before drain'],
    completionRules: ['Integration passes']
  };
}

describe('compiled RunController model', () => {
  test('derives exact immutable first-slice mapping and fixed policy', () => {
    const compiled = compilePlanGraph(planInput());
    const model = compileRunModel(compiled);
    const milestoneNode = compiled.graph.payload.nodes.find(node => node.nodeType === 'milestone')!;
    const executionNode = compiled.graph.payload.nodes.find(
      node => node.nodeType === 'workstream' && node.ownerRole === 'EXECUTION'
    )!;
    const milestoneIntegrationNode = compiled.graph.payload.nodes.find(
      node => node.nodeType === 'integration' && node.expectedReportKind === 'execution-report/v1'
    )!;
    const globalIntegrationNode = compiled.graph.payload.nodes.find(
      node => node.nodeType === 'integration' && node.expectedReportKind === 'goal-verdict/v1'
    )!;

    expect(model).toEqual({
      profileId: RUN_CONTROLLER_PROFILE_ID,
      planKey: 'controller-slice',
      planRevision: 1,
      planDigest: compiled.plan.digest,
      graphDigest: compiled.graph.digest,
      controllerPolicy: {
        milestoneSelection: 'first-eligible',
        onUncertainty: 'pause',
        onUnexpectedEvent: 'pause',
        onNodeFailure: 'fail-run',
        maxConcurrentMilestones: 1,
        maxConcurrentExecutionOrchestrators: 1,
        leafExecution: 'unsupported'
      },
      milestones: [{
        milestoneId: milestoneNode.nodeId,
        dependencyIds: [],
        criteria: ['Core complete'],
        verification: 'npm test',
        executionOrchestratorNodeId: executionNode.nodeId,
        integrationNodeId: milestoneIntegrationNode.nodeId
      }],
      globalIntegrationNodeId: globalIntegrationNode.nodeId,
      nodes: compiled.graph.payload.nodes
    });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.milestones[0])).toBe(true);
    expect(Object.isFrozen(model.nodes[0].writeSet)).toBe(true);
    expect(model.controllerPolicy).toBe(RUN_CONTROLLER_POLICY);
    expect((model.controllerPolicy as any).arbitrary).toBeUndefined();
  });

  test('detaches every projected collection from mutable compiled input', () => {
    const source = JSON.parse(JSON.stringify(compilePlanGraph(planInput())));
    const model = compileRunModel(source);
    const originalModel = structuredClone(model);

    expect(model.milestones).not.toBe(source.plan.payload.milestones);
    expect(model.milestones[0]).not.toBe(source.plan.payload.milestones[0]);
    expect(model.milestones[0].dependencyIds).not.toBe(source.plan.payload.milestones[0].dependencies);
    expect(model.milestones[0].criteria).not.toBe(source.plan.payload.milestones[0].criteria);
    expect(model.nodes).not.toBe(source.graph.payload.nodes);
    for (const modelNode of model.nodes) {
      const sourceNode = source.graph.payload.nodes.find((node: any) => node.nodeId === modelNode.nodeId);
      expect(modelNode).not.toBe(sourceNode);
      expect(modelNode.writeSet).not.toBe(sourceNode.writeSet);
      expect(modelNode.localCriteria).not.toBe(sourceNode.localCriteria);
    }

    source.plan.payload.milestones[0].dependencies.push('hostile-dependency');
    source.plan.payload.milestones[0].criteria[0] = 'hostile criterion';
    source.graph.payload.nodes[0].writeSet[0] = 'hostile/**';
    source.graph.payload.nodes[0].localCriteria.push('hostile criterion');
    source.graph.payload.nodes.length = 0;
    source.plan.payload.milestones.length = 0;

    expect(model).toEqual(originalModel);
  });

  test('returns deterministic fail-closed validation for malformed compiled input', () => {
    const result = validateRunControllerProfile({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.every(reason => reason.startsWith('compiled graph invalid:'))).toBe(true);
    }
    expect(() => compileRunModel({})).toThrow(/Unsupported RunController profile/);
  });

  test('rejects multiple milestones', () => {
    const input = planInput();
    input.milestones.push({
      ...input.milestones[0],
      key: 'docs',
      writeSet: ['src/docs/**'],
      workstreams: [{
        ...input.milestones[0].workstreams[0],
        key: 'guide',
        writeSet: ['src/docs/**']
      }]
    });
    const result = validateRunControllerProfile(compilePlanGraph(input));

    expect(result).toEqual({
      ok: false,
      reasons: [
        'profile requires exactly one execution orchestrator; found 2',
        'profile requires exactly one graph milestone; found 2',
        'profile requires exactly one milestone integration node; found 2',
        'profile requires exactly one plan milestone; found 2'
      ]
    });
    if (!result.ok) expect(result.reasons).toEqual([...result.reasons].sort());
  });

  test('rejects multiple execution orchestrators', () => {
    const input = planInput();
    input.milestones[0].workstreams.push({
      key: 'tests',
      criteria: ['Tests complete'],
      writeSet: ['src/tests/**'],
      leaves: []
    });

    const result = validateRunControllerProfile(compilePlanGraph(input));
    expect(result).toEqual({
      ok: false,
      reasons: ['profile requires exactly one execution orchestrator; found 2']
    });
  });

  test('rejects leaf nodes', () => {
    const input = planInput();
    input.milestones[0].workstreams[0].leaves.push({
      key: 'worker',
      criteria: ['Worker complete'],
      writeSet: ['src/agents/run/worker.ts']
    });

    const result = validateRunControllerProfile(compilePlanGraph(input));
    expect(result).toEqual({
      ok: false,
      reasons: ['profile does not support leaf nodes; found 1']
    });
  });
});
