import { parseExtensionsConfig } from "../extensions/ExtensionsConfig.ts";
import type { DecisionsAccessConfig } from "./DecisionsAccess.ts";

export const DECISION_MODEL = "extensions-v1";
export const DECISION_TEMPLATE = "decisions-v1";
export interface DecisionsConfig extends DecisionsAccessConfig {
  readonly valid: boolean;
  readonly priceNanoUsdPerInputToken: number;
  readonly attemptHoldNanoUsd: number;
  readonly runBudgetNanoUsd: number;
  readonly maxAttemptsPerRun: number;
  readonly maxAttemptsPerRequest: number;
  readonly accountConcurrency: number;
  readonly environmentConcurrency: number;
  readonly requestsPerMinute: number;
  readonly accountExposureNanoUsd: number;
  readonly globalExposureNanoUsd: number;
  readonly unknownHoldSeconds: number;
  readonly resultRetentionSeconds: number;
  readonly maxActualInputTokens: number;
  readonly requestTimeoutMs: number;
}

/** Compatibility adapter for feature settings; evaluation uses only the private service. */
export function parseDecisionsConfig(
  env: Readonly<Record<string, string | undefined>>,
): DecisionsConfig {
  const normalized = parseExtensionsConfig(env);
  const feature = normalized.decisions;
  const valid = feature.valid;
  return {
    ...normalized.shared,
    ...feature,
    valid,
    enabled: valid && feature.enabled,
  };
}
