import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createPhoneConnectAccount,
  createPhoneConnectApi,
  type PhoneConnectStatus,
} from "./phoneConnectAccount";
import type { AndroidHost } from "../lib/androidHostAccess";

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
const authorizing: PhoneConnectStatus = { ...signedOut, state: "authorizing" };
function fixture() {
  const host = {
    protocolVersion: 2,
    connectAccount: true,
    nativeConnect: true,
    getAccessState: vi.fn(),
    requestFullAccess: vi.fn(),
    openDeviceAccess: vi.fn(),
    getConnectState: vi.fn<() => Promise<unknown>>(async () => signedOut),
    openConnectSignIn: vi.fn<() => Promise<unknown>>(async () => authorizing),
    signOutConnect: vi.fn<() => Promise<unknown>>(async () => signedOut),
    getConnectToken: vi.fn<(id: string) => Promise<unknown>>(async () => ({
      token: "synthetic.session.jwt",
    })),
  } satisfies AndroidHost;
  const api = createPhoneConnectApi(host);
  return { host, api, account: createPhoneConnectAccount(api) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("native phone Connect", () => {
  it("waits for native restoration before allowing sign-in or reading credentials", async () => {
    const { account, host } = fixture();
    await account.begin();
    host.getConnectState.mockResolvedValue({ ...signedOut, state: "loading" });
    await account.refresh();
    expect(account.getSnapshot()).toMatchObject({
      status: { configured: true, state: "loading" },
      error: null,
    });
    await account.begin();
    expect(await account.readToken("phone-account")).toBeNull();
    expect(host.openConnectSignIn).not.toHaveBeenCalled();
    expect(host.getConnectToken).not.toHaveBeenCalled();
    host.getConnectState.mockResolvedValue(signedOut);
    await account.refresh();
    await account.begin();
    expect(host.openConnectSignIn).toHaveBeenCalledOnce();
  });

  it("opens native sign-in immediately, waits without a login deadline, and completes on status refresh", async () => {
    vi.useFakeTimers();
    const { account, host } = fixture();
    await account.refresh();
    await account.begin();
    expect(host.openConnectSignIn).toHaveBeenCalledOnce();
    expect(account.getSnapshot()).toMatchObject({ status: authorizing, busy: false });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(account.getSnapshot().status?.state).toBe("authorizing");
    host.getConnectState.mockResolvedValue(signedIn);
    await account.refresh();
    expect(account.getSnapshot().status?.account?.id).toBe("phone-account");
    expect(await account.readToken("other-account")).toBeNull();
    expect(host.getConnectToken).not.toHaveBeenCalled();
    expect(await account.readToken("phone-account")).toBe("synthetic.session.jwt");
    expect(host.getConnectToken).toHaveBeenCalledWith("phone-account");
  });
  it("handles native cancellation on return and allows another sign-in", async () => {
    const { account, host } = fixture();
    await account.refresh();
    await account.begin();
    await account.refresh();
    expect(account.getSnapshot().status?.state).toBe("signed-out");
    await account.begin();
    expect(host.openConnectSignIn).toHaveBeenCalledTimes(2);
    expect(host.signOutConnect).not.toHaveBeenCalled();
  });
  it("retains a focus refresh that arrives before the opening receipt", async () => {
    const { account, host } = fixture();
    await account.refresh();
    const opening = deferred<unknown>();
    host.openConnectSignIn.mockReturnValueOnce(opening.promise);
    const begin = account.begin();
    await account.begin();
    host.getConnectState.mockResolvedValue(signedIn);
    await account.refresh();
    opening.resolve(authorizing);
    await begin;
    expect(host.openConnectSignIn).toHaveBeenCalledOnce();
    expect(account.getSnapshot().status?.state).toBe("signed-in");
  });
  it("reads fresh native state when return overlaps an earlier status request", async () => {
    const { account, host } = fixture();
    await account.refresh();
    await account.begin();
    const stale = deferred<unknown>();
    host.getConnectState.mockReturnValueOnce(stale.promise);
    const earlier = account.refresh();
    host.getConnectState.mockResolvedValue(signedIn);
    const onReturn = account.refresh();
    stale.resolve(authorizing);
    await Promise.all([earlier, onReturn]);
    expect(account.getSnapshot().status?.state).toBe("signed-in");
  });
  it("does not let a stale status read block or overwrite the return refresh", async () => {
    const { account, host } = fixture();
    await account.refresh();
    const stale = deferred<unknown>();
    host.getConnectState.mockReturnValueOnce(stale.promise);
    const oldRefresh = account.refresh();
    await account.begin();
    host.getConnectState.mockResolvedValue(signedIn);
    await account.refresh();
    stale.resolve(signedOut);
    await oldRefresh;
    expect(account.getSnapshot().status?.state).toBe("signed-in");
  });
  it.each(["logout", "switch", "round-trip", "error", "loading", "loading-round-trip"])(
    "discards pending credentials across %s",
    async (transition) => {
      const { account, host } = fixture();
      host.getConnectState.mockResolvedValue(signedIn);
      await account.refresh();
      const token = deferred<unknown>();
      host.getConnectToken.mockReturnValueOnce(token.promise);
      const read = account.readToken("phone-account");
      if (transition === "logout") await account.logout();
      else {
        host.getConnectState.mockResolvedValue(
          transition === "error" || transition.startsWith("loading")
            ? { ...signedIn, state: transition === "error" ? "error" : "loading" }
            : { ...signedIn, account: { id: "second-account" } },
        );
        await account.refresh();
        if (transition === "round-trip" || transition === "loading-round-trip") {
          host.getConnectState.mockResolvedValue(signedIn);
          await account.refresh();
        }
      }
      token.resolve({ token: "late.synthetic.jwt" });
      expect(await read).toBeNull();
    },
  );
  it("preserves the account on native failure and recovers via refresh or logout", async () => {
    const { account, host } = fixture();
    host.getConnectState.mockResolvedValue(signedIn);
    await account.refresh();
    host.signOutConnect.mockRejectedValueOnce(new Error("private provider detail"));
    await account.logout();
    expect(account.getSnapshot().status).toMatchObject({
      state: "error",
      account: signedIn.account,
    });
    expect(account.getSnapshot().error).not.toContain("private provider detail");
    expect(await account.readToken("phone-account")).toBeNull();
    await account.refresh();
    expect(account.getSnapshot().status?.state).toBe("signed-in");
    await account.logout();
    expect(account.getSnapshot().status?.state).toBe("signed-out");
  });
  it("suspends credentials on malformed native status and token replies", async () => {
    const { account, host } = fixture();
    host.getConnectState.mockResolvedValue(signedIn);
    await account.refresh();
    host.getConnectState.mockResolvedValueOnce({ private: "detail" });
    await account.refresh();
    expect(account.getSnapshot().status).toMatchObject({
      state: "error",
      account: signedIn.account,
    });
    await account.refresh();
    host.getConnectToken.mockResolvedValueOnce({ token: 123 });
    expect(await account.readToken("phone-account")).toBeNull();
    expect(account.getSnapshot().status?.state).toBe("error");
    expect(account.getSnapshot().error).not.toContain("123");
  });
  it("cannot start sign-in with disabled or insecure configuration", async () => {
    const { account, host } = fixture();
    for (const status of [
      { ...signedOut, configured: false },
      { ...signedOut, relayUrl: "http://relay.test" },
    ]) {
      host.getConnectState.mockResolvedValue(status);
      await account.refresh();
      await account.begin();
      expect(account.getSnapshot().status?.configured).toBe(false);
    }
    expect(host.openConnectSignIn).not.toHaveBeenCalled();
  });
});

describe("native schema boundary", () => {
  it("rejects malformed status and tokens without exposing schema inputs", async () => {
    const { api, host } = fixture();
    for (const value of [
      null,
      {},
      { ...signedIn, account: { id: 3 } },
      { ...signedIn, state: "pending-task" },
    ]) {
      host.getConnectState.mockResolvedValueOnce(value);
      await expect(api.status()).rejects.toThrow("Could not update");
    }
    for (const value of [null, {}, { token: 42 }, { token: { secret: "private" } }]) {
      host.getConnectToken.mockResolvedValueOnce(value);
      await expect(api.token({ accountId: "phone-account" })).rejects.toThrow("Could not update");
    }
    host.getConnectToken.mockResolvedValueOnce({ token: null });
    await expect(api.token({ accountId: "phone-account" })).resolves.toEqual({ token: null });
    await expect(api.token({ accountId: "" })).rejects.toThrow("Could not update");
  });
  it("requires an updated native host with every method and never uses HTTP fallback", async () => {
    const { host } = fixture();
    const incomplete: AndroidHost = { ...host };
    delete incomplete.getConnectToken;
    for (const old of [
      undefined,
      { ...host, nativeConnect: false },
      incomplete,
      { ...host, protocolVersion: 1 },
    ]) {
      const api = createPhoneConnectApi(old);
      await expect(api.status()).rejects.toThrow("Update Lecturn");
      await expect(api.begin()).rejects.toThrow("Update Lecturn");
      await expect(api.token({ accountId: "phone-account" })).rejects.toThrow("Update Lecturn");
    }
    expect(host.openConnectSignIn).not.toHaveBeenCalled();
  });
});
