import { describe, expect, it } from "vite-plus/test";

import { buildThreadForkMenuItems, resolveThreadForkAvailability } from "./thread-fork-menu";

const forkableInput = {
  serverSupportsForking: true,
  providerConversationFork: "native",
  latestTurn: { state: "completed" as const },
  sessionStatus: "ready" as const,
  connected: true,
};

describe("resolveThreadForkAvailability", () => {
  it("allows forking a connected, capable thread at a completed turn", () => {
    expect(resolveThreadForkAvailability(forkableInput)).toEqual({ available: true });
  });

  it("refuses while the environment is disconnected", () => {
    expect(resolveThreadForkAvailability({ ...forkableInput, connected: false })).toEqual({
      available: false,
      reason: "disconnected",
    });
  });

  it("refuses when the server does not advertise the capability", () => {
    expect(
      resolveThreadForkAvailability({ ...forkableInput, serverSupportsForking: false }),
    ).toEqual({ available: false, reason: "server-unsupported" });
  });

  it("refuses providers without native conversation forking", () => {
    expect(
      resolveThreadForkAvailability({ ...forkableInput, providerConversationFork: "unsupported" }),
    ).toEqual({ available: false, reason: "provider-unsupported" });
    expect(
      resolveThreadForkAvailability({ ...forkableInput, providerConversationFork: null }),
    ).toEqual({ available: false, reason: "provider-unsupported" });
  });

  it("refuses while the latest turn is running or a session is starting", () => {
    expect(
      resolveThreadForkAvailability({
        ...forkableInput,
        latestTurn: { state: "running" },
        sessionStatus: "running",
      }),
    ).toEqual({ available: false, reason: "turn-in-progress" });
    expect(resolveThreadForkAvailability({ ...forkableInput, sessionStatus: "starting" })).toEqual({
      available: false,
      reason: "turn-in-progress",
    });
  });

  it("refuses threads without a completed turn to fork from", () => {
    expect(resolveThreadForkAvailability({ ...forkableInput, latestTurn: null })).toEqual({
      available: false,
      reason: "no-completed-turn",
    });
    expect(
      resolveThreadForkAvailability({ ...forkableInput, latestTurn: { state: "interrupted" } }),
    ).toEqual({ available: false, reason: "no-completed-turn" });
    expect(
      resolveThreadForkAvailability({ ...forkableInput, latestTurn: { state: "error" } }),
    ).toEqual({ available: false, reason: "no-completed-turn" });
  });
});

describe("buildThreadForkMenuItems", () => {
  it("hides forking when the environment or provider does not support it", () => {
    expect(
      buildThreadForkMenuItems({ supported: false, inFlight: false, canForkNow: true }),
    ).toEqual([]);
  });

  it("offers forking for a supported thread with a completed latest turn", () => {
    expect(
      buildThreadForkMenuItems({ supported: true, inFlight: false, canForkNow: true }),
    ).toEqual([
      {
        id: "fork-thread",
        title: "Fork thread",
        image: "arrow.triangle.branch",
      },
    ]);
  });

  it("disables the item while the thread has no completed latest turn", () => {
    expect(
      buildThreadForkMenuItems({ supported: true, inFlight: false, canForkNow: false }),
    ).toEqual([
      {
        id: "fork-thread",
        title: "Fork thread",
        image: "arrow.triangle.branch",
        attributes: { disabled: true },
      },
    ]);
  });

  it("shows and disables the in-flight state", () => {
    expect(buildThreadForkMenuItems({ supported: true, inFlight: true, canForkNow: true })).toEqual(
      [
        {
          id: "fork-thread",
          title: "Forking…",
          image: "arrow.triangle.branch",
          attributes: { disabled: true },
        },
      ],
    );
  });
});
