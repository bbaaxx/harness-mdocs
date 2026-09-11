import * as crypto from 'crypto';

import { FIDELITY_ASSERTION_CATALOG, FidelityProbeId } from './catalog';
import {
  FidelityProbeAdapter,
  FidelityProbeContext,
  ProbeIsolationExecutor
} from './probes';
import { FidelityProbeResult, FidelitySubject } from './schema';

export const FAKE_FIDELITY_SUBJECT: FidelitySubject = Object.freeze({
  surfaceId: 'fake-test-surface',
  adapterId: 'fake-fidelity-adapter',
  adapterVersion: '1.0.0-test',
  implementationDigest: `sha256:${'f'.repeat(64)}`
});

export const FAKE_FIDELITY_MEASURED_AT = '2026-01-01T00:00:00.000Z';

export type FakeFidelityOutcome = 'pass' | 'fail' | 'unknown';
export type FakeFidelityFault = 'throw' | 'timeout' | 'malformed';

export interface FakeFidelityProbeAdapterOptions {
  subject?: FidelitySubject;
  measuredAt?: string;
  outcomes?: Partial<Record<FidelityProbeId, FakeFidelityOutcome>>;
  faults?: Partial<Record<FidelityProbeId, FakeFidelityFault>>;
}

export interface FakeFidelityProbeAdapter extends FidelityProbeAdapter {
  observedChallenges(): readonly string[];
}

export interface FakeProbeIsolationExecutorOptions {
  isolation?: ProbeIsolationExecutor['isolation'];
  undrainedProbeIds?: readonly FidelityProbeId[];
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

/** Stable challenge source for deterministic fake-adapter transcripts. */
export function createFakeFidelityChallengeSource(prefix = 'fake-fidelity-challenge'):
  (probeId: FidelityProbeId) => string {
  return probeId => `${prefix}:${probeId}`;
}

/** Test-only in-process simulation of host isolation, kill, and drain semantics. */
export function createFakeProbeIsolationExecutor(
  adapter: FidelityProbeAdapter,
  options: FakeProbeIsolationExecutorOptions = {}
): ProbeIsolationExecutor {
  const undrained = new Set(options.undrainedProbeIds ?? []);
  return {
    isolation: options.isolation ?? 'killable',
    startProbe(probeId, invocation) {
      const controller = new AbortController();
      let terminated!: () => void;
      const terminatedPromise = new Promise<void>(resolve => {
        terminated = resolve;
      });
      const result = Promise.resolve().then(() => adapter.runProbe(probeId, {
        ...invocation,
        signal: controller.signal
      }));
      const naturallySettled = result.then(() => undefined, () => undefined);
      return {
        result,
        settled: undrained.has(probeId)
          ? naturallySettled
          : Promise.race([naturallySettled, terminatedPromise]),
        async terminate() {
          controller.abort();
          if (!undrained.has(probeId)) terminated();
        }
      };
    }
  };
}

/** Deterministic test-only adapter. It is not production protection or surface registration. */
export function createFakeFidelityProbeAdapter(
  options: FakeFidelityProbeAdapterOptions = {}
): FakeFidelityProbeAdapter {
  const subject = options.subject ?? FAKE_FIDELITY_SUBJECT;
  const at = options.measuredAt ?? FAKE_FIDELITY_MEASURED_AT;
  const challenges: string[] = [];

  return {
    subject,
    async runProbe(probeId: FidelityProbeId, context: FidelityProbeContext): Promise<unknown> {
      challenges.push(context.challengeId);
      const fault = options.faults?.[probeId];
      if (fault === 'throw') throw new Error(`Fake probe failure: ${probeId}`);
      if (fault === 'timeout') return new Promise(() => undefined);
      if (fault === 'malformed') return { schemaVersion: 1, probeId };

      const outcome = options.outcomes?.[probeId] ?? 'pass';
      const assertions = FIDELITY_ASSERTION_CATALOG[probeId].map((assertionId, index) => {
        const status = index === 0 ? outcome : 'pass';
        return {
          assertionId,
          status,
          ...(status === 'pass' ? {
            evidenceDigest: digest([
              subject.implementationDigest,
              probeId,
              assertionId,
              context.challengeId,
              context.sandboxRoot
            ].join('\0'))
          } : {})
        };
      });
      const result: FidelityProbeResult = {
        schemaVersion: 1,
        probeId,
        challengeId: context.challengeId,
        subject,
        status: outcome,
        assertions,
        measuredAt: at
      };
      return result;
    },
    observedChallenges: () => Object.freeze([...challenges])
  };
}
