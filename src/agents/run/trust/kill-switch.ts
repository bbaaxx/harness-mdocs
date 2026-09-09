export interface RunFeatureFlags {
  routeEnabled: boolean;
  runEnabled: boolean;
}

/**
 * Conservative rollout defaults. `runEnabled` stays false until a surface
 * passes every trust and adversarial probe. `routeEnabled` may default on only
 * after read-only purity tests pass; until then it is false too.
 */
export const DEFAULT_RUN_FEATURE_FLAGS: RunFeatureFlags = Object.freeze({
  routeEnabled: false,
  runEnabled: false
});

/**
 * Rollout kill switch. Disabling effects is idempotent, records the first
 * reason and timestamp, denies new effects, and leaves ordinary Orchestrate
 * available. Effects are never allowed while `runEnabled` is false.
 */
export interface RunKillSwitch {
  effectsAllowed(): boolean;
  disableEffects(reason: string): void;
  disableReason(): string | undefined;
}

export function createRunKillSwitch(
  flags: RunFeatureFlags = DEFAULT_RUN_FEATURE_FLAGS
): RunKillSwitch {
  let disabledReason: string | undefined;
  let disabledAt: string | undefined;

  return {
    effectsAllowed: () => flags.runEnabled && disabledReason === undefined,
    disableEffects: (reason: string) => {
      if (disabledReason !== undefined) return;
      disabledReason = reason;
      disabledAt = new Date().toISOString();
    },
    disableReason: () =>
      disabledReason === undefined
        ? undefined
        : `${disabledReason} (at ${disabledAt})`
  };
}
