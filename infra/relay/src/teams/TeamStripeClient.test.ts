import { describe, it, expect, vi } from "vite-plus/test";
import { createHmac } from "node:crypto";
import { Clock, Effect } from "effect";
import { createTeamStripeClient, InvalidTeamWebhookError } from "./TeamStripeClient.ts";
import { STRIPE_API_VERSION } from "../billing/StripeClient.ts";
const config = {
  secretKey: "sk_test_example",
  webhookSecret: "whsec_example",
  livemode: false,
  appOrigin: "https://example.com",
  monthlyPriceId: "price_month",
  annualPriceId: "price_year",
  portalConfigurationId: "portal",
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
describe("Team Stripe adapter", () => {
  const signedWebhook = (overrides: Record<string, unknown> = {}) => {
    const payload = JSON.stringify({
      id: "evt_team",
      type: "invoice.paid",
      livemode: false,
      api_version: STRIPE_API_VERSION,
      data: { object: { customer: "cus_team" } },
      ...overrides,
    });
    const timestamp = Math.floor(Effect.runSync(Clock.currentTimeMillis) / 1000);
    const digest = createHmac("sha256", config.webhookSecret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    return { raw: new TextEncoder().encode(payload), signature: `t=${timestamp},v1=${digest}` };
  };
  it("accepts an authentic webhook with the configured mode and API version", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { raw, signature } = signedWebhook();
    await expect(createTeamStripeClient(config, fetcher).webhook(raw, signature)).resolves.toEqual({
      id: "evt_team",
      customer: "cus_team",
      kind: "invoice.paid",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["tampered", "mode", "version"] as const)(
    "classifies a %s webhook as invalid before making Stripe API calls",
    async (scenario) => {
      const fetcher = vi.fn<typeof fetch>();
      const { raw, signature } = signedWebhook({
        ...(scenario === "mode" ? { livemode: true } : {}),
        ...(scenario === "version" ? { api_version: "2020-08-27" } : {}),
      });
      const bytes =
        scenario === "tampered"
          ? new TextEncoder().encode(new TextDecoder().decode(raw).replace("cus_team", "cus_other"))
          : raw;
      await expect(
        createTeamStripeClient(config, fetcher).webhook(bytes, signature),
      ).rejects.toBeInstanceOf(InvalidTeamWebhookError);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("keeps charge lookup failures retryable after authenticating a dispute webhook", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { type: "invalid_request_error", message: "Charge temporarily unavailable" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );
    const { raw, signature } = signedWebhook({
      type: "charge.dispute.created",
      data: { object: { charge: "ch_team" } },
    });
    const result = createTeamStripeClient(config, fetcher).webhook(raw, signature);
    await expect(result).rejects.toThrow("Charge temporarily unavailable");
    await expect(result).rejects.not.toBeInstanceOf(InvalidTeamWebhookError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("creates quantity-priced organization checkout without personal metadata or trial", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ id: "cs_test_example", livemode: false, url: "https://checkout.example.com" }),
      );
    await createTeamStripeClient(config, fetcher).checkout(
      "cus_team",
      "org_team",
      "month",
      7,
      "operation",
    );
    const body = new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.get("line_items[0][quantity]")).toBe("7");
    expect(body.get("metadata[clerk_organization_id]")).toBe("org_team");
    expect(body.has("metadata[clerk_user_id]")).toBe(false);
    expect(body.has("subscription_data[trial_period_days]")).toBe(false);
  });
  it("uses pending payment semantics and fixed proration date for increases", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          id: "sub_one",
          livemode: false,
          schedule: null,
          items: { data: [{ id: "si_one", price: { id: "price_month" } }] },
        }),
      )
      .mockResolvedValueOnce(response({ id: "sub_one", livemode: false }));
    await createTeamStripeClient(config, fetcher).increase("sub_one", 8, 123456, "change");
    const body = new URLSearchParams(String(fetcher.mock.calls[1]![1]?.body));
    expect(body.get("payment_behavior")).toBe("pending_if_incomplete");
    expect(body.get("proration_behavior")).toBe("always_invoice");
    expect(body.get("proration_date")).toBe("123456");
  });
  it("rejects a billing portal that allows unguarded seat changes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ features: { subscription_update: { enabled: true } } }));
    await expect(
      createTeamStripeClient(config, fetcher).portal("cus_one", "portal"),
    ).rejects.toThrow("disable subscription changes");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("releases a scheduled decrease without canceling the underlying subscription", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          id: "sub_one",
          livemode: false,
          schedule: "sub_sched_one",
          items: { data: [{ id: "si_one", price: { id: "price_month" } }] },
        }),
      )
      .mockResolvedValueOnce(
        response({ id: "sub_sched_one", livemode: false, status: "released" }),
      );
    await createTeamStripeClient(config, fetcher).cancelDecrease("sub_one", "release-one");
    expect(String(fetcher.mock.calls[1]![0])).toContain(
      "/subscription_schedules/sub_sched_one/release",
    );
    const body = new URLSearchParams(String(fetcher.mock.calls[1]![1]?.body));
    expect(body.get("preserve_cancel_date")).toBe("true");
  });
  it("retrying a released schedule performs no extra mutation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        id: "sub_one",
        livemode: false,
        schedule: null,
        items: { data: [{ id: "si_one", price: { id: "price_month" } }] },
      }),
    );
    await createTeamStripeClient(config, fetcher).cancelDecrease("sub_one", "release-one");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { label: "refunded", refunded: 7500, disputes: [] },
    { label: "disputed", refunded: 0, disputes: [{ status: "needs_response" }] },
  ])(
    "a $label original term charge suspends access after a later paid proration",
    async ({ refunded, disputes }) => {
      const invoice = (id: string, amount: number) => ({
        id,
        customer: "cus_one",
        currency: "usd",
        status: "paid",
        amount_paid: amount,
        livemode: false,
        lines: { has_more: false, data: [{ amount, period: { start: 100, end: 200 } }] },
      });
      const payment = (invoiceId: string, charge: string, amount: number) => ({
        data: [{ invoice: invoiceId, status: "paid", amount_paid: amount, payment: { charge } }],
        has_more: false,
      });
      const charge = (id: string, refunded: number) => ({
        id,
        customer: "cus_one",
        currency: "usd",
        paid: true,
        captured: true,
        amount_refunded: refunded,
        livemode: false,
      });
      const results = [
        { data: [{ id: "sub_one", status: "active" }], has_more: false },
        {
          id: "sub_one",
          status: "active",
          livemode: false,
          latest_invoice: "in_proration",
          schedule: null,
          items: {
            data: [
              {
                id: "si_one",
                quantity: 8,
                price: { id: "price_month" },
                current_period_start: 100,
                current_period_end: 200,
              },
            ],
          },
        },
        invoice("in_proration", 3000),
        { data: [invoice("in_original", 7500), invoice("in_proration", 3000)], has_more: false },
        payment("in_original", "ch_original", 7500),
        charge("ch_original", refunded),
        { data: disputes, has_more: false },
        payment("in_proration", "ch_proration", 3000),
        charge("ch_proration", 0),
        { data: [], has_more: false },
      ];
      const fetcher = vi.fn<typeof fetch>();
      for (const result of results) fetcher.mockResolvedValueOnce(response(result));
      const subscription = await createTeamStripeClient(config, fetcher).subscription("cus_one");
      expect(subscription?.suspended).toBe(true);
      expect(subscription?.paid).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(results.length);
    },
  );
});
