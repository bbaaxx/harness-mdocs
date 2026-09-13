import { DEFAULT_EXECUTION_PLAN_BUDGETS } from '../../src/agents/run/compiler';
import {
  BudgetLedger,
  createBudgetLedger,
  parseBudgetLedger,
  reconcileBudget,
  recordBudgetOperation,
  releaseBudget,
  reserveBudget,
  unresolvedHardBudgetReservations
} from '../../src/agents/run/authority/budgets';
import { TicketAuthorityError } from '../../src/agents/run/authority/state';
import {
  deriveAuthorityUsageActual,
  UsageAccountingError
} from '../../src/agents/run/authority/usage-accounting';

const WINDOW = {
  scope: 'budget-test', role: 'PLAN_ROOT' as const,
  startedAt: '2026-09-12T00:00:00.000Z', deadlineAt: '2026-09-13T00:00:00.000Z'
};

/** Test-local counter increment; production has no legacy helper. */
function incrementRetryCounter(ledger: Readonly<BudgetLedger>): Readonly<BudgetLedger> {
  return recordBudgetOperation(ledger, {
    eventId: `retry-${ledger.operationEvents.length + 1}`,
    nodeId: 'test-node', operation: 'retry', kind: 'retry'
  });
}

function errorCode(operation: () => unknown): string | undefined {
  try {
    operation();
  } catch (error) {
    return error instanceof TicketAuthorityError ? error.code : undefined;
  }
  return undefined;
}

describe('run authority budget ledger', () => {
  test('shared usage derivation rejects invalid and unreserved descendant amounts', () => {
    const sample = {
      source: 'meter', provider: 'provider', model: 'model', inputTokens: 2, outputTokens: 3,
      priceTableVersion: 'price-v1', actionCount: 1, confidence: 'authoritative' as const,
      timestamp: '2026-09-12T12:00:00.000Z'
    };
    const derive = (amounts: Record<string, number>, descendantCommitted: Record<string, number>) =>
      deriveAuthorityUsageActual({ amounts, descendantCommitted, currency: 'USD', sample });
    for (const [amounts, descendants] of [
      [{ toolActionsGlobal: 1 }, { tokensGlobal: 1 }],
      [{ toolActionsGlobal: Number.NaN }, {}],
      [{ toolActionsGlobal: -0 }, {}],
      [{ toolActionsGlobal: 1.5 }, {}],
      [{ costUsdGlobal: Number.MAX_SAFE_INTEGER + 1 }, {}],
      [{ costUsdGlobal: 1 }, { toolActionsGlobal: 0.5 }],
      [{ costUsdGlobal: 1 }, { costUsdGlobal: Number.POSITIVE_INFINITY }],
      [{ costUsdGlobal: 1 }, { costUsdGlobal: -1 }]
    ] as Array<[Record<string, number>, Record<string, number>]>) {
      expect(() => derive(amounts, descendants)).toThrow(UsageAccountingError);
    }
    expect(derive({ toolActionsGlobal: 1 }, { tokensGlobal: 0 }))
      .toEqual({ toolActionsGlobal: 1 });
  });

  test('reserves atomically and denies unknown, non-finite, negative-zero, and excess values', () => {
    const ledger = createBudgetLedger({ ...DEFAULT_EXECUTION_PLAN_BUDGETS, costUsdGlobal: 0.3 });
    const reserved = reserveBudget(ledger, {
      reservationId: 'reservation-0001',
      ticketHandleId: 'ticket-handle-0001',
      parentTicketHandleId: null,
      ...WINDOW,
      amounts: { costUsdGlobal: 0.1, tokensGlobal: 100 }
    });
    expect(reserved.totals.costUsdGlobal.remaining).toBe(0.2);
    expect(reserved.totals.tokensGlobal.reserved).toBe(100);
    expect(errorCode(() => reserveBudget(reserved, {
      reservationId: 'reservation-0002', ticketHandleId: 'ticket-handle-0002',
      parentTicketHandleId: null, ...WINDOW, amounts: { costUsdGlobal: 0.21 }
    }))).toBe('budget-exceeded');
    expect(errorCode(() => reserveBudget(ledger, {
      reservationId: 'reservation-0003', ticketHandleId: 'ticket-handle-0003',
      parentTicketHandleId: null, ...WINDOW, amounts: { invented: 1 }
    }))).toBe('invalid-input');
    for (const invalid of [NaN, Infinity, -0]) {
      expect(errorCode(() => reserveBudget(ledger, {
        reservationId: 'reservation-invalid', ticketHandleId: 'ticket-handle-invalid',
        parentTicketHandleId: null, ...WINDOW, amounts: { costUsdGlobal: invalid }
      }))).toBe('invalid-input');
    }
  });

  test('enforces parent subdivision without charging global capacity twice', () => {
    const root = reserveBudget(createBudgetLedger(DEFAULT_EXECUTION_PLAN_BUDGETS), {
      reservationId: 'reservation-root', ticketHandleId: 'ticket-root-0001',
      parentTicketHandleId: null, ...WINDOW, amounts: { tokensGlobal: 1000 }
    });
    const child = reserveBudget(root, {
      reservationId: 'reservation-child', ticketHandleId: 'ticket-child-0001',
      parentTicketHandleId: 'ticket-root-0001', ...WINDOW, role: 'LEAF', amounts: { tokensGlobal: 600 }
    });
    expect(child.totals.tokensGlobal.reserved).toBe(1000);
    expect(child.accounts.find(account => account.ticketHandleId === 'ticket-root-0001')!
      .reserved.tokensGlobal).toBe(600);
    expect(errorCode(() => reserveBudget(child, {
      reservationId: 'reservation-child-2', ticketHandleId: 'ticket-child-0002',
      parentTicketHandleId: 'ticket-root-0001', ...WINDOW, role: 'LEAF', amounts: { tokensGlobal: 401 }
    }))).toBe('budget-exceeded');

    const reconciled = reconcileBudget(child, 'reservation-child', {
      source: 'meter', provider: 'provider', model: 'model', inputTokens: 400, outputTokens: 100,
      priceTableVersion: 'price-v1', actionCount: 0, confidence: 'authoritative',
      timestamp: '2026-09-12T12:00:00.000Z'
    });
    expect(reconciled.totals.tokensGlobal).toEqual(expect.objectContaining({
      reserved: 500, committed: 500
    }));
    expect(reconciled.accounts.find(account => account.ticketHandleId === 'ticket-root-0001')!
      .committed.tokensGlobal).toBe(500);
    const closed = releaseBudget(reconciled, 'reservation-root');
    expect(closed.totals.tokensGlobal).toEqual(expect.objectContaining({
      reserved: 0, committed: 500, released: 500
    }));
  });

  test('closes parent using exclusive remainder after nonzero child usage', () => {
    const root = reserveBudget(createBudgetLedger(DEFAULT_EXECUTION_PLAN_BUDGETS), {
      reservationId: 'reservation-root-close', ticketHandleId: 'ticket-root-close',
      parentTicketHandleId: null, ...WINDOW,
      amounts: { tokensGlobal: 100, toolActionsGlobal: 10, costUsdGlobal: 1 }
    });
    const child = reserveBudget(root, {
      reservationId: 'reservation-child-close', ticketHandleId: 'ticket-child-close',
      parentTicketHandleId: 'ticket-root-close', ...WINDOW, role: 'LEAF',
      amounts: { tokensGlobal: 60, toolActionsGlobal: 6, costUsdGlobal: 0.6 }
    });
    const childClosed = reconcileBudget(child, 'reservation-child-close', {
      source: 'meter', provider: 'provider', model: 'model', inputTokens: 30, outputTokens: 20,
      priceTableVersion: 'price-v1', cost: { currency: 'USD', value: 0.4 }, actionCount: 4,
      confidence: 'authoritative', timestamp: '2026-09-12T12:00:00.000Z'
    });
    expect(childClosed.totals.tokensGlobal).toEqual(expect.objectContaining({
      reserved: 50, committed: 50, released: 0
    }));
    const rootClosed = reconcileBudget(childClosed, 'reservation-root-close', {
      source: 'meter', provider: 'provider', model: 'model', inputTokens: 40, outputTokens: 30,
      priceTableVersion: 'price-v1', cost: { currency: 'USD', value: 0.7 }, actionCount: 7,
      confidence: 'authoritative', timestamp: '2026-09-12T12:00:00.000Z'
    });
    expect(rootClosed.totals.tokensGlobal).toEqual(expect.objectContaining({
      reserved: 0, committed: 70, released: 30
    }));
    expect(rootClosed.totals.toolActionsGlobal).toEqual(expect.objectContaining({
      reserved: 0, committed: 7, released: 3
    }));
    expect(rootClosed.totals.costUsdGlobal).toEqual(expect.objectContaining({
      reserved: 0, committed: 0.7, released: 0.3
    }));
    expect(rootClosed.reservations.find(item => item.reservationId === 'reservation-root-close')!.actual)
      .toEqual({ tokensGlobal: 20, toolActionsGlobal: 3, costUsdGlobal: 0.3 });
  });

  test('keeps hard reservations unresolved until authoritative usage arrives', () => {
    const ledger = reserveBudget(createBudgetLedger(DEFAULT_EXECUTION_PLAN_BUDGETS), {
      reservationId: 'reservation-hard', ticketHandleId: 'ticket-hard-0001',
      parentTicketHandleId: null,
      ...WINDOW,
      amounts: { tokensGlobal: 100, costUsdGlobal: 0.5, toolActionsGlobal: 3 }
    });
    const estimated = {
      source: 'meter', provider: 'provider', model: 'model', inputTokens: 40, outputTokens: 10,
      priceTableVersion: 'price-v1', cost: { currency: 'USD', value: 0.2 }, actionCount: 2,
      confidence: 'estimated' as const, timestamp: '2026-09-12T12:00:00.000Z'
    };
    expect(errorCode(() => reconcileBudget(ledger, 'reservation-hard', estimated)))
      .toBe('reservation-unresolved');
    expect(errorCode(() => reconcileBudget(ledger, 'reservation-hard', {
      source: 'meter', provider: 'provider', model: 'model', outputTokens: 10,
      priceTableVersion: 'price-v1', cost: { currency: 'USD', value: 0.2 }, actionCount: 2,
      confidence: 'authoritative' as const, timestamp: '2026-09-12T12:00:00.000Z'
    }))).toBe('reservation-unresolved');
    expect(unresolvedHardBudgetReservations(ledger)).toEqual(['reservation-hard']);

    const authoritative = { ...estimated, confidence: 'authoritative' as const };
    const committed = reconcileBudget(ledger, 'reservation-hard', authoritative);
    expect(committed.totals.tokensGlobal.committed).toBe(50);
    expect(committed.totals.costUsdGlobal.committed).toBe(0.2);
    expect(committed.totals.toolActionsGlobal.committed).toBe(2);
    expect(reconcileBudget(committed, 'reservation-hard', authoritative)).toEqual(committed);
    expect(errorCode(() => reconcileBudget(committed, 'reservation-hard', {
      ...authoritative, outputTokens: 11
    }))).toBe('reservation-conflict');
  });

  test.each(['estimated', 'unknown'] as const)(
    'requires authoritative confidence for action-only hard usage: %s', confidence => {
      const ledger = reserveBudget(createBudgetLedger(DEFAULT_EXECUTION_PLAN_BUDGETS), {
        reservationId: `reservation-action-${confidence}`, ticketHandleId: `ticket-action-${confidence}`,
        parentTicketHandleId: null, ...WINDOW, amounts: { toolActionsGlobal: 3 }
      });
      expect(errorCode(() => reconcileBudget(ledger, `reservation-action-${confidence}`, {
        source: 'meter', provider: 'provider', model: 'model', priceTableVersion: 'price-v1',
        actionCount: 1, confidence, timestamp: '2026-09-12T12:00:00.000Z'
      }))).toBe('reservation-unresolved');
      expect(unresolvedHardBudgetReservations(ledger)).toEqual([`reservation-action-${confidence}`]);
    }
  );

  test('rejects missing parent account/reservation as semantic corruption before dereference', () => {
    const ledger = reserveBudget(createBudgetLedger(DEFAULT_EXECUTION_PLAN_BUDGETS), {
      reservationId: 'reservation-parent', ticketHandleId: 'ticket-parent',
      parentTicketHandleId: null, ...WINDOW, amounts: { tokensGlobal: 10 }
    });
    const corrupted = JSON.parse(JSON.stringify(ledger));
    corrupted.reservations[0].parentTicketHandleId = 'missing-parent';
    corrupted.accounts[0].parentTicketHandleId = 'missing-parent';
    expect(errorCode(() => parseBudgetLedger(corrupted))).toBe('invalid-state');
    const extraAccount = JSON.parse(JSON.stringify(ledger));
    extraAccount.accounts.push({
      ...extraAccount.accounts[0], ticketHandleId: 'ticket-without-reservation'
    });
    expect(errorCode(() => parseBudgetLedger(extraAccount))).toBe('invalid-state');
  });

  test('reconstructs exact per-node counters and enforces retry/local-fix/spawn high-waters', () => {
    let ledger = createBudgetLedger({
      ...DEFAULT_EXECUTION_PLAN_BUDGETS,
      retryPerNode: 1, globalRetries: 2, localFixLoops: 1, maxCumulativeSpawns: 2
    });
    ledger = recordBudgetOperation(ledger, {
      eventId: 'event-retry-1', nodeId: 'node-a', operation: 'retry', kind: 'retry'
    });
    ledger = recordBudgetOperation(ledger, {
      eventId: 'event-fix-1', nodeId: 'node-a', operation: 'fix', kind: 'local-fix'
    });
    ledger = recordBudgetOperation(ledger, {
      eventId: 'event-replace-1', nodeId: 'node-a', operation: 'replace', kind: 'replacement'
    });
    ledger = recordBudgetOperation(ledger, {
      eventId: 'event-resume-1', nodeId: 'node-b', operation: 'resume', kind: 'resume'
    });
    expect(ledger.cumulative).toEqual({
      spawns: 2, retries: 1, replacements: 1, resumes: 1, localFixes: 1
    });
    expect(ledger.nodeCounters).toEqual([
      { nodeId: 'node-a', retries: 1, localFixes: 1, replacements: 1, resumes: 0 },
      { nodeId: 'node-b', retries: 0, localFixes: 0, replacements: 0, resumes: 1 }
    ]);
    expect(errorCode(() => recordBudgetOperation(ledger, {
      eventId: 'event-retry-2', nodeId: 'node-a', operation: 'retry', kind: 'retry'
    }))).toBe('budget-exceeded');
    expect(errorCode(() => recordBudgetOperation(ledger, {
      eventId: 'event-fix-2', nodeId: 'node-a', operation: 'fix', kind: 'local-fix'
    }))).toBe('budget-exceeded');
    expect(errorCode(() => recordBudgetOperation(ledger, {
      eventId: 'event-spawn-3', nodeId: 'node-b', operation: 'spawn', kind: 'spawn'
    }))).toBe('budget-exceeded');
    const corrupted = JSON.parse(JSON.stringify(ledger));
    corrupted.nodeCounters[0].retries = 0;
    expect(errorCode(() => parseBudgetLedger(corrupted))).toBe('invalid-state');
    const corruptedCumulative = JSON.parse(JSON.stringify(ledger));
    corruptedCumulative.cumulative.retries = 0;
    expect(errorCode(() => parseBudgetLedger(corruptedCumulative))).toBe('invalid-state');

    let persistedOverLimit = createBudgetLedger({
      ...DEFAULT_EXECUTION_PLAN_BUDGETS, retryPerNode: 2, globalRetries: 2
    });
    persistedOverLimit = recordBudgetOperation(persistedOverLimit, {
      eventId: 'persisted-retry-1', nodeId: 'node-a', operation: 'retry', kind: 'retry'
    });
    persistedOverLimit = recordBudgetOperation(persistedOverLimit, {
      eventId: 'persisted-retry-2', nodeId: 'node-a', operation: 'retry', kind: 'retry'
    });
    const loweredLimit = JSON.parse(JSON.stringify(persistedOverLimit));
    loweredLimit.totals.retryPerNode.limit = 1;
    loweredLimit.totals.retryPerNode.remaining = 1;
    expect(errorCode(() => parseBudgetLedger(loweredLimit))).toBe('invalid-state');

    const loweredGlobalRetry = JSON.parse(JSON.stringify(persistedOverLimit));
    loweredGlobalRetry.totals.globalRetries.limit = 1;
    loweredGlobalRetry.totals.globalRetries.remaining = 1;
    expect(errorCode(() => parseBudgetLedger(loweredGlobalRetry))).toBe('invalid-state');

    let persistedSpawns = createBudgetLedger({
      ...DEFAULT_EXECUTION_PLAN_BUDGETS, maxCumulativeSpawns: 2
    });
    for (const ordinal of [1, 2]) {
      persistedSpawns = recordBudgetOperation(persistedSpawns, {
        eventId: `persisted-spawn-${ordinal}`, nodeId: 'node-a',
        operation: 'spawn', kind: 'spawn'
      });
    }
    const loweredSpawnLimit = JSON.parse(JSON.stringify(persistedSpawns));
    loweredSpawnLimit.totals.maxCumulativeSpawns.limit = 1;
    loweredSpawnLimit.totals.maxCumulativeSpawns.remaining = 1;
    expect(errorCode(() => parseBudgetLedger(loweredSpawnLimit))).toBe('invalid-state');

    let persistedFixes = createBudgetLedger({
      ...DEFAULT_EXECUTION_PLAN_BUDGETS, localFixLoops: 2
    });
    for (const ordinal of [1, 2]) {
      persistedFixes = recordBudgetOperation(persistedFixes, {
        eventId: `persisted-fix-${ordinal}`, nodeId: `node-${ordinal}`,
        operation: 'local-fix', kind: 'local-fix'
      });
    }
    const loweredFixLimit = JSON.parse(JSON.stringify(persistedFixes));
    loweredFixLimit.totals.localFixLoops.limit = 1;
    loweredFixLimit.totals.localFixLoops.remaining = 1;
    expect(errorCode(() => parseBudgetLedger(loweredFixLimit))).toBe('invalid-state');
  });

  test('releases pending capacity idempotently and preserves capped cumulative counters', () => {
    const ledger = reserveBudget(createBudgetLedger({
      ...DEFAULT_EXECUTION_PLAN_BUDGETS, globalRetries: 1
    }), {
      reservationId: 'reservation-release', ticketHandleId: 'ticket-release-0001',
      parentTicketHandleId: null, ...WINDOW, amounts: { tokensGlobal: 25 }
    });
    const released = releaseBudget(ledger, 'reservation-release');
    expect(released.totals.tokensGlobal.reserved).toBe(0);
    expect(released.totals.tokensGlobal.released).toBe(25);
    expect(releaseBudget(released, 'reservation-release')).toEqual(released);
    const retried = incrementRetryCounter(released);
    expect(retried.cumulative.retries).toBe(1);
    expect(errorCode(() => incrementRetryCounter(retried)))
      .toBe('budget-exceeded');
  });
});
