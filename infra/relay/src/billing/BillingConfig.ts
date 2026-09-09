/** Live resources and enforcement require independent, explicit rollout gates. */
export interface BillingConfig {
  readonly mode: "disabled" | "observe" | "enforce";
  readonly checkoutEnabled: boolean;
  readonly managedAccessEnabled?: boolean;
  readonly livemode: boolean;
  readonly suspensionEnabled?: boolean;
  readonly accountId?: string;
  readonly automaticTax?: boolean;
  readonly allowedCountries?: readonly string[];
  readonly countryPolicy?: "notice" | "enforced";
  readonly enforcementUsers?: readonly string[];
  readonly checkoutUsers?: readonly string[] | undefined;
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
  if (!["disabled", "observe", "enforce"].includes(mode))
    throw new Error("BILLING_MODE must be disabled, observe or enforce");
  const boolean = (name: string) => {
    if (env[name] !== undefined && !["true", "false"].includes(env[name]))
      throw new Error(`${name} must be true or false`);
    return env[name] === "true";
  };
  const livemode = boolean("STRIPE_LIVEMODE");
  const productionReady = boolean("BILLING_PRODUCTION_READY");
  const suspensionEnabled = boolean("BILLING_SUSPENSION_ENABLED");
  const automaticTax = boolean("BILLING_AUTOMATIC_TAX");
  const countriesVerified = boolean("BILLING_COUNTRY_RESTRICTION_VERIFIED");
  const countryPolicy = env.BILLING_COUNTRY_POLICY ?? "enforced";
  if (countryPolicy !== "notice" && countryPolicy !== "enforced")
    throw new Error("BILLING_COUNTRY_POLICY must be notice or enforced");
  const enforcementUsers = (env.BILLING_ENFORCEMENT_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (enforcementUsers.some((id) => id !== "*" && !/^user_[A-Za-z0-9]+$/.test(id)))
    throw new Error("BILLING_ENFORCEMENT_USERS requires explicit Clerk user IDs");
  const checkoutUsers =
    env.BILLING_CHECKOUT_USERS === undefined
      ? undefined
      : [
          ...new Set(
            env.BILLING_CHECKOUT_USERS.split(",")
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        ];
  if (checkoutUsers?.some((id) => id !== "*" && !/^user_[A-Za-z0-9]+$/.test(id)))
    throw new Error("BILLING_CHECKOUT_USERS requires explicit Clerk user IDs");
  const allowedCountries = (env.BILLING_ALLOWED_COUNTRIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedCountries.some((country) => !/^[A-Z]{2}$/.test(country)))
    throw new Error("BILLING_ALLOWED_COUNTRIES requires ISO country codes");
  if (suspensionEnabled && mode !== "enforce") throw new Error("Suspension requires enforce mode");
  if (mode === "enforce" && enforcementUsers.length === 0)
    throw new Error("Enforcement requires an explicit reviewed cohort");
  if (
    livemode &&
    (mode === "enforce" || env.BILLING_CHECKOUT_ENABLED === "true") &&
    !productionReady
  )
    throw new Error("Live Checkout and enforcement require BILLING_PRODUCTION_READY");
  if (
    env.BILLING_CHECKOUT_ENABLED !== undefined &&
    !["true", "false"].includes(env.BILLING_CHECKOUT_ENABLED)
  ) {
    throw new Error("BILLING_CHECKOUT_ENABLED must be true or false");
  }
  const checkoutEnabled = env.BILLING_CHECKOUT_ENABLED === "true";
  if (checkoutEnabled && mode === "disabled") throw new Error("Checkout requires enabled billing");
  if (
    env.BILLING_SANDBOX_MANAGED_ACCESS_ENABLED !== undefined &&
    !["true", "false"].includes(env.BILLING_SANDBOX_MANAGED_ACCESS_ENABLED)
  )
    throw new Error("BILLING_SANDBOX_MANAGED_ACCESS_ENABLED must be true or false");
  const sandboxManagedAccessEnabled = env.BILLING_SANDBOX_MANAGED_ACCESS_ENABLED === "true";
  const managedAccessEnabled = sandboxManagedAccessEnabled || mode === "enforce";
  if (sandboxManagedAccessEnabled && (mode !== "observe" || livemode))
    throw new Error("Managed access testing requires isolated sandbox observation mode");
  const secretKey = env.STRIPE_SECRET_KEY ?? "";
  if (secretKey && !(livemode ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/).test(secretKey))
    throw new Error("Stripe key mode mismatch; sandbox and live credentials cannot mix");
  const accountId = env.STRIPE_ACCOUNT_ID ?? "";
  if (livemode && !/^acct_[A-Za-z0-9]+$/.test(accountId))
    throw new Error("Live billing requires a pinned STRIPE_ACCOUNT_ID");
  if (
    livemode &&
    checkoutEnabled &&
    (!automaticTax ||
      allowedCountries.length === 0 ||
      (countryPolicy === "enforced" && !countriesVerified))
  )
    throw new Error("Live Checkout requires reviewed countries and automatic tax configuration");
  if (livemode && checkoutEnabled && !checkoutUsers?.length)
    throw new Error("Live Checkout requires a reviewed BILLING_CHECKOUT_USERS cohort");
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
    mode: mode as BillingConfig["mode"],
    checkoutEnabled,
    managedAccessEnabled,
    livemode,
    suspensionEnabled,
    accountId,
    automaticTax,
    allowedCountries,
    countryPolicy,
    enforcementUsers,
    checkoutUsers,
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
    monthlyPriceId: env.STRIPE_MONTHLY_PRICE_ID ?? "",
    annualPriceId: env.STRIPE_ANNUAL_PRICE_ID ?? "",
    portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID ?? "",
    appOrigin,
    renewalGraceSeconds,
  };
  if (mode !== "disabled" && (!secretKey || !config.webhookSecret))
    throw new Error("Enabled billing requires Stripe API and webhook secrets");
  if (
    checkoutEnabled &&
    (![config.monthlyPriceId, config.annualPriceId].every((id) => id.startsWith("price_")) ||
      !config.portalConfigurationId.startsWith("bpc_"))
  ) {
    throw new Error("Checkout requires configured monthly/annual prices and portal configuration");
  }
  return config;
}

/** Purchases have their own cohort; service-enforcement enrollment never authorizes charges. */
export function canStartBillingCheckout(config: BillingConfig, userId: string): boolean {
  if (config.mode === "disabled" || !config.checkoutEnabled) return false;
  if (config.checkoutUsers === undefined) return !config.livemode;
  return config.checkoutUsers.includes("*") || config.checkoutUsers.includes(userId);
}
