import { describe, expect, it } from "@effect/vitest";
import { parseExtensionsConfig } from "./ExtensionsConfig.ts";

const enabled = {
  EXTENSIONS_DECISIONS_ENABLED: "true",
  EXTENSIONS_DECISIONS_COHORT: "user_fixture",
  EXTENSIONS_CONTEXTUAL_ENABLED: "true",
  EXTENSIONS_CONTEXTUAL_COHORT: "user_fixture",
};
describe("shared extension configuration", () => {
  it("does not activate either feature or create a cohort from missing values", () => {
    const config = parseExtensionsConfig({});
    expect(config.shared.monthlyInputTokens).toBe(10_000_000);
    expect(config.decisions.enabled).toBe(false);
    expect(config.contextual.enabled).toBe(false);
    expect(config.decisions.cohort).toEqual([]);
    expect(config.issues).toEqual([]);
  });
  it("carries a legacy allowance into the one shared pool without granting Contextual", () => {
    const config = parseExtensionsConfig({
      DECISIONS_ENABLED: "true",
      DECISIONS_COHORT: "user_fixture",
      DECISIONS_MONTHLY_INPUT_TOKENS: "1234567",
    });
    expect(config.shared.monthlyInputTokens).toBe(1234567);
    expect(config.decisions.enabled).toBe(true);
    expect(config.contextual.enabled).toBe(false);
    expect(config.legacyKeys).toContain("DECISIONS_MONTHLY_INPUT_TOKENS");
    expect(config.decisions).not.toHaveProperty("monthlyInputTokens");
    expect(config.contextual).not.toHaveProperty("monthlyInputTokens");
  });
  it("accepts equal normalized aliases including unordered deduplicated cohorts", () => {
    const config = parseExtensionsConfig({
      ...enabled,
      DECISIONS_ENABLED: "true",
      DECISIONS_COHORT: "user_fixture,user_other,user_fixture",
      EXTENSIONS_DECISIONS_COHORT: " user_other, user_fixture ",
      DECISIONS_MONTHLY_INPUT_TOKENS: "010000000",
      EXTENSIONS_MONTHLY_INPUT_TOKENS: "10000000",
    });
    expect(config.decisions.enabled).toBe(true);
    expect(config.issues).toEqual([]);
  });
  it("fences only Decisions on its admission alias conflict", () => {
    const config = parseExtensionsConfig({ ...enabled, DECISIONS_ENABLED: "false" });
    expect(config.decisions.enabled).toBe(false);
    expect(config.contextual.enabled).toBe(true);
    expect(config.issues).toContainEqual({
      scope: "decisions",
      key: "EXTENSIONS_DECISIONS_ENABLED",
      reason: "conflicting-alias",
    });
  });
  it("fences both features on shared alias conflicts and never falls back from invalid canonical values", () => {
    for (const value of ["123", "garbage", "", "1e7", "9007199254740992"]) {
      const config = parseExtensionsConfig({
        ...enabled,
        DECISIONS_MONTHLY_INPUT_TOKENS: "999",
        EXTENSIONS_MONTHLY_INPUT_TOKENS: value,
      });
      expect(config.shared.valid).toBe(false);
      expect(config.decisions.enabled).toBe(false);
      expect(config.contextual.enabled).toBe(false);
      expect(config.issues.some((issue) => issue.scope === "shared")).toBe(true);
    }
  });
  it("keeps Contextual within six total attempts and validates billable exposure", () => {
    const config = parseExtensionsConfig({
      ...enabled,
      EXTENSIONS_CONTEXTUAL_MAX_ATTEMPTS_PER_RUN: "7",
    });
    expect(config.decisions.enabled).toBe(true);
    expect(config.contextual.enabled).toBe(false);
    const underfunded = parseExtensionsConfig({
      ...enabled,
      EXTENSIONS_CONTEXTUAL_ATTEMPT_HOLD_NANO_USD: "2687999",
    });
    expect(underfunded.contextual.enabled).toBe(false);
    expect(underfunded.decisions.enabled).toBe(true);
  });
  it("requires a hold covering the complete bounded contextual evaluation", () => {
    const exact = parseExtensionsConfig({
      ...enabled,
      EXTENSIONS_CONTEXTUAL_ATTEMPT_HOLD_NANO_USD: "2688000",
    });
    expect(exact.contextual.enabled).toBe(true);
    expect(exact.contextual.maxActualInputTokens).toBe(64000);
    expect(
      Math.ceil(exact.contextual.attemptHoldNanoUsd / exact.contextual.priceNanoUsdPerInputToken),
    ).toBeGreaterThanOrEqual(exact.contextual.maxActualInputTokens);
    const insufficient = parseExtensionsConfig({
      ...enabled,
      EXTENSIONS_CONTEXTUAL_ATTEMPT_HOLD_NANO_USD: "2687999",
    });
    expect(insufficient.contextual.enabled).toBe(false);
    expect(insufficient.decisions.enabled).toBe(true);
  });
  it("rejects timeout/unknown-hold and account/global exposure inversions for all features", () => {
    for (const invalid of [
      { EXTENSIONS_UNKNOWN_HOLD_SECONDS: "30" },
      { EXTENSIONS_GLOBAL_EXPOSURE_NANO_USD: "100" },
    ]) {
      const config = parseExtensionsConfig({ ...enabled, ...invalid });
      expect(config.shared.valid).toBe(false);
      expect(config.decisions.enabled || config.contextual.enabled).toBe(false);
    }
  });
  it("reports names and failure kinds without disclosing raw values", () => {
    const config = parseExtensionsConfig({
      ...enabled,
      EXTENSIONS_CONTEXTUAL_COHORT: "private-invalid-marker",
      IGNORED_PRIVATE_SETTING: "private-provider-marker",
    });
    expect(JSON.stringify(config.issues)).not.toContain("private-invalid-marker");
    expect(JSON.stringify(config)).not.toContain("private-provider-marker");
    expect(config.contextual.enabled).toBe(false);
  });
});
