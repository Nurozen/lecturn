import Stripe from "stripe";

export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;
export interface StripeClientConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly livemode: false;
  readonly allowedPriceIds: readonly string[];
}
export interface CheckoutInput {
  readonly customerId: string;
  readonly ownerId: string;
  readonly priceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly trialEligible: boolean;
}
export interface StripeClient {
  createCustomer(input: { ownerId: string; email?: string }, key: string): Promise<Stripe.Customer>;
  retrieveCustomer(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer>;
  listSubscriptions(customerId: string): Promise<Stripe.Subscription[]>;
  createCheckout(input: CheckoutInput, key: string): Promise<Stripe.Checkout.Session>;
  retrieveCheckout(id: string): Promise<Stripe.Checkout.Session>;
  expireCheckout(id: string, key: string): Promise<Stripe.Checkout.Session>;
  createPortal(
    input: { customerId: string; returnUrl: string; configurationId: string },
    key: string,
  ): Promise<Stripe.BillingPortal.Session>;
  retrieveSubscription(id: string): Promise<Stripe.Subscription>;
  listInvoices(subscriptionId: string): Promise<Stripe.Invoice[]>;
  hasSuccessfulCardSetup(customerId: string, paymentMethodId: string): Promise<boolean>;
  cancelSubscription(id: string, key: string): Promise<Stripe.Subscription>;
  verifyWebhook(rawBody: Uint8Array, signature: string): Promise<Stripe.Event>;
}

/** Fetch and SubtleCrypto providers work in Cloudflare Workers without Node HTTP/crypto. */
export function createStripeClient(
  config: StripeClientConfig,
  fetcher?: typeof fetch,
): StripeClient {
  if (config.livemode !== false || !/^(sk|rk)_test_/.test(config.secretKey))
    throw new Error("Only Stripe sandbox billing is supported");
  const stripe = new Stripe(config.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(fetcher),
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  const sandbox = <T extends { livemode: boolean }>(value: T): T => {
    if (value.livemode !== false) throw new Error("Stripe resource mode mismatch");
    return value;
  };
  const request = (key: string) => {
    if (!key || key.length > 255) throw new Error("A durable Stripe idempotency key is required");
    return { idempotencyKey: key };
  };
  return {
    async createCustomer(input, key) {
      return sandbox(
        await stripe.customers.create(
          {
            ...(input.email ? { email: input.email } : {}),
            metadata: { clerk_user_id: input.ownerId },
          },
          request(key),
        ),
      );
    },
    async retrieveCustomer(id) {
      const customer = await stripe.customers.retrieve(id, {
        expand: ["invoice_settings.default_payment_method"],
      });
      return customer.deleted ? customer : sandbox(customer);
    },
    async listSubscriptions(customerId) {
      const subscriptions: Stripe.Subscription[] = [];
      for await (const subscription of stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
      }))
        subscriptions.push(sandbox(subscription));
      return subscriptions;
    },
    async createCheckout(input, key) {
      if (!config.allowedPriceIds.includes(input.priceId))
        throw new Error("Stripe price is not allowed");
      return sandbox(
        await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer: input.customerId,
            client_reference_id: input.ownerId,
            metadata: { clerk_user_id: input.ownerId },
            line_items: [{ price: input.priceId, quantity: 1 }],
            payment_method_types: ["card"],
            payment_method_collection: "always",
            subscription_data: {
              metadata: { clerk_user_id: input.ownerId },
              ...(input.trialEligible
                ? {
                    trial_period_days: 14,
                    trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } },
                  }
                : {}),
            },
            success_url: input.successUrl,
            cancel_url: input.cancelUrl,
          },
          request(key),
        ),
      );
    },
    async retrieveCheckout(id) {
      return sandbox(await stripe.checkout.sessions.retrieve(id));
    },
    async expireCheckout(id, key) {
      return sandbox(await stripe.checkout.sessions.expire(id, {}, request(key)));
    },
    async createPortal(input, key) {
      return sandbox(
        await stripe.billingPortal.sessions.create(
          {
            customer: input.customerId,
            return_url: input.returnUrl,
            configuration: input.configurationId,
          },
          request(key),
        ),
      );
    },
    async retrieveSubscription(id) {
      return sandbox(
        await stripe.subscriptions.retrieve(id, {
          expand: ["default_payment_method", "pending_setup_intent"],
        }),
      );
    },
    async hasSuccessfulCardSetup(customerId, paymentMethodId) {
      for await (const raw of stripe.setupIntents.list({
        customer: customerId,
        payment_method: paymentMethodId,
        limit: 100,
      })) {
        const intent = sandbox(raw);
        const customer =
          typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
        const method =
          typeof intent.payment_method === "string"
            ? intent.payment_method
            : intent.payment_method?.id;
        if (
          intent.status === "succeeded" &&
          customer === customerId &&
          method === paymentMethodId &&
          intent.payment_method_types.includes("card")
        )
          return true;
      }
      return false;
    },
    async listInvoices(subscriptionId) {
      const invoices: Stripe.Invoice[] = [];
      for await (const invoice of stripe.invoices.list({
        subscription: subscriptionId,
        limit: 100,
      }))
        invoices.push(sandbox(invoice));
      return invoices;
    },
    async cancelSubscription(id, key) {
      return sandbox(
        await stripe.subscriptions.cancel(id, { invoice_now: false, prorate: false }, request(key)),
      );
    },
    async verifyWebhook(rawBody, signature) {
      // Verification must happen before JSON parsing. Replayed valid events are deduplicated by the durable inbox.
      const event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        config.webhookSecret,
        300,
        Stripe.createSubtleCryptoProvider(),
      );
      sandbox(event);
      if (event.api_version !== STRIPE_API_VERSION)
        throw new Error("Stripe event API version mismatch");
      return event;
    },
  };
}
