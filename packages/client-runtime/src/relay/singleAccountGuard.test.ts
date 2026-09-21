// @effect-diagnostics globalDate:off -- Clerk session resources expose createdAt as a Date.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  MULTI_ACCOUNT_MARKER_MAX_AGE_MS,
  decideSingleAccountGuard,
  isMultiAccountMarkerFresh,
  makeSingleAccountEnforcer,
  type SingleAccountGuardInput,
} from "./singleAccountGuard.ts";

const sessionA = { id: "session-a", accountId: "account-a", createdAt: 1_000 };
const sessionB = { id: "session-b", accountId: "account-b", createdAt: 2_000 };

const decide = (input: Partial<SingleAccountGuardInput>) =>
  decideSingleAccountGuard({
    multiAccountEnabled: false,
    markerPresent: false,
    sessions: [sessionA, sessionB],
    activeSessionId: sessionB.id,
    observedAccountId: "account-a",
    persistedAccountId: null,
    ...input,
  });

const proceed = { _tag: "Proceed" };
const rejectB = { _tag: "Reject", acceptedSessionId: sessionA.id, extraSessionIds: [sessionB.id] };
const reactivateA = { _tag: "Reject", acceptedSessionId: sessionA.id, extraSessionIds: [] };

describe("decideSingleAccountGuard", () => {
  it("leaves a single active session alone", () => {
    expect(decide({ sessions: [sessionA], activeSessionId: sessionA.id })).toEqual(proceed);
    expect(decide({ sessions: [], activeSessionId: null, observedAccountId: null })).toEqual(
      proceed,
    );
  });

  it("does nothing once multi-account is on", () => {
    expect(decide({ multiAccountEnabled: true })).toEqual(proceed);
  });

  it("rejects the extra session in every step of Clerk's add-account flow", () => {
    expect(decide({ activeSessionId: sessionA.id })).toEqual(rejectB);
    expect(decide({ activeSessionId: sessionB.id })).toEqual(rejectB);
    expect(decide({ activeSessionId: null })).toEqual(rejectB);
  });

  it("never proceeds while the served account is signed in but not active", () => {
    // Signing out the current extra session leaves one session and no active one.
    expect(decide({ sessions: [sessionA], activeSessionId: null })).toEqual(reactivateA);
    expect(decide({ sessions: [sessionA], activeSessionId: sessionB.id })).toEqual(reactivateA);
  });

  it("proceeds once the served session is gone", () => {
    const sessionC = { id: "session-c", accountId: "account-c", createdAt: 3_000 };
    expect(decide({ sessions: [sessionB, sessionC] })).toEqual(proceed);
    expect(decide({ sessions: [sessionB] })).toEqual(proceed);
    expect(decide({ sessions: [], activeSessionId: null })).toEqual(proceed);
  });

  it("falls back to the persisted account before the first observation", () => {
    expect(decide({ observedAccountId: undefined, persistedAccountId: "account-a" })).toEqual(
      rejectB,
    );
  });

  it("lets an observed sign-out outrank a stale persisted account", () => {
    expect(
      decide({
        sessions: [sessionB],
        observedAccountId: null,
        persistedAccountId: "account-a",
      }),
    ).toEqual(proceed);
  });

  it("accepts the active session, then the oldest, when no account was served", () => {
    const first = { observedAccountId: undefined, persistedAccountId: null };
    expect(decide({ ...first, activeSessionId: sessionB.id })).toEqual({
      _tag: "Reject",
      acceptedSessionId: sessionB.id,
      extraSessionIds: [sessionA.id],
    });
    expect(decide({ ...first, sessions: [sessionB, sessionA], activeSessionId: null })).toEqual(
      rejectB,
    );
  });

  it("holds while the persisted account is still loading", () => {
    expect(decide({ observedAccountId: undefined, persistedAccountId: undefined })).toEqual({
      _tag: "Hold",
    });
  });

  it("stands down when a newer tab has enabled multi-account", () => {
    expect(decide({ markerPresent: true })).toEqual({ _tag: "StandDown" });
  });
});

describe("isMultiAccountMarkerFresh", () => {
  const now = 1_800_000_000_000;

  it("accepts a recent heartbeat", () => {
    expect(isMultiAccountMarkerFresh(String(now - 60_000), now)).toBe(true);
  });

  it("stays fresh for two hours and no more", () => {
    const hour = 60 * 60 * 1_000;
    expect(isMultiAccountMarkerFresh(String(now - 2 * hour + 1), now)).toBe(true);
    expect(isMultiAccountMarkerFresh(String(now - 2 * hour), now)).toBe(false);
  });

  it("ignores a missing, malformed, or stale marker", () => {
    expect(isMultiAccountMarkerFresh(null, now)).toBe(false);
    expect(isMultiAccountMarkerFresh("", now)).toBe(false);
    expect(isMultiAccountMarkerFresh("true", now)).toBe(false);
    expect(isMultiAccountMarkerFresh(String(now - MULTI_ACCOUNT_MARKER_MAX_AGE_MS), now)).toBe(
      false,
    );
  });
});

interface FakeSession {
  readonly id: string;
  readonly createdAt: Date;
  readonly user: { readonly id: string };
}

/** Mirrors the clerk-js behavior the guard depends on. */
function makeClerk() {
  const session = (id: string, accountId: string, createdAt: number): FakeSession => ({
    id,
    createdAt: new Date(createdAt),
    user: { id: accountId },
  });
  const a = session(sessionA.id, sessionA.accountId, sessionA.createdAt);
  const b = session(sessionB.id, sessionB.accountId, sessionB.createdAt);
  const listeners = new Set<() => void>();
  const clerk = {
    session: a as FakeSession | null | undefined,
    client: { signedInSessions: [a] },
    // Like clerk-js, emits once on subscribing.
    addListener: vi.fn((listener: () => void) => {
      listeners.add(listener);
      listener();
      return () => void listeners.delete(listener);
    }),
    setActive: vi.fn(async ({ session: id }: { session: string }) => {
      clerk.session = clerk.client.signedInSessions.find((entry) => entry.id === id) ?? null;
    }),
    signOut: vi.fn(async (options?: { sessionId: string }) => {
      const sessions = clerk.client.signedInSessions;
      if (options === undefined || sessions.length === 1) {
        clerk.client.signedInSessions = [];
        clerk.session = null;
        return;
      }
      clerk.client.signedInSessions = sessions.filter((entry) => entry.id !== options.sessionId);
      // Signing out the current session leaves no active session.
      if (clerk.session?.id === options.sessionId) {
        clerk.session = null;
      }
    }),
  };
  return {
    clerk,
    a,
    b,
    listeners,
    emit: () => {
      for (const listener of listeners) listener();
    },
    add: (active: FakeSession | null) => {
      clerk.client.signedInSessions = [a, b];
      clerk.session = active;
    },
  };
}

function makeEnforcer(markerPresent = false) {
  const events = {
    onRejected: vi.fn(),
    onStandDown: vi.fn(),
    onExhausted: vi.fn<(signOutEverywhere: () => Promise<void>) => void>(),
    onError: vi.fn(),
  };
  const scheduled: Array<{ readonly run: () => void; readonly delayMs: number }> = [];
  const cancelled: number[] = [];
  const wake = { current: null as (() => void) | null };
  // Stands in for a platform flow that unpublishes before it signs out.
  const signOutEverywhere = vi.fn(async (clerk: { signOut: () => Promise<unknown> }) =>
    clerk.signOut(),
  );
  const enforcer = makeSingleAccountEnforcer({
    multiAccountEnabled: false,
    readMarkerPresent: () => markerPresent,
    schedule: (run, delayMs) => {
      const index = scheduled.push({ run, delayMs }) - 1;
      return () => void cancelled.push(index);
    },
    subscribeWake: (run) => {
      wake.current = run;
      return () => (wake.current = null);
    },
    signOutEverywhere,
    ...events,
  });
  return { enforcer, events, scheduled, cancelled, wake, signOutEverywhere };
}

function makeHarness(markerPresent = false) {
  const fake = makeClerk();
  const made = makeEnforcer(markerPresent);
  const onSettled = vi.fn();
  // The caller has served account A throughout and renders Clerk's current state.
  const evaluate = () =>
    made.enforcer.evaluate({
      clerk: fake.clerk,
      renderedAccountId: fake.clerk.session?.user.id ?? null,
      observedAccountId: "account-a",
      persistedAccountId: null,
      onSettled,
    });
  return { ...fake, ...made, onSettled, evaluate };
}

describe("makeSingleAccountEnforcer", () => {
  it("reactivates the served session before signing the extra one out", async () => {
    const { clerk, b, add, enforcer, events, onSettled, evaluate } = makeHarness();

    expect(evaluate()).toBe(true);
    add(b);
    expect(evaluate()).toBe(false);
    expect(events.onRejected).not.toHaveBeenCalled();
    await enforcer.settled();

    expect(clerk.setActive).toHaveBeenCalledExactlyOnceWith({ session: sessionA.id });
    expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({ sessionId: sessionB.id });
    expect(clerk.setActive.mock.invocationCallOrder[0]).toBeLessThan(
      clerk.signOut.mock.invocationCallOrder[0]!,
    );
    expect(events.onRejected).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(evaluate()).toBe(true);
  });

  it("survives Clerk activating the extra session while it is being signed out", async () => {
    const { clerk, a, b, add, enforcer, events, evaluate } = makeHarness();
    const signOut = clerk.signOut.getMockImplementation()!;
    let releaseSignOut = () => {};
    const signOutReleased = new Promise<void>((resolve) => (releaseSignOut = resolve));
    clerk.signOut.mockImplementationOnce(async (options) => {
      await signOutReleased;
      return signOut(options);
    });

    // Step one of Clerk's add-account flow: B exists, A is still active.
    add(a);
    expect(evaluate()).toBe(false);
    // Step two lands mid sign-out: B becomes current, so clerk-js takes the
    // current-session path and leaves no active session.
    clerk.session = b;
    expect(evaluate()).toBe(false);
    releaseSignOut();
    await enforcer.settled();

    expect(clerk.client.signedInSessions).toEqual([a]);
    expect(clerk.session).toBe(a);
    expect(events.onRejected).toHaveBeenCalledTimes(1);
    expect(evaluate()).toBe(true);
  });

  it("reactivates the served session when it is signed in but nothing is active", async () => {
    const { clerk, a, enforcer, events, evaluate } = makeHarness();

    clerk.session = null;
    expect(evaluate()).toBe(false);
    await enforcer.settled();

    expect(clerk.session).toBe(a);
    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(events.onRejected).not.toHaveBeenCalled();
    expect(evaluate()).toBe(true);
  });

  it("holds while the caller rendered an older state than Clerk reports", () => {
    const { clerk, enforcer } = makeHarness();

    expect(
      enforcer.evaluate({
        clerk,
        renderedAccountId: null,
        observedAccountId: "account-a",
        persistedAccountId: null,
        onSettled: () => {},
      }),
    ).toBe(false);
    expect(clerk.setActive).not.toHaveBeenCalled();
  });

  it("runs one rejection while the active session keeps flipping", async () => {
    const { clerk, a, b, add, enforcer, events, evaluate } = makeHarness();

    add(b);
    for (const active of [b, null, a, b]) {
      clerk.session = active;
      expect(evaluate()).toBe(false);
    }
    await enforcer.settled();

    expect(clerk.signOut).toHaveBeenCalledTimes(1);
    expect(events.onRejected).toHaveBeenCalledTimes(1);
  });

  it("retries a failed rejection and announces only once it worked", async () => {
    const { clerk, a, b, add, enforcer, events, scheduled, onSettled, evaluate } = makeHarness();
    const failure = new Error("offline");
    clerk.setActive.mockRejectedValueOnce(failure);

    add(b);
    expect(evaluate()).toBe(false);
    await enforcer.settled();

    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(events.onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(events.onRejected).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([1_000]);

    scheduled[0]!.run();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(evaluate()).toBe(false);
    await enforcer.settled();

    expect(clerk.client.signedInSessions).toEqual([a]);
    expect(events.onRejected).toHaveBeenCalledTimes(1);
    expect(evaluate()).toBe(true);
  });

  it("shows a persistent error once retries run out, and recovers after a full sign-out", async () => {
    const { clerk, a, add, enforcer, events, scheduled, evaluate } = makeHarness();
    const signOut = clerk.signOut.getMockImplementation()!;
    clerk.signOut.mockRejectedValue(new Error("offline"));

    add(a);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(evaluate()).toBe(false);
      await enforcer.settled();
      scheduled[attempt]!.run();
    }
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([1_000, 2_000, 4_000]);
    expect(events.onExhausted).not.toHaveBeenCalled();

    expect(evaluate()).toBe(false);
    expect(evaluate()).toBe(false);
    expect(clerk.signOut).toHaveBeenCalledTimes(3);
    expect(events.onExhausted).toHaveBeenCalledTimes(1);
    expect(events.onRejected).not.toHaveBeenCalled();

    // The offered action signs every session out, which is a normal sign-out.
    clerk.signOut.mockImplementation(signOut);
    await events.onExhausted.mock.calls[0]![0]();
    expect(clerk.client.signedInSessions).toEqual([]);
    expect(evaluate()).toBe(true);

    // The cap was reset with the session gone, so a later extra is rejected again.
    add(a);
    expect(evaluate()).toBe(false);
    await enforcer.settled();
    expect(clerk.client.signedInSessions).toEqual([a]);
    expect(events.onRejected).toHaveBeenCalledTimes(1);
  });

  it("leaves the served account alone when someone else removes the extra mid-rejection", async () => {
    const { clerk, a, b, add, enforcer, events, evaluate } = makeHarness();
    const setActive = clerk.setActive.getMockImplementation()!;
    clerk.setActive.mockImplementationOnce(async (params) => {
      // Another tab signs B out while the switch back to A is on the network.
      clerk.client.signedInSessions = [a];
      return setActive(params);
    });

    add(b);
    expect(evaluate()).toBe(false);
    await enforcer.settled();

    expect(clerk.signOut).not.toHaveBeenCalled();
    expect(clerk.client.signedInSessions).toEqual([a]);
    expect(clerk.session).toBe(a);
    expect(events.onError).not.toHaveBeenCalled();
    expect(evaluate()).toBe(true);
  });

  it("skips an extra that is already gone and still signs out the others", async () => {
    const { clerk, a, b, add, enforcer, evaluate } = makeHarness();
    const c = { id: "session-c", createdAt: new Date(3_000), user: { id: "account-c" } };
    const setActive = clerk.setActive.getMockImplementation()!;
    clerk.setActive.mockImplementationOnce(async (params) => {
      clerk.client.signedInSessions = [a, c];
      return setActive(params);
    });

    add(b);
    clerk.client.signedInSessions = [a, b, c];
    expect(evaluate()).toBe(false);
    await enforcer.settled();

    expect(clerk.signOut).toHaveBeenCalledExactlyOnceWith({ sessionId: c.id });
    expect(clerk.client.signedInSessions).toEqual([a]);
  });

  it("keeps retrying a transient failure and recovers on wake without the prompt", async () => {
    const { clerk, a, b, add, enforcer, events, scheduled, cancelled, wake, onSettled, evaluate } =
      makeHarness();
    const setActive = clerk.setActive.getMockImplementation()!;
    clerk.setActive.mockRejectedValue(new TypeError("Failed to fetch"));

    add(b);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(evaluate()).toBe(false);
      await enforcer.settled();
      if (attempt < 7) scheduled[attempt]!.run();
    }
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(events.onExhausted).not.toHaveBeenCalled();

    // The network is back: the pending retry runs now instead of in 30s.
    clerk.setActive.mockImplementation(setActive);
    onSettled.mockClear();
    wake.current!();
    expect(cancelled).toEqual([7]);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(evaluate()).toBe(false);
    await enforcer.settled();

    expect(clerk.client.signedInSessions).toEqual([a]);
    expect(events.onRejected).toHaveBeenCalledTimes(1);
    expect(events.onExhausted).not.toHaveBeenCalled();
    expect(evaluate()).toBe(true);
  });

  it("treats a Clerk refusal as final but a server error as transient", async () => {
    const { clerk, add, a, enforcer, events, scheduled, evaluate } = makeHarness();
    clerk.signOut.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 503 }));

    add(a);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(evaluate()).toBe(false);
      await enforcer.settled();
      scheduled[attempt]!.run();
    }
    expect(events.onExhausted).not.toHaveBeenCalled();

    clerk.signOut.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    for (let attempt = 5; attempt < 8; attempt += 1) {
      expect(evaluate()).toBe(false);
      await enforcer.settled();
      scheduled[attempt]!.run();
    }
    expect(evaluate()).toBe(false);
    expect(events.onExhausted).toHaveBeenCalledTimes(1);
  });

  it("sends the exhaustion action through the platform sign-out and re-announces a failure", async () => {
    const { clerk, a, add, enforcer, events, scheduled, signOutEverywhere, onSettled, evaluate } =
      makeHarness();
    clerk.signOut.mockRejectedValue(new Error("refused"));
    add(a);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(evaluate()).toBe(false);
      await enforcer.settled();
      scheduled[attempt]!.run();
    }
    expect(evaluate()).toBe(false);
    expect(events.onExhausted).toHaveBeenCalledTimes(1);
    onSettled.mockClear();
    events.onError.mockClear();

    // Desktop blocks the sign-out when unpublishing this computer fails.
    const blocked = new Error("unpublish failed");
    signOutEverywhere.mockRejectedValueOnce(blocked);
    await events.onExhausted.mock.calls[0]![0]();
    expect(clerk.signOut).toHaveBeenCalledTimes(3);
    expect(events.onError).toHaveBeenCalledExactlyOnceWith(blocked);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(evaluate()).toBe(false);
    expect(events.onExhausted).toHaveBeenCalledTimes(2);

    await events.onExhausted.mock.calls[1]![0]();
    expect(signOutEverywhere).toHaveBeenCalledTimes(2);
  });

  it("re-runs a hold when Clerk settles without a render, and not on the subscribing emit", () => {
    const { clerk, a, emit, listeners, onSettled, evaluate, enforcer } = makeHarness();

    // Clerk went A -> undefined -> A and React batched the emits away, so the
    // caller still renders A while Clerk is momentarily undefined.
    clerk.session = undefined;
    const held = () =>
      enforcer.evaluate({
        clerk,
        renderedAccountId: "account-a",
        observedAccountId: undefined,
        persistedAccountId: null,
        onSettled,
      });
    expect(held()).toBe(false);
    expect(held()).toBe(false);
    expect(clerk.addListener).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();

    emit();
    expect(onSettled).not.toHaveBeenCalled();
    clerk.session = a;
    emit();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    expect(evaluate()).toBe(true);
  });

  it("drops its retry timer and subscriptions on dispose and stays usable", async () => {
    const { clerk, a, b, add, enforcer, scheduled, cancelled, wake, listeners, evaluate } =
      makeHarness();
    clerk.setActive.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    add(b);
    expect(evaluate()).toBe(false);
    await enforcer.settled();
    expect(scheduled).toHaveLength(1);
    expect(wake.current).not.toBeNull();

    enforcer.dispose();
    expect(cancelled).toEqual([0]);
    expect(wake.current).toBeNull();
    expect(listeners.size).toBe(0);

    expect(evaluate()).toBe(false);
    await enforcer.settled();
    expect(clerk.client.signedInSessions).toEqual([a]);
  });

  it("proceeds with cleanup when the served account expires while the extra remains", () => {
    const { clerk, b, evaluate } = makeHarness();

    clerk.client.signedInSessions = [b];
    clerk.session = b;
    expect(evaluate()).toBe(true);
    expect(clerk.setActive).not.toHaveBeenCalled();
    expect(clerk.signOut).not.toHaveBeenCalled();
  });

  it("stops rejecting a session that keeps coming back", async () => {
    const { clerk, a, add, enforcer, events, evaluate } = makeHarness();

    for (let round = 0; round < 5; round += 1) {
      add(a);
      expect(evaluate()).toBe(false);
      await enforcer.settled();
    }

    expect(clerk.signOut).toHaveBeenCalledTimes(3);
    expect(events.onRejected).toHaveBeenCalledTimes(1);
    expect(events.onExhausted).toHaveBeenCalledTimes(1);
  });

  it("asks for a reload once and signs nothing out when the marker is fresh", async () => {
    const { clerk, b, add, enforcer, events, evaluate } = makeHarness(true);

    expect(evaluate()).toBe(true);
    add(b);
    expect(evaluate()).toBe(false);
    expect(evaluate()).toBe(false);
    await enforcer.settled();

    expect(events.onStandDown).toHaveBeenCalledTimes(1);
    expect(clerk.setActive).not.toHaveBeenCalled();
    expect(clerk.signOut).not.toHaveBeenCalled();
  });
});
