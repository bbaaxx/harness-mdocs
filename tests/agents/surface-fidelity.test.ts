import fs from 'fs';
import * as path from 'path';

import { DEFAULT_EXECUTION_PLAN_BUDGETS } from '../../src/agents/run/compiler';
import * as fidelityPublic from '../../src/agents/run/fidelity';
import {
  deriveHardBudgetDimensions,
  evaluateSurfaceFidelity,
  FIDELITY_ASSERTION_CATALOG,
  FIDELITY_PROBE_IDS,
  FidelityProbeId,
  FidelityProbeResult,
  fidelityPolicyReasonCodeSchema,
  fidelityProbeResultSchema,
  surfaceFidelityRequirementsSchema,
  UNCONDITIONAL_RUN_FIDELITY_PROBE_IDS
} from '../../src/agents/run/fidelity';
import {
  createFakeFidelityChallengeSource,
  createFakeFidelityProbeAdapter,
  createFakeProbeIsolationExecutor,
  FAKE_FIDELITY_MEASURED_AT,
  FAKE_FIDELITY_SUBJECT
} from '../../src/agents/run/fidelity/fake-adapter';
import { createHostFidelityRunner } from '../../src/agents/run/fidelity/internal';
import {
  FidelityMeasurementOptions,
  FidelityProbeAdapter,
  ProbeExecutionHandle,
  ProbeIsolationExecutor
} from '../../src/agents/run/fidelity/probes';

const SANDBOX_ROOT = '/tmp/mdocs-fidelity-test-sandbox';

const noBudgets = {} as const;

function requirements(
  continuation: 'autonomous' | 'human-checkpoint' = 'autonomous',
  executionPlanBudgets: Record<string, number> = noBudgets
) {
  return {
    continuation,
    hardBudgetDimensions: deriveHardBudgetDimensions(executionPlanBudgets)
  };
}

async function measure(
  adapter: FidelityProbeAdapter = createFakeFidelityProbeAdapter(),
  timeout = 100,
  overrides: Partial<FidelityMeasurementOptions> = {},
  executor: ProbeIsolationExecutor = createFakeProbeIsolationExecutor(adapter)
) {
  const runner = createHostFidelityRunner();
  const registration = runner.registerAdapter(adapter.subject, executor);
  return runner.measure(registration, {
    sandboxRoot: SANDBOX_ROOT,
    probeTimeoutMs: timeout,
    probeDrainTimeoutMs: 10,
    now: () => new Date(FAKE_FIDELITY_MEASURED_AT),
    challengeSource: createFakeFidelityChallengeSource(),
    ...overrides
  });
}

function wrappingAdapter(
  probeId: FidelityProbeId,
  transform: (result: unknown) => unknown
): FidelityProbeAdapter {
  const base = createFakeFidelityProbeAdapter();
  return {
    subject: base.subject,
    async runProbe(current, context) {
      const result = await base.runProbe(current, context);
      return current === probeId ? transform(result) : result;
    }
  };
}

function wrappingExecutor(
  adapter: FidelityProbeAdapter,
  probeId: FidelityProbeId,
  transform: (handle: ProbeExecutionHandle) => ProbeExecutionHandle
): ProbeIsolationExecutor {
  const base = createFakeProbeIsolationExecutor(adapter);
  return {
    isolation: 'killable',
    startProbe(current, invocation) {
      const handle = base.startProbe(current, invocation);
      return current === probeId ? transform(handle) : handle;
    }
  };
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function typescriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return typescriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
  });
}

describe('surface fidelity measurement and evaluation', () => {
  test('complete evidence yields exact autonomous Run and supervised checkpoint Run', async () => {
    const measured = await measure();

    const autonomous = evaluateSurfaceFidelity(measured, requirements());
    expect(autonomous.route).toEqual({ fidelity: 'exact', reasons: [] });
    expect(autonomous.run).toEqual({ fidelity: 'exact', reasons: [] });

    const checkpoint = evaluateSurfaceFidelity(
      measured,
      requirements('human-checkpoint')
    );
    expect(checkpoint.route.fidelity).toBe('exact');
    expect(checkpoint.run).toEqual({
      fidelity: 'supervised',
      reasons: ['RUN_HUMAN_CHECKPOINT_REQUIRED']
    });
    expect(fidelityPolicyReasonCodeSchema.parse(checkpoint.run.reasons[0]))
      .toBe('RUN_HUMAN_CHECKPOINT_REQUIRED');
  });

  test.each(UNCONDITIONAL_RUN_FIDELITY_PROBE_IDS.flatMap(probeId => [
    { probeId, condition: 'fail' as const },
    { probeId, condition: 'unknown' as const },
    { probeId, condition: 'absent' as const }
  ]))('$probeId $condition is plan-only and never supervised', async ({ probeId, condition }) => {
    const adapter = condition === 'absent'
      ? wrappingAdapter(probeId, () => undefined)
      : createFakeFidelityProbeAdapter({ outcomes: { [probeId]: condition } });
    const report = evaluateSurfaceFidelity(
      await measure(adapter),
      requirements('human-checkpoint')
    );

    expect(report.route.fidelity).toBe('exact');
    expect(report.run.fidelity).toBe('plan-only');
    expect(report.run.fidelity).not.toBe('supervised');
  });

  test('token and cost metering gate only matching hard dimensions', async () => {
    const tokenFailure = await measure(createFakeFidelityProbeAdapter({
      outcomes: { 'run.metering.tokens': 'fail' }
    }));
    expect(evaluateSurfaceFidelity(tokenFailure, requirements()).run.fidelity).toBe('exact');
    expect(evaluateSurfaceFidelity(
      tokenFailure,
      requirements('autonomous', { tokensLeaf: 1 })
    ).run).toEqual({
      fidelity: 'plan-only',
      reasons: ['RUN_METERING_TOKENS_FAILED']
    });
    expect(evaluateSurfaceFidelity(
      tokenFailure,
      requirements('autonomous', { costUsdGlobal: 1 })
    ).run.fidelity).toBe('exact');

    const costFailure = await measure(createFakeFidelityProbeAdapter({
      outcomes: { 'run.metering.cost': 'unknown' }
    }));
    expect(evaluateSurfaceFidelity(
      costFailure,
      requirements('autonomous', { costUsdEo: 1 })
    ).run.reasons).toEqual(['RUN_METERING_COST_INCONCLUSIVE']);
    expect(evaluateSurfaceFidelity(
      costFailure,
      requirements('autonomous', { tokensGlobal: 1 })
    ).run.fidelity).toBe('exact');
  });

  test('compiled default budgets derive both hard dimensions', () => {
    expect(deriveHardBudgetDimensions(DEFAULT_EXECUTION_PLAN_BUDGETS)).toEqual(['tokens', 'cost']);
    expect(deriveHardBudgetDimensions({ tokensEo: 1 })).toEqual(['tokens']);
    expect(deriveHardBudgetDimensions({ costUsdGlobal: 1 })).toEqual(['cost']);
    expect(deriveHardBudgetDimensions({ toolActionsGlobal: 1 })).toEqual([]);
    expect(deriveHardBudgetDimensions({ tokensLeaf: undefined })).toEqual([]);
    expect(deriveHardBudgetDimensions({ costUsdGlobal: undefined })).toEqual([]);
  });

  test.each([
    ['undefined requirements', undefined],
    ['null requirements', null],
    ['missing continuation', { hardBudgetDimensions: [] }],
    ['undefined continuation', { continuation: undefined, hardBudgetDimensions: [] }],
    ['invalid continuation string', { continuation: 'manual', hardBudgetDimensions: [] }],
    ['missing dimensions', { continuation: 'autonomous' }],
    ['undefined dimensions', { continuation: 'autonomous', hardBudgetDimensions: undefined }],
    ['null dimensions', { continuation: 'autonomous', hardBudgetDimensions: null }],
    ['undefined dimension', { continuation: 'autonomous', hardBudgetDimensions: [undefined] }],
    ['null dimension', { continuation: 'autonomous', hardBudgetDimensions: [null] }],
    ['invalid dimension string', {
      continuation: 'autonomous', hardBudgetDimensions: ['tokens', 'wall-time']
    }],
    ['extra field', { continuation: 'autonomous', hardBudgetDimensions: [], optimistic: true }]
  ] as const)('%s fails closed without changing measured Route', async (_name, malformed) => {
    const report = evaluateSurfaceFidelity(await measure(), malformed);
    expect(report.route).toEqual({ fidelity: 'exact', reasons: [] });
    expect(report.run).toEqual({
      fidelity: 'plan-only',
      reasons: ['RUN_REQUIREMENTS_INVALID']
    });
  });

  test('requirements schema canonically deduplicates and orders hard dimensions', async () => {
    const raw = {
      continuation: 'autonomous',
      hardBudgetDimensions: ['cost', 'tokens', 'cost', 'tokens']
    } as const;
    const normalized = surfaceFidelityRequirementsSchema.parse(raw);
    expect(normalized.hardBudgetDimensions).toEqual(['tokens', 'cost']);
    expect(Object.isFrozen(normalized.hardBudgetDimensions)).toBe(true);

    const measured = await measure(createFakeFidelityProbeAdapter({
      outcomes: {
        'run.metering.tokens': 'fail',
        'run.metering.cost': 'fail'
      }
    }));
    expect(evaluateSurfaceFidelity(measured, raw).run.reasons).toEqual([
      'RUN_METERING_TOKENS_FAILED',
      'RUN_METERING_COST_FAILED'
    ]);

    const maximumDuplicates = {
      continuation: 'autonomous',
      hardBudgetDimensions: Array(16).fill('tokens')
    };
    expect(surfaceFidelityRequirementsSchema.parse(maximumDuplicates).hardBudgetDimensions)
      .toEqual(['tokens']);
  });

  test('requirements boundary rejects huge, accessor, and proxy records without copying them', async () => {
    const measured = await measure();
    const huge: Record<string, unknown> = {
      continuation: 'autonomous',
      hardBudgetDimensions: []
    };
    for (let index = 0; index < 10_000; index += 1) huge[`extra${index}`] = index;

    let accessorRead = false;
    const accessor = { hardBudgetDimensions: [] } as Record<string, unknown>;
    Object.defineProperty(accessor, 'continuation', {
      enumerable: true,
      get() {
        accessorRead = true;
        throw new Error('requirements getter must not run');
      }
    });
    let dimensionsAccessorRead = false;
    const dimensionsAccessor = { continuation: 'autonomous' } as Record<string, unknown>;
    Object.defineProperty(dimensionsAccessor, 'hardBudgetDimensions', {
      enumerable: true,
      get() {
        dimensionsAccessorRead = true;
        throw new Error('dimensions getter must not run');
      }
    });
    let proxyTrap = false;
    const proxy = new Proxy({ continuation: 'autonomous', hardBudgetDimensions: [] }, {
      ownKeys() {
        proxyTrap = true;
        throw new Error('requirements proxy must not be traversed');
      }
    });

    for (const candidate of [huge, accessor, dimensionsAccessor, proxy]) {
      expect(evaluateSurfaceFidelity(measured, candidate).run).toEqual({
        fidelity: 'plan-only',
        reasons: ['RUN_REQUIREMENTS_INVALID']
      });
    }
    expect(accessorRead).toBe(false);
    expect(dimensionsAccessorRead).toBe(false);
    expect(proxyTrap).toBe(false);
  });

  test('oversized dimension arrays are rejected before Zod element parsing', async () => {
    let indexed = false;
    const dimensions = new Proxy(Array(17).fill('tokens'), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          indexed = true;
          throw new Error('dimension element must not be read');
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const report = evaluateSurfaceFidelity(await measure(), {
      continuation: 'autonomous',
      hardBudgetDimensions: dimensions
    });
    expect(indexed).toBe(false);
    expect(report.run).toEqual({
      fidelity: 'plan-only',
      reasons: ['RUN_REQUIREMENTS_INVALID']
    });
  });

  test.each(['sparse', 'accessor', 'hostile-proxy'] as const)(
    '%s requirement dimensions fail closed before Zod element access',
    async condition => {
      let indexed = false;
      const dimensions: unknown[] = condition === 'sparse' ? new Array(2) : ['tokens'];
      if (condition === 'accessor') {
        Object.defineProperty(dimensions, '0', {
          enumerable: true,
          get() {
            indexed = true;
            throw new Error('dimension getter must not run');
          }
        });
      }
      const input = condition === 'hostile-proxy'
        ? new Proxy(dimensions, {
          get(target, property, receiver) {
            if (property === '0') {
              indexed = true;
              throw new Error('dimension element must not be read');
            }
            return Reflect.get(target, property, receiver);
          }
        })
        : dimensions;
      const report = evaluateSurfaceFidelity(await measure(), {
        continuation: 'autonomous',
        hardBudgetDimensions: input
      });
      expect(indexed).toBe(false);
      expect(report.run).toEqual({
        fidelity: 'plan-only',
        reasons: ['RUN_REQUIREMENTS_INVALID']
      });
    }
  );

  test('hostile requirements cannot throw through evaluator', async () => {
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error('hostile requirements');
      }
    });
    const measured = await measure();
    expect(() => evaluateSurfaceFidelity(measured, hostile)).not.toThrow();
    expect(evaluateSurfaceFidelity(measured, hostile).run).toEqual({
      fidelity: 'plan-only',
      reasons: ['RUN_REQUIREMENTS_INVALID']
    });
  });

  test.each(['fail', 'unknown', 'absent'] as const)(
    'contracts %s affects Route but not Run',
    async condition => {
      const adapter = condition === 'absent'
        ? wrappingAdapter('route.contracts', () => undefined)
        : createFakeFidelityProbeAdapter({ outcomes: { 'route.contracts': condition } });
      const report = evaluateSurfaceFidelity(await measure(adapter), requirements());
      expect(report.route.fidelity).toBe('unsupported');
      expect(report.run).toEqual({ fidelity: 'exact', reasons: [] });
      expect(report.route.reasons).toEqual([
        condition === 'fail' ? 'ROUTE_CONTRACTS_FAILED' : 'ROUTE_CONTRACTS_INCONCLUSIVE'
      ]);
    }
  );

  test('purity failure downgrades only Route', async () => {
    const report = evaluateSurfaceFidelity(await measure(createFakeFidelityProbeAdapter({
      outcomes: { 'route.purity': 'fail' }
    })), requirements());
    expect(report.route).toEqual({ fidelity: 'plan-only', reasons: ['ROUTE_PURITY_FAILED'] });
    expect(report.run.fidelity).toBe('exact');
  });

  test('Run failure downgrades only Run', async () => {
    const report = evaluateSurfaceFidelity(await measure(createFakeFidelityProbeAdapter({
      outcomes: { 'run.host-identity': 'fail' }
    })), requirements());
    expect(report.route.fidelity).toBe('exact');
    expect(report.run).toEqual({
      fidelity: 'plan-only',
      reasons: ['RUN_HOST_IDENTITY_FAILED']
    });
  });

  test.each([
    ['duplicate probe result', (raw: unknown) => [raw, raw]],
    ['duplicate assertion', (raw: unknown) => {
      const result = raw as FidelityProbeResult;
      return { ...result, assertions: [...result.assertions, result.assertions[0]] };
    }],
    ['missing assertion', (raw: unknown) => {
      const result = raw as FidelityProbeResult;
      return { ...result, assertions: result.assertions.slice(1) };
    }],
    ['invalid evidence digest', (raw: unknown) => {
      const result = raw as FidelityProbeResult;
      return {
        ...result,
        assertions: result.assertions.map((assertion, index) =>
          index === 0 ? { ...assertion, evidenceDigest: 'sha256:nope' } : assertion
        )
      };
    }],
    ['stale subject', (raw: unknown) => {
      const result = raw as FidelityProbeResult;
      return { ...result, subject: { ...result.subject, adapterVersion: 'stale' } };
    }],
    ['status mismatch', (raw: unknown) => ({ ...(raw as object), status: 'fail' })]
  ] as const)('%s normalizes to unknown and cannot upgrade', async (_name, corrupt) => {
    const measured = await measure(wrappingAdapter('run.receipt-integrity', corrupt));
    const probe = measured.probes.find(item => item.probeId === 'run.receipt-integrity');
    expect(probe?.status).toBe('unknown');
    expect(probe?.assertions.every(assertion => assertion.status === 'unknown')).toBe(true);
    expect(evaluateSurfaceFidelity(measured, requirements()).run).toEqual({
      fidelity: 'plan-only',
      reasons: ['RUN_RECEIPT_INTEGRITY_INCONCLUSIVE']
    });
  });

  test('oversized assertions are rejected before Zod element parsing', async () => {
    let indexed = false;
    const measured = await measure(wrappingAdapter('run.receipt-integrity', raw => {
      const assertions = new Proxy(new Array(
        FIDELITY_ASSERTION_CATALOG['run.receipt-integrity'].length + 1
      ), {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            indexed = true;
            throw new Error('assertion element must not be read');
          }
          return Reflect.get(target, property, receiver);
        }
      });
      return { ...(raw as FidelityProbeResult), assertions };
    }));
    expect(indexed).toBe(false);
    expect(measured.probes.find(probe => probe.probeId === 'run.receipt-integrity'))
      .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_MALFORMED' });
  });

  test.each(['sparse', 'accessor', 'hostile-proxy'] as const)(
    '%s assertion arrays become malformed before Zod element access',
    async condition => {
      let indexed = false;
      const length = FIDELITY_ASSERTION_CATALOG['run.receipt-integrity'].length;
      const assertions: unknown[] = condition === 'sparse'
        ? new Array(length)
        : Array.from({ length }, (_, index) => ({ assertionId: `placeholder-${index}` }));
      if (condition === 'accessor') {
        Object.defineProperty(assertions, '0', {
          enumerable: true,
          get() {
            indexed = true;
            throw new Error('assertion getter must not run');
          }
        });
      }
      const input = condition === 'hostile-proxy'
        ? new Proxy(assertions, {
          get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
              indexed = true;
              throw new Error('assertion element must not be read');
            }
            return Reflect.get(target, property, receiver);
          }
        })
        : assertions;
      const measured = await measure(wrappingAdapter('run.receipt-integrity', raw => ({
        ...(raw as FidelityProbeResult),
        assertions: input
      })));
      expect(indexed).toBe(condition === 'hostile-proxy');
      expect(measured.probes.find(probe => probe.probeId === 'run.receipt-integrity'))
        .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_MALFORMED' });
    }
  );

  test.each(['passing-first', 'failing-first'] as const)(
    'duplicate probe IDs make whole probe unknown with %s order',
    async order => {
      const measured = await measure(wrappingAdapter('run.receipt-integrity', raw => {
        const passing = raw as FidelityProbeResult;
        const failing = {
          ...passing,
          status: 'fail',
          assertions: passing.assertions.map((assertion, index) => index === 0
            ? { assertionId: assertion.assertionId, status: 'fail' }
            : assertion)
        };
        return order === 'passing-first' ? [passing, failing] : [failing, passing];
      }));
      expect(measured.probes.find(probe => probe.probeId === 'run.receipt-integrity'))
        .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_DUPLICATE' });
    }
  );

  test('runner verifies fresh challenge, stamps host time, and canonicalizes assertions', async () => {
    const measured = await measure(wrappingAdapter('run.receipt-integrity', raw => ({
      ...(raw as FidelityProbeResult),
      measuredAt: '1999-01-01T00:00:00.000Z',
      assertions: [...(raw as FidelityProbeResult).assertions].reverse()
    })));
    const receipt = measured.probes.find(probe => probe.probeId === 'run.receipt-integrity')!;
    expect(receipt.measuredAt).toBe(FAKE_FIDELITY_MEASURED_AT);
    expect(receipt.assertions.map(assertion => assertion.assertionId))
      .toEqual(FIDELITY_ASSERTION_CATALOG['run.receipt-integrity']);

    const replayed = await measure(wrappingAdapter('run.receipt-integrity', raw => ({
      ...(raw as FidelityProbeResult),
      challengeId: 'cached-challenge'
    })));
    expect(replayed.probes.find(probe => probe.probeId === 'run.receipt-integrity'))
      .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_CHALLENGE_MISMATCH' });
  });

  test('registered adapter identity is scoped to host runner capability', async () => {
    const owner = createHostFidelityRunner();
    const other = createHostFidelityRunner();
    const registeredAdapter = createFakeFidelityProbeAdapter();
    const registration = owner.registerAdapter(
      registeredAdapter.subject,
      createFakeProbeIsolationExecutor(registeredAdapter)
    );
    const options = {
      sandboxRoot: SANDBOX_ROOT,
      now: () => new Date(FAKE_FIDELITY_MEASURED_AT),
      challengeSource: createFakeFidelityChallengeSource()
    };

    await expect(other.measure(registration, options)).rejects.toThrow(
      'Fidelity adapter is not registered with this runner'
    );
    expect(evaluateSurfaceFidelity(registration, requirements()).run.reasons)
      .toEqual(['RUN_MEASUREMENT_UNTRUSTED']);
    expect(evaluateSurfaceFidelity(await owner.measure(registration, options), requirements()).run)
      .toEqual({ fidelity: 'exact', reasons: [] });

    const base = createFakeFidelityProbeAdapter();
    let currentSubject = base.subject;
    const mutableIdentity: FidelityProbeAdapter = {
      get subject() {
        return currentSubject;
      },
      async runProbe(probeId, context) {
        return {
          ...(await base.runProbe(probeId, context) as FidelityProbeResult),
          subject: currentSubject
        };
      }
    };
    const boundRunner = createHostFidelityRunner();
    const boundRegistration = boundRunner.registerAdapter(
      mutableIdentity.subject,
      createFakeProbeIsolationExecutor(mutableIdentity)
    );
    currentSubject = { ...currentSubject, adapterVersion: 'changed-after-registration' };
    const stale = await boundRunner.measure(boundRegistration, options);
    expect(stale.probes.every(probe => probe.diagnosticCode === 'PROBE_STALE_SUBJECT')).toBe(true);
  });

  test('registration binds executor identity and isolation claim', async () => {
    const adapter = createFakeFidelityProbeAdapter();
    const original = createFakeProbeIsolationExecutor(adapter);
    let starts = 0;
    const mutable: {
      isolation: ProbeIsolationExecutor['isolation'];
      startProbe: ProbeIsolationExecutor['startProbe'];
    } = {
      isolation: 'killable',
      startProbe(probeId, invocation) {
        starts += 1;
        return original.startProbe(probeId, invocation);
      }
    };
    const runner = createHostFidelityRunner();
    const registration = runner.registerAdapter(adapter.subject, mutable);
    mutable.isolation = 'in-process';
    mutable.startProbe = () => {
      throw new Error('replacement executor must not run');
    };

    const measured = await runner.measure(registration, {
      sandboxRoot: SANDBOX_ROOT,
      now: () => new Date(FAKE_FIDELITY_MEASURED_AT),
      challengeSource: createFakeFidelityChallengeSource('bound')
    });
    expect(starts).toBe(FIDELITY_PROBE_IDS.length);
    expect(measured.diagnostics.isolation).toBe('killable');
    expect(evaluateSurfaceFidelity(measured, requirements()).run.fidelity).toBe('exact');
  });

  test('schema enforces assertion evidence and probe diagnostic status invariants', () => {
    const base = createFakeFidelityProbeAdapter();
    return base.runProbe('route.contracts', {
      challengeId: 'challenge',
      sandboxRoot: SANDBOX_ROOT,
      signal: new AbortController().signal
    }).then(raw => {
      const result = raw as FidelityProbeResult;
      expect(fidelityProbeResultSchema.safeParse({
        ...result,
        assertions: [{ assertionId: 'invented', status: 'pass' }]
      }).success).toBe(false);
      expect(fidelityProbeResultSchema.safeParse({
        ...result,
        assertions: result.assertions.map((assertion, index) =>
          index === 0 ? { assertionId: assertion.assertionId, status: 'pass' } : assertion
        )
      }).success).toBe(false);
      expect(fidelityProbeResultSchema.safeParse({
        ...result,
        diagnosticCode: 'PROBE_THROWN'
      }).success).toBe(false);
      expect(fidelityProbeResultSchema.safeParse({
        ...result,
        status: 'fail',
        assertions: result.assertions.map((assertion, index) => index === 0
          ? { ...assertion, status: 'fail' }
          : assertion)
      }).success).toBe(false);
    });
  });

  test('exported probe schema rejects oversized and sparse assertions before traversal', async () => {
    const base = createFakeFidelityProbeAdapter();
    const raw = await base.runProbe('route.contracts', {
      challengeId: 'challenge',
      sandboxRoot: SANDBOX_ROOT,
      signal: new AbortController().signal
    }) as FidelityProbeResult;
    const oversizedLength = Math.max(
      ...Object.values(FIDELITY_ASSERTION_CATALOG).map(assertions => assertions.length)
    ) + 1;
    let indexed = false;
    const oversized = new Proxy(new Array(oversizedLength), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) indexed = true;
        return Reflect.get(target, property, receiver);
      }
    });

    expect(fidelityProbeResultSchema.safeParse({ ...raw, assertions: oversized }).success)
      .toBe(false);
    expect(indexed).toBe(false);
    expect(fidelityProbeResultSchema.safeParse({
      ...raw,
      assertions: new Array(raw.assertions.length)
    }).success).toBe(false);
  });

  test('exported probe schema descriptor-clones and never traverses hostile proxies', async () => {
    const base = createFakeFidelityProbeAdapter();
    const raw = await base.runProbe('route.contracts', {
      challengeId: 'challenge',
      sandboxRoot: SANDBOX_ROOT,
      signal: new AbortController().signal
    }) as FidelityProbeResult;
    let traps = 0;
    const hostile = <T extends object>(target: T): T => new Proxy(target, {
      get() {
        traps += 1;
        throw new Error('proxy get must not run');
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error('proxy descriptor must not run');
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error('proxy prototype must not run');
      },
      ownKeys() {
        traps += 1;
        throw new Error('proxy keys must not run');
      }
    });

    const rootProxy = hostile({ ...raw });
    const arrayProxy = hostile([...raw.assertions]);
    const entryProxy = hostile({ ...raw.assertions[0] });
    const evidenceProxy = hostile({ digest: raw.assertions[0].evidenceDigest });
    for (const candidate of [
      rootProxy,
      { ...raw, assertions: arrayProxy },
      { ...raw, assertions: [entryProxy, ...raw.assertions.slice(1)] },
      {
        ...raw,
        assertions: [
          { ...raw.assertions[0], evidenceDigest: evidenceProxy },
          ...raw.assertions.slice(1)
        ]
      }
    ]) {
      expect(fidelityProbeResultSchema.safeParse(candidate).success).toBe(false);
    }
    expect(traps).toBe(0);

    const accessor = { ...raw.assertions[0] } as Record<string, unknown>;
    Object.defineProperty(accessor, 'status', {
      enumerable: true,
      get() {
        traps += 1;
        throw new Error('assertion getter must not run');
      }
    });
    const hidden = { ...raw } as Record<string, unknown>;
    Object.defineProperty(hidden, 'measuredAt', {
      value: raw.measuredAt,
      enumerable: false
    });
    expect(fidelityProbeResultSchema.safeParse({
      ...raw,
      assertions: [accessor, ...raw.assertions.slice(1)]
    }).success).toBe(false);
    expect(fidelityProbeResultSchema.safeParse({ ...raw, extra: true }).success).toBe(false);
    expect(fidelityProbeResultSchema.safeParse(hidden).success).toBe(false);
    expect(traps).toBe(0);
    expect(fidelityProbeResultSchema.safeParse(raw).success).toBe(true);
  });

  test('throw and timeout normalize to unknown with stable diagnostics', async () => {
    const thrown = await measure(createFakeFidelityProbeAdapter({
      faults: { 'run.trusted-attestation': 'throw' }
    }));
    expect(thrown.probes.find(probe => probe.probeId === 'run.trusted-attestation'))
      .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_THROWN' });

    jest.useFakeTimers();
    try {
      const adapter = createFakeFidelityProbeAdapter({
        faults: { 'run.cancellation': 'timeout' }
      });
      const pending = measure(adapter, 25, {}, createFakeProbeIsolationExecutor(adapter, {
        undrainedProbeIds: ['run.cancellation']
      }));
      await jest.advanceTimersByTimeAsync(35);
      const timedOut = await pending;
      expect(timedOut.probes.find(probe => probe.probeId === 'run.cancellation'))
        .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_TIMEOUT' });
      expect(timedOut.probes.filter(probe => probe.diagnosticCode === 'PROBE_RUNNER_POISONED')
        .map(probe => probe.probeId)).toEqual([
        'run.metering.tokens',
        'run.metering.cost'
      ]);
      expect(adapter.observedChallenges()).toEqual(
        FIDELITY_PROBE_IDS.slice(0, FIDELITY_PROBE_IDS.indexOf('run.cancellation') + 1)
          .map(probeId => `fake-fidelity-challenge:${probeId}`)
      );
      expect(timedOut.diagnostics).toEqual({
        poisoned: true,
        isolation: 'killable',
        quarantines: [{
          probeId: 'run.cancellation',
          sandboxRoot: expect.stringMatching(/08-run-cancellation-[0-9a-f]{16}$/),
          diagnosticCode: 'PROBE_TIMEOUT'
        }]
      });
      expect(evaluateSurfaceFidelity(timedOut, requirements()).run.reasons)
        .toContain('RUN_CANCELLATION_INCONCLUSIVE');
    } finally {
      jest.useRealTimers();
    }
  });

  test('passing transcript with never-settling handle is unknown and poisons Run', async () => {
    const adapter = createFakeFidelityProbeAdapter();
    const base = createFakeProbeIsolationExecutor(adapter);
    let rogue = false;
    let terminateCalled = false;
    let drainStarted!: () => void;
    const draining = new Promise<void>(resolve => {
      drainStarted = resolve;
    });
    const executor: ProbeIsolationExecutor = {
      isolation: 'killable',
      startProbe(probeId, invocation) {
        const handle = base.startProbe(probeId, invocation);
        if (!rogue || probeId !== 'run.host-identity') return handle;
        return {
          result: handle.result,
          get settled() {
            drainStarted();
            return new Promise<void>(() => undefined);
          },
          async terminate() {
            terminateCalled = true;
            await handle.terminate();
          }
        };
      }
    };
    const runner = createHostFidelityRunner();
    const registration = runner.registerAdapter(adapter.subject, executor);
    const options: FidelityMeasurementOptions = {
      sandboxRoot: SANDBOX_ROOT,
      probeTimeoutMs: 100,
      probeDrainTimeoutMs: 5,
      now: () => new Date(FAKE_FIDELITY_MEASURED_AT),
      challengeSource: createFakeFidelityChallengeSource()
    };
    const clean = await runner.measure(registration, options);
    expect(evaluateSurfaceFidelity(clean, requirements()).run.fidelity).toBe('exact');

    rogue = true;
    const pending = runner.measure(registration, options);
    await draining;
    expect(evaluateSurfaceFidelity(clean, requirements()).run.fidelity).not.toBe('exact');

    const measured = await pending;
    expect(terminateCalled).toBe(true);
    expect(measured.probes.find(probe => probe.probeId === 'run.host-identity'))
      .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_TIMEOUT' });
    expect(measured.diagnostics.poisoned).toBe(true);
    expect(measured.diagnostics.quarantines).toHaveLength(1);
    expect(evaluateSurfaceFidelity(measured, requirements()).run.fidelity).not.toBe('exact');
  });

  test('passing transcript is accepted only after late natural settlement', async () => {
    const adapter = createFakeFidelityProbeAdapter();
    let terminateCalled = false;
    const executor = wrappingExecutor(adapter, 'run.host-identity', handle => ({
      result: handle.result,
      settled: handle.result.then(() => new Promise<void>(resolve => setTimeout(resolve, 5))),
      async terminate() {
        terminateCalled = true;
        await handle.terminate();
      }
    }));

    const measured = await measure(adapter, 100, { probeDrainTimeoutMs: 20 }, executor);
    expect(terminateCalled).toBe(false);
    expect(measured.probes.find(probe => probe.probeId === 'run.host-identity')?.status).toBe('pass');
    expect(evaluateSurfaceFidelity(measured, requirements()).run.fidelity).toBe('exact');
  });

  test('rejected result with live handle is terminated and never trusted', async () => {
    const adapter = createFakeFidelityProbeAdapter({
      faults: { 'run.host-identity': 'throw' }
    });
    let terminateCalled = false;
    let settle!: () => void;
    const live = new Promise<void>(resolve => {
      settle = resolve;
    });
    const executor = wrappingExecutor(adapter, 'run.host-identity', handle => ({
      result: handle.result,
      settled: live,
      async terminate() {
        terminateCalled = true;
        await handle.terminate();
        settle();
      }
    }));

    const measured = await measure(adapter, 100, { probeDrainTimeoutMs: 5 }, executor);
    expect(terminateCalled).toBe(true);
    expect(measured.probes.find(probe => probe.probeId === 'run.host-identity'))
      .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_THROWN' });
    expect(evaluateSurfaceFidelity(measured, requirements()).run.fidelity).not.toBe('exact');
  });

  test('rejected settled promise poisons and quarantines runner', async () => {
    const adapter = createFakeFidelityProbeAdapter();
    let terminateCalled = false;
    const executor = wrappingExecutor(adapter, 'run.host-identity', handle => ({
      result: handle.result,
      settled: handle.result.then(() => {
        throw new Error('settlement verification failed');
      }),
      async terminate() {
        terminateCalled = true;
        await handle.terminate();
      }
    }));

    const measured = await measure(adapter, 100, { probeDrainTimeoutMs: 5 }, executor);
    expect(terminateCalled).toBe(true);
    expect(measured.probes.find(probe => probe.probeId === 'run.host-identity'))
      .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_TIMEOUT' });
    expect(measured.diagnostics.poisoned).toBe(true);
    expect(measured.diagnostics.quarantines).toHaveLength(1);
    expect(evaluateSurfaceFidelity(measured, requirements()).run.fidelity).toBe('plan-only');
  });

  test('settlement after monotonic probe deadline cannot be accepted', async () => {
    const adapter = createFakeFidelityProbeAdapter();
    let monotonic = 0;
    let terminateCalled = false;
    const executor = wrappingExecutor(adapter, 'run.host-identity', handle => ({
      result: handle.result,
      get settled() {
        return Promise.resolve().then(() => {
          monotonic = 11;
        });
      },
      async terminate() {
        terminateCalled = true;
        await handle.terminate();
      }
    }));

    const measured = await measure(adapter, 10, {
      probeDrainTimeoutMs: 5,
      monotonicNow: () => monotonic
    }, executor);
    expect(terminateCalled).toBe(true);
    expect(measured.probes.find(probe => probe.probeId === 'run.host-identity'))
      .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_TIMEOUT' });
    expect(evaluateSurfaceFidelity(measured, requirements()).run.fidelity).toBe('plan-only');
  });

  test('clean pass and natural settlement remain exact without termination', async () => {
    const adapter = createFakeFidelityProbeAdapter();
    let terminateCalls = 0;
    const base = createFakeProbeIsolationExecutor(adapter);
    const executor: ProbeIsolationExecutor = {
      isolation: 'killable',
      startProbe(probeId, invocation) {
        const handle = base.startProbe(probeId, invocation);
        return {
          result: handle.result,
          settled: handle.settled,
          async terminate() {
            terminateCalls += 1;
            await handle.terminate();
          }
        };
      }
    };

    const measured = await measure(adapter, 100, {}, executor);
    expect(terminateCalls).toBe(0);
    expect(evaluateSurfaceFidelity(measured, requirements()).run.fidelity).toBe('exact');
  });

  test('undrained timeout permanently poisons runner and prevents adapter reuse', async () => {
    jest.useFakeTimers();
    try {
      const runner = createHostFidelityRunner();
      const timedOutAdapter = createFakeFidelityProbeAdapter({
        faults: { 'route.contracts': 'timeout' }
      });
      const first = runner.measure(runner.registerAdapter(
        timedOutAdapter.subject,
        createFakeProbeIsolationExecutor(timedOutAdapter, {
          undrainedProbeIds: ['route.contracts']
        })
      ), {
        sandboxRoot: SANDBOX_ROOT,
        probeTimeoutMs: 5,
        probeDrainTimeoutMs: 5,
        now: () => new Date(FAKE_FIDELITY_MEASURED_AT),
        challengeSource: createFakeFidelityChallengeSource('poison')
      });
      await jest.advanceTimersByTimeAsync(10);
      expect((await first).diagnostics.poisoned).toBe(true);

      const replacement = createFakeFidelityProbeAdapter();
      const second = await runner.measure(runner.registerAdapter(
        replacement.subject,
        createFakeProbeIsolationExecutor(replacement)
      ), {
        sandboxRoot: SANDBOX_ROOT,
        now: () => new Date(FAKE_FIDELITY_MEASURED_AT),
        challengeSource: createFakeFidelityChallengeSource('replacement')
      });
      expect(second.probes.every(probe => probe.diagnosticCode === 'PROBE_RUNNER_POISONED'))
        .toBe(true);
      expect(replacement.observedChallenges()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('older trusted measurement observes later live runner poison state', async () => {
    jest.useFakeTimers();
    try {
      const runner = createHostFidelityRunner();
      const cleanAdapter = createFakeFidelityProbeAdapter();
      const cleanRegistration = runner.registerAdapter(
        cleanAdapter.subject,
        createFakeProbeIsolationExecutor(cleanAdapter)
      );
      const clean = await runner.measure(cleanRegistration, {
        sandboxRoot: SANDBOX_ROOT,
        now: () => new Date(FAKE_FIDELITY_MEASURED_AT),
        challengeSource: createFakeFidelityChallengeSource('clean')
      });
      expect(evaluateSurfaceFidelity(clean, requirements()).run.fidelity).toBe('exact');

      const poisonedAdapter = createFakeFidelityProbeAdapter({
        faults: { 'run.metering.cost': 'timeout' }
      });
      const poisoning = runner.measure(runner.registerAdapter(
        poisonedAdapter.subject,
        createFakeProbeIsolationExecutor(poisonedAdapter, {
          undrainedProbeIds: ['run.metering.cost']
        })
      ), {
        sandboxRoot: SANDBOX_ROOT,
        probeTimeoutMs: 5,
        probeDrainTimeoutMs: 5,
        now: () => new Date(FAKE_FIDELITY_MEASURED_AT),
        challengeSource: createFakeFidelityChallengeSource('later')
      });
      await jest.advanceTimersByTimeAsync(10);
      await poisoning;

      expect(clean.diagnostics.poisoned).toBe(false);
      const reevaluated = evaluateSurfaceFidelity(clean, requirements());
      expect(reevaluated.route).toEqual({ fidelity: 'exact', reasons: [] });
      expect(reevaluated.run).toEqual({ fidelity: 'plan-only', reasons: ['RUNNER_POISONED'] });
      expect(reevaluated.diagnostics.poisoned).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('poison in optional meter probe prevents exact Run while preserving completed Route', async () => {
    jest.useFakeTimers();
    try {
      const adapter = createFakeFidelityProbeAdapter({
        faults: { 'run.metering.tokens': 'timeout' }
      });
      const pending = measure(adapter, 5, { probeDrainTimeoutMs: 5 },
        createFakeProbeIsolationExecutor(adapter, {
          undrainedProbeIds: ['run.metering.tokens']
        }));
      await jest.advanceTimersByTimeAsync(10);
      const measured = await pending;
      const report = evaluateSurfaceFidelity(measured, requirements());
      expect(measured.diagnostics.poisoned).toBe(true);
      expect(report.route).toEqual({ fidelity: 'exact', reasons: [] });
      expect(report.run).toEqual({ fidelity: 'plan-only', reasons: ['RUNNER_POISONED'] });
      expect(evaluateSurfaceFidelity(measured, undefined).run).toEqual({
        fidelity: 'plan-only',
        reasons: ['RUNNER_POISONED', 'RUN_REQUIREMENTS_INVALID']
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('probes run sequentially in isolated sandboxes and bounded abort drain avoids poisoning', async () => {
    const base = createFakeFidelityProbeAdapter();
    const starts: FidelityProbeId[] = [];
    const sandboxes: string[] = [];
    let active = 0;
    let maxActive = 0;
    const adapter: FidelityProbeAdapter = {
      subject: base.subject,
      async runProbe(probeId, context) {
        starts.push(probeId);
        sandboxes.push(context.sandboxRoot);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const raw = await base.runProbe(probeId, context);
        if (probeId === 'run.cancellation') {
          await new Promise<void>(resolve => {
            context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        active -= 1;
        return raw;
      }
    };

    const measured = await measure(adapter, 5, { probeDrainTimeoutMs: 20 });
    expect(starts).toEqual(FIDELITY_PROBE_IDS);
    expect(maxActive).toBe(1);
    expect(new Set(sandboxes).size).toBe(FIDELITY_PROBE_IDS.length);
    expect(sandboxes.every(sandbox => sandbox.startsWith(`${SANDBOX_ROOT}${path.sep}`)))
      .toBe(true);
    expect(measured.probes.find(probe => probe.probeId === 'run.cancellation'))
      .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_TIMEOUT' });
    expect(measured.diagnostics).toEqual({
      poisoned: false,
      isolation: 'killable',
      quarantines: []
    });
  });

  test('in-process executor cannot grant exact or supervised fidelity', async () => {
    const adapter = createFakeFidelityProbeAdapter();
    const measured = await measure(
      adapter,
      100,
      {},
      createFakeProbeIsolationExecutor(adapter, { isolation: 'in-process' })
    );
    const report = evaluateSurfaceFidelity(measured, requirements('human-checkpoint'));
    expect(report.route).toEqual({
      fidelity: 'plan-only',
      reasons: ['ROUTE_ISOLATION_NOT_KILLABLE']
    });
    expect(report.run).toEqual({
      fidelity: 'plan-only',
      reasons: ['RUN_ISOLATION_NOT_KILLABLE']
    });
  });

  test('monotonic late result is terminated, unknown, and poisoned', async () => {
    const adapter = createFakeFidelityProbeAdapter();
    const baseExecutor = createFakeProbeIsolationExecutor(adapter);
    let monotonic = 0;
    const executor: ProbeIsolationExecutor = {
      isolation: 'killable',
      startProbe(probeId, invocation) {
        const handle = baseExecutor.startProbe(probeId, invocation);
        if (probeId !== 'run.cancellation') return handle;
        monotonic = 11;
        return {
          result: handle.result,
          settled: new Promise(() => undefined),
          terminate: () => handle.terminate()
        };
      }
    };
    const measured = await measure(adapter, 10, {
      probeDrainTimeoutMs: 2,
      monotonicNow: () => monotonic
    }, executor);
    expect(measured.probes.find(probe => probe.probeId === 'run.cancellation'))
      .toMatchObject({ status: 'unknown', diagnosticCode: 'PROBE_TIMEOUT' });
    expect(measured.diagnostics.poisoned).toBe(true);
    expect(evaluateSurfaceFidelity(measured, requirements()).run.fidelity).toBe('plan-only');
  });

  test.each([
    ['decreasing', (() => {
      let call = 0;
      return () => call++ === 0 ? 10 : 9;
    })()],
    ['invalid', () => Number.NaN]
  ] as const)('%s monotonic clock fails closed', async (_condition, monotonicNow) => {
    const adapter = createFakeFidelityProbeAdapter();
    const measured = await measure(adapter, 10, { monotonicNow });
    expect(measured.probes[0]).toMatchObject({
      status: 'unknown',
      diagnosticCode: 'PROBE_TIMEOUT'
    });
  });

  test('reason and probe order remains canonical', async () => {
    const base = createFakeFidelityProbeAdapter({
      outcomes: {
        'run.trusted-attestation': 'fail',
        'run.host-identity': 'fail',
        'run.cancellation': 'fail'
      }
    });
    const adapter: FidelityProbeAdapter = {
      subject: base.subject,
      async runProbe(probeId, context) {
        return base.runProbe(probeId, context);
      }
    };
    const report = evaluateSurfaceFidelity(await measure(adapter), requirements());
    expect(report.probes.map(probe => probe.probeId)).toEqual(FIDELITY_PROBE_IDS);
    expect(report.run.reasons).toEqual([
      'RUN_ATTESTATION_FAILED',
      'RUN_HOST_IDENTITY_FAILED',
      'RUN_CANCELLATION_FAILED'
    ]);
  });

  test('cancellation and topology catalogs require every runtime denial assertion', () => {
    expect(FIDELITY_ASSERTION_CATALOG['run.action-mediation']).toEqual([
      'every-effect-path-gated',
      'every-spawn-path-gated',
      'bypass-corpus-denied',
      'intent-before-effect',
      'effect-boundary-guard'
    ]);
    expect(FIDELITY_ASSERTION_CATALOG['run.cancellation']).toEqual([
      'generation-committed-before-authorize',
      'pending-effects-denied',
      'descendants-signalled',
      'bounded-drain',
      'no-post-cancel-effect'
    ]);
    expect(FIDELITY_ASSERTION_CATALOG['run.depth-topology']).toEqual([
      'root-to-leaf-denied',
      'eo-to-eo-denied',
      'leaf-delegation-denied',
      'depth-overflow-denied'
    ]);
    expect(Object.isFrozen(FIDELITY_ASSERTION_CATALOG)).toBe(true);
    for (const probeId of FIDELITY_PROBE_IDS) {
      expect(Object.isFrozen(FIDELITY_ASSERTION_CATALOG[probeId])).toBe(true);
    }
  });

  test('incomplete receipt evidence is plan-only', async () => {
    const measured = await measure(wrappingAdapter('run.receipt-integrity', raw => {
      const result = raw as FidelityProbeResult;
      return { ...result, assertions: result.assertions.filter(
        assertion => assertion.assertionId !== 'fingerprint-validation'
      ) };
    }));
    expect(evaluateSurfaceFidelity(measured, requirements()).run).toEqual({
      fidelity: 'plan-only',
      reasons: ['RUN_RECEIPT_INTEGRITY_INCONCLUSIVE']
    });
  });

  test('arbitrary clones and JSON cannot mint a passing measurement', async () => {
    const measured = await measure();
    for (const candidate of [
      { ...measured },
      JSON.parse(JSON.stringify(measured)),
      { schemaVersion: 1, subject: measured.subject, probes: measured.probes }
    ]) {
      const report = evaluateSurfaceFidelity(candidate, requirements());
      expect(report.route).toEqual({
        fidelity: 'unsupported',
        reasons: ['ROUTE_MEASUREMENT_UNTRUSTED']
      });
      expect(report.run).toEqual({
        fidelity: 'unsupported',
        reasons: ['RUN_MEASUREMENT_UNTRUSTED']
      });
    }

    const fakeReport = evaluateSurfaceFidelity(createFakeFidelityProbeAdapter(), requirements());
    expect(fakeReport.route.reasons).toEqual(['ROUTE_MEASUREMENT_UNTRUSTED']);
    expect(fakeReport.run.reasons).toEqual(['RUN_MEASUREMENT_UNTRUSTED']);

    const absent = evaluateSurfaceFidelity(undefined, requirements());
    expect(absent.route.reasons).toEqual(['ROUTE_MEASUREMENT_NOT_MEASURED']);
    expect(absent.run.reasons).toEqual(['RUN_MEASUREMENT_NOT_MEASURED']);
  });

  test('fake clock, challenge, evidence, and deeply frozen output are deterministic', async () => {
    const firstAdapter = createFakeFidelityProbeAdapter();
    const secondAdapter = createFakeFidelityProbeAdapter();
    const first = await measure(firstAdapter);
    const second = await measure(secondAdapter);

    expect(first).toEqual(second);
    expect(first.subject).toEqual(FAKE_FIDELITY_SUBJECT);
    expect(first.probes.every(probe => probe.measuredAt === FAKE_FIDELITY_MEASURED_AT)).toBe(true);
    expect(firstAdapter.observedChallenges()).toEqual(
      FIDELITY_PROBE_IDS.map(probeId => `fake-fidelity-challenge:${probeId}`)
    );
    for (const probe of first.probes) {
      for (const assertion of probe.assertions) {
        expect(assertion.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    }
    expectDeepFrozen(first);
    expectDeepFrozen(evaluateSurfaceFidelity(first, requirements()));
  });

  test('recursive production dependency and export scan excludes fidelity authority', () => {
    const sourceRoot = path.join(__dirname, '../../src');
    const fidelityRoot = path.join(sourceRoot, 'agents/run/fidelity');
    const surfaceRoot = path.join(sourceRoot, 'surfaces');
    const fidelitySources = typescriptFiles(fidelityRoot)
      .map(filename => fs.readFileSync(filename, 'utf8')).join('\n');
    const surfaceSources = typescriptFiles(surfaceRoot)
      .map(filename => fs.readFileSync(filename, 'utf8')).join('\n');
    const publicBarrels = typescriptFiles(sourceRoot)
      .filter(filename => path.basename(filename) === 'index.ts')
      .map(filename => fs.readFileSync(filename, 'utf8')).join('\n');
    const authoritySources = ['internal.ts', 'probes.ts']
      .map(filename => fs.readFileSync(path.join(fidelityRoot, filename), 'utf8')).join('\n');

    expect(fidelitySources).not.toMatch(/from ['"].*surfaces\//);
    expect(fidelitySources).not.toMatch(/surfaceId:\s*['"](?:opencode|claude-code|codex|pi)['"]/);
    expect(surfaceSources).not.toMatch(/run\/fidelity\/(?:internal|probes|fake-adapter)/);
    expect(surfaceSources).not.toMatch(/createHostFidelityRunner|registerAdapter\(/);
    expect(authoritySources).not.toMatch(/adapter\.runProbe|\.runProbe\(probeId,/);
    expect(publicBarrels).not.toMatch(/fidelity\/(?:internal|probes|fake-adapter)/);
    expect(fs.readFileSync(path.join(fidelityRoot, 'index.ts'), 'utf8')).not.toMatch(
      /internal|probes|fake-adapter|createHostFidelityRunner|FidelityProbeAdapter/
    );
    expect(fidelityPublic).not.toHaveProperty('createHostFidelityRunner');
    expect(fidelityPublic).not.toHaveProperty('createFakeFidelityProbeAdapter');
    expect(fidelityPublic).not.toHaveProperty('runCanonicalFidelityProbes');
  });
});
