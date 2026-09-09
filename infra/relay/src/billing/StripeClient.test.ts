import Stripe from "stripe";
import { describe, expect, it, vi } from "vite-plus/test";
import { createStripeClient, STRIPE_API_VERSION } from "./StripeClient.ts";
const config = {
  secretKey: "sk_test_example",
  webhookSecret: "whsec_example",
  livemode: false as const,
  allowedPriceIds: ["price_month"],
};
const checkout = {
  customerId: "cus_example",
  ownerId: "user_example",
  priceId: "price_month",
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
  trialEligible: true,
};
describe("Stripe sandbox adapter", () => {
  it("pins API and durable idempotency with a card-required trial", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "cs_test_example", livemode: false }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createStripeClient(config, fetcher);
    await client.createCheckout(checkout, "checkout-operation-1");
    const [, options] = fetcher.mock.calls[0]!;
    const headers = new Headers(options?.headers);
    expect(headers.get("Stripe-Version")).toBe(STRIPE_API_VERSION);
    expect(headers.get("Idempotency-Key")).toBe("checkout-operation-1");
    const body = new URLSearchParams(String(options?.body));
    expect(body.get("payment_method_collection")).toBe("always");
    expect(body.get("payment_method_types[0]")).toBe("card");
    expect(body.get("subscription_data[trial_period_days]")).toBe("14");
    expect(
      body.get("subscription_data[trial_settings][end_behavior][missing_payment_method]"),
    ).toBe("cancel");
    expect(body.get("metadata[clerk_user_id]")).toBe("user_example");
    await expect(
      client.createCheckout({ ...checkout, priceId: "price_attacker" }, "key"),
    ).rejects.toThrow(/not allowed/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("omits a second trial and rejects live API responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: "cs_test_example", livemode: true })));
    await expect(
      createStripeClient(config, fetcher).createCheckout(
        { ...checkout, trialEligible: false },
        "key",
      ),
    ).rejects.toThrow(/mode mismatch/);
    const body = new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.has("subscription_data[trial_period_days]")).toBe(false);
  });
  it("paginates subscriptions including canceled subscriptions", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "sub_1", livemode: false }],
            has_more: true,
            url: "/v1/subscriptions",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "sub_2", livemode: false }],
            has_more: false,
            url: "/v1/subscriptions",
          }),
        ),
      );
    expect(await createStripeClient(config, fetcher).listSubscriptions("cus_1")).toHaveLength(2);
    expect(String(fetcher.mock.calls[0]![0])).toContain("status=all");
    expect(String(fetcher.mock.calls[1]![0])).toContain("starting_after=sub_1");
  });
  it("verifies original raw bytes asynchronously and rejects mutations/mode/version/age", async () => {
    const client = createStripeClient(config);
    const stripe = new Stripe(config.secretKey);
    const payload = JSON.stringify({
      id: "evt_example",
      object: "event",
      api_version: STRIPE_API_VERSION,
      livemode: false,
      type: "customer.updated",
      data: { object: { id: "cus_example" } },
    });
    const sign = (body: string, timestamp?: number) =>
      stripe.webhooks.generateTestHeaderStringAsync({
        payload: body,
        secret: config.webhookSecret,
        ...(timestamp === undefined ? {} : { timestamp }),
        cryptoProvider: Stripe.createSubtleCryptoProvider(),
      });
    const signature = await sign(payload);
    const bytes = new TextEncoder().encode(payload);
    expect((await client.verifyWebhook(bytes, signature)).id).toBe("evt_example");
    // Verification is deterministic for retries; durable storage owns event-ID deduplication.
    expect((await client.verifyWebhook(bytes, signature)).id).toBe("evt_example");
    await expect(
      client.verifyWebhook(new TextEncoder().encode(payload + " "), signature),
    ).rejects.toThrow();
    for (const changed of [
      payload.replace('"livemode":false', '"livemode":true'),
      payload.replace(STRIPE_API_VERSION, "2026-07-29.dahlia"),
    ]) {
      await expect(
        client.verifyWebhook(new TextEncoder().encode(changed), await sign(changed)),
      ).rejects.toThrow(/mismatch/);
    }
    await expect(client.verifyWebhook(bytes, await sign(payload, 1))).rejects.toThrow(/Timestamp/);
  });
  it("requires successful setup for the same customer and card", async () => {
    const intents = [
      {
        id: "seti_pending",
        livemode: false,
        customer: "cus_test",
        payment_method: "pm_test",
        status: "requires_action",
        payment_method_types: ["card"],
      },
      {
        id: "seti_wrong",
        livemode: false,
        customer: "cus_other",
        payment_method: "pm_test",
        status: "succeeded",
        payment_method_types: ["card"],
      },
      {
        id: "seti_ok",
        livemode: false,
        customer: "cus_test",
        payment_method: "pm_test",
        status: "succeeded",
        payment_method_types: ["card"],
      },
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: intents,
            has_more: false,
            url: "/v1/setup_intents",
          }),
        ),
    );
    const client = createStripeClient(config, fetcher);
    expect(await client.hasSuccessfulCardSetup("cus_test", "pm_test")).toBe(true);
    expect(await client.hasSuccessfulCardSetup("cus_test", "pm_other")).toBe(false);
    const requested = String(fetcher.mock.calls[0]?.[0]);
    expect(requested).toContain("customer=cus_test");
    expect(requested).toContain("payment_method=pm_test");
  });
});
