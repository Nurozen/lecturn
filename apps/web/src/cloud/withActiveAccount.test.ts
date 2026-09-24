import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ActiveAccountError,
  bindActiveAccountClerk,
  withActiveAccount,
  withActiveAccountForProfile,
  getProfileSelectedAccountId,
} from "./withActiveAccount";

function makeClerk(options: { readonly active: string | null; readonly stuck?: boolean }) {
  const sessions = [
    { id: "session-a", user: { id: "account-a" } },
    { id: "session-b", user: { id: "account-b" } },
  ];
  const clerk = {
    user: options.active === null ? null : { id: options.active },
    client: { signedInSessions: sessions },
    setActive: vi.fn(async ({ session }: { session: string }) => {
      await Promise.resolve();
      if (options.stuck) return;
      clerk.user = sessions.find((entry) => entry.id === session)?.user ?? null;
    }),
  };
  return clerk;
}

describe("withActiveAccount", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    bindActiveAccountClerk(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not switch when the account is already active", async () => {
    const clerk = makeClerk({ active: "account-a" });
    bindActiveAccountClerk(clerk);
    expect(await withActiveAccount("account-a", () => "done")).toBe("done");
    expect(clerk.setActive).not.toHaveBeenCalled();
  });

  it("switches to the account's session, runs, and leaves it active", async () => {
    const clerk = makeClerk({ active: "account-a" });
    bindActiveAccountClerk(clerk);
    const seen = await withActiveAccount("account-b", () => clerk.user?.id);
    expect(seen).toBe("account-b");
    expect(clerk.setActive).toHaveBeenCalledExactlyOnceWith({ session: "session-b" });
    expect(clerk.user?.id).toBe("account-b");
  });

  it("runs one call at a time, in order", async () => {
    const clerk = makeClerk({ active: "account-a" });
    bindActiveAccountClerk(clerk);
    const events: string[] = [];
    let releaseFirst = () => {};
    const first = withActiveAccount("account-b", async () => {
      events.push(`first starts as ${clerk.user?.id}`);
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push(`first ends as ${clerk.user?.id}`);
    });
    const second = withActiveAccount("account-a", () => {
      events.push(`second runs as ${clerk.user?.id}`);
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(clerk.setActive).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first starts as account-b",
      "first ends as account-b",
      "second runs as account-a",
    ]);
  });

  it("restores selection before another profile turn and after failed IO", async () => {
    const clerk = makeClerk({ active: "account-a" });
    bindActiveAccountClerk(clerk);
    const seen: string[] = [];
    await Promise.all([
      withActiveAccountForProfile("account-b", () => {
        seen.push(clerk.user!.id);
        expect(getProfileSelectedAccountId()).toBe("account-a");
      }),
      withActiveAccountForProfile("account-a", () => {
        seen.push(clerk.user!.id);
      }),
    ]);
    expect(seen).toEqual(["account-b", "account-a"]);
    expect(clerk.user?.id).toBe("account-a");
    expect(clerk.setActive.mock.calls).toEqual([
      [{ session: "session-b" }],
      [{ session: "session-a" }],
    ]);
    await expect(
      withActiveAccountForProfile("account-b", () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow("offline");
    expect(clerk.user?.id).toBe("account-a");
  });

  it("does not run when Clerk did not switch", async () => {
    const clerk = makeClerk({ active: "account-a", stuck: true });
    bindActiveAccountClerk(clerk);
    const fn = vi.fn();
    await expect(withActiveAccount("account-b", fn)).rejects.toBeInstanceOf(ActiveAccountError);
    expect(fn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("fails when the active account changed while it ran", async () => {
    const clerk = makeClerk({ active: "account-a" });
    bindActiveAccountClerk(clerk);
    await expect(
      withActiveAccount("account-a", () => {
        clerk.user = { id: "account-b" };
      }),
    ).rejects.toBeInstanceOf(ActiveAccountError);
  });

  it("refuses an account without a signed-in session, and keeps serving later calls", async () => {
    const clerk = makeClerk({ active: "account-a" });
    bindActiveAccountClerk(clerk);
    await expect(withActiveAccount("account-c", () => "never")).rejects.toThrow("needs sign-in");
    expect(clerk.setActive).not.toHaveBeenCalled();
    expect(await withActiveAccount("account-a", () => "still works")).toBe("still works");
  });

  it("keeps timed-out switches serialized and never performs their late action", async () => {
    vi.useFakeTimers();
    const clerk = makeClerk({ active: "account-a" });
    let release = () => {};
    clerk.setActive.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      clerk.user = { id: "account-b" };
    });
    bindActiveAccountClerk(clerk);
    const lateAction = vi.fn();
    const first = withActiveAccount("account-b", lateAction, 10);
    const firstFailure = expect(first).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(10);
    await firstFailure;
    const second = withActiveAccount("account-a", () => clerk.user?.id, 100);
    await Promise.resolve();
    expect(clerk.setActive).toHaveBeenCalledTimes(1);
    release();
    expect(await second).toBe("account-a");
    expect(lateAction).not.toHaveBeenCalled();
    expect(clerk.setActive).toHaveBeenCalledTimes(2);
  });

  it("fails without a bound Clerk", async () => {
    await expect(withActiveAccount("account-a", () => "never")).rejects.toThrow("not ready");
  });
});
