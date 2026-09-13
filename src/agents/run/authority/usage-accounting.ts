import * as crypto from 'crypto';

import { z } from 'zod';

import { canonicalizeJson } from '../../contracts';
import { UsageSample } from '../trust';
import { strictRfc3339UtcSchema } from './schema';

const TOKEN_DIMENSIONS = new Set(['tokensGlobal', 'tokensEo', 'tokensLeaf']);
const COST_DIMENSIONS = new Set(['costUsdGlobal', 'costUsdEo']);
const ACTION_DIMENSIONS = new Set(['toolActionsGlobal', 'toolActionsEo', 'toolActionsLeaf']);
const HARD_USAGE_DIMENSIONS = new Set([
  ...TOKEN_DIMENSIONS, ...COST_DIMENSIONS, ...ACTION_DIMENSIONS
]);
const COUNT_DIMENSIONS = new Set([
  'maxActiveExecutionOrchestrators', 'maxLeavesPerEO', 'maxGlobalDescendants',
  'maxCumulativeSpawns', 'retryPerNode', 'globalRetries', 'localFixLoops',
  ...TOKEN_DIMENSIONS, ...ACTION_DIMENSIONS
]);
const boundedUsageId = z.string().min(1).max(16 * 1024);
const usageAmountSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
  .refine(value => !Object.is(value, -0), 'Negative zero is forbidden');
const usageCountSchema = usageAmountSchema.int().safe();

export const authorityUsageSampleSchema = z.object({
  source: boundedUsageId,
  provider: boundedUsageId,
  model: boundedUsageId,
  inputTokens: usageCountSchema.optional(),
  outputTokens: usageCountSchema.optional(),
  cacheTokens: usageCountSchema.optional(),
  priceTableVersion: boundedUsageId,
  cost: z.object({ currency: boundedUsageId, value: usageAmountSchema }).strict().optional(),
  actionCount: usageCountSchema,
  confidence: z.enum(['authoritative', 'estimated', 'unknown']),
  timestamp: strictRfc3339UtcSchema
}).strict();

export type UsageAccountingErrorCode =
  | 'invalid-telemetry'
  | 'currency-mismatch'
  | 'budget-exceeded'
  | 'descendant-exceeded';

export class UsageAccountingError extends Error {
  constructor(readonly code: UsageAccountingErrorCode, message: string) {
    super(message);
    this.name = 'UsageAccountingError';
  }
}

function decimalParts(value: number): { coefficient: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) throw new UsageAccountingError('invalid-telemetry', 'Usage number is not canonical');
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  const coefficient = BigInt(`${match[1]}${fraction}`);
  const scale = fraction.length - exponent;
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

function compare(left: number, right: number): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const leftValue = a.coefficient * 10n ** BigInt(scale - a.scale);
  const rightValue = b.coefficient * 10n ** BigInt(scale - b.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function subtract(left: number, right: number): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const coefficient = a.coefficient * 10n ** BigInt(scale - a.scale) -
    b.coefficient * 10n ** BigInt(scale - b.scale);
  if (coefficient < 0n) {
    throw new UsageAccountingError('descendant-exceeded', 'Descendant usage exceeds measured usage');
  }
  const digits = coefficient.toString().padStart(scale + 1, '0');
  return Number(scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`);
}

function tokenTotal(sample: UsageSample, required: boolean): number {
  if (required && (sample.inputTokens === undefined || sample.outputTokens === undefined)) {
    throw new UsageAccountingError('invalid-telemetry', 'Input/output token telemetry is required');
  }
  const values = [sample.inputTokens ?? 0, sample.outputTokens ?? 0, sample.cacheTokens ?? 0];
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new UsageAccountingError('invalid-telemetry', 'Token telemetry must be safe non-negative integers');
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) {
    throw new UsageAccountingError('invalid-telemetry', 'Token telemetry total exceeds safe integer range');
  }
  return total;
}

function validateAmount(value: number, dimension: string): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || Object.is(value, -0) ||
      (COUNT_DIMENSIONS.has(dimension) && !Number.isSafeInteger(value))) {
    throw new UsageAccountingError('invalid-telemetry', `Invalid usage amount for ${dimension}`);
  }
}

/** Shared digest semantics for persisted WP-210 reservations and WP-220 evidence. */
export function computeAuthorityUsageSampleDigest(sample: UsageSample): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(canonicalizeJson(sample)).digest('hex')}`;
}

/** Reproduces WP-210 reservation reconciliation without mutating ledger state. */
export function deriveAuthorityUsageActual(input: {
  readonly amounts: Readonly<Record<string, number>>;
  readonly currency: string;
  readonly sample: UsageSample;
  readonly descendantCommitted: Readonly<Record<string, number>>;
}): Readonly<Record<string, number>> {
  const dimensions = Object.keys(input.amounts);
  for (const [dimension, amount] of Object.entries(input.amounts)) validateAmount(amount, dimension);
  for (const [dimension, amount] of Object.entries(input.descendantCommitted)) {
    validateAmount(amount, dimension);
    if (input.amounts[dimension] === undefined && amount !== 0) {
      throw new UsageAccountingError(
        'descendant-exceeded',
        `Nonzero descendant usage lacks reservation dimension ${dimension}`
      );
    }
  }
  for (const [dimension, value] of [
    ['inputTokens', input.sample.inputTokens],
    ['outputTokens', input.sample.outputTokens],
    ['cacheTokens', input.sample.cacheTokens],
    ['actionCount', input.sample.actionCount]
  ] as const) {
    if (value !== undefined) validateAmount(value, dimension === 'actionCount' ? 'toolActionsGlobal' : 'tokensGlobal');
  }
  if (input.sample.cost) validateAmount(input.sample.cost.value, 'costUsdGlobal');
  if (dimensions.some(dimension => HARD_USAGE_DIMENSIONS.has(dimension)) &&
      input.sample.confidence !== 'authoritative') {
    throw new UsageAccountingError('invalid-telemetry', 'Authoritative usage telemetry is required');
  }
  const needsTokens = dimensions.some(dimension => TOKEN_DIMENSIONS.has(dimension));
  const tokens = tokenTotal(input.sample, needsTokens);
  if (dimensions.some(dimension => COST_DIMENSIONS.has(dimension)) &&
      (!input.sample.cost || input.sample.cost.currency !== input.currency)) {
    throw new UsageAccountingError('currency-mismatch', `Authoritative cost in ${input.currency} is required`);
  }

  const actual: Record<string, number> = {};
  for (const dimension of dimensions) {
    const reserved = input.amounts[dimension];
    const measured = TOKEN_DIMENSIONS.has(dimension) ? tokens
      : COST_DIMENSIONS.has(dimension) ? input.sample.cost!.value
        : ACTION_DIMENSIONS.has(dimension) ? input.sample.actionCount : reserved;
    if (compare(measured, reserved) > 0) {
      throw new UsageAccountingError('budget-exceeded', `Usage exceeds reservation for ${dimension}`);
    }
    const descendant = input.descendantCommitted[dimension] ?? 0;
    if (compare(descendant, measured) > 0) {
      throw new UsageAccountingError('descendant-exceeded', `Descendant usage exceeds ${dimension}`);
    }
    actual[dimension] = subtract(measured, descendant);
  }
  return Object.freeze(actual);
}
