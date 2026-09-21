import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { signOutMobileConnectAccount } from "./mobileAccountSignOut";
const effects = vi.hoisted(() => ({
  events: [] as string[],
  unregisterFails: false,
  sync: vi.fn(),
}));
vi.mock("../../lib/runtime", () => ({
  runtime: { runPromise: async (effect: () => Promise<void>) => effect() },
}));
vi.mock("./accountTokenReaders", () => ({ accountTokenReader: () => async () => "token" }));
vi.mock("./accountPushRegistration", () => ({
  unregisterAccountPush: (id: string) => async () => {
    effects.events.push(`unregister:${id}`);
    if (effects.unregisterFails) throw new Error("offline");
  },
  syncAccountPushProviders: effects.sync,
}));
vi.mock("./knownAccountStorage", () => ({
  notifyConnectAccountRemoval: () => {
    effects.events.push("notify");
  },
  markConnectAccountRemoval: async (id: string) => {
    effects.events.push(`mark:${id}`);
  },
  cancelConnectAccountRemoval: async (id: string) => {
    effects.events.push(`cancel:${id}`);
  },
}));
function fixture() {
  const a = { id: "session-a", user: { id: "a" } };
  const b = { id: "session-b", user: { id: "b" } };
  const clerk = {
    session: b,
    client: { signedInSessions: [a, b] },
    setActive: vi.fn(async ({ session }: { session: string }) => {
      effects.events.push(`active:${session}`);
      clerk.session = a;
    }),
    signOut: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      effects.events.push(`out:${sessionId}`);
      clerk.client.signedInSessions = clerk.client.signedInSessions.filter(
        (entry) => entry.id !== sessionId,
      );
    }),
  };
  return { clerk, typed: clerk as unknown as Parameters<typeof signOutMobileConnectAccount>[0] };
}
beforeEach(() => {
  effects.events.length = 0;
  effects.unregisterFails = false;
  effects.sync.mockReset();
});
describe("mobile account sign-out", () => {
  it("unregisters with a live credential, activates the survivor, and ends only the requested session", async () => {
    const { clerk, typed } = fixture();
    expect(await signOutMobileConnectAccount(typed, "b")).toEqual({ unregisterFailed: false });
    expect(effects.events).toEqual([
      "unregister:b",
      "active:session-a",
      "mark:b",
      "out:session-b",
      "notify",
    ]);
    expect(clerk.client.signedInSessions.map((session) => session.user.id)).toEqual(["a"]);
  });
  it("allows offline unregister failure and reports it without touching the other account", async () => {
    effects.unregisterFails = true;
    const { typed } = fixture();
    expect(await signOutMobileConnectAccount(typed, "b")).toEqual({ unregisterFailed: true });
    expect(effects.events).toContain("out:session-b");
    expect(effects.events).not.toContain("out:session-a");
  });
  it("cancels cleanup and restores push membership if Clerk refuses sign-out", async () => {
    const { clerk, typed } = fixture();
    clerk.signOut.mockRejectedValueOnce(new Error("refused"));
    await expect(signOutMobileConnectAccount(typed, "b")).rejects.toThrow("refused");
    expect(effects.events.at(-1)).toBe("cancel:b");
    expect(effects.sync.mock.calls[0]?.[0].size).toBe(2);
  });
});
