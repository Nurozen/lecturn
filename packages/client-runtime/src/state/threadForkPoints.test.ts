import { MessageId, RunId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forkSourcePointForRun,
  forkableRunIdsByUserMessage,
  latestForkableRunId,
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
