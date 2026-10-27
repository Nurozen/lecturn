import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import { ProviderInstanceId, RunId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { resolveThreadStatusBadge, resolveThreadStatusLabel } from "./thread-status-badge";

const NOW = "2026-10-25T12:00:00.000Z";

const running = {
  status: "running",
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  lastErrorClass: null,
  updatedAt: NOW,
} satisfies EnvironmentThreadShell["runtime"];

const finished = {
  runId: RunId.make("run-1"),
  status: "completed",
  requestedAt: "2026-10-25T11:00:00.000Z",
  startedAt: "2026-10-25T11:00:00.000Z",
  completedAt: "2026-10-25T11:10:00.000Z",
  assistantMessageId: null,
} satisfies EnvironmentThreadShell["latestRun"];

const badgeOf = (overrides: Partial<EnvironmentThreadShell>) =>
  resolveThreadStatusBadge(makeThreadShellFixture(overrides))?.label;

describe("thread status badge", () => {
  it("marks a running thread waiting on approval apart from one that is just working", () => {
    expect(badgeOf({ runtime: running, hasPendingApprovals: true })).toBe("Approval");
    expect(badgeOf({ runtime: running, pendingSubagentRequest: "approval" })).toBe("Approval");
    expect(badgeOf({ runtime: running })).toBeUndefined();
  });

  it("keeps the working label for announcements, including an active goal", () => {
    expect(resolveThreadStatusLabel(makeThreadShellFixture({ runtime: running }))?.label).toBe(
      "Working",
    );
    const goal = makeThreadShellFixture({
      runtime: running,
      goal: { objective: "Fly higher", status: "active" },
    });
    expect(resolveThreadStatusLabel(goal)?.label).toBe("Goal");
    expect(resolveThreadStatusBadge(goal)).toBeUndefined();
  });

  it("names input, failures and usage limits", () => {
    expect(badgeOf({ hasPendingUserInput: true })).toBe("Input");
    expect(badgeOf({ runtime: { ...running, status: "failed" } })).toBe("Failed");
    expect(
      badgeOf({ runtime: { ...running, status: "failed", lastErrorClass: "usage_limit" } }),
    ).toBe("Limited");
  });

  it("shows Done for a finished run until the thread is opened, then nothing", () => {
    expect(badgeOf({ latestRun: finished, lastVisitedAt: "2026-10-25T11:05:00.000Z" })).toBe(
      "Done",
    );
    expect(
      badgeOf({ latestRun: finished, lastVisitedAt: "2026-10-25T11:20:00.000Z" }),
    ).toBeUndefined();
    expect(badgeOf({})).toBeUndefined();
  });
});
