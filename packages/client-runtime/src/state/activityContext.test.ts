import { describe, expect, it } from "vite-plus/test";
import {
  activityVisualState,
  threadActivityExcerpt,
  describeThreadActivity,
  type ActivityThreadContext,
} from "./activityContext.ts";

const thread: ActivityThreadContext = {
  title: "Fix the failing CI check",
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestUserMessageAt: "2026-09-13T12:00:00Z",
};
const message = (role: "user" | "assistant", text: string, createdAt: string) => ({
  role,
  text,
  createdAt,
  updatedAt: createdAt,
});
describe("activity task context", () => {
  it("includes only the current turn's most recent assistant text", () => {
    const result = describeThreadActivity(thread, [
      message("assistant", "Earlier task is finished", "2026-09-13T11:59:00Z"),
      message("assistant", "Inspecting the failing assertion", "2026-09-13T12:00:01Z"),
      message("user", "private next prompt", "2026-09-13T12:00:02Z"),
    ]);
    expect(result).toContain("Inspecting the failing assertion");
    expect(result).not.toContain("Earlier task");
    expect(result).not.toContain("private next prompt");
  });
  it("retains the task and precise blocker alongside progress", () => {
    const result = describeThreadActivity({
      ...thread,
      hasPendingApprovals: true,
      planProgress: { step: "Run targeted tests", completedSteps: 2, totalSteps: 3 },
    });
    expect(result).toContain("Waiting for your approval");
    expect(result).toContain("Run targeted tests (2/3 complete)");
  });
  it("does not mislabel a silent agent as stuck or reuse prior-turn progress", () => {
    const result = describeThreadActivity(thread, [
      message("assistant", "Done", "2026-09-13T11:59:00Z"),
    ]);
    expect(result).toContain(thread.title);
    expect(result).toContain("No progress update yet");
    expect(result).not.toContain("stuck");
    expect(result).not.toContain("Done");
  });
});

describe("compact activity cues", () => {
  it("does not confuse a passing check with completed work", () => {
    expect(
      activityVisualState({
        status: "unassigned · checks passing",
        checks: [{ status: "success" }],
      }),
    ).toBe("idle");
    expect(activityVisualState({ status: "Merged", checks: [{ status: "success" }] })).toBe(
      "complete",
    );
    expect(activityVisualState({ status: "Idle", settled: true })).toBe("complete");
  });
  it("prioritizes offline, blockers and failures over running work", () => {
    expect(
      activityVisualState({ status: "Offline · last observed", checks: [{ status: "pending" }] }),
    ).toBe("offline");
    expect(activityVisualState({ status: "Needs approval", checks: [{ status: "pending" }] })).toBe(
      "attention",
    );
    expect(activityVisualState({ status: "working", checks: [{ status: "failure" }] })).toBe(
      "failed",
    );
    expect(activityVisualState({ checks: [{ status: "pending" }] })).toBe("active");
    expect(activityVisualState({ checks: [{ status: "neutral" }] })).toBe("idle");
  });
  it("bounds the excerpt to current assistant text and keeps explicit blockers first", () => {
    const messages = [
      message("assistant", "Earlier task", "2026-09-13T11:59:00Z"),
      message("assistant", "Inspecting\n  tests " + "x".repeat(250), "2026-09-13T12:00:01Z"),
      message("user", "ignore this prompt", "2026-09-13T12:00:02Z"),
    ];
    const excerpt = threadActivityExcerpt(thread, messages);
    expect(excerpt).toHaveLength(180);
    expect(excerpt).toMatch(/^Inspecting tests /);
    expect(excerpt).not.toContain("ignore this");
    expect(threadActivityExcerpt({ ...thread, hasPendingUserInput: true }, messages)).toBe(
      "Waiting for your answer",
    );
    expect(threadActivityExcerpt(thread, [messages[0]!])).toBe("No task update yet");
  });
});
