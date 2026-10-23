import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
  decideConnectCliAuthorizeStep,
  leaveForConnectCliAuthorize,
  hasConnectCliAuthConfig,
} from "./connectCliAuth";

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

  it("builds a PKCE authorize URL that redirects to the CLI's loopback listener", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");

    const authorizeUrl = buildConnectCliClerkAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
      loopbackPort: 34338,
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.hostname).toBe("witty-mole-42.clerk.accounts.dev");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:34338/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("returns null when the CLI OAuth client id is not configured", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    expect(
      buildConnectCliClerkAuthorizeUrl({
        state: "state-1",
        challenge: "challenge-1",
        loopbackPort: 34338,
      }),
    ).toBeNull();
  });

  it("sends the sign-in redirect to the authorize endpoint, not back to /connect", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");

    const connectUrl =
      "https://lecturn.cloudgatherer.net/connect#state=state-1&challenge=challenge-1&port=34338";
    const redirectUrl = connectCliSignInRedirectUrl(
      { state: "state-1", challenge: "challenge-1", loopbackPort: 34338 },
      connectUrl,
    );

    expect(redirectUrl).not.toBe(connectUrl);
    expect(new URL(redirectUrl).pathname).toBe("/oauth/authorize");
  });

  it("falls back to the current URL when the authorize URL cannot be built", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);

    const connectUrl =
      "https://lecturn.cloudgatherer.net/connect#state=state-1&challenge=challenge-1&port=34338";
    expect(
      connectCliSignInRedirectUrl(
        { state: "state-1", challenge: "challenge-1", loopbackPort: 34338 },
        connectUrl,
      ),
    ).toBe(connectUrl);
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

describe("CLI account authorization", () => {
  it("navigates as the active account when no account was chosen", async () => {
    const asAccount = vi.fn();
    const navigate = vi.fn();
    await leaveForConnectCliAuthorize({ accountId: null, asAccount, navigate });
    expect(asAccount).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("switches to the chosen account before navigating", async () => {
    const events: string[] = [];
    await leaveForConnectCliAuthorize({
      accountId: "account-b",
      asAccount: async (accountId, leave) => {
        events.push(accountId);
        leave();
      },
      navigate: () => {
        events.push("navigate");
      },
    });
    expect(events).toEqual(["account-b", "navigate"]);
  });

  it("never redirects when switching fails", async () => {
    const navigate = vi.fn();
    await expect(
      leaveForConnectCliAuthorize({
        accountId: "account-b",
        asAccount: async () => {
          throw new Error("switch failed");
        },
        navigate,
      }),
    ).rejects.toThrow("switch failed");
    expect(navigate).not.toHaveBeenCalled();
  });
});
