import Stripe from "stripe";
import { STRIPE_API_VERSION } from "../billing/StripeClient.ts";
export class InvalidTeamWebhookError extends Error {
  override readonly name = "InvalidTeamWebhookError";
}
export interface TeamBillingConfig {
  secretKey: string;
  webhookSecret: string;
  livemode: boolean;
  appOrigin: string;
  monthlyPriceId: string;
  annualPriceId: string;
  portalConfigurationId: string;
  minimumSeats?: number;
  maximumSeats?: number;
  automaticTax?: boolean;
  accountId?: string;
}
export interface TeamSubscription {
  id: string;
  quantity: number;
  interval: "month" | "year";
  periodStart: number;
  periodEnd: number;
  paid: boolean;
  suspended: boolean;
  pendingQuantity: number | null;
}
export interface TeamStripeClient {
  customer(org: string, key: string): Promise<string>;
  checkout(
    customer: string,
    org: string,
    interval: "month" | "year",
    quantity: number,
    key: string,
  ): Promise<{ id: string; url: string }>;
  checkoutStatus(
    session: string,
    customer: string,
    org: string,
  ): Promise<"open" | "complete" | "expired">;
  expireCheckout(session: string, key: string): Promise<void>;
  subscription(customer: string): Promise<TeamSubscription | null>;
  preview(
    subscription: string,
    quantity: number,
    date: number,
  ): Promise<{ amountDue: number; currency: string }>;
  increase(subscription: string, quantity: number, date: number, key: string): Promise<void>;
  decrease(subscription: string, quantity: number, key: string): Promise<void>;
  cancelDecrease(subscription: string, key: string): Promise<void>;
  cancelSubscription(subscription: string, key: string): Promise<void>;
  portal(customer: string, key: string): Promise<{ url: string }>;
  webhook(
    raw: Uint8Array,
    signature: string,
  ): Promise<{ id: string; customer: string | null; kind: string }>;
}
const id = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;
export function createTeamStripeClient(
  config: TeamBillingConfig,
  fetcher?: typeof fetch,
): TeamStripeClient {
  if (!(config.livemode ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/).test(config.secretKey))
    throw new Error("Stripe key mode mismatch");
  const stripe = new Stripe(config.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(fetcher),
    timeout: 20000,
    maxNetworkRetries: 2,
  });
  const scope = <T extends { livemode: boolean }>(value: T): T => {
    if (value.livemode !== config.livemode) throw new Error("Stripe mode mismatch");
    return value;
  };
  const check = async () => {
    if (config.accountId && (await stripe.accounts.retrieve(null)).id !== config.accountId)
      throw new Error("Stripe account mismatch");
  };
  const sub = async (subscription: string) => {
    const value = scope(await stripe.subscriptions.retrieve(subscription));
    if (
      value.items.data.length !== 1 ||
      ![config.monthlyPriceId, config.annualPriceId].includes(value.items.data[0]!.price.id)
    )
      throw new Error("Unexpected team subscription");
    return value;
  };
  return {
    async customer(org, key) {
      await check();
      return scope(
        await stripe.customers.create(
          { metadata: { clerk_organization_id: org } },
          { idempotencyKey: key },
        ),
      ).id;
    },
    async checkout(customer, org, interval, quantity, key) {
      await check();
      const session = scope(
        await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer,
            client_reference_id: org,
            metadata: { clerk_organization_id: org },
            subscription_data: { metadata: { clerk_organization_id: org } },
            line_items: [
              {
                price: interval === "month" ? config.monthlyPriceId : config.annualPriceId,
                quantity,
              },
            ],
            payment_method_types: ["card"],
            billing_address_collection: "required",
            customer_update: { address: "auto" },
            automatic_tax: { enabled: config.automaticTax ?? false },
            success_url: `${config.appOrigin}/account/billing?tab=teams&checkout=complete`,
            cancel_url: `${config.appOrigin}/account/billing?tab=teams`,
          },
          { idempotencyKey: key },
        ),
      );
      if (!session.url) throw new Error("Missing checkout URL");
      return { id: session.id, url: session.url };
    },
    async checkoutStatus(session, customer, org) {
      const checkout = scope(await stripe.checkout.sessions.retrieve(session));
      if (
        id(checkout.customer) !== customer ||
        checkout.client_reference_id !== org ||
        !checkout.status
      )
        throw new Error("Checkout ownership mismatch");
      if (checkout.status === "open") return "open";
      if (checkout.status === "complete") return "complete";
      if (checkout.status === "expired") return "expired";
      throw new Error("Unknown checkout status");
    },
    async expireCheckout(session, key) {
      await check();
      scope(await stripe.checkout.sessions.expire(session, {}, { idempotencyKey: key }));
    },
    async subscription(customer) {
      const list = await stripe.subscriptions.list({ customer, status: "all", limit: 100 });
      if (list.has_more) throw new Error("Subscription history requires review");
      const active = list.data.filter(
        (s) => !["canceled", "incomplete_expired"].includes(s.status),
      );
      if (active.length > 1) throw new Error("Multiple team subscriptions require review");
      if (!active[0]) return null;
      const s = await sub(active[0].id);
      const item = s.items.data[0]!;
      const invoiceId = id(s.latest_invoice);
      let paid = false;
      let suspended = false;
      if (invoiceId) {
        const latest = scope(await stripe.invoices.retrieve(invoiceId));
        paid =
          id(latest.customer) === customer &&
          latest.status === "paid" &&
          latest.amount_paid > 0 &&
          s.status === "active";
        const invoices = await stripe.invoices.list({
          subscription: s.id,
          status: "paid",
          limit: 100,
        });
        if (invoices.has_more) throw new Error("Active term invoice history requires review");
        const backing = new Map(invoices.data.map((invoice) => [invoice.id, scope(invoice)]));
        if (latest.status === "paid") backing.set(latest.id, latest);
        let latestPaymentVerified = false;
        for (const invoice of backing.values()) {
          if (invoice.lines.has_more) throw new Error("Active term invoice lines require review");
          const coversTerm = invoice.lines.data.some(
            (line) =>
              line.period.end > item.current_period_start &&
              line.period.start < item.current_period_end &&
              line.amount > 0,
          );
          if (!coversTerm && invoice.id !== invoiceId) continue;
          if (id(invoice.customer) !== customer) throw new Error("Invoice ownership mismatch");
          const payments = await stripe.invoicePayments.list({
            invoice: invoice.id,
            status: "paid",
            limit: 100,
            expand: ["data.payment.payment_intent.latest_charge", "data.payment.charge"],
          });
          if (payments.has_more || !payments.data.length) {
            paid = false;
            continue;
          }
          let verified = 0;
          for (const payment of payments.data) {
            const intent = payment.payment.payment_intent;
            const chargeId = id(
              payment.payment.charge ?? (typeof intent === "object" ? intent.latest_charge : null),
            );
            if (!chargeId) {
              paid = false;
              continue;
            }
            const charge = scope(await stripe.charges.retrieve(chargeId));
            if (
              id(charge.customer) !== customer ||
              id(payment.invoice) !== invoice.id ||
              charge.currency !== invoice.currency ||
              payment.status !== "paid" ||
              !charge.paid ||
              !charge.captured
            )
              throw new Error("Payment ownership or settlement mismatch");
            if (payment.amount_paid === null) throw new Error("Payment amount missing");
            verified += payment.amount_paid;
            const disputes = await stripe.disputes.list({ charge: charge.id, limit: 100 });
            suspended ||=
              charge.amount_refunded > 0 ||
              disputes.has_more ||
              disputes.data.some((dispute) => dispute.status !== "won");
          }
          if (verified < invoice.amount_paid) paid = false;
          if (invoice.id === invoiceId && verified >= invoice.amount_paid)
            latestPaymentVerified = true;
        }
        paid &&= latestPaymentVerified;
      }
      let pendingQuantity: number | null = null;
      if (s.schedule) {
        const schedule = scope(await stripe.subscriptionSchedules.retrieve(id(s.schedule)!));
        const next = schedule.phases.find((phase) => phase.start_date >= item.current_period_end);
        if (next) {
          if (next.items.length !== 1 || id(next.items[0]!.price) !== item.price.id)
            throw new Error("Unexpected scheduled team plan");
          pendingQuantity = next.items[0]!.quantity ?? null;
        }
      }
      return {
        id: s.id,
        quantity: item.quantity ?? 0,
        interval: item.price.id === config.monthlyPriceId ? "month" : "year",
        periodStart: item.current_period_start,
        periodEnd: item.current_period_end,
        paid: paid && !suspended,
        suspended,
        pendingQuantity,
      };
    },
    async preview(subscription, quantity, date) {
      const s = await sub(subscription);
      const invoice = await stripe.invoices.createPreview({
        subscription,
        subscription_details: {
          items: [{ id: s.items.data[0]!.id, quantity }],
          proration_date: date,
          proration_behavior: "always_invoice",
        },
      });
      return { amountDue: invoice.amount_due, currency: invoice.currency };
    },
    async increase(subscription, quantity, date, key) {
      await check();
      const s = await sub(subscription);
      if (s.schedule) throw new Error("Cancel scheduled change before increasing seats");
      await stripe.subscriptions.update(
        subscription,
        {
          items: [{ id: s.items.data[0]!.id, quantity }],
          proration_date: date,
          proration_behavior: "always_invoice",
          payment_behavior: "pending_if_incomplete",
        },
        { idempotencyKey: key },
      );
    },
    async decrease(subscription, quantity, key) {
      await check();
      const s = await sub(subscription);
      const item = s.items.data[0]!;
      const schedule = s.schedule
        ? await stripe.subscriptionSchedules.retrieve(id(s.schedule)!)
        : await stripe.subscriptionSchedules.create(
            { from_subscription: subscription },
            { idempotencyKey: `${key}:create` },
          );
      await stripe.subscriptionSchedules.update(
        schedule.id,
        {
          end_behavior: "release",
          proration_behavior: "none",
          phases: [
            {
              start_date: schedule.current_phase?.start_date ?? item.current_period_start,
              end_date: item.current_period_end,
              items: [{ price: item.price.id, quantity: item.quantity ?? 1 }],
            },
            {
              start_date: item.current_period_end,
              duration: {
                interval: item.price.id === config.monthlyPriceId ? "month" : "year",
                interval_count: 1,
              },
              items: [{ price: item.price.id, quantity }],
              proration_behavior: "none",
            },
          ],
        },
        { idempotencyKey: key },
      );
    },
    async cancelDecrease(subscription, key) {
      await check();
      const s = await sub(subscription);
      if (s.schedule)
        await stripe.subscriptionSchedules.release(
          id(s.schedule)!,
          { preserve_cancel_date: true },
          { idempotencyKey: key },
        );
    },
    async cancelSubscription(subscription, key) {
      await check();
      await stripe.subscriptions.cancel(
        subscription,
        { invoice_now: false, prorate: false },
        { idempotencyKey: key },
      );
    },
    async portal(customer, key) {
      await check();
      const configuration = await stripe.billingPortal.configurations.retrieve(
        config.portalConfigurationId,
      );
      if (configuration.features.subscription_update.enabled)
        throw new Error("Team portal must disable subscription changes");
      return scope(
        await stripe.billingPortal.sessions.create(
          {
            customer,
            configuration: config.portalConfigurationId,
            return_url: `${config.appOrigin}/account/billing?tab=teams`,
          },
          { idempotencyKey: key },
        ),
      );
    },
    async webhook(raw, signature) {
      let event: Stripe.Event;
      try {
        event = scope(
          await stripe.webhooks.constructEventAsync(
            raw,
            signature,
            config.webhookSecret,
            300,
            Stripe.createSubtleCryptoProvider(),
          ),
        );
        if (event.api_version !== STRIPE_API_VERSION) throw new Error("Webhook version mismatch");
      } catch (cause) {
        throw new InvalidTeamWebhookError("Invalid Teams webhook", { cause });
      }
      const object = event.data.object as {
        customer?: string | { id: string };
        charge?: string | { id: string };
      };
      let customer = id(object.customer) ?? null;
      if (!customer && object.charge)
        customer = id((await stripe.charges.retrieve(id(object.charge)!)).customer) ?? null;
      return { id: event.id, customer, kind: event.type };
    },
  };
}
