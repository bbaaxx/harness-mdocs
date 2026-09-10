import { z } from 'zod';

import { canonicalizeJson, kebabIdSchema } from '../../contracts';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FORBIDDEN_DISPLAY_CONTROL = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

export const COMPILER_RESOURCE_LIMITS = Object.freeze({
  rawJsonBytes: 1024 * 1024,
  stringLength: 16 * 1024,
  traversedValues: 10_000,
  depth: 32,
  milestones: 256,
  workstreamsPerMilestone: 256,
  leavesPerWorkstream: 256,
  dependenciesPerMilestone: 256,
  criteriaPerCollection: 256,
  selectorsPerCollection: 1024,
  rulesPerCollection: 256,
  adapterRequirements: 256
} as const);

function validUnicode(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

const humanStringSchema = z.string()
  .max(
    COMPILER_RESOURCE_LIMITS.stringLength,
    `String exceeds maximum length ${COMPILER_RESOURCE_LIMITS.stringLength}`
  )
  .refine(validUnicode, 'String contains an invalid Unicode lone surrogate')
  .refine(
    value => Buffer.byteLength(value, 'utf8') <= COMPILER_RESOURCE_LIMITS.stringLength,
    `String exceeds maximum UTF-8 byte length ${COMPILER_RESOURCE_LIMITS.stringLength}`
  )
  .refine(
    value => !FORBIDDEN_DISPLAY_CONTROL.test(value),
    'String contains a control or bidirectional formatting character'
  )
  .transform(value => value.trim())
  .pipe(z.string().min(1));

const humanStringListSchema = z.array(humanStringSchema).max(
  COMPILER_RESOURCE_LIMITS.rulesPerCollection,
  `Collection exceeds maximum length ${COMPILER_RESOURCE_LIMITS.rulesPerCollection}`
);
const criteriaSchema = z.array(humanStringSchema)
  .min(1)
  .max(
    COMPILER_RESOURCE_LIMITS.criteriaPerCollection,
    `Criteria exceed maximum length ${COMPILER_RESOURCE_LIMITS.criteriaPerCollection}`
  );

/** Relative project path, optionally ending in the only supported glob suffix: `/**`. */
export const writeSelectorSchema = z.string().superRefine((value, context) => {
  if (!validUnicode(value)) {
    context.addIssue({ code: 'custom', message: 'Write selector contains an invalid Unicode lone surrogate' });
  }
  if (value.length > COMPILER_RESOURCE_LIMITS.stringLength) {
    context.addIssue({ code: 'custom', message: 'Write selector exceeds maximum string length' });
  }
  if (FORBIDDEN_DISPLAY_CONTROL.test(value)) {
    context.addIssue({ code: 'custom', message: 'Write selector contains a control or bidirectional formatting character' });
  }
  if (value.length === 0 || value.trim() !== value) {
    context.addIssue({ code: 'custom', message: 'Write selector must be nonempty and unpadded' });
  }
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) {
    context.addIssue({ code: 'custom', message: 'Write selector must be project-relative' });
  }
  if (value.includes('\\')) {
    context.addIssue({ code: 'custom', message: 'Write selector must use POSIX separators' });
  }
  if (value.includes('//')) {
    context.addIssue({ code: 'custom', message: 'Write selector cannot contain repeated separators' });
  }

  const wildcardIndex = value.indexOf('*');
  if (wildcardIndex !== -1 && (!value.endsWith('/**') || wildcardIndex !== value.length - 2)) {
    context.addIssue({ code: 'custom', message: 'Write selector only supports a terminal "/**" wildcard' });
  }
  if (/[?\[\]{}]/.test(value)) {
    context.addIssue({ code: 'custom', message: 'Write selector contains an unsupported wildcard' });
  }

  const pathPart = value.endsWith('/**') ? value.slice(0, -3) : value;
  if (pathPart.length === 0) {
    context.addIssue({ code: 'custom', message: 'Write selector wildcard requires a directory path' });
  }
  if (pathPart.endsWith('/')) {
    context.addIssue({ code: 'custom', message: 'Write selector cannot end with a separator' });
  }
  if (pathPart.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    context.addIssue({ code: 'custom', message: 'Write selector cannot contain empty, dot, or dotdot segments' });
  }
});

const writeSelectorListSchema = z.array(writeSelectorSchema)
  .max(
    COMPILER_RESOURCE_LIMITS.selectorsPerCollection,
    `Selectors exceed maximum length ${COMPILER_RESOURCE_LIMITS.selectorsPerCollection}`
  );
const nonemptyWriteSelectorListSchema = writeSelectorListSchema.min(1);

const positiveSafeInteger = z.number().int().positive().safe();
const positiveFiniteNumber = z.number().positive().finite().max(Number.MAX_SAFE_INTEGER);

export const executionPlanBudgetInputSchema = z.object({
  maxActiveExecutionOrchestrators: positiveSafeInteger.optional(),
  maxLeavesPerEO: positiveSafeInteger.optional(),
  maxGlobalDescendants: positiveSafeInteger.optional(),
  maxCumulativeSpawns: positiveSafeInteger.optional(),
  retryPerNode: positiveSafeInteger.optional(),
  globalRetries: positiveSafeInteger.optional(),
  localFixLoops: positiveSafeInteger.optional(),
  wallTimeMinutesRun: positiveFiniteNumber.optional(),
  wallTimeMinutesEo: positiveFiniteNumber.optional(),
  wallTimeMinutesLeaf: positiveFiniteNumber.optional(),
  toolActionsGlobal: positiveSafeInteger.optional(),
  toolActionsEo: positiveSafeInteger.optional(),
  toolActionsLeaf: positiveSafeInteger.optional(),
  tokensGlobal: positiveSafeInteger.optional(),
  tokensEo: positiveSafeInteger.optional(),
  tokensLeaf: positiveSafeInteger.optional(),
  costUsdGlobal: positiveFiniteNumber.optional(),
  costUsdEo: positiveFiniteNumber.optional()
}).strict();

const leafInputSchema = z.object({
  key: kebabIdSchema,
  criteria: criteriaSchema,
  writeSet: nonemptyWriteSelectorListSchema
}).strict();

const workstreamInputSchema = z.object({
  key: kebabIdSchema,
  criteria: criteriaSchema,
  writeSet: nonemptyWriteSelectorListSchema,
  leaves: z.array(leafInputSchema).max(
    COMPILER_RESOURCE_LIMITS.leavesPerWorkstream,
    `Leaves exceed maximum length ${COMPILER_RESOURCE_LIMITS.leavesPerWorkstream}`
  )
}).strict();

const milestoneInputSchema = z.object({
  key: kebabIdSchema,
  dependsOn: z.array(kebabIdSchema).max(
    COMPILER_RESOURCE_LIMITS.dependenciesPerMilestone,
    `Dependencies exceed maximum length ${COMPILER_RESOURCE_LIMITS.dependenciesPerMilestone}`
  ),
  criteria: criteriaSchema,
  verification: humanStringSchema,
  writeSet: nonemptyWriteSelectorListSchema,
  integrationCriteria: criteriaSchema,
  workstreams: z.array(workstreamInputSchema)
    .min(1)
    .max(
      COMPILER_RESOURCE_LIMITS.workstreamsPerMilestone,
      `Workstreams exceed maximum length ${COMPILER_RESOURCE_LIMITS.workstreamsPerMilestone}`
    )
}).strict();

/** Strict untrusted compiler input. Semantic graph and attenuation checks run during normalization. */
export const planGraphInputSchema = z.object({
  planKey: kebabIdSchema,
  planRevision: z.number().int().positive().safe(),
  objective: humanStringSchema,
  scope: writeSelectorListSchema,
  outOfScope: writeSelectorListSchema,
  milestones: z.array(milestoneInputSchema).min(1).max(
    COMPILER_RESOURCE_LIMITS.milestones,
    `Milestones exceed maximum length ${COMPILER_RESOURCE_LIMITS.milestones}`
  ),
  integrationCriteria: criteriaSchema,
  regressionCriteria: z.array(humanStringSchema).max(
    COMPILER_RESOURCE_LIMITS.criteriaPerCollection,
    `Criteria exceed maximum length ${COMPILER_RESOURCE_LIMITS.criteriaPerCollection}`
  ),
  expectedSideEffects: humanStringListSchema,
  policy: z.record(z.string(), z.unknown()),
  budgets: executionPlanBudgetInputSchema.optional(),
  adapterRequirements: z.array(humanStringSchema).max(
    COMPILER_RESOURCE_LIMITS.adapterRequirements,
    `Adapter requirements exceed maximum length ${COMPILER_RESOURCE_LIMITS.adapterRequirements}`
  ),
  pauseRules: humanStringListSchema,
  failureRules: humanStringListSchema,
  cancelRules: humanStringListSchema,
  completionRules: humanStringListSchema
}).strict();

export type WriteSelector = z.infer<typeof writeSelectorSchema>;
export type ExecutionPlanBudgetInput = z.infer<typeof executionPlanBudgetInputSchema>;
export type PlanGraphInput = z.infer<typeof planGraphInputSchema>;

export const DEFAULT_EXECUTION_PLAN_BUDGETS = Object.freeze({
  maxActiveExecutionOrchestrators: 2,
  maxLeavesPerEO: 2,
  maxGlobalDescendants: 6,
  maxCumulativeSpawns: 12,
  retryPerNode: 1,
  globalRetries: 4,
  localFixLoops: 2,
  wallTimeMinutesRun: 60,
  wallTimeMinutesEo: 20,
  wallTimeMinutesLeaf: 10,
  toolActionsGlobal: 120,
  toolActionsEo: 40,
  toolActionsLeaf: 20,
  tokensGlobal: 200000,
  tokensEo: 60000,
  tokensLeaf: 25000,
  costUsdGlobal: 5,
  costUsdEo: 2
} as const);

export type ExecutionPlanBudgets = {
  [Key in keyof typeof DEFAULT_EXECUTION_PLAN_BUDGETS]: number;
};

export type NormalizedPlanGraphInput = Omit<PlanGraphInput, 'budgets'> & {
  budgets: ExecutionPlanBudgets;
};

function selectorBase(selector: WriteSelector): string {
  return selector.endsWith('/**') ? selector.slice(0, -3) : selector;
}

/** Exact selectors cover only themselves; `dir/**` covers `dir` and descendants. */
export function writeSelectorCovers(parent: WriteSelector, child: WriteSelector): boolean {
  if (!parent.endsWith('/**')) return parent === child;
  const parentBase = selectorBase(parent);
  const childBase = selectorBase(child);
  return childBase === parentBase || childBase.startsWith(`${parentBase}/`);
}

/** True when two selectors can name at least one common path. */
export function writeSelectorsOverlap(left: WriteSelector, right: WriteSelector): boolean {
  return writeSelectorCovers(left, right) || writeSelectorCovers(right, left);
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareUtf16);
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejectDuplicateKeys(values: readonly { key: string }[], namespace: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.key)) throw new Error(`Duplicate ${namespace} key "${value.key}"`);
    seen.add(value.key);
  }
}

function canonicalPolicy(policy: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(canonicalizeJson(policy)) as Record<string, unknown>;
}

/**
 * Rejects values outside plain JSON data without reading properties or invoking
 * accessors. Proxy reflection traps cannot be neutralized in JavaScript; raw
 * JSON through compilePlanGraphJson is the preferred hostile-data boundary.
 */
export interface CompilerDataValidationLimits {
  maxDepth?: number;
  maxValues?: number;
  maxStringLength?: number;
}

/** Descriptor-only validation for untrusted programmatic values. */
export function assertCompilerData(
  value: unknown,
  limits: CompilerDataValidationLimits = {}
): void {
  const resolved = {
    maxDepth: limits.maxDepth ?? COMPILER_RESOURCE_LIMITS.depth,
    maxValues: limits.maxValues ?? COMPILER_RESOURCE_LIMITS.traversedValues,
    maxStringLength: limits.maxStringLength ?? COMPILER_RESOURCE_LIMITS.stringLength
  };
  const state = { values: 0 };
  assertPlainData(value, new Set(), '$', 0, resolved, state);
}

function assertPlainData(
  value: unknown,
  ancestors: Set<object>,
  path: string,
  depth: number,
  limits: Required<CompilerDataValidationLimits>,
  state: { values: number }
): void {
  state.values += 1;
  if (state.values > limits.maxValues) {
    throw new Error(`Compiler data exceeds maximum value count ${limits.maxValues}`);
  }
  if (depth > limits.maxDepth) {
    throw new Error(`Compiler data exceeds maximum depth ${limits.maxDepth} at ${path}`);
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > limits.maxStringLength) {
      throw new Error(`Compiler string exceeds maximum UTF-8 byte length ${limits.maxStringLength} at ${path}`);
    }
    if (!validUnicode(value)) {
      throw new Error(`Compiler string contains an invalid Unicode lone surrogate at ${path}`);
    }
    if (FORBIDDEN_DISPLAY_CONTROL.test(value)) {
      throw new Error(`Compiler string contains a control or bidirectional formatting character at ${path}`);
    }
  }
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new Error(`Compiler data contains a non-I-JSON number at ${path}`);
    }
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`Compiler data contains non-JSON ${typeof value} at ${path}`);
  }
  if (ancestors.has(value)) throw new Error(`Compiler input contains a cycle at ${path}`);

  const array = Array.isArray(value);
  const remainingValues = limits.maxValues - state.values;
  let arrayLength: number | undefined;
  if (array) {
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor && 'value' in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      throw new Error(`Compiler input contains an invalid array length at ${path}`);
    }
    if (length > remainingValues) {
      throw new Error(`Compiler data exceeds maximum value count ${limits.maxValues}`);
    }
    arrayLength = length;
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    (array && prototype !== Array.prototype) ||
    (!array && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new Error(`Compiler input contains a custom prototype or class instance at ${path}`);
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length > remainingValues + (array ? 1 : 0)) {
    throw new Error(`Compiler data exceeds maximum value count ${limits.maxValues}`);
  }
  if (keys.some(key => typeof key === 'symbol')) {
    throw new Error(`Compiler input contains a symbol property at ${path}`);
  }
  if (array) {
    if (keys.length !== arrayLength! + 1 || keys[arrayLength!] !== 'length') {
      throw new Error(`Compiler input contains a sparse or extra-property array at ${path}`);
    }
    for (let index = 0; index < arrayLength!; index += 1) {
      if (keys[index] !== String(index)) {
        throw new Error(`Compiler input contains a sparse or extra-property array at ${path}`);
      }
    }
  }

  ancestors.add(value);
  for (const key of keys as string[]) {
    if (array && key === 'length') continue;
    if (key === '__proto__') throw new Error(`Compiler input contains poison key "__proto__" at ${path}`);
    if (Buffer.byteLength(key, 'utf8') > limits.maxStringLength) {
      throw new Error(`Compiler string exceeds maximum UTF-8 byte length ${limits.maxStringLength} at ${path}.${key}`);
    }
    if (!validUnicode(key)) {
      throw new Error(`Compiler string contains an invalid Unicode lone surrogate at ${path}.${key}`);
    }
    if (FORBIDDEN_DISPLAY_CONTROL.test(key)) {
      throw new Error(`Compiler string contains a control or bidirectional formatting character at ${path}.${key}`);
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !('value' in descriptor)) {
      throw new Error(`Compiler input contains an accessor at ${path}.${key}`);
    }
    if (!descriptor.enumerable) {
      throw new Error(`Compiler input contains a non-enumerable property at ${path}.${key}`);
    }
    assertPlainData(descriptor.value, ancestors, `${path}.${key}`, depth + 1, limits, state);
  }
  ancestors.delete(value);
}

function assertCovered(
  child: readonly WriteSelector[],
  parent: readonly WriteSelector[],
  description: string
): void {
  for (const selector of child) {
    if (!parent.some(candidate => writeSelectorCovers(candidate, selector))) {
      throw new Error(`${description} selector "${selector}" expands beyond its parent write set`);
    }
  }
}

function sortMilestones(milestones: PlanGraphInput['milestones']): PlanGraphInput['milestones'] {
  const byKey = new Map(milestones.map(milestone => [milestone.key, milestone]));
  const indegree = new Map(milestones.map(milestone => [milestone.key, milestone.dependsOn.length]));
  const outgoing = new Map<string, string[]>();
  for (const milestone of milestones) {
    for (const dependency of milestone.dependsOn) {
      outgoing.set(dependency, [...(outgoing.get(dependency) ?? []), milestone.key]);
    }
  }
  const ready = milestones.filter(milestone => indegree.get(milestone.key) === 0)
    .map(milestone => milestone.key)
    .sort(compareUtf16);
  const result: PlanGraphInput['milestones'] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    result.push(byKey.get(key)!);
    for (const dependent of (outgoing.get(key) ?? []).sort(compareUtf16)) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareUtf16);
      }
    }
  }
  if (result.length !== milestones.length) throw new Error('Milestone dependency graph contains a cycle');
  return result;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

/** Parses, validates, canonicalizes sets/order/policy, and returns a detached deeply frozen value. */
export function normalizePlanGraphInput(input: unknown): NormalizedPlanGraphInput {
  assertCompilerData(input);
  const parsed = planGraphInputSchema.parse(input);
  canonicalizeJson(parsed.policy);

  rejectDuplicateKeys(parsed.milestones, 'milestone');
  const milestoneKeys = new Set(parsed.milestones.map(milestone => milestone.key));
  for (const milestone of parsed.milestones) {
    rejectDuplicateKeys(milestone.workstreams, `workstream in milestone "${milestone.key}"`);
    const dependencyKeys = new Set<string>();
    for (const dependency of milestone.dependsOn) {
      if (dependencyKeys.has(dependency)) {
        throw new Error(`Duplicate dependency "${dependency}" on milestone "${milestone.key}"`);
      }
      dependencyKeys.add(dependency);
      if (dependency === milestone.key) throw new Error(`Milestone "${milestone.key}" depends on itself`);
      if (!milestoneKeys.has(dependency)) {
        throw new Error(`Milestone "${milestone.key}" has dangling dependency "${dependency}"`);
      }
    }
    for (const workstream of milestone.workstreams) {
      rejectDuplicateKeys(workstream.leaves, `leaf in workstream "${milestone.key}/${workstream.key}"`);
    }
  }

  const scope = sortedUnique(parsed.scope);
  const outOfScope = sortedUnique(parsed.outOfScope);
  const budgets: ExecutionPlanBudgets = { ...DEFAULT_EXECUTION_PLAN_BUDGETS, ...parsed.budgets };
  let cumulativeSpawns = 0;

  const milestones = sortMilestones(parsed.milestones).map(milestone => {
    const writeSet = sortedUnique(milestone.writeSet);
    assertCovered(writeSet, scope, `Milestone "${milestone.key}"`);
    for (const selector of writeSet) {
      if (outOfScope.some(excluded => writeSelectorsOverlap(selector, excluded))) {
        throw new Error(`Milestone "${milestone.key}" selector "${selector}" overlaps outOfScope`);
      }
    }

    const workstreams = [...milestone.workstreams].sort((a, b) => compareUtf16(a.key, b.key)).map(workstream => {
      const workstreamWriteSet = sortedUnique(workstream.writeSet);
      assertCovered(workstreamWriteSet, writeSet, `Workstream "${milestone.key}/${workstream.key}"`);
      if (workstream.leaves.length > budgets.maxLeavesPerEO) {
        throw new Error(
          `Workstream "${milestone.key}/${workstream.key}" has ${workstream.leaves.length} leaves, ` +
          `exceeding maxLeavesPerEO ${budgets.maxLeavesPerEO}`
        );
      }
      cumulativeSpawns += 1 + workstream.leaves.length;
      const leaves = [...workstream.leaves].sort((a, b) => compareUtf16(a.key, b.key)).map(leaf => {
        const leafWriteSet = sortedUnique(leaf.writeSet);
        assertCovered(leafWriteSet, workstreamWriteSet, `Leaf "${milestone.key}/${workstream.key}/${leaf.key}"`);
        return {
          key: leaf.key,
          criteria: sortedUnique(leaf.criteria),
          writeSet: leafWriteSet
        };
      });
      return {
        key: workstream.key,
        criteria: sortedUnique(workstream.criteria),
        writeSet: workstreamWriteSet,
        leaves
      };
    });
    return {
      key: milestone.key,
      dependsOn: sortedUnique(milestone.dependsOn),
      criteria: sortedUnique(milestone.criteria),
      verification: milestone.verification,
      writeSet,
      integrationCriteria: sortedUnique(milestone.integrationCriteria),
      workstreams
    };
  });

  if (cumulativeSpawns > budgets.maxCumulativeSpawns) {
    throw new Error(
      `Compiled EO+leaf node count ${cumulativeSpawns} exceeds maxCumulativeSpawns ` +
      `${budgets.maxCumulativeSpawns}`
    );
  }
  if (cumulativeSpawns > budgets.maxGlobalDescendants) {
    throw new Error(
      `Compiled EO+leaf node count ${cumulativeSpawns} exceeds maxGlobalDescendants ` +
      `${budgets.maxGlobalDescendants}`
    );
  }

  return deepFreeze({
    planKey: parsed.planKey,
    planRevision: parsed.planRevision,
    objective: parsed.objective,
    scope,
    outOfScope,
    milestones,
    integrationCriteria: sortedUnique(parsed.integrationCriteria),
    regressionCriteria: sortedUnique(parsed.regressionCriteria),
    expectedSideEffects: sortedUnique(parsed.expectedSideEffects),
    policy: canonicalPolicy(parsed.policy),
    budgets,
    adapterRequirements: sortedUnique(parsed.adapterRequirements),
    pauseRules: sortedUnique(parsed.pauseRules),
    failureRules: sortedUnique(parsed.failureRules),
    cancelRules: sortedUnique(parsed.cancelRules),
    completionRules: sortedUnique(parsed.completionRules)
  });
}

export { compareUtf16 };
