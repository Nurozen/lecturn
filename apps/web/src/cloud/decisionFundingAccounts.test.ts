import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@lecturn/contracts";
import { createDecisionFundingAccountsClient } from "./decisionFundingAccounts";

describe("payer-owned Decisions funding", () => {
  it("lists using the selected account token with bounded pagination and no host credential", async () => {
    const token = vi.fn(async () => "payer-jwt");
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ environments: [], nextCursor: null }),
    );
    const client = createDecisionFundingAccountsClient({
      relayUrl: "https://relay.test",
      token,
      fetch,
    });
    await client.list("payer-a", "last-host");
    expect(token).toHaveBeenCalledWith("payer-a");
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://relay.test/v1/decisions/funding/account-list?limit=25&cursor=last-host",
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer payer-jwt" },
      credentials: "omit",
    });
  });
  it("revoke uses the displayed generation and never sends a claimed payer", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 409 }));
    const client = createDecisionFundingAccountsClient({
      relayUrl: "https://relay.test",
      token: async () => "jwt",
      fetch,
    });
    await expect(
      client.revoke("payer-b", {
        environmentId: EnvironmentId.make("host"),
        expectedGeneration: 7,
      }),
    ).rejects.toThrow("Funding changed");
    expect(fetch.mock.calls[0]![1]?.body).toBe('{"environmentId":"host","expectedGeneration":7}');
  });
  it("cancels a stale account action while its token is resolving", async () => {
    const abort = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createDecisionFundingAccountsClient({
      relayUrl: "https://relay.test",
      token: async () => {
        abort.abort();
        return "old-account-token";
      },
      fetch,
    });
    await expect(
      client.revoke(
        "old-account",
        { environmentId: EnvironmentId.make("host"), expectedGeneration: 1 },
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
