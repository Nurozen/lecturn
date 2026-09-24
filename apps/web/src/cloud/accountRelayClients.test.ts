import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createAccountBillingClient, createAccountTeamsClient } from "./accountRelayClients";
import { bindAccountTokenClerk } from "./accountTokens";

vi.mock("./publicConfig", () => ({
  resolveRelayClerkTokenOptions: () => ({ template: "relay" }),
  resolveCloudPublicConfig: () => ({ relayUrl: "https://relay.example.com" }),
}));

function jwt(sub: string) {
  return `header.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`;
}

const session = (accountId: string) => ({
  id: `session-${accountId}`,
  user: { id: accountId },
  getToken: vi.fn(async () => jwt(accountId)),
});

function authorizations(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(
    ([, init]) => (init as { headers: Record<string, string> }).headers.Authorization,
  );
}

afterEach(() => {
  bindAccountTokenClerk(null);
  vi.unstubAllGlobals();
});

describe("per-account relay clients", () => {
  it("authorize with the chosen account's token, whichever session Clerk has active", async () => {
    // account-a is first, as Clerk's active session would be.
    bindAccountTokenClerk({
      client: { signedInSessions: [session("account-a"), session("account-b")] },
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await createAccountBillingClient("account-b")
      .getStatus()
      .catch(() => undefined);
    await createAccountTeamsClient("account-b")
      .list()
      .catch(() => undefined);

    expect(authorizations(fetchMock)).toEqual([
      `Bearer ${jwt("account-b")}`,
      `Bearer ${jwt("account-b")}`,
    ]);
  });

  it("sends nothing for an account without a session, and never another account's token", async () => {
    bindAccountTokenClerk({ client: { signedInSessions: [session("account-a")] } });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createAccountBillingClient("account-b").getStatus()).rejects.toThrow("Sign in");
    await expect(createAccountBillingClient(null).getStatus()).rejects.toThrow("Sign in");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
