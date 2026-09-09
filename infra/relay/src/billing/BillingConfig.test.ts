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

const live = {
  BILLING_MODE: "observe",
  STRIPE_LIVEMODE: "true",
  STRIPE_ACCOUNT_ID: "acct_owner",
  STRIPE_SECRET_KEY: "sk_live_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_MONTHLY_PRICE_ID: "price_month",
  STRIPE_ANNUAL_PRICE_ID: "price_year",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_example",
};
it("allows isolated live observation without enabling purchases or access restrictions", () => {
  expect(parseBillingConfig(live)).toMatchObject({
    livemode: true,
    checkoutEnabled: false,
    managedAccessEnabled: false,
  });
  expect(() => parseBillingConfig({ ...live, STRIPE_SECRET_KEY: "sk_test_example" })).toThrow(
    /mode mismatch/,
  );
  expect(() => parseBillingConfig({ ...live, STRIPE_ACCOUNT_ID: "" })).toThrow(/pinned/);
});
it("requires production, country and tax readiness before live checkout", () => {
  const checkout = { ...live, BILLING_CHECKOUT_ENABLED: "true" };
  expect(() => parseBillingConfig(checkout)).toThrow(/PRODUCTION_READY/);
  expect(() => parseBillingConfig({ ...checkout, BILLING_PRODUCTION_READY: "true" })).toThrow(
    /countries/,
  );
  expect(
    parseBillingConfig({
      ...checkout,
      BILLING_PRODUCTION_READY: "true",
      BILLING_ALLOWED_COUNTRIES: "US",
      BILLING_AUTOMATIC_TAX: "true",
      BILLING_COUNTRY_RESTRICTION_VERIFIED: "true",
    }).checkoutEnabled,
  ).toBe(true);
});
it("requires an explicit cohort and an independent suspension opt-in", () => {
  const enforce = { ...live, BILLING_MODE: "enforce", BILLING_PRODUCTION_READY: "true" };
  expect(() => parseBillingConfig(enforce)).toThrow(/cohort/);
  expect(parseBillingConfig({ ...enforce, BILLING_ENFORCEMENT_USERS: "user_owner" })).toMatchObject(
    { managedAccessEnabled: true, suspensionEnabled: false },
  );
  expect(
    parseBillingConfig({
      ...enforce,
      BILLING_ENFORCEMENT_USERS: "*",
      BILLING_SUSPENSION_ENABLED: "true",
    }).suspensionEnabled,
  ).toBe(true);
  expect(() => parseBillingConfig({ ...live, BILLING_SUSPENSION_ENABLED: "true" })).toThrow(
    /enforce/,
  );
});

it("allows an explicit sales notice policy without claiming a verified country block", () => {
  const checkout = {
    ...live,
    BILLING_CHECKOUT_ENABLED: "true",
    BILLING_PRODUCTION_READY: "true",
    BILLING_ALLOWED_COUNTRIES: "US",
    BILLING_AUTOMATIC_TAX: "true",
    BILLING_COUNTRY_POLICY: "notice",
    BILLING_COUNTRY_RESTRICTION_VERIFIED: "false",
  };
  expect(parseBillingConfig(checkout)).toMatchObject({
    checkoutEnabled: true,
    countryPolicy: "notice",
  });
  expect(() => parseBillingConfig({ ...checkout, BILLING_COUNTRY_POLICY: "enforced" })).toThrow(
    /countries/,
  );
  expect(() => parseBillingConfig({ ...checkout, BILLING_COUNTRY_POLICY: "unknown" })).toThrow(
    /COUNTRY_POLICY/,
  );
});
