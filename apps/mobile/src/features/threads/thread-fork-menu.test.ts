import { RunId, ThreadId } from "@lecturn/contracts";
import { hasRunlessForkHistory } from "@lecturn/client-runtime/state/thread-fork-points";
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

  it("allows a never-run thread with V1-migrated or imported history (whole-thread fork)", () => {
    expect(
      resolveThreadForkAvailability({ ...forkableInput, latestRun: null, runlessHistory: true }),
    ).toEqual({ available: true });
    // The availability gate still applies before the run-less history does.
    expect(
      resolveThreadForkAvailability({
        ...forkableInput,
        latestRun: null,
        runlessHistory: true,
        serverSupportsForking: false,
      }),
    ).toEqual({ available: false, reason: "server-unsupported" });
    expect(
      resolveThreadForkAvailability({
        ...forkableInput,
        latestRun: null,
        runlessHistory: true,
        runtimeStatus: "starting",
      }),
    ).toEqual({ available: false, reason: "turn-in-progress" });
  });
});

describe("whole-thread fork of a never-run fork child", () => {
  const importedFrom = {
    driverKind: "codex",
    providerInstanceId: "codex",
    sessionId: "external-1",
    title: "Imported",
    cwd: "/repo",
    importedAt: "2026-01-01T00:00:00.000Z",
  } as never;
  const availability = (thread: Parameters<typeof hasRunlessForkHistory>[0]) =>
    resolveThreadForkAvailability({
      ...forkableInput,
      latestRun: null,
      runlessHistory: hasRunlessForkHistory(thread),
    });

  it("refuses a V2 fork child whose inherited run-less history stays on the parent", () => {
    // The child copies importedFrom/historyOrigin from its source; the server
    // finds no run-less items of its own and would reject the fork.
    expect(
      availability({
        importedFrom,
        historyOrigin: "v1_import",
        forkedFrom: { type: "run", threadId: ThreadId.make("parent"), runId: RunId.make("run-1") },
      }),
    ).toEqual({ available: false, reason: "no-completed-turn" });
  });

  it("allows a run-less fork child, which owns its copied history", () => {
    expect(availability({ importedFrom, forkedFrom: null })).toEqual({ available: true });
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
