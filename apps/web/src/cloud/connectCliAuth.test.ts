import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
  decideConnectCliAuthorizeStep,
  parseConnectCliAuthAccount,
  leaveForConnectCliAuthorize,
  nameConnectCliAuthorizedAccount,
  hasConnectCliAuthConfig,
  readConnectCliCallbackResult,
} from "./connectCliAuth";

// Any pk_test_* key decodes to <base64 hostname>.clerk.accounts.dev.
const TEST_PUBLISHABLE_KEY = `pk_test_${btoa("witty-mole-42.clerk.accounts.dev$")}`;

describe("connectCliAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires both the publishable key and the CLI OAuth client id", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "lecturn-relay");
    vi.stubEnv("VITE_LECTURN_RELAY_URL", "https://relay.example.com");
    expect(hasConnectCliAuthConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");
    expect(hasConnectCliAuthConfig()).toBe(true);
  });

  it("builds the Clerk authorize URL with the configured hosted origin's callback", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://nightly.lecturn.cloudgatherer.net");

    const authorizeUrl = buildConnectCliClerkAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.hostname).toBe("witty-mole-42.clerk.accounts.dev");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://nightly.lecturn.cloudgatherer.net/connect/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("redirects straight to the CLI's loopback listener when the request carries a port", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");

    const authorizeUrl = buildConnectCliClerkAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
      loopbackPort: 34338,
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:34338/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("returns null when the CLI OAuth client id is not configured", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    expect(
      buildConnectCliClerkAuthorizeUrl({ state: "state-1", challenge: "challenge-1" }),
    ).toBeNull();
  });

  it("sends the sign-in redirect to the authorize endpoint, not back to /connect", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");

    const connectUrl =
      "https://lecturn.cloudgatherer.net/connect#state=state-1&challenge=challenge-1";
    const redirectUrl = connectCliSignInRedirectUrl(
      { state: "state-1", challenge: "challenge-1" },
      connectUrl,
    );

    expect(redirectUrl).not.toBe(connectUrl);
    expect(new URL(redirectUrl).pathname).toBe("/oauth/authorize");
  });

  it("falls back to the current URL when the authorize URL cannot be built", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);

    const connectUrl =
      "https://lecturn.cloudgatherer.net/connect#state=state-1&challenge=challenge-1";
    expect(
      connectCliSignInRedirectUrl({ state: "state-1", challenge: "challenge-1" }, connectUrl),
    ).toBe(connectUrl);
  });

  it("reads the code and state Clerk echoes back to the callback", () => {
    expect(
      readConnectCliCallbackResult(
        new URL("https://lecturn.cloudgatherer.net/connect/callback?code=abc&state=state-1"),
      ),
    ).toEqual({ code: "abc", state: "state-1" });
    expect(
      readConnectCliCallbackResult(
        new URL("https://lecturn.cloudgatherer.net/connect/callback?code=abc"),
      ),
    ).toBeNull();
    expect(
      readConnectCliCallbackResult(
        new URL("https://lecturn.cloudgatherer.net/connect/callback?state=s"),
      ),
    ).toBeNull();
  });
});

describe("decideConnectCliAuthorizeStep", () => {
  const signedIn = {
    isLoaded: true,
    isSignedIn: true,
    knownAccountIds: ["account-a", "account-b"],
    knownAccountsSynced: true,
    confirmedAccountId: null,
  };

  it("waits for Clerk, then asks a signed-out visitor to sign in", () => {
    expect(decideConnectCliAuthorizeStep({ ...signedIn, isLoaded: false })._tag).toBe("wait");
    expect(decideConnectCliAuthorizeStep({ ...signedIn, isSignedIn: false })._tag).toBe("sign-in");
  });

  it("redirects at once as the active account with one account, as it always did", () => {
    const asActive = { _tag: "redirect", accountId: null };
    expect(decideConnectCliAuthorizeStep({ ...signedIn, knownAccountIds: ["account-a"] })).toEqual(
      asActive,
    );
  });

  it("shows the chooser with two accounts, and redirects as the chosen one once confirmed", () => {
    expect(decideConnectCliAuthorizeStep(signedIn)).toEqual({ _tag: "choose" });
    expect(decideConnectCliAuthorizeStep({ ...signedIn, confirmedAccountId: "account-b" })).toEqual(
      { _tag: "redirect", accountId: "account-b" },
    );
  });

  it("does not redirect before the known accounts were read from Clerk", () => {
    expect(
      decideConnectCliAuthorizeStep({
        ...signedIn,
        knownAccountIds: ["account-a"],
        knownAccountsSynced: false,
      })._tag,
    ).toBe("wait");
  });
});

describe("parseConnectCliAuthAccount", () => {
  it("reads the chosen account ID only for the request it was chosen for", () => {
    const stored = JSON.stringify({ state: "state-1", accountId: "account-b" });
    expect(parseConnectCliAuthAccount(stored, "state-1")).toBe("account-b");
    expect(parseConnectCliAuthAccount(stored, "state-2")).toBeNull();
    expect(parseConnectCliAuthAccount(null, "state-1")).toBeNull();
    expect(parseConnectCliAuthAccount("not json", "state-1")).toBeNull();
    expect(parseConnectCliAuthAccount(JSON.stringify({ state: "state-1" }), "state-1")).toBeNull();
  });
});

describe("CLI account authorization", () => {
  it("records the chosen ID only after switching and before navigating", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const events: string[] = [];
    await leaveForConnectCliAuthorize({
      state: "request-1",
      accountId: "account-b",
      storage,
      asAccount: async (accountId, leave) => {
        expect(values.size).toBe(0);
        events.push(accountId);
        leave();
      },
      navigate: () => {
        expect(
          [...values.values()].some(
            (value) => parseConnectCliAuthAccount(value, "request-1") === "account-b",
          ),
        ).toBe(true);
        events.push("navigate");
      },
    });
    expect(events).toEqual(["account-b", "navigate"]);
  });

  it("never redirects when switching fails", async () => {
    const navigate = vi.fn();
    await expect(
      leaveForConnectCliAuthorize({
        state: "request-1",
        accountId: "account-b",
        storage: null,
        asAccount: async () => {
          throw new Error("switch failed");
        },
        navigate,
      }),
    ).rejects.toThrow("switch failed");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("names the actual authorized user and flags a different chosen account", () => {
    expect(
      nameConnectCliAuthorizedAccount({
        chosenAccountId: "account-b",
        user: { id: "account-a", label: "a@example.com" },
      }),
    ).toEqual({ label: "a@example.com", differsFromChoice: true });
  });
});
