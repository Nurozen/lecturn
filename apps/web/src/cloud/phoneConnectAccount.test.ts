import { describe, expect, it, vi } from "vite-plus/test";
import {
  createPhoneConnectAccount,
  createPhoneConnectApi,
  type PhoneConnectApi,
  type PhoneConnectStatus,
} from "./phoneConnectAccount";

const signedOut: PhoneConnectStatus = {
  configured: true,
  state: "signed-out",
  account: null,
  relayUrl: "https://relay.example.test",
};
const signedIn: PhoneConnectStatus = {
  ...signedOut,
  state: "signed-in",
  account: { id: "phone-account", email: "phone@example.test" },
};
const authorization = {
  authorizationUrl: "https://accounts.example.test/authorize",
  requestId: "attempt-one",
  expiresAt: "2030-01-01T00:00:00.000Z",
};
function fixture() {
  const api = {
    status: vi.fn(async () => signedOut),
    begin: vi.fn(async () => authorization),
    complete: vi.fn(async () => signedIn),
    cancel: vi.fn(async () => signedOut),
    token: vi.fn(async (): Promise<{ token: string | null }> => ({
      token: "opaque-test-credential",
    })),
    logout: vi.fn(async () => signedOut),
  } satisfies PhoneConnectApi;
  return { api, account: createPhoneConnectAccount(api) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("phone Connect account", () => {
  it("completes hosted sign-in and reads opaque credentials only for the signed-in account", async () => {
    const { account, api } = fixture();
    await account.refresh();
    await account.begin();
    expect(account.getSnapshot().status?.state).toBe("authorizing");
    await account.complete("  entire-return-code  ");
    expect(api.complete).toHaveBeenCalledWith({
      requestId: authorization.requestId,
      code: "entire-return-code",
    });
    expect(account.getSnapshot().authorization).toBeNull();
    expect(account.getSnapshot().status?.account?.id).toBe("phone-account");
    expect(await account.readToken("someone-else")).toBeNull();
    expect(api.token).not.toHaveBeenCalled();
    expect(await account.readToken("phone-account")).not.toBeNull();
    expect(api.token).toHaveBeenCalledWith({ accountId: "phone-account" });
  });
  it("keeps configuration-disabled accounts visible but cannot start login", async () => {
    const { account, api } = fixture();
    api.status.mockResolvedValue({ ...signedOut, configured: false, relayUrl: null });
    await account.refresh();
    await account.begin();
    expect(account.getSnapshot().status?.configured).toBe(false);
    expect(api.begin).not.toHaveBeenCalled();
  });
  it("cancels the pending attempt and discards its authorization data", async () => {
    const { account, api } = fixture();
    await account.refresh();
    await account.begin();
    await account.cancel();
    expect(api.cancel).toHaveBeenCalledWith({ requestId: authorization.requestId });
    expect(account.getSnapshot().authorization).toBeNull();
    expect(account.getSnapshot().status?.state).toBe("signed-out");
    await account.complete("old-code");
    expect(api.complete).not.toHaveBeenCalled();
  });
  it("recovers an authorizing session after reload without persisting its link", async () => {
    const { account, api } = fixture();
    api.status.mockResolvedValue({ ...signedOut, state: "authorizing" });
    await account.refresh();
    await account.cancel();
    expect(api.logout).toHaveBeenCalledOnce();
    expect(api.cancel).not.toHaveBeenCalled();
    expect(account.getSnapshot().status?.state).toBe("signed-out");
  });
  it("drops late credential reads and clears the account on logout", async () => {
    const { account, api } = fixture();
    api.status.mockResolvedValue(signedIn);
    await account.refresh();
    const token = deferred<{ token: string | null }>();
    api.token.mockReturnValueOnce(token.promise);
    const read = account.readToken("phone-account");
    await account.logout();
    token.resolve({ token: "late-test-credential" });
    expect(await read).toBeNull();
    expect(account.getSnapshot().status?.account).toBeNull();
    expect(await account.readToken("phone-account")).toBeNull();
  });
  it("ignores status responses started before newer login operations", async () => {
    const { account, api } = fixture();
    await account.refresh();
    const status = deferred<PhoneConnectStatus>();
    api.status.mockReturnValueOnce(status.promise);
    const refresh = account.refresh();
    await account.begin();
    status.resolve(signedOut);
    await refresh;
    expect(account.getSnapshot().status?.state).toBe("authorizing");
  });
  it("reconciles consumed invalid codes and permits a fresh attempt", async () => {
    const { account, api } = fixture();
    await account.refresh();
    await account.begin();
    api.complete.mockRejectedValueOnce(new Error("private provider detail"));
    await account.complete("bad-code");
    expect(account.getSnapshot().authorization).toBeNull();
    expect(account.getSnapshot().error).not.toContain("private provider detail");
    await account.begin();
    expect(api.begin).toHaveBeenCalledTimes(2);
    expect(account.getSnapshot().error).toBeNull();
  });
  it("serializes repeated gestures and keeps a failed logout recoverable", async () => {
    const { account, api } = fixture();
    await account.refresh();
    const begin = deferred<typeof authorization>();
    api.begin.mockReturnValueOnce(begin.promise);
    const first = account.begin();
    await account.begin();
    expect(api.begin).toHaveBeenCalledOnce();
    begin.resolve(authorization);
    await first;
    await account.complete("code");
    api.status.mockResolvedValue(signedIn);
    api.logout.mockRejectedValueOnce(new Error("unavailable"));
    await account.logout();
    expect(account.getSnapshot().status?.state).toBe("signed-in");
    expect(account.getSnapshot().error).not.toBeNull();
    await account.logout();
    expect(account.getSnapshot().status?.state).toBe("signed-out");
  });
});

describe("phone Connect HTTP boundary", () => {
  it("uses the same-origin authenticated contract without caching credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(signedOut)));
    const api = createPhoneConnectApi(fetcher);
    await api.status();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/connect/account/status",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json", "X-Lecturn-Connect-Account": "local-ui" },
      }),
    );
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ token: null })));
    await api.token({ accountId: "phone-account" });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/connect/account/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ accountId: "phone-account" }),
      }),
    );
  });
  it("rejects malformed responses and does not reflect error bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}"));
    const api = createPhoneConnectApi(fetcher);
    await expect(api.status()).rejects.toThrow();
    fetcher.mockResolvedValueOnce(new Response("private detail", { status: 403 }));
    await expect(api.begin()).rejects.toThrow("This local session cannot manage");
  });
});
