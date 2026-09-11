import * as crypto from 'crypto';
import * as path from 'path';

import { FIDELITY_ASSERTION_CATALOG, FIDELITY_PROBE_IDS, FidelityProbeId } from './catalog';
import {
  FidelityProbeResult,
  FidelitySubject,
  fidelityProbeResultSchema,
  fidelitySubjectSchema,
  subjectMatches,
  unknownProbeResult
} from './schema';

export interface FidelityProbeInvocation {
  challengeId: string;
  sandboxRoot: string;
}

export interface FidelityProbeContext extends FidelityProbeInvocation {
  signal: AbortSignal;
}

/** Test adapter shape. Production runner never receives or invokes this object. */
export interface FidelityProbeAdapter {
  readonly subject: FidelitySubject;
  runProbe(probeId: FidelityProbeId, context: FidelityProbeContext): Promise<unknown>;
}

export interface ProbeExecutionHandle {
  readonly result: Promise<unknown>;
  readonly settled: Promise<void>;
  terminate(): Promise<void>;
}

/**
 * Host isolation boundary. Production exact/supervised support requires a
 * killable process, worker, or equivalent that returns host-cloned data.
 */
export interface ProbeIsolationExecutor {
  readonly isolation: 'killable' | 'in-process';
  startProbe(probeId: FidelityProbeId, invocation: FidelityProbeInvocation): ProbeExecutionHandle;
}

export interface FidelityMeasurementOptions {
  sandboxRoot: string;
  probeTimeoutMs?: number;
  probeDrainTimeoutMs?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  challengeSource?: (probeId: FidelityProbeId) => string;
}

export interface FidelityQuarantineDiagnostic {
  probeId: FidelityProbeId;
  sandboxRoot: string;
  diagnosticCode: 'PROBE_TIMEOUT';
}

export interface FidelityRunnerDiagnostics {
  poisoned: boolean;
  isolation: ProbeIsolationExecutor['isolation'];
  quarantines: readonly FidelityQuarantineDiagnostic[];
}

export interface FidelityRunnerState {
  poisoned: boolean;
  draining: boolean;
  quarantines: FidelityQuarantineDiagnostic[];
}

export interface CanonicalProbeRun {
  subject: FidelitySubject;
  probes: readonly FidelityProbeResult[];
  diagnostics: FidelityRunnerDiagnostics;
}

const INVALID_SUBJECT: FidelitySubject = Object.freeze({
  surfaceId: 'invalid-surface',
  adapterId: 'invalid-adapter',
  adapterVersion: '0',
  implementationDigest: `sha256:${'0'.repeat(64)}`
});

const TIMEOUT = Symbol('fidelity-probe-timeout');
const DRAINED = Symbol('fidelity-probe-drained');
const DRAIN_REJECTED = Symbol('fidelity-probe-drain-rejected');
const DRAIN_TIMEOUT = Symbol('fidelity-probe-drain-timeout');
const MAX_RAW_PROBE_RESULTS = 16;

type ProbeResultOutcome =
  | { status: 'resolved'; value: unknown }
  | { status: 'rejected' };

function measuredAt(now: () => Date): string {
  try {
    return now().toISOString();
  } catch {
    return '1970-01-01T00:00:00.000Z';
  }
}

function monotonicAt(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function monotonicRemaining(startedAt: number, deadlineAt: number, now: () => number): number {
  const current = monotonicAt(now);
  const elapsed = current - startedAt;
  const remaining = deadlineAt - current;
  return Number.isFinite(startedAt) && Number.isFinite(deadlineAt) &&
    Number.isFinite(current) && elapsed >= 0 && remaining > 0
    ? remaining
    : 0;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, value) : fallback;
}

function sandboxFor(root: string, probeId: FidelityProbeId, challengeId: string): string {
  const index = FIDELITY_PROBE_IDS.indexOf(probeId).toString().padStart(2, '0');
  const probe = probeId.replace(/[^a-z0-9]+/g, '-');
  const challenge = crypto.createHash('sha256').update(challengeId).digest('hex').slice(0, 16);
  return path.join(root, `${index}-${probe}-${challenge}`);
}

function canonicalResult(result: FidelityProbeResult, measuredAtValue: string): FidelityProbeResult {
  const byId = new Map(result.assertions.map(assertion => [assertion.assertionId, assertion]));
  return fidelityProbeResultSchema.parse({
    ...result,
    measuredAt: measuredAtValue,
    assertions: FIDELITY_ASSERTION_CATALOG[result.probeId].map(assertionId => byId.get(assertionId))
  });
}

function matchingProbeCount(raw: unknown, probeId: FidelityProbeId): number {
  if (!Array.isArray(raw) || raw.length > MAX_RAW_PROBE_RESULTS) return 0;
  let matches = 0;
  for (const candidate of raw) {
    if (typeof candidate === 'object' && candidate !== null &&
        (candidate as { probeId?: unknown }).probeId === probeId) {
      matches += 1;
    }
  }
  return matches;
}

function boundedAssertions(raw: unknown, probeId: FidelityProbeId): readonly unknown[] | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  try {
    const assertions = (raw as { assertions?: unknown }).assertions;
    if (!Array.isArray(assertions) ||
        assertions.length !== FIDELITY_ASSERTION_CATALOG[probeId].length) {
      return undefined;
    }

    const bounded: unknown[] = [];
    for (let index = 0; index < assertions.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(assertions, String(index));
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      const element = Reflect.get(assertions, String(index));
      if (element !== descriptor.value) return undefined;
      bounded.push(element);
    }
    return bounded;
  } catch {
    return undefined;
  }
}

type DrainOutcome = typeof DRAINED | typeof DRAIN_REJECTED | typeof DRAIN_TIMEOUT;

async function boundedDrain(
  settled: Promise<unknown>,
  drainTimeoutMs: number
): Promise<DrainOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = settled.then(
    (): typeof DRAINED => DRAINED,
    (): typeof DRAIN_REJECTED => DRAIN_REJECTED
  );
  const timeout = new Promise<typeof DRAIN_TIMEOUT>(resolve => {
    timer = setTimeout(() => resolve(DRAIN_TIMEOUT), drainTimeoutMs);
  });
  try {
    return await Promise.race([drained, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function terminateAndDrain(
  handle: ProbeExecutionHandle,
  drainTimeoutMs: number
): Promise<DrainOutcome> {
  void Promise.resolve().then(() => handle.terminate()).catch(() => undefined);
  return boundedDrain(handle.settled, drainTimeoutMs);
}

function quarantine(
  state: FidelityRunnerState,
  probeId: FidelityProbeId,
  sandboxRoot: string
): void {
  state.poisoned = true;
  state.quarantines.push({ probeId, sandboxRoot, diagnosticCode: 'PROBE_TIMEOUT' });
}

async function naturalSettlement(
  handle: ProbeExecutionHandle,
  state: FidelityRunnerState,
  remainingMs: number
): Promise<DrainOutcome> {
  state.draining = true;
  try {
    return await boundedDrain(handle.settled, remainingMs);
  } catch {
    return DRAIN_REJECTED;
  } finally {
    state.draining = false;
  }
}

async function terminateProbe(
  handle: ProbeExecutionHandle,
  state: FidelityRunnerState,
  subject: FidelitySubject,
  probeId: FidelityProbeId,
  sandboxRoot: string,
  challengeId: string,
  at: string,
  drainTimeoutMs: number,
  diagnosticCode: 'PROBE_THROWN' | 'PROBE_TIMEOUT',
  poisonRegardless = false
): Promise<FidelityProbeResult> {
  state.draining = true;
  let drainOutcome: DrainOutcome = DRAIN_REJECTED;
  try {
    drainOutcome = await terminateAndDrain(handle, drainTimeoutMs);
  } catch {
    drainOutcome = DRAIN_REJECTED;
  } finally {
    state.draining = false;
  }
  if (poisonRegardless || drainOutcome !== DRAINED) {
    quarantine(state, probeId, sandboxRoot);
  }
  return unknownProbeResult(probeId, subject, challengeId, at, diagnosticCode);
}

async function timeoutProbe(
  handle: ProbeExecutionHandle,
  state: FidelityRunnerState,
  subject: FidelitySubject,
  probeId: FidelityProbeId,
  sandboxRoot: string,
  challengeId: string,
  at: string,
  drainTimeoutMs: number,
  poisonRegardless = false
): Promise<FidelityProbeResult> {
  return terminateProbe(
    handle, state, subject, probeId, sandboxRoot, challengeId, at,
    drainTimeoutMs, 'PROBE_TIMEOUT', poisonRegardless
  );
}

async function runOneProbe(
  executor: ProbeIsolationExecutor,
  subject: FidelitySubject,
  probeId: FidelityProbeId,
  options: Required<FidelityMeasurementOptions>,
  state: FidelityRunnerState,
  usedChallenges: Set<string>
): Promise<FidelityProbeResult> {
  const at = measuredAt(options.now);
  if (state.poisoned) {
    return unknownProbeResult(probeId, subject, `poisoned:${probeId}`, at, 'PROBE_RUNNER_POISONED');
  }

  let challengeId: string;
  try {
    challengeId = options.challengeSource(probeId);
    if (challengeId.length === 0 || challengeId.length > 256 || usedChallenges.has(challengeId)) {
      throw new Error('Invalid or reused fidelity challenge');
    }
    usedChallenges.add(challengeId);
  } catch {
    return unknownProbeResult(probeId, subject, `invalid:${probeId}`, at, 'PROBE_THROWN');
  }

  const sandboxRoot = sandboxFor(options.sandboxRoot, probeId, challengeId);
  const startedAt = monotonicAt(options.monotonicNow);
  const deadlineAt = startedAt + options.probeTimeoutMs;
  let handle: ProbeExecutionHandle;
  try {
    handle = executor.startProbe(probeId, { challengeId, sandboxRoot });
  } catch {
    return unknownProbeResult(probeId, subject, challengeId, at, 'PROBE_THROWN');
  }

  const executionRemaining = monotonicRemaining(startedAt, deadlineAt, options.monotonicNow);
  if (executionRemaining <= 0) {
    return timeoutProbe(
      handle, state, subject, probeId, sandboxRoot, challengeId, at, options.probeDrainTimeoutMs
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMEOUT>(resolve => {
      timer = setTimeout(() => resolve(TIMEOUT), executionRemaining);
    });
    const outcome: Promise<ProbeResultOutcome> = Promise.resolve(handle.result).then(
      (value): ProbeResultOutcome => ({ status: 'resolved', value }),
      (): ProbeResultOutcome => ({ status: 'rejected' })
    );
    const result = await Promise.race([outcome, timeout]);
    if (result === TIMEOUT || monotonicRemaining(
      startedAt, deadlineAt, options.monotonicNow
    ) <= 0) {
      return timeoutProbe(
        handle, state, subject, probeId, sandboxRoot, challengeId, at, options.probeDrainTimeoutMs
      );
    }
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (result.status === 'rejected') {
      return terminateProbe(
        handle, state, subject, probeId, sandboxRoot, challengeId, at,
        options.probeDrainTimeoutMs, 'PROBE_THROWN'
      );
    }

    const settlementRemaining = monotonicRemaining(
      startedAt, deadlineAt, options.monotonicNow
    );
    if (settlementRemaining <= 0) {
      return timeoutProbe(
        handle, state, subject, probeId, sandboxRoot, challengeId, at, options.probeDrainTimeoutMs
      );
    }
    const settlement = await naturalSettlement(handle, state, settlementRemaining);
    if (settlement !== DRAINED || monotonicRemaining(
      startedAt, deadlineAt, options.monotonicNow
    ) <= 0) {
      return timeoutProbe(
        handle, state, subject, probeId, sandboxRoot, challengeId, at,
        options.probeDrainTimeoutMs, settlement === DRAIN_REJECTED
      );
    }
    const raw = result.value;

    if (Array.isArray(raw) && raw.length > MAX_RAW_PROBE_RESULTS) {
      return unknownProbeResult(probeId, subject, challengeId, at, 'PROBE_MALFORMED');
    }
    if (matchingProbeCount(raw, probeId) > 1) {
      return unknownProbeResult(probeId, subject, challengeId, at, 'PROBE_DUPLICATE');
    }
    const assertions = boundedAssertions(raw, probeId);
    if (assertions === undefined) {
      return unknownProbeResult(probeId, subject, challengeId, at, 'PROBE_MALFORMED');
    }
    const stamped = { ...(raw as object), assertions, measuredAt: at };
    const parsed = fidelityProbeResultSchema.safeParse(stamped);
    if (!parsed.success || parsed.data.probeId !== probeId) {
      return unknownProbeResult(probeId, subject, challengeId, at, 'PROBE_MALFORMED');
    }
    if (parsed.data.challengeId !== challengeId) {
      return unknownProbeResult(probeId, subject, challengeId, at, 'PROBE_CHALLENGE_MISMATCH');
    }
    if (!subjectMatches(parsed.data.subject, subject)) {
      return unknownProbeResult(probeId, subject, challengeId, at, 'PROBE_STALE_SUBJECT');
    }
    return canonicalResult(parsed.data, at);
  } catch {
    return unknownProbeResult(probeId, subject, challengeId, at, 'PROBE_THROWN');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Sequential host-isolated execution preserves sandbox and timeout boundaries. */
export async function runCanonicalFidelityProbes(
  rawSubject: unknown,
  executor: ProbeIsolationExecutor,
  options: FidelityMeasurementOptions,
  state: FidelityRunnerState
): Promise<CanonicalProbeRun> {
  const parsedSubject = fidelitySubjectSchema.safeParse(rawSubject);
  const subject = parsedSubject.success ? parsedSubject.data : INVALID_SUBJECT;
  const resolved: Required<FidelityMeasurementOptions> = {
    sandboxRoot: options.sandboxRoot,
    probeTimeoutMs: positiveTimeout(options.probeTimeoutMs, 10_000),
    probeDrainTimeoutMs: positiveTimeout(options.probeDrainTimeoutMs, 1_000),
    now: options.now ?? (() => new Date()),
    monotonicNow: options.monotonicNow ?? (() => Number(process.hrtime.bigint()) / 1_000_000),
    challengeSource: options.challengeSource ?? (() => crypto.randomUUID())
  };
  const probes: FidelityProbeResult[] = [];
  const usedChallenges = new Set<string>();

  for (const probeId of FIDELITY_PROBE_IDS) {
    if (!parsedSubject.success) {
      probes.push(unknownProbeResult(
        probeId,
        subject,
        `invalid-subject:${probeId}`,
        measuredAt(resolved.now),
        'PROBE_MALFORMED'
      ));
      continue;
    }
    probes.push(await runOneProbe(executor, subject, probeId, resolved, state, usedChallenges));
  }

  return {
    subject,
    probes,
    diagnostics: {
      poisoned: state.poisoned || state.draining,
      isolation: executor.isolation,
      quarantines: state.quarantines.map(item => ({ ...item }))
    }
  };
}
