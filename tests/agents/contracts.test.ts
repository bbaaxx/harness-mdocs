import * as fs from 'fs';
import * as path from 'path';

import {
  CANONICAL_AGENT_CAPABILITIES,
  CANONICAL_AGENT_PROFILES,
  canonicalAgentCapabilityRegistry,
  CanonicalizationError,
  canonicalizeJson,
  assertNoDuplicateKeys,
  parseCanonicalJson,
  COMPATIBILITY_POLICY,
  CONTRACT_KINDS,
  CONTRACT_PAYLOAD_SCHEMAS,
  ContractEnvelope,
  contractKindSchema,
  computeContractDigest,
  delegationEdgeSchema,
  EXECUTION_ORCHESTRATOR_PROFILE,
  executionModeSelectionPayloadSchema,
  executionPlanPayloadSchema,
  orchestrationArtifactPayloadSchema,
  parseContract,
  planApprovalPayloadSchema,
  sealContract,
  verifyContractEnvelope
} from '../../src/agents';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'agents', 'contracts');

function loadJsonFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function expectIssues(result: { ok: boolean; issues?: string[] }, matcher: RegExp): void {
  expect(result.ok).toBe(false);
  expect((result.issues ?? []).join('\n')).toMatch(matcher);
}

describe('RFC 8785 canonicalization', () => {
  // Golden digest vectors. These hex literals are COMMITTED: they prove
  // canonicalization stability — any regression in key ordering, number
  // formatting, escaping, or the preimage layout flips them.
  test.each([
    [
      'execution-plan/v1',
      'golden-1',
      { b: 1, a: [true, null, 'x'] },
      'sha256:0fd3d372d234d65542aa0c3c54e854467534c3c2b6f9f495b1abe98719b319e9'
    ],
    [
      'plan-approval/v1',
      'golden-2',
      { nested: { z: 0.5, a: 'µ' }, n: 2 },
      'sha256:5bf22f0a1ef056c72f9bd9acd3bc32a0d1fda9aa6805227ce608398f266ede6e'
    ],
    [
      'run-record/v1',
      'golden-3',
      {},
      'sha256:e2ab7a24f965ef646d16ea1d0571a18016237ec0edbbf6cd6be6d3ba4a4e76d9'
    ]
  ] as const)('golden digest for %s/%s', (kind, id, payload, expected) => {
    expect(computeContractDigest(kind, 1, id, payload)).toBe(expected);
  });

  test('key order permutations canonicalize identically and digest equally', () => {
    const first = { a: 1, b: { y: 2, x: 3 }, c: ['z', 'a'] };
    const second = { c: ['z', 'a'], b: { x: 3, y: 2 }, a: 1 };

    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));
    expect(computeContractDigest('execution-plan/v1', 1, 'det', first))
      .toBe(computeContractDigest('execution-plan/v1', 1, 'det', second));
  });

  test('object keys sort by UTF-16 code units', () => {
    expect(canonicalizeJson({ b: 1, A: 2, a: 3, B: 4 })).toBe('{"A":2,"B":4,"a":3,"b":1}');
  });

  test.each<[string, unknown]>([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['negative zero', -0],
    ['integral beyond 2^53', 2 ** 53 + 1],
    ['lone surrogate', 'lone\ud800surrogate'],
    ['undefined', undefined],
    ['function', () => 1],
    ['symbol', Symbol('s')],
    ['bigint', BigInt(1)],
    ['class instance', new Date('2026-09-08T00:00:00Z')],
    ['undefined property', { a: undefined }]
  ])('rejects %s before canonicalization', (label, value) => {
    expect(() => canonicalizeJson(value)).toThrow(CanonicalizationError);
    expect(() => computeContractDigest('execution-plan/v1', 1, 'x', value))
      .toThrow(CanonicalizationError);
  });

  test('rejects duplicate object keys in raw JSON, including escape-aliased keys', () => {
    expect(() => assertNoDuplicateKeys('{"a":1,"a":2}')).toThrow(/duplicate object key "a"/);
    expect(() => assertNoDuplicateKeys('{"a":1,"\\u0061":2}')).toThrow(/duplicate object key/);
    expect(() => assertNoDuplicateKeys('{"o":{"x":1},"p":{"x":2}}')).not.toThrow();
    expect(() => assertNoDuplicateKeys('{"a":1,"b":{"a":2}}')).not.toThrow();
    expect(() => parseCanonicalJson('{"a":1,"a":2}')).toThrow(/duplicate object key/);
  });

  test('parseCanonicalJson rejects non-I-JSON numbers JSON.parse would silently accept', () => {
    expect(() => parseCanonicalJson('{"budget":1e400}')).toThrow(/non-finite/);
    expect(() => parseCanonicalJson('{"n":9007199254740993}')).toThrow(/safe range/);
    expect(parseCanonicalJson('{"n":9007199254740991}')).toEqual({ n: 9007199254740991 });
    expect(() => parseCanonicalJson('{malformed')).toThrow(CanonicalizationError);
  });

  test('digest is domain-separated by kind', () => {
    const payload = { a: 1 };
    expect(computeContractDigest('execution-plan/v1', 1, 'same', payload))
      .not.toBe(computeContractDigest('run-record/v1', 1, 'same', payload));
  });
});

describe('topology: only PLAN_ROOT -> EXECUTION -> LEAF', () => {
  test.each([
    ['PLAN_ROOT', 'EXECUTION', true],
    ['EXECUTION', 'LEAF', true],
    ['PLAN_ROOT', 'LEAF', false],
    ['EXECUTION', 'EXECUTION', false],
    ['LEAF', 'PLAN_ROOT', false],
    ['LEAF', 'EXECUTION', false],
    ['LEAF', 'LEAF', false],
    ['PLAN_ROOT', 'PLAN_ROOT', false],
    ['EXECUTION', 'PLAN_ROOT', false]
  ] as const)('edge %s -> %s legal=%s', (from, to, legal) => {
    const result = delegationEdgeSchema.safeParse({ from, to });
    expect(result.success).toBe(legal);
    if (!legal) {
      expect(result.error!.issues.map(issue => issue.message).join('\n'))
        .toContain(`${from}->${to}`);
    }
  });

  test('orchestration artifact rejects a root->leaf edge', () => {
    expectIssues(
      parseContract(loadJsonFixture('invalid/root-to-leaf-edge.json')),
      /Illegal delegation edge milestone-one->leaf-task \(PLAN_ROOT->LEAF\)/
    );
  });

  test('orchestration artifact rejects an EO->EO edge', () => {
    expectIssues(
      parseContract(loadJsonFixture('invalid/eo-to-eo-edge.json')),
      /Illegal delegation edge workstream-one->workstream-two \(EXECUTION->EXECUTION\)/
    );
  });

  test('orchestration artifact rejects cycles', () => {
    expectIssues(
      parseContract(loadJsonFixture('invalid/cyclic-graph.json')),
      /contains a cycle/
    );
  });

  test('orchestration artifact rejects dangling edges', () => {
    expectIssues(
      parseContract(loadJsonFixture('invalid/dangling-edge.json')),
      /Dangling edge workstream-one->ghost-node/
    );
  });

  test('workstream nodes must be bounded by exactly one milestone', () => {
    expectIssues(
      parseContract(loadJsonFixture('invalid/workstream-without-milestone.json')),
      /must be bounded by exactly one milestone; found 0/
    );
  });

  test('integration nodes must be owned by PLAN_ROOT', () => {
    expectIssues(
      parseContract(loadJsonFixture('invalid/integration-not-root-owned.json')),
      /type "integration" has illegal owner EXECUTION/
    );
  });
});

describe('contract registry and fixtures', () => {
  test('registry covers exactly the 11 contract kinds', () => {
    expect(Object.isFrozen(CONTRACT_KINDS)).toBe(true);
    expect(CONTRACT_KINDS).toHaveLength(11);
    expect(Object.keys(CONTRACT_PAYLOAD_SCHEMAS).sort()).toEqual([...CONTRACT_KINDS].sort());
    for (const kind of CONTRACT_KINDS) {
      expect(contractKindSchema.parse(kind)).toBe(kind);
    }
  });

  const validFixtures = fs.readdirSync(path.join(FIXTURES, 'valid'))
    .filter(file => file.endsWith('.json'))
    .sort();

  test('all 11 valid fixtures parse and verify', () => {
    expect(validFixtures).toHaveLength(11);
    for (const file of validFixtures) {
      const result = parseContract(loadJsonFixture(`valid/${file}`));
      if (!result.ok) throw new Error(`${file}: ${result.issues.join('; ')}`);
      expect(result.envelope.kind).toBe(file.replace(/\.json$/, '') + '/v1');
    }
  });

  test('valid fixture envelopes verify against verifyContractEnvelope', () => {
    for (const file of validFixtures) {
      const envelope = loadJsonFixture(`valid/${file}`) as ContractEnvelope;
      expect(verifyContractEnvelope(envelope)).toEqual({ ok: true });
    }
  });

  test('raw duplicate-key fixture is rejected by the canonical JSON parser', () => {
    const raw = fs.readFileSync(path.join(FIXTURES, 'invalid', 'duplicate-key.txt'), 'utf8');
    expect(() => parseCanonicalJson(raw)).toThrow(/duplicate object key "id"/);
  });

  test('raw non-I-JSON number fixture is rejected by the canonical JSON parser', () => {
    const raw = fs.readFileSync(path.join(FIXTURES, 'invalid', 'non-ijson-number.txt'), 'utf8');
    expect(() => parseCanonicalJson(raw)).toThrow(/non-finite/);
  });

  test('digest-mismatch envelope fails closed', () => {
    expectIssues(parseContract(loadJsonFixture('invalid/digest-mismatch.json')), /digest mismatch/);
  });

  test('approval+mode bundled in one event is rejected by the strict schema', () => {
    expectIssues(
      parseContract(loadJsonFixture('invalid/approval-mode-bundled.json')),
      /Unrecognized key.*mode/
    );
  });

  test('unknown kind fails closed', () => {
    expectIssues(
      parseContract({ kind: 'unknown/v9', schemaVersion: 1, id: 'x', payload: {}, digest: 'sha256:' + '0'.repeat(64) }),
      /kind/
    );
  });

  test('unknown newer schema major fails closed', () => {
    expectIssues(
      parseContract({ kind: 'execution-plan/v1', schemaVersion: 2, id: 'x', payload: {}, digest: 'sha256:' + '0'.repeat(64) }),
      /schemaVersion/
    );
    expect(COMPATIBILITY_POLICY.unknownNewerSchemaMajor).toContain('fail-closed');
    expect(COMPATIBILITY_POLICY.previousBinary).toContain('cannot acquire controller lease');
    expect(Object.isFrozen(COMPATIBILITY_POLICY)).toBe(true);
  });
});

describe('material change invalidates approval', () => {
  // ANY payload change — material criteria or a mere label — flips the
  // digest. Display-only exclusions must be encoded by schema, never by
  // convention; this schema encodes none.
  function demoPlan() {
    return {
      objective: 'Deliver the demo milestone',
      scope: ['src/**'],
      outOfScope: ['dist/**'],
      milestones: [{
        milestoneId: 'milestone-one',
        dependencies: [],
        criteria: ['tests pass'],
        verification: 'npm test'
      }],
      integrationCriteria: ['full suite green'],
      regressionCriteria: ['no capability regressions'],
      writeSets: ['src/**'],
      expectedSideEffects: ['workspace-writes'],
      policy: { network: 'deny' },
      budgets: { tokensGlobal: 200000 },
      pauseRules: ['pause on uncertain outcome'],
      failureRules: ['retry once per node'],
      cancelRules: ['drain 30s'],
      completionRules: ['all milestones accepted']
    };
  }

  test('a milestone criteria change flips the digest', () => {
    const plan = demoPlan();
    const sealed = sealContract('execution-plan/v1', 'plan-material', plan);
    const changed = demoPlan();
    changed.milestones[0].criteria = ['tests pass and lint clean'];
    const resealed = sealContract('execution-plan/v1', 'plan-material', changed);

    expect(resealed.digest).not.toBe(sealed.digest);
    expect(verifyContractEnvelope({ ...sealed, payload: changed }).ok).toBe(false);
  });

  test('even a display-label-style change flips the digest (no display-only exclusion)', () => {
    const plan = demoPlan();
    const sealed = sealContract('execution-plan/v1', 'plan-label', plan);
    const relabeled = demoPlan();
    relabeled.milestones[0].verification = 'run the test suite';
    const resealed = sealContract('execution-plan/v1', 'plan-label', relabeled);

    expect(resealed.digest).not.toBe(sealed.digest);
  });
});

describe('approval/mode separation', () => {
  test('planApprovalPayload rejects a mode field (strict)', () => {
    const approval = loadJsonFixture('valid/plan-approval.json') as ContractEnvelope;
    expect(planApprovalPayloadSchema.safeParse(approval.payload).success).toBe(true);
    expect(planApprovalPayloadSchema.safeParse({
      ...(approval.payload as object),
      mode: 'autonomous'
    }).success).toBe(false);
  });

  test('executionModeSelectionPayload rejects a decision field (strict)', () => {
    const modeSelection = loadJsonFixture('valid/execution-mode-selection.json') as ContractEnvelope;
    expect(executionModeSelectionPayloadSchema.safeParse(modeSelection.payload).success).toBe(true);
    expect(executionModeSelectionPayloadSchema.safeParse({
      ...(modeSelection.payload as object),
      decision: 'approved'
    }).success).toBe(false);
  });

  test('execution-plan envelope is well-formed through the strict payload schema', () => {
    const plan = loadJsonFixture('valid/execution-plan.json') as ContractEnvelope;
    expect(executionPlanPayloadSchema.safeParse(plan.payload).success).toBe(true);
    expect(orchestrationArtifactPayloadSchema.safeParse(
      (loadJsonFixture('valid/orchestration-artifact.json') as ContractEnvelope).payload
    ).success).toBe(true);
  });
});

describe('capability registry with internal Execution Orchestrator profile', () => {
  test('EO profile is internal, policy-backed-resumable, and carries no capability', () => {
    expect(EXECUTION_ORCHESTRATOR_PROFILE.id).toBe('execution-orchestrator');
    expect(EXECUTION_ORCHESTRATOR_PROFILE.exposure).toBe('internal');
    expect(EXECUTION_ORCHESTRATOR_PROFILE.mode).toBe('policy-backed-resumable');
    expect(CANONICAL_AGENT_PROFILES).toContain(EXECUTION_ORCHESTRATOR_PROFILE);
    expect(
      CANONICAL_AGENT_CAPABILITIES.some(
        capability => (capability.profileId as string) === EXECUTION_ORCHESTRATOR_PROFILE.id
      )
    ).toBe(false);
  });

  test('exactly one default activation among capabilities survives the EO profile', () => {
    const registry = canonicalAgentCapabilityRegistry;
    expect(registry.getProfile('execution-orchestrator')?.exposure).toBe('internal');
    expect(
      registry.listCapabilities().filter(c => c.invocation.activation === 'default')
    ).toHaveLength(1);
    expect(registry.listCapabilities().map(c => c.id)).toEqual(['orchestrate', 'route', 'run']);
  });
});
