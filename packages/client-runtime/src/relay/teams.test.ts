import { describe, expect, it, vi } from "vite-plus/test";
import { createTeamsClient, selectTeam, selectedTeam } from "./teams";

function fixture(body: unknown, status = 200) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  return {
    fetch,
    client: createTeamsClient({
      relayUrl: "https://relay.example.com",
      getToken: async () => "token",
      fetch,
    }),
  };
}
describe("Teams client", () => {
  it("does not send unauthenticated requests", async () => {
    const fetch = vi.fn();
    await expect(
      createTeamsClient({
        relayUrl: "https://relay.example.com",
        getToken: async () => null,
        fetch,
      }).list(),
    ).rejects.toThrow("Sign in");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("encodes organization IDs and makes seat assignment explicit without buying seats", async () => {
    const { client, fetch } = fixture({});
    await client.seat("org/a", "user_one", true);
    expect(fetch).toHaveBeenCalledWith(
      "https://relay.example.com/v1/teams/org%2Fa/seat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ userId: "user_one", assigned: true }),
      }),
    );
  });
  it("rejects unexpected billing redirect origins", async () => {
    await expect(
      fixture({ url: "https://checkout.stripe.com.attacker.example/pay" }).client.checkout(
        "org",
        "month",
        5,
      ),
    ).rejects.toThrow("Invalid billing");
    await expect(
      fixture({ url: "https://user:pass@checkout.stripe.com/pay" }).client.checkout(
        "org",
        "month",
        5,
      ),
    ).rejects.toThrow("Invalid billing");
  });
  it("accepts Stripe Checkout and portal destinations for their respective actions", async () => {
    await expect(
      fixture({ url: "https://checkout.stripe.com/pay/test" }).client.checkout("org", "month", 5),
    ).resolves.toContain("checkout.stripe.com");
    await expect(
      fixture({ url: "https://billing.stripe.com/p/session/test" }).client.portal("org"),
    ).resolves.toContain("billing.stripe.com");
  });
  it("fails closed on malformed organization access data", async () => {
    await expect(
      fixture({ organizations: [{ organizationId: "org", hasAccess: "true" }] }).client.list(),
    ).rejects.toThrow();
  });
  it("preserves conflicts as retryable team changes", async () => {
    await expect(fixture({}, 409).client.seat("org", "user", true)).rejects.toThrow(
      "changed while",
    );
  });
  it("never carries a funding selection across user identities", () => {
    selectTeam("alice", "company");
    expect(selectedTeam("bob")).toBe(null);
    expect(selectedTeam(null)).toBe(null);
    expect(selectedTeam("alice")).toBe("company");
    selectTeam("alice", null);
    expect(selectedTeam("alice")).toBe(null);
  });
});
