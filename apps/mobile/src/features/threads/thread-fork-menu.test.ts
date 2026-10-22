import { describe, expect, it } from "vite-plus/test";

import { buildThreadForkMenuItems, resolveThreadForkAvailability } from "./thread-fork-menu";

const forkableInput = {
  serverSupportsForking: true,
  latestRun: { status: "completed" as const },
  runtimeStatus: "idle" as const,
  connected: true,
};

describe("resolveThreadForkAvailability", () => {
  it("allows forking a connected, capable thread at a completed run", () => {
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

  it("refuses while the latest run is running or the runtime is starting", () => {
    expect(
      resolveThreadForkAvailability({
        ...forkableInput,
        latestRun: { status: "running" },
        runtimeStatus: "running",
      }),
    ).toEqual({ available: false, reason: "turn-in-progress" });
    expect(resolveThreadForkAvailability({ ...forkableInput, runtimeStatus: "starting" })).toEqual({
      available: false,
      reason: "turn-in-progress",
    });
  });

  it("refuses threads without a completed run to fork from", () => {
    expect(resolveThreadForkAvailability({ ...forkableInput, latestRun: null })).toEqual({
      available: false,
      reason: "no-completed-turn",
    });
    expect(
      resolveThreadForkAvailability({ ...forkableInput, latestRun: { status: "interrupted" } }),
    ).toEqual({ available: false, reason: "no-completed-turn" });
    expect(
      resolveThreadForkAvailability({ ...forkableInput, latestRun: { status: "failed" } }),
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
