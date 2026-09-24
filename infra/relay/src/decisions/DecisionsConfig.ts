import { Redacted } from "effect";
import type { DecisionsAccessConfig } from "./DecisionsAccess.ts";

export const DECISION_MODEL = "jev-1.13.0";
export const DECISION_TEMPLATE = "decisions-v1";
export interface DecisionsConfig extends DecisionsAccessConfig {
  readonly apiKey: Redacted.Redacted<string> | null;
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

/** Invalid feature configuration fails closed without taking down unrelated relay routes. */
export function parseDecisionsConfig(
  env: Readonly<Record<string, string | undefined>>,
): DecisionsConfig {
  let valid =
    env.DECISIONS_ENABLED === undefined || ["true", "false"].includes(env.DECISIONS_ENABLED);
  const number = (name: string, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0 || value > max) {
      valid = false;
      return fallback;
    }
    return value;
  };
  const config = {
    billingMaxAgeSeconds: number("DECISIONS_BILLING_MAX_AGE_SECONDS", 86400),
    monthlyInputTokens: number("DECISIONS_MONTHLY_INPUT_TOKENS", 10_000_000),
    priceNanoUsdPerInputToken: 42,
    attemptHoldNanoUsd: number("DECISIONS_ATTEMPT_HOLD_NANO_USD", 10_000_000),
    runBudgetNanoUsd: number("DECISIONS_RUN_BUDGET_NANO_USD", 30_000_000),
    maxAttemptsPerRun: number("DECISIONS_MAX_ATTEMPTS_PER_RUN", 24, 100),
    maxAttemptsPerRequest: number("DECISIONS_MAX_ATTEMPTS_PER_REQUEST", 2, 5),
    accountConcurrency: number("DECISIONS_ACCOUNT_CONCURRENCY", 2, 16),
    environmentConcurrency: number("DECISIONS_ENVIRONMENT_CONCURRENCY", 1, 4),
    requestsPerMinute: number("DECISIONS_REQUESTS_PER_MINUTE", 60, 1000),
    accountExposureNanoUsd: number("DECISIONS_ACCOUNT_EXPOSURE_NANO_USD", 100_000_000),
    globalExposureNanoUsd: number("DECISIONS_GLOBAL_EXPOSURE_NANO_USD", 1_000_000_000),
    unknownHoldSeconds: number("DECISIONS_UNKNOWN_HOLD_SECONDS", 120, 3600),
    resultRetentionSeconds: number("DECISIONS_RESULT_RETENTION_SECONDS", 86400),
    maxActualInputTokens: 64000,
    requestTimeoutMs: number("DECISIONS_REQUEST_TIMEOUT_MS", 30000, 60000),
  };
  const cohort = [
    ...new Set(
      (env.DECISIONS_COHORT ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (cohort.some((id) => id !== "*" && !/^user_[A-Za-z0-9]+$/.test(id))) valid = false;
  const key = env.TYPESAFE_API_KEY?.trim();
  if (env.DECISIONS_ENABLED === "true" && (!key || cohort.length === 0)) valid = false;
  if (
    config.attemptHoldNanoUsd < config.maxActualInputTokens * config.priceNanoUsdPerInputToken ||
    config.runBudgetNanoUsd < config.attemptHoldNanoUsd ||
    config.accountExposureNanoUsd < config.attemptHoldNanoUsd ||
    config.globalExposureNanoUsd < config.accountExposureNanoUsd ||
    config.unknownHoldSeconds * 1000 <= config.requestTimeoutMs
  )
    valid = false;
  return {
    ...config,
    valid,
    enabled: valid && env.DECISIONS_ENABLED === "true",
    cohort,
    apiKey: key ? Redacted.make(key) : null,
  };
}
