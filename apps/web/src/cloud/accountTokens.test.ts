import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { bindAccountTokenClerk, readToken } from "./accountTokens";

vi.mock("./publicConfig", () => ({
  resolveRelayClerkTokenOptions: () => ({ template: "relay" }),
}));

// A JWT as Clerk issues it, base64url and unsigned: only `sub` is read here.
function jwt(sub: string, template = "relay") {
  const payload = Buffer.from(JSON.stringify({ sub, template })).toString("base64url");
  return `header.${payload}.signature`;
}

function fakeSession(accountId: string) {
  return {
    id: `session-${accountId}`,
    user: { id: accountId },
    getToken: vi.fn(async (options?: { readonly template?: string }) =>
      jwt(accountId, options?.template ?? "bare"),
    ),
  };
}

function fakeClerk(accountIds: ReadonlyArray<string>) {
  const sessions = accountIds.map(fakeSession);
  return { client: { signedInSessions: sessions } };
}

afterEach(() => {
  bindAccountTokenClerk(null);
});

describe("readToken", () => {
  it("reads a session's template token from that session, whichever one is active", async () => {
    const clerk = fakeClerk(["account-a", "account-b"]);
    bindAccountTokenClerk(clerk);

    expect(await readToken("account-b")).toBe(jwt("account-b"));
    expect(clerk.client.signedInSessions[0]!.getToken).not.toHaveBeenCalled();
  });

  it("never asks a session for a bare token", async () => {
    const clerk = fakeClerk(["account-a", "account-b"]);
    bindAccountTokenClerk(clerk);
    await Promise.all([readToken("account-a"), readToken("account-b")]);

    for (const session of clerk.client.signedInSessions) {
      expect(session.getToken.mock.calls).toEqual([[{ template: "relay" }]]);
    }
  });

  it("finds the session at call time, since Clerk re-creates its session objects", async () => {
    const clerk = fakeClerk(["account-a"]);
    bindAccountTokenClerk(clerk);
    const stale = clerk.client.signedInSessions[0]!;
    clerk.client.signedInSessions = [fakeSession("account-a")];

    expect(await readToken("account-a")).toBe(jwt("account-a"));
    expect(stale.getToken).not.toHaveBeenCalled();
  });

  it("serializes a five-way fan-out", async () => {
    const accountIds = ["account-1", "account-2", "account-3", "account-4", "account-5"];
    const clerk = fakeClerk(accountIds);
    let inFlight = 0;
    let mostInFlight = 0;
    const started: string[] = [];
    for (const session of clerk.client.signedInSessions) {
      session.getToken.mockImplementation(async () => {
        started.push(session.user.id);
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise<void>((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return jwt(session.user.id);
      });
    }
    bindAccountTokenClerk(clerk);

    const tokens = await Promise.all(accountIds.map(readToken));

    expect(tokens).toEqual(accountIds.map((accountId) => jwt(accountId)));
    expect(started).toEqual(accountIds);
    expect(mostInFlight).toBe(1);
  });

  it("lets the next read through after one fails", async () => {
    const clerk = fakeClerk(["account-a", "account-b"]);
    clerk.client.signedInSessions[0]!.getToken.mockRejectedValue(new Error("offline"));
    bindAccountTokenClerk(clerk);

    const [first, second] = await Promise.allSettled([
      readToken("account-a"),
      readToken("account-b"),
    ]);
    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: jwt("account-b") });
  });

  it("keeps a hung read's permit, and fails the readers behind it instead", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const clerk = fakeClerk(["account-a", "account-b"]);
      const [sessionA, sessionB] = clerk.client.signedInSessions;
      let finishHungRead = (_token: string) => {};
      sessionA!.getToken.mockReturnValue(new Promise((resolve) => (finishHungRead = resolve)));
      bindAccountTokenClerk(clerk);

      const outcomes: string[] = [];
      const settle = (name: string, read: Promise<unknown>) =>
        read.then(
          () => outcomes.push(`${name} read`),
          () => outcomes.push(`${name} failed`),
        );
      void settle("hung", readToken("account-a"));
      void settle("queued", readToken("account-b"));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(outcomes).toEqual([]);
      expect(sessionB!.getToken).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes.toSorted()).toEqual(["hung failed", "queued failed"]);
      // Nobody else queues behind the hung read, and none overlaps it.
      await settle("late", readToken("account-b"));
      expect(outcomes).toContain("late failed");
      expect(sessionB!.getToken).not.toHaveBeenCalled();

      finishHungRead(jwt("account-a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await readToken("account-b")).toBe(jwt("account-b"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for a read that never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const clerk = fakeClerk(["account-a", "account-b"]);
      clerk.client.signedInSessions[0]!.getToken.mockReturnValue(new Promise(() => {}));
      bindAccountTokenClerk(clerk);

      const hung = readToken("account-a").catch(() => "failed");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await hung).toBe("failed");
      await expect(readToken("account-b")).rejects.toThrow();

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await readToken("account-b")).toBe(jwt("account-b"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed, and says so once, when Clerk returns another account's token", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const clerk = fakeClerk(["account-a", "account-b"]);
      clerk.client.signedInSessions[1]!.getToken.mockResolvedValue(jwt("account-a"));
      bindAccountTokenClerk(clerk);

      expect(await readToken("account-b")).toBeNull();
      expect(await readToken("account-b")).toBeNull();
      expect(consoleError).toHaveBeenCalledTimes(1);

      clerk.client.signedInSessions[1]!.getToken.mockResolvedValue("not-a-jwt");
      expect(await readToken("account-b")).toBeNull();
      expect(await readToken("account-a")).toBe(jwt("account-a"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("resolves null, as a signed-out reader does, for an account without a session", async () => {
    const clerk = fakeClerk(["account-a"]);
    bindAccountTokenClerk(clerk);
    expect(await readToken("account-b")).toBeNull();

    bindAccountTokenClerk(null);
    expect(await readToken("account-a")).toBeNull();
    expect(clerk.client.signedInSessions[0]!.getToken).not.toHaveBeenCalled();
  });
});
