import {
  FidelityMeasurementOptions,
  FidelityProbeInvocation,
  FidelityQuarantineDiagnostic,
  FidelityRunnerState,
  ProbeIsolationExecutor,
  runCanonicalFidelityProbes
} from './probes';
import { FidelityProbeResult, FidelitySubject, fidelitySubjectSchema } from './schema';
import { FidelityProbeId } from './catalog';

export interface FidelityRunnerDiagnosticsSnapshot {
  readonly poisoned: boolean;
  readonly isolation: ProbeIsolationExecutor['isolation'];
  readonly quarantines: readonly Readonly<FidelityQuarantineDiagnostic>[];
}

interface LiveRunnerState extends FidelityRunnerState {}

export interface TrustedFidelitySnapshot {
  subject: FidelitySubject;
  probes: readonly FidelityProbeResult[];
  diagnostics: FidelityRunnerDiagnosticsSnapshot;
}

export interface RegisteredFidelityAdapter {
  readonly registeredAdapter: 'opaque';
}

export interface HostFidelityMeasurement {
  readonly schemaVersion: 1;
  readonly subject: FidelitySubject;
  readonly probes: readonly FidelityProbeResult[];
  readonly diagnostics: FidelityRunnerDiagnosticsSnapshot;
}

export interface HostFidelityRunner {
  registerAdapter(
    subject: FidelitySubject,
    executor: ProbeIsolationExecutor
  ): RegisteredFidelityAdapter;
  measure(
    registration: RegisteredFidelityAdapter,
    options: FidelityMeasurementOptions
  ): Promise<HostFidelityMeasurement>;
}

interface RegistrationState {
  subject: FidelitySubject;
  executor: ProbeIsolationExecutor;
}

interface TrustedMeasurementState {
  subject: FidelitySubject;
  probes: readonly FidelityProbeResult[];
  isolation: ProbeIsolationExecutor['isolation'];
  runnerState: LiveRunnerState;
}

const trustedMeasurements = new WeakMap<object, TrustedMeasurementState>();

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function diagnostics(
  state: LiveRunnerState,
  isolation: ProbeIsolationExecutor['isolation']
): FidelityRunnerDiagnosticsSnapshot {
  return deepFreeze({
    poisoned: state.poisoned || state.draining,
    isolation,
    quarantines: state.quarantines.map(item => ({ ...item }))
  });
}

/** Resolves current runner safety state, not only state captured when measurement was minted. */
export function resolveTrustedFidelityMeasurement(value: object): TrustedFidelitySnapshot | undefined {
  const trusted = trustedMeasurements.get(value);
  if (trusted === undefined) return undefined;
  return {
    subject: trusted.subject,
    probes: trusted.probes,
    diagnostics: diagnostics(trusted.runnerState, trusted.isolation)
  };
}

/**
 * Host-only authority factory. TypeScript is not protection. Production hosts
 * must keep registry/runner credentials from workers and register only executors
 * backed by killable isolation; runner never receives an adapter callback.
 */
export function createHostFidelityRunner(): HostFidelityRunner {
  const registrations = new WeakMap<object, RegistrationState>();
  const runnerState: LiveRunnerState = { poisoned: false, draining: false, quarantines: [] };
  let measurementActive = false;

  return Object.freeze({
    registerAdapter(
      rawSubject: FidelitySubject,
      executor: ProbeIsolationExecutor
    ): RegisteredFidelityAdapter {
      const registration = Object.freeze({ registeredAdapter: 'opaque' as const });
      const subject = fidelitySubjectSchema.parse(rawSubject);
      const isolation = executor.isolation;
      const startProbe = executor.startProbe;
      if ((isolation !== 'killable' && isolation !== 'in-process') ||
          typeof startProbe !== 'function') {
        throw new Error('Invalid fidelity isolation executor');
      }
      const boundExecutor: ProbeIsolationExecutor = Object.freeze({
        isolation,
        startProbe: (probeId: FidelityProbeId, invocation: FidelityProbeInvocation) =>
          startProbe.call(executor, probeId, invocation)
      });
      registrations.set(registration, { subject, executor: boundExecutor });
      return registration;
    },
    async measure(
      registration: RegisteredFidelityAdapter,
      options: FidelityMeasurementOptions
    ): Promise<HostFidelityMeasurement> {
      const registered = typeof registration === 'object' && registration !== null
        ? registrations.get(registration)
        : undefined;
      if (registered === undefined) throw new Error('Fidelity adapter is not registered with this runner');
      if (measurementActive) throw new Error('Fidelity runner already has an active measurement');

      measurementActive = true;
      let measured;
      try {
        measured = await runCanonicalFidelityProbes(
          registered.subject,
          registered.executor,
          options,
          runnerState
        );
      } finally {
        measurementActive = false;
      }
      const exposed = deepFreeze({
        schemaVersion: 1 as const,
        subject: measured.subject,
        probes: measured.probes,
        diagnostics: measured.diagnostics
      });
      trustedMeasurements.set(exposed, {
        subject: exposed.subject,
        probes: exposed.probes,
        isolation: registered.executor.isolation,
        runnerState
      });
      return exposed;
    }
  });
}
