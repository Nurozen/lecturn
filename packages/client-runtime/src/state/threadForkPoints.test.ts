import { MessageId, RunId, ThreadId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ForkPointMessage,
  forkCommandSource,
  forkParentThreadId,
  forkSourcePointForRun,
  forkableRunIdsByUserMessage,
  hasRunlessForkHistory,
  isDefaultForkChildTitle,
  isSameForkPoint,
  latestForkPoint,
  latestForkableRunId,
  resolveMessageForkPoints,
  resolveTurnTitleSeed,
} from "./threadForkPoints.ts";

const run = (id: string, message: string, status: "completed" | "running" | "rolled_back") => ({
  id: RunId.make(id),
  userMessageId: MessageId.make(message),
  status,
});

describe("Lecturn fork points on V2", () => {
  it("forks through a run", () => {
    expect(forkSourcePointForRun(RunId.make("run-1"))).toEqual({ type: "run", runId: "run-1" });
  });

  it("offers the latest run only once it completed", () => {
    const latestRun = {
      runId: RunId.make("run-2"),
      status: "completed" as const,
      requestedAt: null,
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    };
    expect(latestForkableRunId({ latestRun })).toBe("run-2");
    expect(latestForkableRunId({ latestRun: { ...latestRun, status: "running" } })).toBeNull();
    expect(latestForkableRunId({ latestRun: null })).toBeNull();
    expect(latestForkableRunId(null)).toBeNull();
  });

  it("maps user messages to completed runs and skips unfinished or reverted turns", () => {
    const map = forkableRunIdsByUserMessage([
      run("run-1", "message-1", "completed"),
      run("run-2", "message-2", "running"),
      run("run-3", "message-3", "rolled_back"),
      run("run-4", "message-4", "completed"),
    ]);
    expect([...map]).toEqual([
      ["message-1", "run-1"],
      ["message-4", "run-4"],
    ]);
    // Imported history has no run, so it is never a fork point.
    expect(map.has(MessageId.make("message-imported"))).toBe(false);
  });
});

describe("Lecturn fork points over run-less history", () => {
  const importedFrom = {
    driverKind: "codex",
    providerInstanceId: "codex",
    sessionId: "external-1",
    title: "Imported",
    cwd: "/repo",
    importedAt: "2026-01-01T00:00:00.000Z",
  } as never;
  const completedRun = {
    runId: RunId.make("run-1"),
    status: "completed" as const,
    requestedAt: null,
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  };
  const user = (id: string, runId: string | null = null): ForkPointMessage => ({
    id: MessageId.make(id),
    role: "user",
    runId: runId === null ? null : RunId.make(runId),
  });
  const reply = (id: string, runId: string | null = null, streaming = false): ForkPointMessage => ({
    id: MessageId.make(id),
    role: "assistant",
    runId: runId === null ? null : RunId.make(runId),
    streaming,
  });

  it("detects V1-migrated and imported history", () => {
    expect(
      hasRunlessForkHistory({ historyOrigin: "v1_import", importedFrom: null, forkedFrom: null }),
    ).toBe(true);
    expect(hasRunlessForkHistory({ historyOrigin: "native", importedFrom, forkedFrom: null })).toBe(
      true,
    );
    expect(
      hasRunlessForkHistory({ historyOrigin: "native", importedFrom: null, forkedFrom: null }),
    ).toBe(false);
    expect(hasRunlessForkHistory({ forkedFrom: null })).toBe(false);
    expect(hasRunlessForkHistory(null)).toBe(false);
  });

  it("forks the whole run-less history of a thread that never ran", () => {
    expect(
      latestForkPoint({ latestRun: null, historyOrigin: "v1_import", forkedFrom: null }),
    ).toEqual({
      type: "runless",
      messageId: null,
    });
    expect(latestForkPoint({ latestRun: null, importedFrom, forkedFrom: null })).toEqual({
      type: "runless",
      messageId: null,
    });
    // A completed run is the cut once the thread has one.
    expect(
      latestForkPoint({ latestRun: completedRun, historyOrigin: "v1_import", forkedFrom: null }),
    ).toEqual({
      type: "run",
      runId: "run-1",
    });
    // A run in flight blocks the fork; a native never-run thread has nothing.
    expect(
      latestForkPoint({
        latestRun: { ...completedRun, status: "running" },
        historyOrigin: "v1_import",
        forkedFrom: null,
      }),
    ).toBeNull();
    expect(
      latestForkPoint({ latestRun: null, historyOrigin: "native", forkedFrom: null }),
    ).toBeNull();
    expect(latestForkPoint(null)).toBeNull();
  });

  it("offers no run-less fork on a V2 fork child that inherits the history", () => {
    // ThreadForkService spreads the source thread, so a native fork child of an
    // imported or V1-migrated thread carries importedFrom/historyOrigin while
    // its run-less history stays on the parent; the server would reject it.
    const forkedFrom = {
      type: "run" as const,
      threadId: ThreadId.make("parent"),
      runId: RunId.make("parent-run"),
    };
    const nativeChild = {
      latestRun: null,
      historyOrigin: "v1_import" as const,
      importedFrom,
      forkedFrom,
    };
    expect(hasRunlessForkHistory(nativeChild)).toBe(false);
    expect(latestForkPoint(nativeChild)).toBeNull();
    // Its own completed run is still a fork point.
    expect(latestForkPoint({ ...nativeChild, latestRun: completedRun })).toEqual({
      type: "run",
      runId: "run-1",
    });
    // A run-less fork child (forkedFrom null) owns its copied history.
    const runlessChild = { latestRun: null, importedFrom, forkedFrom: null };
    expect(hasRunlessForkHistory(runlessChild)).toBe(true);
    expect(latestForkPoint(runlessChild)).toEqual({ type: "runless", messageId: null });
  });

  it("builds thread.fork source fields the server resolves", () => {
    const runId = RunId.make("run-1");
    const anchor = MessageId.make("message-1");
    expect(forkCommandSource({ type: "run", runId })).toEqual({
      sourcePoint: { type: "run", runId },
    });
    expect(forkCommandSource({ type: "run", runId }, anchor)).toEqual({
      sourcePoint: { type: "run", runId },
      sourceMessageId: anchor,
    });
    // Run-less cut: message-addressed on latest_stable; the anchor argument is moot.
    expect(forkCommandSource({ type: "runless", messageId: anchor })).toEqual({
      sourcePoint: { type: "latest_stable" },
      sourceMessageId: anchor,
    });
    expect(forkCommandSource({ type: "runless", messageId: null })).toEqual({
      sourcePoint: { type: "latest_stable" },
    });
  });

  it("cuts run-less history at the turn before each user message and at each reply", () => {
    const { byUserMessage, byRunlessReply } = resolveMessageForkPoints({
      messages: [
        user("u1"),
        reply("a1"),
        user("u2"),
        reply("a2"),
        user("u3", "run-1"),
        reply("a3", "run-1"),
        user("u4", "run-2"),
        reply("a4", "run-2", true),
      ],
      completedRunIds: new Set([RunId.make("run-1")]),
      activeRunId: RunId.make("run-2"),
      runlessHistory: true,
    });
    expect([...byUserMessage]).toEqual([
      ["u2", { type: "runless", messageId: "u1" }],
      // The first Lecturn turn after the history cuts at the last run-less turn.
      ["u3", { type: "runless", messageId: "u2" }],
      ["u4", { type: "run", runId: "run-1" }],
    ]);
    expect([...byRunlessReply]).toEqual([
      ["a1", { type: "runless", messageId: "u1" }],
      ["a2", { type: "runless", messageId: "u2" }],
    ]);
  });

  it("offers no run-less cuts without run-less history, and none on the first message", () => {
    const messages = [user("u1"), reply("a1"), user("u2", "run-1"), reply("a2", "run-1")];
    const native = resolveMessageForkPoints({
      messages,
      completedRunIds: new Set([RunId.make("run-1")]),
      activeRunId: null,
      runlessHistory: false,
    });
    expect([...native.byUserMessage]).toEqual([]);
    expect([...native.byRunlessReply]).toEqual([]);
    const inherited = resolveMessageForkPoints({
      messages: [
        { ...user("u0"), inherited: true },
        { ...reply("a0"), inherited: true },
        user("u1"),
      ],
      completedRunIds: new Set(),
      activeRunId: null,
      runlessHistory: true,
    });
    expect(inherited.byUserMessage.size).toBe(0);
  });

  it("compares fork points by value", () => {
    const runId = RunId.make("run-1");
    const messageId = MessageId.make("u1");
    expect(isSameForkPoint({ type: "run", runId }, { type: "run", runId })).toBe(true);
    expect(isSameForkPoint({ type: "runless", messageId }, { type: "runless", messageId })).toBe(
      true,
    );
    expect(isSameForkPoint({ type: "run", runId }, { type: "runless", messageId: null })).toBe(
      false,
    );
  });
});

describe("Lecturn fork child title seed", () => {
  const parentId = ThreadId.make("thread-parent");
  const child = (title: string) => ({
    title,
    forkedFrom: null,
    forkOrigin: { threadId: parentId, messageId: null },
  });

  it("finds the parent from forkOrigin or a run forkedFrom", () => {
    expect(forkParentThreadId(child("x"))).toBe(parentId);
    expect(
      forkParentThreadId({
        forkedFrom: { type: "run", threadId: parentId, runId: RunId.make("run-1") },
        forkOrigin: null,
      }),
    ).toBe(parentId);
    expect(forkParentThreadId({ forkedFrom: null, forkOrigin: null })).toBeNull();
  });

  it("treats Lecturn and upstream minted titles as default", () => {
    expect(isDefaultForkChildTitle("Plan (fork)", "Plan")).toBe(true);
    expect(isDefaultForkChildTitle("Untitled (fork)", null)).toBe(true);
    expect(isDefaultForkChildTitle("Plan fork", "Plan")).toBe(true);
    // Without the parent title a bare " fork" suffix may be the user's rename.
    expect(isDefaultForkChildTitle("Spoon fork", null)).toBe(false);
    expect(isDefaultForkChildTitle("Spoon fork", "Plan")).toBe(false);
  });

  it("seeds a default fork title, skips a renamed fork, and seeds others from the message", () => {
    const messageTitleSeed = "Fix the build";
    expect(
      resolveTurnTitleSeed({ thread: child("Plan (fork)"), parentTitle: "Plan", messageTitleSeed }),
    ).toBe("Plan (fork)");
    expect(
      resolveTurnTitleSeed({ thread: child("Plan fork"), parentTitle: "Plan", messageTitleSeed }),
    ).toBe("Plan fork");
    expect(
      resolveTurnTitleSeed({ thread: child("My name"), parentTitle: "Plan", messageTitleSeed }),
    ).toBeUndefined();
    expect(
      resolveTurnTitleSeed({
        thread: { title: "New thread", forkedFrom: null, forkOrigin: null },
        messageTitleSeed,
      }),
    ).toBe(messageTitleSeed);
  });
});
