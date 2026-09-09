import Stripe from "stripe";

export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;
export interface StripeClientConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly livemode: boolean;
  readonly allowedPriceIds: readonly string[];
  readonly expectedAccountId?: string;
  readonly automaticTax?: boolean;
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
  listInvoicePayments(invoiceId: string): Promise<Stripe.InvoicePayment[]>;
  retrieveCharge(id: string): Promise<Stripe.Charge>;
  listDisputes(chargeId: string): Promise<Stripe.Dispute[]>;
  hasSuccessfulCardSetup(customerId: string, paymentMethodId: string): Promise<boolean>;
  cancelSubscription(id: string, key: string): Promise<Stripe.Subscription>;
  verifyWebhook(rawBody: Uint8Array, signature: string): Promise<Stripe.Event>;
}

/** Fetch and SubtleCrypto providers work in Cloudflare Workers without Node HTTP/crypto. */
export function createStripeClient(
  config: StripeClientConfig,
  fetcher?: typeof fetch,
): StripeClient {
  const keyPattern = config.livemode ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/;
  if (!keyPattern.test(config.secretKey)) throw new Error("Stripe secret key mode mismatch");
  const stripe = new Stripe(config.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(fetcher),
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  let accountCheck: Promise<void> | undefined;
  const assertAccount = (): Promise<void> => {
    if (!config.expectedAccountId) return Promise.resolve();
    accountCheck ??= stripe.accounts
      .retrieve(null)
      .then((account) => {
        if (account.id !== config.expectedAccountId) throw new Error("Stripe account mismatch");
      })
      .catch((cause: unknown) => {
        accountCheck = undefined;
        throw cause;
      });
    return accountCheck;
  };
  const sandbox = <T extends { livemode: boolean }>(value: T): T => {
    if (value.livemode !== config.livemode) throw new Error("Stripe resource mode mismatch");
    return value;
  };
  const request = (key: string) => {
    if (!key || key.length > 255) throw new Error("A durable Stripe idempotency key is required");
    return { idempotencyKey: key };
  };
  return {
    async createCustomer(input, key) {
      await assertAccount();
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
      })) {
        if (subscriptions.length >= 100)
          throw new Error("Subscription history requires support review");
        subscriptions.push(sandbox(subscription));
      }
      return subscriptions;
    },
    async createCheckout(input, key) {
      await assertAccount();
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
            billing_address_collection: "required",
            customer_update: { address: "auto" },
            automatic_tax: { enabled: config.automaticTax ?? false },
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
      await assertAccount();
      return sandbox(await stripe.checkout.sessions.expire(id, {}, request(key)));
    },
    async createPortal(input, key) {
      await assertAccount();
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
      let checked = 0;
      for await (const raw of stripe.setupIntents.list({
        customer: customerId,
        payment_method: paymentMethodId,
        limit: 100,
      })) {
        if (++checked > 100) throw new Error("Card setup history requires support review");
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
      // Newest page only. Old history cannot permanently block a long-lived subscriber.
      // Reconciliation treats this as a conservative continuity horizon, not complete history.
      const invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 100 });
      return invoices.data.map(sandbox);
    },
    async listInvoicePayments(invoiceId) {
      const payments = await stripe.invoicePayments.list({
        invoice: invoiceId,
        status: "paid",
        limit: 10,
        expand: ["data.payment.payment_intent.latest_charge", "data.payment.charge"],
      });
      if (payments.has_more) throw new Error("Invoice payment history requires support review");
      return payments.data.map(sandbox);
    },
    async retrieveCharge(id) {
      return sandbox(await stripe.charges.retrieve(id));
    },
    async listDisputes(chargeId) {
      const disputes = await stripe.disputes.list({ charge: chargeId, limit: 10 });
      if (disputes.has_more) throw new Error("Dispute history requires support review");
      return disputes.data.map(sandbox);
    },
    async cancelSubscription(id, key) {
      await assertAccount();
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
