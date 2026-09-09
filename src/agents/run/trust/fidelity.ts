import { SurfaceFidelity } from '../../schema';

export type TrustComponentId =
  | 'attestation'
  | 'host-identity'
  | 'controller-store'
  | 'action-mediation'
  | 'cancellation'
  | 'usage-metering';

export interface TrustComponentObservation {
  component: TrustComponentId;
  status: 'enforced' | 'missing' | 'unknown';
  reason?: string;
}

export interface FidelityAssessment {
  fidelity: SurfaceFidelity;
  reasons: string[];
}

export interface RunFidelityInput {
  contractRendering: 'available' | 'unavailable';
  components: TrustComponentObservation[];
  hardBudgetDimensions: ('tokens' | 'cost')[];
  continuation: 'autonomous' | 'human-checkpoint';
}

const AUTHORITY_COMPONENTS: readonly TrustComponentId[] = Object.freeze([
  'attestation',
  'host-identity',
  'controller-store',
  'action-mediation',
  'cancellation'
]);

/**
 * Pure, fail-closed fidelity evaluator. Missing observations default to
 * 'missing'. Every downgrade carries a human-readable reason. A human
 * checkpoint NEVER compensates for missing enforcement: any missing authority
 * component yields 'plan-only', never 'supervised'.
 */
export function evaluateRunFidelity(input: RunFidelityInput): FidelityAssessment {
  if (input.contractRendering === 'unavailable') {
    return {
      fidelity: 'unsupported',
      reasons: ['contract rendering/validation unavailable; refusing capability']
    };
  }

  const observed = new Map(input.components.map(entry => [entry.component, entry]));
  const reasons: string[] = [];

  for (const component of AUTHORITY_COMPONENTS) {
    const observation = observed.get(component);
    const status = observation?.status ?? 'missing';
    if (status !== 'enforced') {
      const detail = observation?.reason ? `: ${observation.reason}` : '';
      reasons.push(`trust component "${component}" is ${status}${detail}`);
    }
  }

  const metering = observed.get('usage-metering');
  const meteringStatus = metering?.status ?? 'missing';
  if (input.hardBudgetDimensions.length > 0 && meteringStatus !== 'enforced') {
    reasons.push(
      `trust component "usage-metering" is ${meteringStatus} while hard budget dimensions ` +
        `[${input.hardBudgetDimensions.join(', ')}] are enforced`
    );
  }

  if (reasons.length > 0) {
    return { fidelity: 'plan-only', reasons };
  }

  return {
    fidelity: input.continuation === 'autonomous' ? 'exact' : 'supervised',
    reasons: []
  };
}
