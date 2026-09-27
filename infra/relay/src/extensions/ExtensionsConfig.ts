import { Option, Schema } from "effect";

export type ExtensionConfigScope = "shared" | "decisions" | "contextual";
export interface ExtensionConfigIssue {
  readonly scope: ExtensionConfigScope;
  readonly key: string;
  readonly reason: "invalid" | "conflicting-alias" | "missing-cohort" | "unsafe-bound";
}

/** Names only: diagnostics never include operator values or provider credentials. */
export const extensionConfigAliases = {
  EXTENSIONS_DECISIONS_ENABLED: "DECISIONS_ENABLED",
  EXTENSIONS_DECISIONS_COHORT: "DECISIONS_COHORT",
  EXTENSIONS_MONTHLY_INPUT_TOKENS: "DECISIONS_MONTHLY_INPUT_TOKENS",
  EXTENSIONS_BILLING_MAX_AGE_SECONDS: "DECISIONS_BILLING_MAX_AGE_SECONDS",
  EXTENSIONS_ACCOUNT_CONCURRENCY: "DECISIONS_ACCOUNT_CONCURRENCY",
  EXTENSIONS_ENVIRONMENT_CONCURRENCY: "DECISIONS_ENVIRONMENT_CONCURRENCY",
  EXTENSIONS_REQUESTS_PER_MINUTE: "DECISIONS_REQUESTS_PER_MINUTE",
  EXTENSIONS_ACCOUNT_EXPOSURE_NANO_USD: "DECISIONS_ACCOUNT_EXPOSURE_NANO_USD",
  EXTENSIONS_GLOBAL_EXPOSURE_NANO_USD: "DECISIONS_GLOBAL_EXPOSURE_NANO_USD",
  EXTENSIONS_UNKNOWN_HOLD_SECONDS: "DECISIONS_UNKNOWN_HOLD_SECONDS",
  EXTENSIONS_RESULT_RETENTION_SECONDS: "DECISIONS_RESULT_RETENTION_SECONDS",
  EXTENSIONS_REQUEST_TIMEOUT_MS: "DECISIONS_REQUEST_TIMEOUT_MS",
  EXTENSIONS_DECISIONS_ATTEMPT_HOLD_NANO_USD: "DECISIONS_ATTEMPT_HOLD_NANO_USD",
  EXTENSIONS_DECISIONS_RUN_BUDGET_NANO_USD: "DECISIONS_RUN_BUDGET_NANO_USD",
  EXTENSIONS_DECISIONS_MAX_ATTEMPTS_PER_RUN: "DECISIONS_MAX_ATTEMPTS_PER_RUN",
  EXTENSIONS_DECISIONS_MAX_ATTEMPTS_PER_REQUEST: "DECISIONS_MAX_ATTEMPTS_PER_REQUEST",
} as const;

const Decimal = Schema.String.check(Schema.isPattern(/^\d+$/));
const BooleanText = Schema.Literals(["true", "false"]);
const Cohort = Schema.Array(Schema.String.check(Schema.isPattern(/^(?:\*|user_[A-Za-z0-9]+)$/)));
const decodeDecimal = Schema.decodeUnknownOption(Decimal);
const decodeBoolean = Schema.decodeUnknownOption(BooleanText);
const decodeCohort = Schema.decodeUnknownOption(Cohort);
const decodePositiveInteger = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
);
const decimal =
  (max: number) =>
  (raw: string): Option.Option<number> => {
    const text = decodeDecimal(raw.trim());
    if (Option.isNone(text)) return Option.none();
    return Option.filter(decodePositiveInteger(Number(text.value)), (value) => value <= max);
  };
const boolean = (raw: string): Option.Option<boolean> =>
  Option.map(decodeBoolean(raw.trim()), (value) => value === "true");
const cohort = (raw: string): Option.Option<readonly string[]> =>
  decodeCohort(
    [
      ...new Set(
        raw
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ].sort(),
  );

/** Normalize once, preserving absence and independently fencing each feature. */
export function parseExtensionsConfig(env: Readonly<Record<string, string | undefined>>) {
  const issues: ExtensionConfigIssue[] = [];
  const legacyKeys: string[] = [];
  const read = <A>(
    scope: ExtensionConfigScope,
    key: string,
    fallback: A,
    decode: (value: string) => Option.Option<A>,
  ): A => {
    const legacy = extensionConfigAliases[key as keyof typeof extensionConfigAliases];
    const canonicalRaw = env[key];
    const legacyRaw = legacy === undefined ? undefined : env[legacy];
    if (legacyRaw !== undefined) legacyKeys.push(legacy!);
    const parse = (raw: string | undefined, name: string) => {
      if (raw === undefined) return Option.none<A>();
      const value = decode(raw);
      if (Option.isNone(value)) issues.push({ scope, key: name, reason: "invalid" });
      return value;
    };
    const canonical = parse(canonicalRaw, key);
    const old = parse(legacyRaw, legacy ?? key);
    if (
      Option.isSome(canonical) &&
      Option.isSome(old) &&
      JSON.stringify(canonical.value) !== JSON.stringify(old.value)
    )
      issues.push({ scope, key, reason: "conflicting-alias" });
    // A present invalid canonical value cannot silently fall back to its legacy alias.
    return Option.getOrElse(canonicalRaw === undefined ? old : canonical, () => fallback);
  };
  const number = (
    scope: ExtensionConfigScope,
    name: string,
    fallback: number,
    max = Number.MAX_SAFE_INTEGER,
  ) => read(scope, name, fallback, decimal(max));
  const shared = {
    monthlyInputTokens: number("shared", "EXTENSIONS_MONTHLY_INPUT_TOKENS", 10_000_000),
    billingMaxAgeSeconds: number("shared", "EXTENSIONS_BILLING_MAX_AGE_SECONDS", 86400),
    accountConcurrency: number("shared", "EXTENSIONS_ACCOUNT_CONCURRENCY", 2, 16),
    environmentConcurrency: number("shared", "EXTENSIONS_ENVIRONMENT_CONCURRENCY", 1, 4),
    requestsPerMinute: number("shared", "EXTENSIONS_REQUESTS_PER_MINUTE", 60, 1000),
    accountExposureNanoUsd: number("shared", "EXTENSIONS_ACCOUNT_EXPOSURE_NANO_USD", 100_000_000),
    globalExposureNanoUsd: number("shared", "EXTENSIONS_GLOBAL_EXPOSURE_NANO_USD", 1_000_000_000),
    unknownHoldSeconds: number("shared", "EXTENSIONS_UNKNOWN_HOLD_SECONDS", 120, 3600),
    resultRetentionSeconds: number("shared", "EXTENSIONS_RESULT_RETENTION_SECONDS", 86400),
    requestTimeoutMs: number("shared", "EXTENSIONS_REQUEST_TIMEOUT_MS", 30000, 60000),
  };
  if (shared.globalExposureNanoUsd < shared.accountExposureNanoUsd)
    issues.push({
      scope: "shared",
      key: "EXTENSIONS_GLOBAL_EXPOSURE_NANO_USD",
      reason: "unsafe-bound",
    });
  if (shared.unknownHoldSeconds * 1000 <= shared.requestTimeoutMs)
    issues.push({
      scope: "shared",
      key: "EXTENSIONS_UNKNOWN_HOLD_SECONDS",
      reason: "unsafe-bound",
    });
  const sharedValid = !issues.some((issue) => issue.scope === "shared");
  const feature = (scope: "decisions" | "contextual") => {
    const prefix = `EXTENSIONS_${scope.toUpperCase()}_`;
    const requested = read(scope, `${prefix}ENABLED`, false, boolean);
    const admittedCohort = read(scope, `${prefix}COHORT`, [] as readonly string[], cohort);
    const bounds = {
      priceNanoUsdPerInputToken: 42,
      // One admitted attempt includes every bounded internal evaluation step.
      maxActualInputTokens: 64000,
      attemptHoldNanoUsd: number(scope, `${prefix}ATTEMPT_HOLD_NANO_USD`, 10_000_000),
      runBudgetNanoUsd: number(scope, `${prefix}RUN_BUDGET_NANO_USD`, 30_000_000),
      maxAttemptsPerRun: number(
        scope,
        `${prefix}MAX_ATTEMPTS_PER_RUN`,
        scope === "decisions" ? 24 : 6,
        scope === "decisions" ? 100 : 6,
      ),
      maxAttemptsPerRequest: number(scope, `${prefix}MAX_ATTEMPTS_PER_REQUEST`, 2, 5),
    };
    if (requested && admittedCohort.length === 0)
      issues.push({ scope, key: `${prefix}COHORT`, reason: "missing-cohort" });
    if (bounds.attemptHoldNanoUsd < bounds.maxActualInputTokens * bounds.priceNanoUsdPerInputToken)
      issues.push({ scope, key: `${prefix}ATTEMPT_HOLD_NANO_USD`, reason: "unsafe-bound" });
    if (bounds.runBudgetNanoUsd < bounds.attemptHoldNanoUsd)
      issues.push({ scope, key: `${prefix}RUN_BUDGET_NANO_USD`, reason: "unsafe-bound" });
    if (shared.accountExposureNanoUsd < bounds.attemptHoldNanoUsd)
      issues.push({ scope, key: `${prefix}ATTEMPT_HOLD_NANO_USD`, reason: "unsafe-bound" });
    const valid = sharedValid && !issues.some((issue) => issue.scope === scope);
    return { ...bounds, valid, enabled: valid && requested, cohort: admittedCohort };
  };
  const decisions = feature("decisions");
  const contextual = feature("contextual");
  return { shared: { ...shared, valid: sharedValid }, decisions, contextual, issues, legacyKeys };
}
export type ExtensionsConfig = ReturnType<typeof parseExtensionsConfig>;

/** Both names are forwarded during the compatibility release; defaults apply only in the parser. */
export const extensionEnvironmentKeys = [
  ...Object.keys(extensionConfigAliases),
  ...Object.values(extensionConfigAliases),
  "EXTENSIONS_CONTEXTUAL_ENABLED",
  "EXTENSIONS_CONTEXTUAL_COHORT",
  "EXTENSIONS_CONTEXTUAL_ATTEMPT_HOLD_NANO_USD",
  "EXTENSIONS_CONTEXTUAL_RUN_BUDGET_NANO_USD",
  "EXTENSIONS_CONTEXTUAL_MAX_ATTEMPTS_PER_RUN",
  "EXTENSIONS_CONTEXTUAL_MAX_ATTEMPTS_PER_REQUEST",
] as const;
