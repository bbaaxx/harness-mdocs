export interface UsageSample {
  source: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  priceTableVersion: string;
  cost?: { currency: string; value: number };
  actionCount: number;
  confidence: 'authoritative' | 'estimated' | 'unknown';
  /** RFC3339 UTC `Z` timestamp. */
  timestamp: string;
}

export interface UsageEstimate {
  tokens?: number;
  cost?: { currency: string; value: number };
  actions?: number;
}

export interface UsageReservation {
  reservationId: string;
  boundedMax: UsageEstimate;
  toleratedOvershoot: number;
}

/**
 * Monotonic usage source with reservation and reconciliation. Hard token/cost
 * budgets are enforceable only with confidence 'authoritative'; confidence
 * 'unknown' cannot satisfy a hard ceiling — the approved plan must omit that
 * hard dimension or the surface stays plan-only. Default tolerated overshoot
 * beyond the reserved maximum is zero.
 */
export interface UsageMeter {
  reserve(estimate: UsageEstimate): Promise<UsageReservation>;
  commit(reservationId: string, sample: UsageSample): Promise<void>;
  sample(scope: string): Promise<UsageSample>;
}
