/** Billing is deliberately observation-only until the rollout safety gates pass. */
export interface BillingConfig {
  readonly mode: "disabled" | "observe";
  readonly checkoutEnabled: boolean;
  readonly managedAccessEnabled?: boolean;
  readonly livemode: false;
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly monthlyPriceId: string;
  readonly annualPriceId: string;
  readonly portalConfigurationId: string;
  readonly appOrigin: string;
  readonly renewalGraceSeconds: number;
}

export function parseBillingConfig(
  env: Readonly<Record<string, string | undefined>>,
): BillingConfig {
  const mode = env.BILLING_MODE ?? "disabled";
  if (mode !== "disabled" && mode !== "observe")
    throw new Error("BILLING_MODE must be disabled or observe");
  if (
    env.BILLING_CHECKOUT_ENABLED !== undefined &&
    !["true", "false"].includes(env.BILLING_CHECKOUT_ENABLED)
  ) {
    throw new Error("BILLING_CHECKOUT_ENABLED must be true or false");
  }
  const checkoutEnabled = env.BILLING_CHECKOUT_ENABLED === "true";
  if (checkoutEnabled && mode !== "observe") throw new Error("Checkout requires observe mode");
  if (
    env.BILLING_SANDBOX_MANAGED_ACCESS_ENABLED !== undefined &&
    !["true", "false"].includes(env.BILLING_SANDBOX_MANAGED_ACCESS_ENABLED)
  )
    throw new Error("BILLING_SANDBOX_MANAGED_ACCESS_ENABLED must be true or false");
  const managedAccessEnabled = env.BILLING_SANDBOX_MANAGED_ACCESS_ENABLED === "true";
  if (managedAccessEnabled && mode !== "observe")
    throw new Error("Managed access testing requires isolated sandbox observation mode");
  const secretKey = env.STRIPE_SECRET_KEY ?? "";
  if (secretKey && !/^(sk|rk)_test_/.test(secretKey))
    throw new Error("This billing rollout supports Stripe sandbox keys only");
  const renewalGraceSeconds = Number(env.BILLING_RENEWAL_GRACE_SECONDS ?? "0");
  if (
    !Number.isSafeInteger(renewalGraceSeconds) ||
    renewalGraceSeconds < 0 ||
    renewalGraceSeconds > 604800
  ) {
    throw new Error("BILLING_RENEWAL_GRACE_SECONDS must be an integer between 0 and 604800");
  }
  const appOrigin = env.BILLING_APP_ORIGIN ?? "https://lecturn.cloudgatherer.net";
  const url = new URL(appOrigin);
  if (url.protocol !== "https:" || url.origin !== appOrigin || url.username || url.password)
    throw new Error("BILLING_APP_ORIGIN must be an HTTPS origin");
  const config: BillingConfig = {
    mode,
    checkoutEnabled,
    managedAccessEnabled,
    livemode: false,
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
    monthlyPriceId: env.STRIPE_MONTHLY_PRICE_ID ?? "",
    annualPriceId: env.STRIPE_ANNUAL_PRICE_ID ?? "",
    portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID ?? "",
    appOrigin,
    renewalGraceSeconds,
  };
  if (mode === "observe" && (!secretKey || !config.webhookSecret))
    throw new Error("Observe mode requires Stripe API and webhook secrets");
  if (
    checkoutEnabled &&
    (![config.monthlyPriceId, config.annualPriceId].every((id) => id.startsWith("price_")) ||
      !config.portalConfigurationId.startsWith("bpc_"))
  ) {
    throw new Error("Checkout requires configured monthly/annual prices and portal configuration");
  }
  return config;
}
