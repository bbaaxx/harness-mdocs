import * as fs from 'fs';
import * as path from 'path';

import {
  assertCompilerData,
  canonicalizeJson,
  COMPILER_RESOURCE_LIMITS,
  compilePlanGraph,
  compilePlanGraphJson,
  createFakeTrustedControlPlane,
  normalizePlanGraphInput,
  sealContract,
  validateCompiledPlanGraph,
  verifyApprovalBinding,
  writeSelectorCovers,
  writeSelectorsOverlap
} from '../../src/agents';

const GOLDEN = path.join(__dirname, '..', 'fixtures', 'agents', 'compiler', 'golden');

function goldenInput(): any {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN, 'multi-milestone-input.json'), 'utf8'));
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value)) as T;
}

function resealGraph(compiled: any, change: (payload: any) => void): any {
  const payload = clone(compiled.graph.payload);
  change(payload);
  return {
    ...compiled,
    graph: sealContract('orchestration-artifact/v1', compiled.graph.id, payload)
  };
}

async function attest(compiled: any, overrides: Record<string, unknown> = {}) {
  const controlPlane = createFakeTrustedControlPlane(overrides);
  const params = {
    planDigest: compiled.plan.digest,
    graphDigest: compiled.graph.digest,
    planRevision: compiled.planRevision,
    projectId: 'project:fake',
    hostSessionRef: 'host-session:fake',
    principalRef: 'principal:fake'
  } as const;
  const approvalChallenge = await controlPlane.attestation.beginChallenge(params);
  const approval = await controlPlane.attestation.recordApproval(approvalChallenge.challengeId, 'approved');
  const modeChallenge = await controlPlane.attestation.beginChallenge(params);
  const modeSelection = await controlPlane.attestation.recordModeSelection(
    modeChallenge.challengeId,
    'autonomous'
  );
  return { controlPlane, approval, modeSelection };
}

describe('plan/graph normalization and compilation', () => {
  test('golden multi-milestone envelopes match exact canonical fixture bytes and literal digests', () => {
    const compiled = compilePlanGraph(goldenInput());
    const planBytes = fs.readFileSync(path.join(GOLDEN, 'multi-milestone-plan.json'), 'utf8');
    const graphBytes = fs.readFileSync(path.join(GOLDEN, 'multi-milestone-graph.json'), 'utf8');

    expect(`${canonicalizeJson(compiled.plan)}\n`).toBe(planBytes);
    expect(`${canonicalizeJson(compiled.graph)}\n`).toBe(graphBytes);
    expect(compiled.plan.digest).toBe(
      'sha256:79c2201fbb7a47a0dea0d7452e457ca9cca944e0f2e7d56cf202f8c35a746986'
    );
    expect(compiled.graph.digest).toBe(
      'sha256:07b955fc6cd857a1ed64d5e8daebbaa77bb19120e954338613f7f0f5480a5744'
    );
  });

  test('permutations and object insertion order produce byte-identical payloads and digests', () => {
    const first = goldenInput();
    const permuted = Object.fromEntries(Object.entries(goldenInput()).reverse()) as any;
    permuted.scope.reverse();
    permuted.milestones.reverse();
    permuted.policy = { review: { required: true }, network: 'deny' };
    for (const milestone of permuted.milestones) {
      milestone.criteria.reverse();
      milestone.dependsOn.reverse();
      milestone.workstreams.reverse();
    }

    const expected = compilePlanGraph(first);
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const actual = compilePlanGraph(permuted);
      expect(canonicalizeJson(actual.plan)).toBe(canonicalizeJson(expected.plan));
      expect(canonicalizeJson(actual.graph)).toBe(canonicalizeJson(expected.graph));
    }
  });

  test('topological milestone order uses UTF-16 lexical ties and keeps dependencies out of graph edges', () => {
    const input = goldenInput();
    const docs = input.milestones[0];
    docs.dependsOn = [];
    const compiled = compilePlanGraph(input);

    expect(compiled.plan.payload.milestones.map((item: any) => item.milestoneId)).toEqual([
      'milestone-4-core',
      'milestone-4-docs'
    ]);
    expect(compiled.graph.payload.edges.every((edge: any) =>
      !edge.fromNodeId.startsWith('milestone-4-core') ||
      edge.toNodeId.startsWith('workstream-4-core-'))).toBe(true);
  });

  test('derives exact bounded nodes/edges and graph binds sealed plan digest', () => {
    const compiled = compilePlanGraph(goldenInput());
    expect(compiled.graph.payload.planDigest).toBe(compiled.plan.digest);
    expect(compiled.graph.payload.edges).toEqual([
      { fromNodeId: 'milestone-4-core', toNodeId: 'workstream-4-core-3-api' },
      { fromNodeId: 'milestone-4-docs', toNodeId: 'workstream-4-docs-5-guide' },
      { fromNodeId: 'workstream-4-core-3-api', toNodeId: 'leaf-4-core-3-api-7-handler' }
    ]);
    expect(compiled.graph.payload.nodes).toHaveLength(8);
    expect(validateCompiledPlanGraph(compiled)).toEqual({ ok: true });
  });

  test('fills complete defaults, accepts lower overrides, and computes union plan writeSets', () => {
    const input = goldenInput();
    input.budgets = { maxLeavesPerEO: 1, costUsdGlobal: 1 };
    const compiled = compilePlanGraph(input);
    expect(Object.keys(compiled.plan.payload.budgets)).toHaveLength(18);
    expect(compiled.plan.payload.budgets.maxLeavesPerEO).toBe(1);
    expect(compiled.plan.payload.budgets.wallTimeMinutesRun).toBe(60);
    expect(compiled.plan.payload.writeSets).toEqual(['docs/**', 'src/**']);
  });

  test('enforces static descendants against default, lower, and approved higher global caps', () => {
    const crowded = goldenInput();
    for (const key of ['extra-a', 'extra-b', 'extra-c', 'extra-d']) {
      crowded.milestones[1].workstreams.push({
        key,
        criteria: [`${key} complete`],
        writeSet: ['src/compiler/**'],
        leaves: []
      });
    }
    expect(() => compilePlanGraph(crowded)).toThrow(/7 exceeds maxGlobalDescendants 6/);
    crowded.budgets = { maxGlobalDescendants: 7 };
    expect(compilePlanGraph(crowded).graph.payload.nodes).toHaveLength(12);

    const lowered = goldenInput();
    lowered.budgets = { maxGlobalDescendants: 2 };
    expect(() => compilePlanGraph(lowered)).toThrow(/3 exceeds maxGlobalDescendants 2/);
  });

  test('write selector coverage and overlap follow exact versus recursive semantics', () => {
    expect(writeSelectorCovers('src/**', 'src')).toBe(true);
    expect(writeSelectorCovers('src/**', 'src/a.ts')).toBe(true);
    expect(writeSelectorCovers('src/a.ts', 'src/a.ts')).toBe(true);
    expect(writeSelectorCovers('src/a.ts', 'src/a.ts/**')).toBe(false);
    expect(writeSelectorsOverlap('src/a/**', 'src/a/file.ts')).toBe(true);
    expect(writeSelectorsOverlap('src/a/**', 'src/ab/file.ts')).toBe(false);
  });

  test('sibling write overlap is legal and compiler assigns serialized isolation', () => {
    const input = goldenInput();
    input.milestones[1].workstreams.push({
      key: 'also-api',
      criteria: ['Also API'],
      writeSet: ['src/compiler/**'],
      leaves: []
    });
    const compiled = compilePlanGraph(input);
    const descendants = compiled.graph.payload.nodes.filter((node: any) =>
      node.ownerRole === 'EXECUTION' || node.ownerRole === 'LEAF');
    expect(descendants.every((node: any) => node.isolation === 'serialized')).toBe(true);
  });

  test('generated IDs remain collision-free for ambiguous raw concatenation attempts', () => {
    const input = goldenInput();
    input.milestones[1].workstreams.push({
      key: 'api-7-handler',
      criteria: ['Separate workstream'],
      writeSet: ['src/compiler/**'],
      leaves: []
    });
    const ids = compilePlanGraph(input).graph.payload.nodes.map((node: any) => node.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('leaf-4-core-3-api-7-handler');
    expect(ids).toContain('workstream-4-core-13-api-7-handler');
  });

  test('normalization detaches and deeply freezes without mutating input', () => {
    const input = goldenInput();
    const before = clone(input);
    const normalized = normalizePlanGraphInput(input);
    const compiled = compilePlanGraph(input);
    expect(input).toEqual(before);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.milestones[0].workstreams[0])).toBe(true);
    expect(Object.isFrozen(normalized.policy.review)).toBe(true);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.graph.payload.nodes[0])).toBe(true);
  });

  test('material changes change digest while revision-only changes do not', () => {
    const first = goldenInput();
    const changed = goldenInput();
    changed.objective = 'Changed objective';
    const revised = goldenInput();
    revised.planRevision += 1;
    const original = compilePlanGraph(first);
    expect(compilePlanGraph(changed).plan.digest).not.toBe(original.plan.digest);
    expect(compilePlanGraph(revised).plan.digest).toBe(original.plan.digest);
    expect(compilePlanGraph(revised).graph.digest).toBe(original.graph.digest);
  });

  test('raw JSON entry rejects duplicate, escape-aliased, and non-I-JSON values before schema parsing', () => {
    const raw = fs.readFileSync(path.join(GOLDEN, 'multi-milestone-input.json'), 'utf8');
    expect(compilePlanGraphJson(raw)).toEqual(compilePlanGraph(JSON.parse(raw)));
    expect(() => compilePlanGraphJson('{"planKey":"x","planKey":"y"}')).toThrow(/duplicate/);
    expect(() => compilePlanGraphJson('{"planKey":"x","\u0070lanKey":"y"}')).toThrow(/duplicate/);
    expect(() => compilePlanGraphJson('{"n":1e400}')).toThrow(/non-finite/);
  });

  test('raw JSON byte limit accepts exact boundary and rejects one byte over before parsing', () => {
    const raw = fs.readFileSync(path.join(GOLDEN, 'multi-milestone-input.json'), 'utf8');
    const bytes = Buffer.byteLength(raw, 'utf8');
    const boundary = raw + ' '.repeat(COMPILER_RESOURCE_LIMITS.rawJsonBytes - bytes);
    expect(compilePlanGraphJson(boundary).plan.digest).toBe(compilePlanGraphJson(raw).plan.digest);
    expect(() => compilePlanGraphJson(`${boundary} `)).toThrow(/maximum byte length/);
    expect(() => compilePlanGraphJson(
      '['.repeat(COMPILER_RESOURCE_LIMITS.depth + 2)
    )).toThrow(/raw JSON exceeds maximum depth/);
  });
});

describe('strict compiler rejection', () => {
  test.each([
    ['duplicate milestone', (input: any) => input.milestones.push(clone(input.milestones[0])), /duplicate milestone/i],
    ['duplicate workstream', (input: any) => input.milestones[0].workstreams.push(clone(input.milestones[0].workstreams[0])), /duplicate workstream/i],
    ['duplicate leaf', (input: any) => input.milestones[1].workstreams[0].leaves.push(clone(input.milestones[1].workstreams[0].leaves[0])), /duplicate leaf/i],
    ['duplicate dependency', (input: any) => input.milestones[0].dependsOn.push('core'), /duplicate dependency/i],
    ['dangling dependency', (input: any) => input.milestones[0].dependsOn = ['ghost'], /dangling dependency/i],
    ['self dependency', (input: any) => input.milestones[0].dependsOn = ['docs'], /depends on itself/i],
    ['cyclic dependencies', (input: any) => input.milestones[1].dependsOn = ['docs'], /cycle/i],
    ['empty criteria', (input: any) => input.milestones[0].criteria = [], /too small|at least/i],
    ['empty write set', (input: any) => input.milestones[0].writeSet = [], /too small|at least/i],
    ['empty workstreams', (input: any) => input.milestones[0].workstreams = [], /too small|at least/i],
    ['milestone expansion', (input: any) => input.milestones[0].writeSet = ['other/**'], /beyond.*parent/i],
    ['workstream expansion', (input: any) => input.milestones[1].workstreams[0].writeSet = ['docs/**'], /beyond.*parent/i],
    ['leaf expansion', (input: any) => input.milestones[1].workstreams[0].leaves[0].writeSet = ['src/other.ts'], /beyond.*parent/i],
    ['out-of-scope overlap', (input: any) => input.outOfScope = ['src/compiler/**'], /overlaps outOfScope/i],
    ['leaf budget overflow', (input: any) => input.budgets = { maxLeavesPerEO: 0.5 }, /maxLeavesPerEO/i],
    ['cumulative budget overflow', (input: any) => input.budgets = { maxCumulativeSpawns: 2 }, /maxCumulativeSpawns/i]
  ])('rejects %s', (_label, mutate, expected) => {
    const input = goldenInput();
    mutate(input);
    expect(() => compilePlanGraph(input)).toThrow(expected);
  });

  test.each([
    '/absolute', '~/home', 'C:/drive', 'src\\file.ts', 'src//file.ts',
    'src/./file.ts', 'src/../file.ts', 'src/*.ts', 'src/**/file.ts', 'src/file?.ts', 'src/{a,b}.ts',
    'src/\u0000file.ts', 'src/\u202efile.ts', 'src/'
  ])('rejects invalid write selector %p', selector => {
    const input = goldenInput();
    input.scope = [selector];
    input.milestones[0].writeSet = [selector];
    expect(() => compilePlanGraph(input)).toThrow();
  });

  test('rejects non-I-JSON, cyclic, class, and accessor policy values', () => {
    const nonFinite = goldenInput();
    nonFinite.policy = { n: Infinity };
    expect(() => compilePlanGraph(nonFinite)).toThrow(/non-I-JSON number/);

    const cyclic = goldenInput();
    cyclic.policy.self = cyclic.policy;
    expect(() => compilePlanGraph(cyclic)).toThrow(/cycle/i);

    const classValue = goldenInput();
    classValue.policy = { date: new Date() };
    expect(() => compilePlanGraph(classValue)).toThrow(/non-plain object|class instance/i);

    const accessor = goldenInput();
    Object.defineProperty(accessor.policy, 'secret', { enumerable: true, get: () => 'value' });
    expect(() => compilePlanGraph(accessor)).toThrow(/accessor/i);

    const arrayAccessor = goldenInput();
    const values: string[] = [];
    Object.defineProperty(values, '0', { enumerable: true, get: () => 'value' });
    arrayAccessor.policy = { values };
    expect(() => compilePlanGraph(arrayAccessor)).toThrow(/accessor/i);
  });

  test('descriptor-scans complete programmatic input before invoking getters', () => {
    const getter = jest.fn(() => 'stolen');
    const accessor = goldenInput();
    Object.defineProperty(accessor, 'objective', { enumerable: true, get: getter });
    expect(() => compilePlanGraph(accessor)).toThrow(/accessor/i);
    expect(getter).not.toHaveBeenCalled();

    const symbol = goldenInput();
    symbol[Symbol('hidden')] = true;
    expect(() => compilePlanGraph(symbol)).toThrow(/symbol property/i);

    const functionValue = goldenInput();
    functionValue.policy = { callback: () => true };
    expect(() => compilePlanGraph(functionValue)).toThrow(/non-JSON function/i);

    const hidden = goldenInput();
    Object.defineProperty(hidden.milestones[0], 'hidden', { value: true });
    expect(() => compilePlanGraph(hidden)).toThrow(/non-enumerable/i);

    const sparse = goldenInput();
    sparse.scope = new Array(1);
    expect(() => compilePlanGraph(sparse)).toThrow(/sparse or extra-property array/i);

    const extraArrayProperty = goldenInput();
    extraArrayProperty.scope.extra = true;
    expect(() => compilePlanGraph(extraArrayProperty)).toThrow(/sparse or extra-property array/i);

    const customArrayPrototype = goldenInput();
    Object.setPrototypeOf(customArrayPrototype.scope, null);
    expect(() => compilePlanGraph(customArrayPrototype)).toThrow(/custom prototype/i);

    const poison = goldenInput();
    poison.policy = JSON.parse('{"__proto__":"blocked"}');
    expect(() => compilePlanGraph(poison)).toThrow(/poison key/i);
  });

  test('rejects a huge sparse array before materializing its declared length', () => {
    const hugeSparse: unknown[] = [];
    hugeSparse.length = 500_000_000;
    hugeSparse[499_999_999] = 'present';

    expect(() => assertCompilerData(hugeSparse)).toThrow(/maximum value count/);
  });

  test.each([
    'maxActiveExecutionOrchestrators', 'maxLeavesPerEO', 'maxGlobalDescendants',
    'maxCumulativeSpawns', 'retryPerNode', 'globalRetries', 'localFixLoops',
    'toolActionsGlobal', 'toolActionsEo', 'toolActionsLeaf',
    'tokensGlobal', 'tokensEo', 'tokensLeaf'
  ])('rejects fractional count budget %s', budget => {
    const input = goldenInput();
    input.budgets = { [budget]: 1.5 };
    expect(() => compilePlanGraph(input)).toThrow(/expected int/i);
  });

  test('allows fractional wall-time and USD budgets', () => {
    const input = goldenInput();
    input.budgets = { wallTimeMinutesRun: 30.5, costUsdGlobal: 2.5 };
    const compiled = compilePlanGraph(input);
    expect(compiled.plan.payload.budgets.wallTimeMinutesRun).toBe(30.5);
    expect(compiled.plan.payload.budgets.costUsdGlobal).toBe(2.5);
  });

  test('rejects invalid Unicode and unknown object fields', () => {
    const bidi = goldenInput();
    bidi.objective = 'unsafe\u202etext';
    expect(() => compilePlanGraph(bidi)).toThrow(/bidirectional/i);
    const surrogate = goldenInput();
    surrogate.failureRules = ['bad\ud800'];
    expect(() => compilePlanGraph(surrogate)).toThrow(/Unicode/i);
    const unknown = goldenInput();
    unknown.mode = 'autonomous';
    expect(() => compilePlanGraph(unknown)).toThrow(/Unrecognized key/i);
  });

  test.each([
    ['objective ESC', (input: any) => { input.objective = 'unsafe\u001b[31m'; }],
    ['criteria newline', (input: any) => { input.milestones[0].criteria = ['unsafe\nline']; }],
    ['verification tab', (input: any) => { input.milestones[0].verification = 'unsafe\tcommand'; }],
    ['rule DEL', (input: any) => { input.pauseRules = ['unsafe\u007f']; }],
    ['side effect C1', (input: any) => { input.expectedSideEffects = ['unsafe\u0085']; }],
    ['adapter bidi', (input: any) => { input.adapterRequirements = ['unsafe\u2066']; }],
    ['selector control', (input: any) => { input.scope = ['unsafe\u0001/path']; }],
    ['policy value control', (input: any) => { input.policy = { value: 'unsafe\u001b' }; }],
    ['policy key control', (input: any) => { input.policy = { ['unsafe\u001b']: true }; }]
  ])('rejects approval-visible control characters in %s', (_label, mutate) => {
    const input = goldenInput();
    mutate(input);
    expect(() => compilePlanGraph(input)).toThrow(/control or bidirectional/i);
  });

  test('enforces per-string, traversal, and policy-depth boundaries', () => {
    const boundaryString = goldenInput();
    boundaryString.objective = 'a'.repeat(COMPILER_RESOURCE_LIMITS.stringLength);
    expect(() => compilePlanGraph(boundaryString)).not.toThrow();
    boundaryString.objective += 'a';
    expect(() => compilePlanGraph(boundaryString)).toThrow(/maximum .*length/);

    const multibyteOverflow = goldenInput();
    multibyteOverflow.objective = '😀'.repeat(COMPILER_RESOURCE_LIMITS.stringLength / 2);
    expect(() => compilePlanGraph(multibyteOverflow)).toThrow(/UTF-8 byte length/);

    expect(() => assertCompilerData(
      Array(COMPILER_RESOURCE_LIMITS.traversedValues - 1).fill(null)
    )).not.toThrow();
    expect(() => assertCompilerData(
      Array(COMPILER_RESOURCE_LIMITS.traversedValues).fill(null)
    )).toThrow(/maximum value count/);

    const nested = (levels: number): unknown => {
      let value: unknown = 'leaf';
      for (let index = 0; index < levels; index += 1) value = { next: value };
      return value;
    };
    const boundaryDepth = goldenInput();
    boundaryDepth.policy = nested(31);
    expect(() => compilePlanGraph(boundaryDepth)).not.toThrow();
    boundaryDepth.policy = nested(32);
    expect(() => compilePlanGraph(boundaryDepth)).toThrow(/maximum depth/);
  });

  test.each([
    ['milestones', (input: any) => {
      input.milestones = Array.from(
        { length: COMPILER_RESOURCE_LIMITS.milestones + 1 },
        (_, index) => ({ ...clone(input.milestones[0]), key: `milestone-${index}` })
      );
    }],
    ['workstreams', (input: any) => {
      input.milestones[0].workstreams = Array.from(
        { length: COMPILER_RESOURCE_LIMITS.workstreamsPerMilestone + 1 },
        (_, index) => ({ ...clone(input.milestones[0].workstreams[0]), key: `stream-${index}` })
      );
    }],
    ['leaves', (input: any) => {
      input.milestones[1].workstreams[0].leaves = Array.from(
        { length: COMPILER_RESOURCE_LIMITS.leavesPerWorkstream + 1 },
        (_, index) => ({ ...clone(input.milestones[1].workstreams[0].leaves[0]), key: `leaf-${index}` })
      );
    }],
    ['dependencies', (input: any) => {
      input.milestones[0].dependsOn = Array(COMPILER_RESOURCE_LIMITS.dependenciesPerMilestone + 1)
        .fill('core');
    }],
    ['criteria', (input: any) => {
      input.integrationCriteria = Array(COMPILER_RESOURCE_LIMITS.criteriaPerCollection + 1)
        .fill('criterion');
    }],
    ['rules', (input: any) => {
      input.pauseRules = Array(COMPILER_RESOURCE_LIMITS.rulesPerCollection + 1).fill('pause');
    }],
    ['selectors', (input: any) => {
      input.scope = Array(COMPILER_RESOURCE_LIMITS.selectorsPerCollection + 1).fill('src/**');
    }],
    ['adapters', (input: any) => {
      input.adapterRequirements = Array(COMPILER_RESOURCE_LIMITS.adapterRequirements + 1)
        .fill('adapter');
    }]
  ])('rejects %s collection overflow', (_label, mutate) => {
    const input = goldenInput();
    mutate(input);
    expect(() => compilePlanGraph(input)).toThrow(/too big|maximum|<=/i);
  });

  test('accepts collection boundary', () => {
    const input = goldenInput();
    input.adapterRequirements = Array.from(
      { length: COMPILER_RESOURCE_LIMITS.adapterRequirements },
      (_, index) => `adapter-${index}`
    );
    expect(compilePlanGraph(input).graph.payload.adapterRequirements).toHaveLength(
      COMPILER_RESOURCE_LIMITS.adapterRequirements
    );
  });
});

describe('compiled pair validation', () => {
  test.each([
    ['wrong planDigest', (compiled: any) => resealGraph(compiled, payload => { payload.planDigest = 'sha256:' + '0'.repeat(64); })],
    ['missing milestone', (compiled: any) => resealGraph(compiled, payload => {
      payload.nodes = payload.nodes.filter((node: any) => node.nodeId !== 'milestone-4-docs');
      payload.edges = payload.edges.filter((edge: any) => edge.fromNodeId !== 'milestone-4-docs');
    })],
    ['extra milestone', (compiled: any) => resealGraph(compiled, payload => payload.nodes.push({
      ...payload.nodes.find((node: any) => node.nodeId === 'milestone-4-core'),
      nodeId: 'milestone-5-extra'
    }))],
    ['missing integration', (compiled: any) => resealGraph(compiled, payload => {
      payload.nodes = payload.nodes.filter((node: any) => node.nodeId !== 'integration-4-docs');
    })],
    ['extra integration', (compiled: any) => resealGraph(compiled, payload => payload.nodes.push({
      ...payload.nodes.find((node: any) => node.nodeId === 'integration-4-core'),
      nodeId: 'integration-5-extra'
    }))],
    ['duplicate edge', (compiled: any) => resealGraph(compiled, payload => payload.edges.push(payload.edges[0]))],
    ['changed isolation', (compiled: any) => resealGraph(compiled, payload => { payload.nodes[0].isolation = 'parallel'; })],
    ['changed report kind', (compiled: any) => resealGraph(compiled, payload => { payload.nodes[0].expectedReportKind = 'goal-verdict/v1'; })],
    ['reparented workstream', (compiled: any) => resealGraph(compiled, payload => {
      payload.edges[0].fromNodeId = 'milestone-4-docs';
    })],
    ['broadened write set', (compiled: any) => resealGraph(compiled, payload => {
      payload.nodes.find((node: any) => node.ownerRole === 'LEAF').writeSet = ['src/**'];
    })],
    ['changed fanout', (compiled: any) => resealGraph(compiled, payload => { payload.fanout = 2; })],
    ['changed graph budget', (compiled: any) => resealGraph(compiled, payload => {
      payload.budgets.tokensLeaf = 1;
    })],
    ['changed adapter requirements', (compiled: any) => resealGraph(compiled, payload => {
      payload.adapterRequirements = ['other-adapter'];
    })],
    ['added authority node', (compiled: any) => resealGraph(compiled, payload => payload.nodes.push({
      ...payload.nodes.find((node: any) => node.ownerRole === 'EXECUTION'),
      nodeId: 'workstream-4-core-5-extra'
    }))],
    ['bad envelope digest', (compiled: any) => ({ ...compiled, graph: { ...compiled.graph, digest: 'sha256:' + '0'.repeat(64) } })]
  ])('rejects %s', (_label, mutate) => {
    expect(validateCompiledPlanGraph(mutate(compilePlanGraph(goldenInput()))).ok).toBe(false);
  });

  test('never throws for malformed pairs', () => {
    expect(validateCompiledPlanGraph(null)).toEqual({ ok: false, reasons: ['compiled: expected object'] });
    expect(() => validateCompiledPlanGraph({ plan: Object.create(null) })).not.toThrow();
  });

  test('descriptor-validates compiled input before property reads', () => {
    const getter = jest.fn(() => compilePlanGraph(goldenInput()).plan);
    const malicious: Record<string, unknown> = {};
    Object.defineProperty(malicious, 'plan', { enumerable: true, get: getter });
    const result = validateCompiledPlanGraph(malicious);
    expect(result.ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  test('source snapshot is detached, normalized, deeply frozen, and required for validation', () => {
    const input = goldenInput();
    const compiled = compilePlanGraph(input);
    input.milestones[0].criteria[0] = 'mutated caller';
    expect(compiled.source.milestones[1].criteria).toEqual(['Guide is accurate']);
    expect(Object.isFrozen(compiled.source)).toBe(true);
    expect(Object.isFrozen(compiled.source.milestones[0].workstreams[0])).toBe(true);
    const { source: _source, ...withoutSource } = compiled;
    expect(validateCompiledPlanGraph(withoutSource).ok).toBe(false);
  });
});

describe('approval binding', () => {
  test('accepts approved plan and separate explicit mode events', async () => {
    const compiled = compilePlanGraph(goldenInput());
    const { controlPlane, approval, modeSelection } = await attest(compiled);
    expect(verifyApprovalBinding({
      compiled,
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake',
      principalRef: 'principal:fake',
      approval,
      modeSelection,
      provider: controlPlane.attestation
    })).toEqual({
      ok: true,
      mode: 'autonomous',
      approvalRef: approval.verificationRef,
      modeSelectionRef: modeSelection.verificationRef
    });
  });

  test('uses atomic pair verification instead of consuming individual methods', async () => {
    const compiled = compilePlanGraph(goldenInput());
    const { controlPlane, approval, modeSelection } = await attest(compiled);
    const pair = jest.spyOn(controlPlane.attestation, 'verifyPair');
    const approvalOnly = jest.spyOn(controlPlane.attestation, 'verifyApproval');
    const modeOnly = jest.spyOn(controlPlane.attestation, 'verifyModeSelection');
    expect(verifyApprovalBinding({
      compiled,
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake',
      principalRef: 'principal:fake',
      approval,
      modeSelection,
      provider: controlPlane.attestation
    }).ok).toBe(true);
    expect(pair).toHaveBeenCalledTimes(1);
    expect(approvalOnly).not.toHaveBeenCalled();
    expect(modeOnly).not.toHaveBeenCalled();
  });

  test('atomic pair failure consumes neither valid event', async () => {
    const compiled = compilePlanGraph(goldenInput());
    const { controlPlane, approval, modeSelection } = await attest(compiled);
    const result = verifyApprovalBinding({
      compiled,
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake',
      principalRef: 'principal:fake',
      approval,
      modeSelection: { ...modeSelection },
      provider: controlPlane.attestation
    });
    expect(result).toEqual({ ok: false, reasons: ['mode-selection: untrusted-origin'] });
    const expected = {
      planDigest: compiled.plan.digest as `sha256:${string}`,
      graphDigest: compiled.graph.digest as `sha256:${string}`,
      planRevision: compiled.planRevision,
      principalRef: 'principal:fake',
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake'
    };
    expect(controlPlane.attestation.verifyApproval(approval, expected)).toEqual({ ok: true });
    expect(controlPlane.attestation.verifyModeSelection(modeSelection, expected)).toEqual({ ok: true });
  });

  test('forged getter cannot re-enter verification or consume valid pair', async () => {
    const compiled = compilePlanGraph(goldenInput());
    const { controlPlane, approval, modeSelection } = await attest(compiled);
    const expected = {
      planDigest: compiled.plan.digest as `sha256:${string}`,
      graphDigest: compiled.graph.digest as `sha256:${string}`,
      planRevision: compiled.planRevision,
      principalRef: 'principal:fake',
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake'
    };
    const reentrant = jest.fn(() => {
      controlPlane.attestation.verifyPair(approval, modeSelection, expected);
      return approval.planDigest;
    });
    const forged = { ...approval } as Record<string, unknown>;
    Object.defineProperty(forged, 'planDigest', { enumerable: true, get: reentrant });
    const base = {
      compiled,
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake',
      principalRef: 'principal:fake',
      modeSelection,
      provider: controlPlane.attestation
    };
    expect(verifyApprovalBinding({ ...base, approval: forged as any }).ok).toBe(false);
    expect(reentrant).not.toHaveBeenCalled();
    expect(verifyApprovalBinding({ ...base, approval }).ok).toBe(true);
  });

  test('proxy event cannot trigger reflection traps or consume valid issued pair', async () => {
    const compiled = compilePlanGraph(goldenInput());
    const { controlPlane, approval, modeSelection } = await attest(compiled);
    const expected = {
      planDigest: compiled.plan.digest as `sha256:${string}`,
      graphDigest: compiled.graph.digest as `sha256:${string}`,
      planRevision: compiled.planRevision,
      principalRef: 'principal:fake',
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake'
    };
    const reenter = jest.fn(() => {
      controlPlane.attestation.verifyApproval(approval, expected);
      controlPlane.attestation.verifyModeSelection(modeSelection, expected);
    });
    const ownKeys = jest.fn((target: object) => {
      reenter();
      return Reflect.ownKeys(target);
    });
    const getOwnPropertyDescriptor = jest.fn((target: object, key: PropertyKey) => {
      reenter();
      return Reflect.getOwnPropertyDescriptor(target, key);
    });
    const get = jest.fn((target: object, key: PropertyKey, receiver: unknown) => {
      reenter();
      return Reflect.get(target, key, receiver);
    });
    const proxy = new Proxy(approval, { ownKeys, getOwnPropertyDescriptor, get });
    const base = {
      compiled,
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake',
      principalRef: 'principal:fake',
      modeSelection,
      provider: controlPlane.attestation
    };

    expect(verifyApprovalBinding({ ...base, approval: proxy as typeof approval })).toEqual({
      ok: false,
      reasons: ['approval: untrusted-origin']
    });
    expect(ownKeys).not.toHaveBeenCalled();
    expect(getOwnPropertyDescriptor).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(reenter).not.toHaveBeenCalled();
    expect(verifyApprovalBinding({ ...base, approval })).toEqual(expect.objectContaining({ ok: true }));
  });

  test.each([
    ['plan digest', (event: any) => { event.planDigest = 'sha256:' + '0'.repeat(64); }],
    ['graph digest', (event: any) => { event.graphDigest = 'sha256:' + '0'.repeat(64); }],
    ['revision', (event: any) => { event.planRevision += 1; }],
    ['principal', (event: any) => { event.principalRef = 'principal:other'; }],
    ['project', (event: any) => { event.projectId = 'project:other'; }],
    ['session', (event: any) => { event.hostSessionRef = 'session:other'; }]
  ])('rejects wrong approval %s binding', async (_label, mutate) => {
    const compiled = compilePlanGraph(goldenInput());
    const { controlPlane, approval, modeSelection } = await attest(compiled);
    const changed = { ...approval } as any;
    mutate(changed);
    expect(verifyApprovalBinding({
      compiled,
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake',
      principalRef: 'principal:fake',
      approval: changed,
      modeSelection,
      provider: controlPlane.attestation
    }).ok).toBe(false);
  });

  test('rejects rejected, missing, bundled, or shared event material', async () => {
    const compiled = compilePlanGraph(goldenInput());
    const { controlPlane, approval, modeSelection } = await attest(compiled);
    const base = {
      compiled,
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake',
      principalRef: 'principal:fake',
      provider: controlPlane.attestation
    };
    expect(verifyApprovalBinding({ ...base, approval: { ...approval, decision: 'rejected' }, modeSelection }).ok)
      .toBe(false);
    expect(verifyApprovalBinding({ ...base, approval, modeSelection: undefined as any }).ok).toBe(false);
    expect(verifyApprovalBinding({ ...base, approval: { ...approval, mode: 'autonomous' } as any, modeSelection }).ok)
      .toBe(false);
    expect(verifyApprovalBinding({
      ...base,
      approval,
      modeSelection: {
        ...modeSelection,
        eventId: approval.eventId,
        challengeNonce: approval.challengeNonce,
        verificationRef: approval.verificationRef
      },
    }).ok).toBe(false);
  });

  test('rejects copied/synthetic events, replay, expiry, and revocation', async () => {
    const compiled = compilePlanGraph(goldenInput());
    const forged = await attest(compiled);
    expect(verifyApprovalBinding({
      compiled,
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake',
      principalRef: 'principal:fake',
      approval: { ...forged.approval },
      modeSelection: forged.modeSelection,
      provider: forged.controlPlane.attestation
    }).ok).toBe(false);

    const first = await attest(compiled);
    const args = {
      compiled,
      projectId: 'project:fake',
      hostSessionRef: 'host-session:fake',
      principalRef: 'principal:fake',
      approval: first.approval,
      modeSelection: first.modeSelection,
      provider: first.controlPlane.attestation
    };
    expect(verifyApprovalBinding(args).ok).toBe(true);
    expect(verifyApprovalBinding(args).ok).toBe(false);

    const revoked = await attest(compiled);
    await revoked.controlPlane.attestation.revoke(revoked.approval.eventId, 1);
    expect(verifyApprovalBinding({ ...args, approval: revoked.approval, modeSelection: revoked.modeSelection,
      provider: revoked.controlPlane.attestation }).ok).toBe(false);

    let current = new Date('2026-09-10T00:00:00.000Z');
    const expired = await attest(compiled, { now: () => current });
    current = new Date('2026-09-10T01:00:00.000Z');
    expect(verifyApprovalBinding({ ...args, approval: expired.approval, modeSelection: expired.modeSelection,
      provider: expired.controlPlane.attestation }).ok).toBe(false);
  });

  test('material/resealed artifacts and revision-only changes invalidate old events', async () => {
    const compiled = compilePlanGraph(goldenInput());
    const { controlPlane, approval, modeSelection } = await attest(compiled);
    const args = {
      projectId: 'project:fake', hostSessionRef: 'host-session:fake', principalRef: 'principal:fake',
      approval, modeSelection, provider: controlPlane.attestation
    };
    const material = goldenInput();
    material.integrationCriteria = ['Changed integration'];
    expect(verifyApprovalBinding({ ...args, compiled: compilePlanGraph(material) }).ok).toBe(false);
    const revision = goldenInput();
    revision.planRevision += 1;
    const revised = compilePlanGraph(revision);
    expect(revised.plan.digest).toBe(compiled.plan.digest);
    expect(revised.graph.digest).toBe(compiled.graph.digest);
    expect(verifyApprovalBinding({ ...args, compiled: revised }).ok).toBe(false);
  });
});
