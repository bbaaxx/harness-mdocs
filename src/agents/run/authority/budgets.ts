import * as crypto from 'crypto';

import { z } from 'zod';

import { canonicalizeJson } from '../../contracts';
import { DEFAULT_EXECUTION_PLAN_BUDGETS, ExecutionPlanBudgets } from '../compiler';
import { UsageSample } from '../trust';
import { strictRfc3339UtcSchema } from './schema';
import { canonicalAuthoritySnapshot, snapshotAuthorityData, TicketAuthorityError } from './state';

export const BUDGET_DIMENSIONS = Object.freeze(
  Object.keys(DEFAULT_EXECUTION_PLAN_BUDGETS).sort() as (keyof ExecutionPlanBudgets)[]
);
export type BudgetDimension = keyof ExecutionPlanBudgets;

const COUNT_DIMENSIONS = new Set<BudgetDimension>([
  'maxActiveExecutionOrchestrators', 'maxLeavesPerEO', 'maxGlobalDescendants',
  'maxCumulativeSpawns', 'retryPerNode', 'globalRetries', 'localFixLoops',
  'toolActionsGlobal', 'toolActionsEo', 'toolActionsLeaf',
  'tokensGlobal', 'tokensEo', 'tokensLeaf'
]);
const TOKEN_DIMENSIONS = new Set<BudgetDimension>(['tokensGlobal', 'tokensEo', 'tokensLeaf']);
const COST_DIMENSIONS = new Set<BudgetDimension>(['costUsdGlobal', 'costUsdEo']);
const ACTION_DIMENSIONS = new Set<BudgetDimension>([
  'toolActionsGlobal', 'toolActionsEo', 'toolActionsLeaf'
]);
const HARD_USAGE_DIMENSIONS = new Set<BudgetDimension>([
  ...TOKEN_DIMENSIONS, ...COST_DIMENSIONS, ...ACTION_DIMENSIONS
]);

const boundedId = z.string().min(1).max(16 * 1024);
const amountSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
  .refine(value => !Object.is(value, -0), 'Negative zero is forbidden');
const dimensionSchema = z.enum(BUDGET_DIMENSIONS as [BudgetDimension, ...BudgetDimension[]]);
const amountMapSchema = z.partialRecord(dimensionSchema, amountSchema).superRefine((amounts, context) => {
  for (const [dimension, value] of Object.entries(amounts) as [BudgetDimension, number][]) {
    if (COUNT_DIMENSIONS.has(dimension) && !Number.isSafeInteger(value)) {
      context.addIssue({ code: 'custom', path: [dimension], message: 'Count/token budget must be a safe integer' });
    }
  }
});

const totalsSchema = z.object({
  limit: amountSchema,
  reserved: amountSchema,
  committed: amountSchema,
  released: amountSchema,
  remaining: amountSchema
}).strict();

const totalsMapSchema = z.record(dimensionSchema, totalsSchema);
const reservationSchema = z.object({
  reservationId: boundedId,
  ticketHandleId: boundedId,
  parentTicketHandleId: boundedId.nullable(),
  amounts: amountMapSchema,
  status: z.enum(['pending', 'committed', 'released']),
  sampleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  actual: amountMapSchema,
  retryOrdinal: z.number().int().nonnegative().safe(),
  scope: boundedId,
  role: z.enum(['PLAN_ROOT', 'EXECUTION', 'LEAF']),
  startedAt: strictRfc3339UtcSchema,
  deadlineAt: strictRfc3339UtcSchema
}).strict();

const accountSchema = z.object({
  ticketHandleId: boundedId,
  parentTicketHandleId: boundedId.nullable(),
  limits: amountMapSchema,
  reserved: amountMapSchema,
  committed: amountMapSchema,
  released: amountMapSchema
}).strict();

const budgetOperationKindSchema = z.enum(['spawn', 'retry', 'local-fix', 'replacement', 'resume']);
const budgetOperationEventSchema = z.object({
  eventId: boundedId,
  nodeId: boundedId,
  operation: boundedId,
  kind: budgetOperationKindSchema
}).strict();
const nodeCounterSchema = z.object({
  nodeId: boundedId,
  retries: z.number().int().nonnegative().safe(),
  localFixes: z.number().int().nonnegative().safe(),
  replacements: z.number().int().nonnegative().safe(),
  resumes: z.number().int().nonnegative().safe()
}).strict();

export const budgetLedgerSchema = z.object({
  currency: z.string().min(1).max(16),
  totals: totalsMapSchema,
  accounts: z.array(accountSchema).max(4096),
  reservations: z.array(reservationSchema).max(16_384),
  cumulative: z.object({
    spawns: z.number().int().nonnegative().safe(),
    retries: z.number().int().nonnegative().safe(),
    replacements: z.number().int().nonnegative().safe(),
    resumes: z.number().int().nonnegative().safe(),
    localFixes: z.number().int().nonnegative().safe()
  }).strict(),
  operationEvents: z.array(budgetOperationEventSchema).max(65_536),
  nodeCounters: z.array(nodeCounterSchema).max(16_384)
}).strict();

const reserveInputSchema = z.object({
  reservationId: boundedId,
  ticketHandleId: boundedId,
  parentTicketHandleId: boundedId.nullable(),
  amounts: amountMapSchema,
  retryOrdinal: z.number().int().nonnegative().safe().optional(),
  scope: boundedId,
  role: z.enum(['PLAN_ROOT', 'EXECUTION', 'LEAF']),
  startedAt: strictRfc3339UtcSchema,
  deadlineAt: strictRfc3339UtcSchema
}).strict();

const usageSampleSchema = z.object({
  source: boundedId,
  provider: boundedId,
  model: boundedId,
  inputTokens: z.number().int().nonnegative().safe().optional(),
  outputTokens: z.number().int().nonnegative().safe().optional(),
  cacheTokens: z.number().int().nonnegative().safe().optional(),
  priceTableVersion: boundedId,
  cost: z.object({ currency: boundedId, value: amountSchema }).strict().optional(),
  actionCount: z.number().int().nonnegative().safe(),
  confidence: z.enum(['authoritative', 'estimated', 'unknown']),
  timestamp: strictRfc3339UtcSchema
}).strict();

export type BudgetLedger = z.infer<typeof budgetLedgerSchema>;
export type BudgetReservation = z.infer<typeof reservationSchema>;
export type BudgetAmounts = Partial<Record<BudgetDimension, number>>;
export type BudgetOperationKind = z.infer<typeof budgetOperationKindSchema>;

function fail(code: 'invalid-input' | 'invalid-state' | 'budget-exceeded' | 'reservation-conflict' |
  'reservation-unresolved' | 'unknown-reservation', message: string): never {
  throw new TicketAuthorityError(code, message);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, state = false): T {
  let snapshot: unknown;
  try {
    snapshot = snapshotAuthorityData(value);
  } catch (error) {
    fail(state ? 'invalid-state' : 'invalid-input', error instanceof Error ? error.message : String(error));
  }
  const result = schema.safeParse(snapshot);
  if (!result.success) {
    fail(state ? 'invalid-state' : 'invalid-input', result.error.issues
      .map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`).sort().join('; '));
  }
  return result.data;
}

function canonicalAmounts(amounts: BudgetAmounts, complete = false): Record<string, number> {
  const entries = (complete ? BUDGET_DIMENSIONS : BUDGET_DIMENSIONS.filter(key => amounts[key] !== undefined))
    .map(key => [key, amounts[key] ?? 0] as const);
  return Object.fromEntries(entries);
}

function amountAt(amounts: BudgetAmounts, dimension: BudgetDimension): number {
  return amounts[dimension] ?? 0;
}

function checkedAdd(left: number, right: number, dimension: BudgetDimension): number {
  const total = decimalOperation(left, right, 1);
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER ||
      (COUNT_DIMENSIONS.has(dimension) && !Number.isSafeInteger(total))) {
    fail('invalid-state', `Budget arithmetic overflow for ${dimension}`);
  }
  return total;
}

function decimalParts(value: number): { coefficient: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) fail('invalid-state', 'Budget number cannot be represented canonically');
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  const digits = BigInt(`${match[1]}${fraction}`);
  const scale = fraction.length - exponent;
  return scale < 0
    ? { coefficient: digits * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient: digits, scale };
}

function decimalOperation(left: number, right: number, sign: 1 | -1): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const coefficient = a.coefficient * 10n ** BigInt(scale - a.scale) +
    BigInt(sign) * b.coefficient * 10n ** BigInt(scale - b.scale);
  if (coefficient < 0n) fail('invalid-state', 'Budget arithmetic became negative');
  const digits = coefficient.toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const value = Number(text);
  if (!Number.isFinite(value)) fail('invalid-state', 'Budget arithmetic overflow');
  return value;
}

function decimalSubtract(left: number, right: number): number {
  return decimalOperation(left, right, -1);
}

function decimalGreater(left: number, right: number): boolean {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  return a.coefficient * 10n ** BigInt(scale - a.scale) >
    b.coefficient * 10n ** BigInt(scale - b.scale);
}

export function parseBudgetLedger(value: unknown): Readonly<BudgetLedger> {
  const ledger = parse(budgetLedgerSchema, value, true);
  const expectedDimensions = BUDGET_DIMENSIONS.join(',');
  if (Object.keys(ledger.totals).sort().join(',') !== expectedDimensions) {
    fail('invalid-state', 'Budget totals do not contain exact known dimensions');
  }
  if (new Set(ledger.accounts.map(account => account.ticketHandleId)).size !== ledger.accounts.length) {
    fail('invalid-state', 'Budget account ticket IDs are not unique');
  }
  if (new Set(ledger.reservations.map(item => item.reservationId)).size !== ledger.reservations.length) {
    fail('invalid-state', 'Budget reservation IDs are not unique');
  }
  const reservationsByTicket = new Map(ledger.reservations.map(item => [item.ticketHandleId, item]));
  if (reservationsByTicket.size !== ledger.reservations.length) {
    fail('invalid-state', 'Each ticket must have exactly one budget reservation');
  }
  const accountIds = ledger.accounts.map(account => account.ticketHandleId).sort();
  const reservationTicketIds = [...reservationsByTicket.keys()].sort();
  if (canonicalizeJson(accountIds) !== canonicalizeJson(reservationTicketIds)) {
    fail('invalid-state', 'Budget accounts and reservations must have identical ticket ID sets');
  }
  for (const dimension of BUDGET_DIMENSIONS) {
    const total = ledger.totals[dimension];
    if (decimalGreater(checkedAdd(total.reserved, total.committed, dimension), total.limit) ||
        total.remaining !== decimalSubtract(decimalSubtract(total.limit, total.reserved), total.committed)) {
      fail('invalid-state', `Budget totals are inconsistent for ${dimension}`);
    }
  }
  for (const account of ledger.accounts) {
    for (const dimension of Object.keys(account.limits) as BudgetDimension[]) {
      const used = checkedAdd(account.reserved[dimension] ?? 0, account.committed[dimension] ?? 0, dimension);
      if (decimalGreater(used, account.limits[dimension]!)) fail('invalid-state', `Account exceeds ${dimension}`);
    }
  }
  for (const [reservationIndex, reservation] of ledger.reservations.entries()) {
    const account = ledger.accounts.find(item => item.ticketHandleId === reservation.ticketHandleId);
    if (reservation.parentTicketHandleId !== null) {
      const parentAccount = ledger.accounts.find(item => item.ticketHandleId === reservation.parentTicketHandleId);
      const parentReservation = reservationsByTicket.get(reservation.parentTicketHandleId);
      if (!parentAccount || !parentReservation) {
        fail('invalid-state', 'Reservation parent account and reservation must both exist');
      }
    }
    if (!account || account.parentTicketHandleId !== reservation.parentTicketHandleId ||
        BUDGET_DIMENSIONS.some(dimension =>
          amountAt(account.limits, dimension) !== amountAt(reservation.amounts, dimension))) {
      fail('invalid-state', 'Reservation and ticket budget account bindings differ');
    }
    if ((reservation.status === 'pending' &&
        (reservation.sampleDigest !== null || Object.keys(reservation.actual).length !== 0)) ||
        (reservation.status === 'committed' && reservation.sampleDigest === null) ||
        (reservation.status === 'released' &&
          (reservation.sampleDigest !== null || Object.keys(reservation.actual).length !== 0))) {
      fail('invalid-state', 'Reservation lifecycle fields are inconsistent');
    }
    if (Date.parse(reservation.startedAt) >= Date.parse(reservation.deadlineAt)) {
      fail('invalid-state', 'Reservation deadline must follow trusted start');
    }
    if (reservation.parentTicketHandleId !== null && ledger.reservations.findIndex(
      item => item.ticketHandleId === reservation.parentTicketHandleId
    ) >= reservationIndex) {
      fail('invalid-state', 'Parent reservation must precede child reservation');
    }
  }
  if (new Set(ledger.operationEvents.map(event => event.eventId)).size !== ledger.operationEvents.length) {
    fail('invalid-state', 'Budget operation event IDs are not unique');
  }
  const expectedCounters = new Map<string, z.infer<typeof nodeCounterSchema>>();
  const cumulative = { spawns: 0, retries: 0, replacements: 0, resumes: 0, localFixes: 0 };
  for (const event of ledger.operationEvents) {
    const counter = expectedCounters.get(event.nodeId) ?? {
      nodeId: event.nodeId, retries: 0, localFixes: 0, replacements: 0, resumes: 0
    };
    if (event.kind === 'spawn') cumulative.spawns += 1;
    if (event.kind === 'retry') { cumulative.retries += 1; counter.retries += 1; }
    if (event.kind === 'local-fix') { cumulative.localFixes += 1; counter.localFixes += 1; }
    if (event.kind === 'replacement') {
      cumulative.spawns += 1; cumulative.replacements += 1; counter.replacements += 1;
    }
    if (event.kind === 'resume') {
      cumulative.spawns += 1; cumulative.resumes += 1; counter.resumes += 1;
    }
    expectedCounters.set(event.nodeId, counter);
  }
  const canonicalCounters = [...expectedCounters.values()].sort((left, right) =>
    left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0);
  if (canonicalizeJson(cumulative) !== canonicalizeJson(ledger.cumulative) ||
      canonicalizeJson(canonicalCounters) !== canonicalizeJson(ledger.nodeCounters)) {
    fail('invalid-state', 'Budget cumulative or per-node counters do not reconstruct from operation events');
  }
  if (ledger.cumulative.spawns > ledger.totals.maxCumulativeSpawns.limit ||
      ledger.cumulative.retries > ledger.totals.globalRetries.limit ||
      ledger.cumulative.localFixes > ledger.totals.localFixLoops.limit ||
      ledger.nodeCounters.some(counter =>
        counter.retries > ledger.totals.retryPerNode.limit ||
        counter.localFixes > ledger.totals.localFixLoops.limit)) {
    fail('invalid-state', 'Budget cumulative or per-node counters exceed approved limits');
  }
  for (const account of ledger.accounts) {
    const own = ledger.reservations.find(item => item.ticketHandleId === account.ticketHandleId)!;
    const children = ledger.reservations.filter(item => item.parentTicketHandleId === account.ticketHandleId);
    for (const dimension of BUDGET_DIMENSIONS) {
      const expectedReserved = children.filter(child => child.status === 'pending').reduce(
        (sum, child) => checkedAdd(sum, decimalSubtract(
          amountAt(child.amounts, dimension),
          amountAt(ledger.accounts.find(item => item.ticketHandleId === child.ticketHandleId)!.committed, dimension)
        ), dimension), 0);
      const ownCommitted = own.status === 'committed' ? amountAt(own.actual, dimension) : 0;
      const expectedCommitted = children.reduce((sum, child) => checkedAdd(
        sum,
        amountAt(ledger.accounts.find(item => item.ticketHandleId === child.ticketHandleId)!.committed, dimension),
        dimension
      ), ownCommitted);
      const expectedReleased = own.status === 'released'
        ? decimalSubtract(amountAt(own.amounts, dimension), expectedCommitted)
        : own.status === 'committed'
          ? decimalSubtract(amountAt(own.amounts, dimension), expectedCommitted)
          : 0;
      if (amountAt(account.reserved, dimension) !== expectedReserved ||
          amountAt(account.committed, dimension) !== expectedCommitted ||
          amountAt(account.released, dimension) !== expectedReleased) {
        fail('invalid-state', `Budget account totals are inconsistent for ${dimension}`);
      }
    }
  }
  const roots = ledger.reservations.filter(item => item.parentTicketHandleId === null);
  for (const dimension of BUDGET_DIMENSIONS) {
    const expectedReserved = roots.filter(item => item.status === 'pending').reduce((sum, item) => {
      const account = ledger.accounts.find(account => account.ticketHandleId === item.ticketHandleId)!;
      return checkedAdd(sum, decimalSubtract(
        amountAt(item.amounts, dimension), amountAt(account.committed, dimension)
      ), dimension);
    }, 0);
    const expectedCommitted = roots.reduce((sum, item) => checkedAdd(
      sum,
      amountAt(ledger.accounts.find(account => account.ticketHandleId === item.ticketHandleId)!.committed, dimension),
      dimension
    ), 0);
    const expectedReleased = roots.reduce((sum, item) => {
      const account = ledger.accounts.find(account => account.ticketHandleId === item.ticketHandleId)!;
      const amount = item.status === 'released'
        ? amountAt(account.released, dimension)
        : item.status === 'committed'
          ? decimalSubtract(amountAt(item.amounts, dimension), amountAt(account.committed, dimension))
          : 0;
      return checkedAdd(sum, amount, dimension);
    }, 0);
    const total = ledger.totals[dimension];
    if (total.reserved !== expectedReserved || total.committed !== expectedCommitted ||
        total.released !== expectedReleased) {
      fail('invalid-state', `Global budget totals do not reconstruct for ${dimension}`);
    }
  }
  return canonicalAuthoritySnapshot(ledger);
}

export function createBudgetLedger(
  limits: ExecutionPlanBudgets,
  currency = 'USD'
): Readonly<BudgetLedger> {
  const parsedLimits = parse(amountMapSchema, limits);
  if (Object.keys(parsedLimits).sort().join(',') !== BUDGET_DIMENSIONS.join(',')) {
    fail('invalid-input', 'Global budget limits must contain exact known dimensions');
  }
  const totals = Object.fromEntries(BUDGET_DIMENSIONS.map(dimension => [dimension, {
    limit: parsedLimits[dimension]!, reserved: 0, committed: 0, released: 0,
    remaining: parsedLimits[dimension]!
  }]));
  return parseBudgetLedger({
    currency, totals, accounts: [], reservations: [],
    cumulative: { spawns: 0, retries: 0, replacements: 0, resumes: 0, localFixes: 0 },
    operationEvents: [], nodeCounters: []
  });
}

export function reserveBudget(ledgerValue: unknown, inputValue: unknown): Readonly<BudgetLedger> {
  const ledger = parseBudgetLedger(ledgerValue);
  const input = parse(reserveInputSchema, inputValue);
  if (ledger.reservations.some(item => item.reservationId === input.reservationId)) {
    fail('reservation-conflict', `Reservation "${input.reservationId}" already exists`);
  }
  if (ledger.accounts.some(account => account.ticketHandleId === input.ticketHandleId)) {
    fail('reservation-conflict', `Ticket budget account "${input.ticketHandleId}" already exists`);
  }
  const parent = input.parentTicketHandleId === null
    ? undefined
    : ledger.accounts.find(account => account.ticketHandleId === input.parentTicketHandleId);
  if (input.parentTicketHandleId !== null && !parent) fail('unknown-reservation', 'Parent budget account is absent');
  if (parent) {
    const parentReservation = ledger.reservations.find(item => item.ticketHandleId === parent.ticketHandleId);
    if (parentReservation?.status !== 'pending') {
      fail('reservation-conflict', 'Parent capacity is no longer pending');
    }
  }

  const totals = snapshotAuthorityData(ledger.totals);
  const parentCopy = parent ? snapshotAuthorityData(parent) : undefined;
  for (const [dimension, amount] of Object.entries(input.amounts) as [BudgetDimension, number][]) {
    if (!parentCopy && decimalGreater(amount, totals[dimension].remaining)) {
      fail('budget-exceeded', `Global ${dimension} remaining exceeded`);
    }
    if (parentCopy) {
      const available = parentCopy.limits[dimension] === undefined
        ? 0
        : decimalSubtract(
          decimalSubtract(parentCopy.limits[dimension], parentCopy.reserved[dimension] ?? 0),
          parentCopy.committed[dimension] ?? 0
        );
      if (decimalGreater(amount, available)) fail('budget-exceeded', `Parent ${dimension} remaining exceeded`);
      parentCopy.reserved[dimension] = checkedAdd(parentCopy.reserved[dimension] ?? 0, amount, dimension);
    }
    if (!parentCopy) {
      totals[dimension].reserved = checkedAdd(totals[dimension].reserved, amount, dimension);
      totals[dimension].remaining = decimalSubtract(
        decimalSubtract(totals[dimension].limit, totals[dimension].reserved), totals[dimension].committed
      );
    }
  }
  const account = {
    ticketHandleId: input.ticketHandleId,
    parentTicketHandleId: input.parentTicketHandleId,
    limits: canonicalAmounts(input.amounts),
    reserved: canonicalAmounts({}, true),
    committed: canonicalAmounts({}, true),
    released: canonicalAmounts({}, true)
  };
  const reservation = {
    reservationId: input.reservationId,
    ticketHandleId: input.ticketHandleId,
    parentTicketHandleId: input.parentTicketHandleId,
    amounts: canonicalAmounts(input.amounts),
    status: 'pending', sampleDigest: null, actual: {}, retryOrdinal: input.retryOrdinal ?? 0,
    scope: input.scope, role: input.role, startedAt: input.startedAt, deadlineAt: input.deadlineAt
  };
  const accounts = ledger.accounts.map(existing =>
    parentCopy && existing.ticketHandleId === parentCopy.ticketHandleId ? parentCopy : existing);
  accounts.push(account);
  return parseBudgetLedger({ ...ledger, totals, accounts, reservations: [...ledger.reservations, reservation] });
}

function sampleDigest(sample: UsageSample): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalizeJson(sample)).digest('hex')}`;
}

function safeTokenTotal(sample: UsageSample): number {
  let total = 0;
  for (const value of [sample.inputTokens ?? 0, sample.outputTokens ?? 0, sample.cacheTokens ?? 0]) {
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid-input', 'Token value must be a safe non-negative integer');
    total = checkedAdd(total, value, 'tokensGlobal');
  }
  return total;
}

function rebuildAccounting(
  ledger: Readonly<BudgetLedger>,
  reservations: BudgetLedger['reservations']
): Readonly<BudgetLedger> {
  const accountsByTicket = new Map<string, BudgetLedger['accounts'][number]>();
  for (const reservation of [...reservations].reverse()) {
    const children = reservations.filter(item => item.parentTicketHandleId === reservation.ticketHandleId);
    const committed: BudgetAmounts = {};
    const reserved: BudgetAmounts = {};
    const released: BudgetAmounts = {};
    for (const dimension of BUDGET_DIMENSIONS) {
      const childCommitted = children.reduce((sum, child) => checkedAdd(
        sum, amountAt(accountsByTicket.get(child.ticketHandleId)!.committed, dimension), dimension
      ), 0);
      const ownCommitted = reservation.status === 'committed'
        ? amountAt(reservation.actual, dimension) : 0;
      const subtreeCommitted = checkedAdd(ownCommitted, childCommitted, dimension);
      committed[dimension] = subtreeCommitted;
      reserved[dimension] = children.filter(child => child.status === 'pending').reduce(
        (sum, child) => checkedAdd(sum, decimalSubtract(
          amountAt(child.amounts, dimension),
          amountAt(accountsByTicket.get(child.ticketHandleId)!.committed, dimension)
        ), dimension), 0
      );
      released[dimension] = reservation.status === 'pending' ? 0 : decimalSubtract(
        amountAt(reservation.amounts, dimension), subtreeCommitted
      );
    }
    accountsByTicket.set(reservation.ticketHandleId, {
      ticketHandleId: reservation.ticketHandleId,
      parentTicketHandleId: reservation.parentTicketHandleId,
      limits: reservation.amounts,
      reserved: canonicalAmounts(reserved, true),
      committed: canonicalAmounts(committed, true),
      released: canonicalAmounts(released, true)
    });
  }
  const roots = reservations.filter(item => item.parentTicketHandleId === null);
  const totals = snapshotAuthorityData(ledger.totals);
  for (const dimension of BUDGET_DIMENSIONS) {
    const committed = roots.reduce((sum, root) => checkedAdd(
      sum, amountAt(accountsByTicket.get(root.ticketHandleId)!.committed, dimension), dimension
    ), 0);
    const reserved = roots.filter(root => root.status === 'pending').reduce((sum, root) => checkedAdd(
      sum, decimalSubtract(
        amountAt(root.amounts, dimension),
        amountAt(accountsByTicket.get(root.ticketHandleId)!.committed, dimension)
      ), dimension
    ), 0);
    const released = roots.filter(root => root.status !== 'pending').reduce((sum, root) => checkedAdd(
      sum, decimalSubtract(
        amountAt(root.amounts, dimension),
        amountAt(accountsByTicket.get(root.ticketHandleId)!.committed, dimension)
      ), dimension
    ), 0);
    totals[dimension] = {
      ...totals[dimension], reserved, committed, released,
      remaining: decimalSubtract(decimalSubtract(totals[dimension].limit, reserved), committed)
    };
  }
  const accounts = reservations.map(item => accountsByTicket.get(item.ticketHandleId)!);
  return parseBudgetLedger({ ...ledger, totals, accounts, reservations });
}

export function reconcileBudget(
  ledgerValue: unknown,
  reservationId: string,
  sampleValue: UsageSample
): Readonly<BudgetLedger> {
  const ledger = parseBudgetLedger(ledgerValue);
  const sample = parse(usageSampleSchema, sampleValue);
  const reservation = ledger.reservations.find(item => item.reservationId === reservationId);
  if (!reservation) fail('unknown-reservation', `Reservation "${reservationId}" is absent`);
  const sampleTime = Date.parse(sample.timestamp);
  if (sampleTime < Date.parse(reservation.startedAt) || sampleTime > Date.parse(reservation.deadlineAt)) {
    fail('reservation-unresolved', 'Usage sample timestamp is outside reservation authority window');
  }
  const digest = sampleDigest(sample);
  if (reservation.status === 'committed') {
    if (reservation.sampleDigest === digest) return ledger;
    fail('reservation-conflict', 'Reservation already reconciled with different sample');
  }
  if (reservation.status !== 'pending') fail('reservation-conflict', 'Released reservation cannot reconcile');
  if (ledger.reservations.some(item =>
    item.parentTicketHandleId === reservation.ticketHandleId && item.status === 'pending')) {
    fail('reservation-unresolved', 'Parent envelopes close by release after all children settle');
  }
  const needsAuthoritative = Object.keys(reservation.amounts).some(
    key => HARD_USAGE_DIMENSIONS.has(key as BudgetDimension));
  if (needsAuthoritative && sample.confidence !== 'authoritative') {
    fail('reservation-unresolved', 'Hard token/cost/action reservation requires authoritative usage');
  }
  if (Object.keys(reservation.amounts).some(key => TOKEN_DIMENSIONS.has(key as BudgetDimension)) &&
      (sample.inputTokens === undefined || sample.outputTokens === undefined)) {
    fail('reservation-unresolved', 'Authoritative input/output token telemetry is required');
  }
  const tokens = safeTokenTotal(sample);
  if (Object.keys(reservation.amounts).some(key => COST_DIMENSIONS.has(key as BudgetDimension))) {
    if (!sample.cost || sample.cost.currency !== ledger.currency) {
      fail('reservation-unresolved', `Authoritative cost in ${ledger.currency} is required`);
    }
  }
  const actual: BudgetAmounts = {};
  const children = ledger.reservations.filter(item => item.parentTicketHandleId === reservation.ticketHandleId);
  for (const [dimension, reserved] of Object.entries(reservation.amounts) as [BudgetDimension, number][]) {
    const measured = TOKEN_DIMENSIONS.has(dimension) ? tokens
      : COST_DIMENSIONS.has(dimension) ? sample.cost!.value
        : ACTION_DIMENSIONS.has(dimension) ? sample.actionCount : reserved;
    if (decimalGreater(measured, reserved)) {
      fail('budget-exceeded', `Usage exceeds zero-overshoot reservation for ${dimension}`);
    }
    const descendantCommitted = children.reduce((sum, child) => checkedAdd(
      sum,
      amountAt(ledger.accounts.find(item => item.ticketHandleId === child.ticketHandleId)!.committed, dimension),
      dimension
    ), 0);
    if (decimalGreater(descendantCommitted, measured)) {
      fail('reservation-conflict', `Descendant usage exceeds measured parent usage for ${dimension}`);
    }
    actual[dimension] = decimalSubtract(measured, descendantCommitted);
  }
  const reservations = ledger.reservations.map(item => item.reservationId === reservationId
    ? { ...item, status: 'committed' as const, sampleDigest: digest, actual: canonicalAmounts(actual) }
    : item);
  return rebuildAccounting(ledger, reservations);
}

export function releaseBudget(ledgerValue: unknown, reservationId: string): Readonly<BudgetLedger> {
  const ledger = parseBudgetLedger(ledgerValue);
  const reservation = ledger.reservations.find(item => item.reservationId === reservationId);
  if (!reservation) fail('unknown-reservation', `Reservation "${reservationId}" is absent`);
  if (reservation.status === 'released') return ledger;
  if (reservation.status === 'committed') fail('reservation-conflict', 'Committed usage cannot be released');
  if (ledger.reservations.some(item =>
    item.parentTicketHandleId === reservation.ticketHandleId && item.status === 'pending')) {
    fail('reservation-unresolved', 'Child reservations must settle before parent release');
  }
  const reservations = ledger.reservations.map(item => item.reservationId === reservationId
    ? { ...item, status: 'released' as const, actual: {}, sampleDigest: null }
    : item);
  return rebuildAccounting(ledger, reservations);
}

export function recordBudgetOperation(ledgerValue: unknown, inputValue: unknown): Readonly<BudgetLedger> {
  const ledger = parseBudgetLedger(ledgerValue);
  const input = parse(budgetOperationEventSchema, inputValue);
  const existing = ledger.operationEvents.find(event => event.eventId === input.eventId);
  if (existing) {
    if (canonicalizeJson(existing) === canonicalizeJson(input)) return ledger;
    fail('reservation-conflict', `Budget operation "${input.eventId}" conflicts with persisted event`);
  }
  const current = ledger.nodeCounters.find(counter => counter.nodeId === input.nodeId);
  if (input.kind === 'retry' && (current?.retries ?? 0) >= ledger.totals.retryPerNode.limit) {
    fail('budget-exceeded', `Node "${input.nodeId}" retry budget exhausted`);
  }
  if (input.kind === 'retry' && ledger.cumulative.retries >= ledger.totals.globalRetries.limit) {
    fail('budget-exceeded', 'Global retry budget exhausted');
  }
  if (input.kind === 'local-fix' && (current?.localFixes ?? 0) >= ledger.totals.localFixLoops.limit) {
    fail('budget-exceeded', `Node "${input.nodeId}" local-fix budget exhausted`);
  }
  if (['spawn', 'replacement', 'resume'].includes(input.kind) &&
      ledger.cumulative.spawns >= ledger.totals.maxCumulativeSpawns.limit) {
    fail('budget-exceeded', 'Cumulative spawn budget exhausted');
  }
  const events = [...ledger.operationEvents, input];
  const counter = current ?? {
    nodeId: input.nodeId, retries: 0, localFixes: 0, replacements: 0, resumes: 0
  };
  const changed = {
    ...counter,
    ...(input.kind === 'retry' ? { retries: counter.retries + 1 } : {}),
    ...(input.kind === 'local-fix' ? { localFixes: counter.localFixes + 1 } : {}),
    ...(input.kind === 'replacement' ? { replacements: counter.replacements + 1 } : {}),
    ...(input.kind === 'resume' ? { resumes: counter.resumes + 1 } : {})
  };
  const nodeCounters = [
    ...ledger.nodeCounters.filter(item => item.nodeId !== input.nodeId), changed
  ].sort((left, right) => left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0);
  const cumulative = {
    spawns: ledger.cumulative.spawns + (['spawn', 'replacement', 'resume'].includes(input.kind) ? 1 : 0),
    retries: ledger.cumulative.retries + (input.kind === 'retry' ? 1 : 0),
    replacements: ledger.cumulative.replacements + (input.kind === 'replacement' ? 1 : 0),
    resumes: ledger.cumulative.resumes + (input.kind === 'resume' ? 1 : 0),
    localFixes: ledger.cumulative.localFixes + (input.kind === 'local-fix' ? 1 : 0)
  };
  return parseBudgetLedger({ ...ledger, operationEvents: events, nodeCounters, cumulative });
}

export function assertRoleBudgetAmounts(
  role: 'PLAN_ROOT' | 'EXECUTION' | 'LEAF',
  amountsValue: unknown
): Readonly<BudgetAmounts> {
  const amounts = parse(amountMapSchema, amountsValue);
  const requiredGroups: BudgetDimension[][] = role === 'PLAN_ROOT'
    ? [['toolActionsGlobal'], ['tokensGlobal'], ['costUsdGlobal']]
    : role === 'EXECUTION'
      ? [
          ['toolActionsGlobal', 'toolActionsEo'], ['tokensGlobal', 'tokensEo'],
          ['costUsdGlobal', 'costUsdEo']
        ]
      : [
          ['toolActionsGlobal', 'toolActionsEo', 'toolActionsLeaf'],
          ['tokensGlobal', 'tokensEo', 'tokensLeaf'], ['costUsdGlobal', 'costUsdEo']
        ];
  for (const group of requiredGroups) {
    if (group.some(dimension => amounts[dimension] === undefined)) {
      fail('invalid-input', `${role} reservation must charge ${group.join(', ')}`);
    }
  }
  return canonicalAuthoritySnapshot(canonicalAmounts(amounts));
}

export function unresolvedHardBudgetReservations(ledgerValue: unknown): readonly string[] {
  const ledger = parseBudgetLedger(ledgerValue);
  return Object.freeze(ledger.reservations
    .filter(item => item.status === 'pending' && Object.keys(item.amounts).some(
      key => HARD_USAGE_DIMENSIONS.has(key as BudgetDimension)
    ))
    .map(item => item.reservationId)
    .sort());
}
