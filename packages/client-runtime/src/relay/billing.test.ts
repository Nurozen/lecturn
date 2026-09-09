import { describe, expect, it, vi } from "vite-plus/test";
import { BillingRequestError, createBillingClient } from "./billing.ts";

const status = {
  state: "disabled",
  checkoutEnabled: false,
  portalEnabled: false,
  trialEligible: false,
  cancelAt: null,
  interval: null,
  currentPeriodEnd: null,
  trialEnd: null,
  cancelAtPeriodEnd: false,
  hasAccess: false,
  features: { managedConnect: false, pushNotifications: false, liveActivities: false },
  quota: { limit: 3, used: 0 },
};
function setup(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  const client = createBillingClient({
    relayUrl: "https://relay.example.test",
    getToken: async () => "account-token",
    fetch,
  });
  return { client, fetch };
}
describe("account billing client", () => {
  it("uses account bearer auth without environment credentials", async () => {
    const { client, fetch } = setup(Response.json(status));
    expect(await client.getStatus()).toEqual(status);
    expect(fetch).toHaveBeenCalledWith(
      "https://relay.example.test/v1/billing/status",
      expect.objectContaining({
        headers: { Authorization: "Bearer account-token" },
        cache: "no-store",
        redirect: "error",
      }),
    );
  });
  it.each([404, 500, 503])("does not turn HTTP %s into a free subscription", async (code) => {
    const { client } = setup(new Response(null, { status: code }));
    await expect(client.getStatus()).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("rejects an unknown response schema", async () => {
    await expect(setup(Response.json({ state: "free" })).client.getStatus()).rejects.toMatchObject({
      reason: "unavailable",
    });
  });
  it("requires sign in before issuing requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createBillingClient({
      relayUrl: "https://relay.example.test",
      getToken: async () => null,
      fetch,
    });
    await expect(client.getStatus()).rejects.toBeInstanceOf(BillingRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sends only the chosen interval to checkout", async () => {
    const { client, fetch } = setup(
      Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_example" }),
    );
    await client.checkout("year");
    expect(fetch).toHaveBeenCalledWith(
      "https://relay.example.test/v1/billing/checkout",
      expect.objectContaining({ method: "POST", body: '{"interval":"year"}' }),
    );
  });
  it.each([
    "https://evil.example/",
    "https://checkout.stripe.com.evil.example/",
    "javascript:alert(1)",
    "https://user@checkout.stripe.com/",
  ])("rejects unsafe redirect %s", async (url) => {
    await expect(setup(Response.json({ url })).client.checkout("month")).rejects.toMatchObject({
      reason: "unavailable",
    });
  });
  it("reconciles a return without trusting URL payment status", async () => {
    const { client, fetch } = setup(Response.json(status));
    expect(await client.reconcile("cs_test_return")).toEqual(status);
    expect(fetch).toHaveBeenCalledWith(
      "https://relay.example.test/v1/billing/checkout/reconcile",
      expect.objectContaining({ body: '{"sessionId":"cs_test_return"}' }),
    );
  });
  it("rejects insecure relay config before transmitting account token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createBillingClient({
      relayUrl: "http://relay.example.test",
      getToken: async () => "token",
      fetch,
    });
    await expect(client.getStatus()).rejects.toMatchObject({ reason: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
