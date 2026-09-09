import { expect, it } from "vite-plus/test";
import { parseBillingConfig } from "./BillingConfig.ts";
it("defaults to no checkout, no enforcement, no grace", () => {
  expect(parseBillingConfig({})).toMatchObject({
    mode: "disabled",
    checkoutEnabled: false,
    livemode: false,
    renewalGraceSeconds: 0,
  });
});
it("rejects live credentials and enforcement modes", () => {
  expect(() => parseBillingConfig({ STRIPE_SECRET_KEY: "sk_live_example" })).toThrow(/sandbox/);
  expect(() => parseBillingConfig({ BILLING_MODE: "enforce" })).toThrow();
  expect(() => parseBillingConfig({ BILLING_CHECKOUT_ENABLED: "true" })).toThrow();
});
it("requires complete sandbox settings before enabling checkout", () => {
  const env = {
    BILLING_MODE: "observe",
    BILLING_CHECKOUT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example",
    STRIPE_MONTHLY_PRICE_ID: "price_month",
    STRIPE_ANNUAL_PRICE_ID: "price_year",
    STRIPE_PORTAL_CONFIGURATION_ID: "bpc_example",
  };
  expect(parseBillingConfig(env).checkoutEnabled).toBe(true);
  expect(() => parseBillingConfig({ ...env, STRIPE_ANNUAL_PRICE_ID: "" })).toThrow();
  expect(() =>
    parseBillingConfig({ ...env, BILLING_APP_ORIGIN: "https://example.com/path" }),
  ).toThrow();
});
it("restricts managed admission checks to an explicit sandbox opt-in", () => {
  expect(parseBillingConfig({}).managedAccessEnabled).toBe(false);
  expect(() => parseBillingConfig({ BILLING_SANDBOX_MANAGED_ACCESS_ENABLED: "true" })).toThrow();
  expect(() => parseBillingConfig({ BILLING_SANDBOX_MANAGED_ACCESS_ENABLED: "yes" })).toThrow();
  expect(
    parseBillingConfig({
      BILLING_MODE: "observe",
      STRIPE_SECRET_KEY: "sk_test_example",
      STRIPE_WEBHOOK_SECRET: "whsec_example",
      BILLING_SANDBOX_MANAGED_ACCESS_ENABLED: "true",
    }).managedAccessEnabled,
  ).toBe(true);
});
