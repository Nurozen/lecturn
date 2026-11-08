import { describe, expect, it } from "vite-plus/test";

import {
  LECTURN_MCP_TOOL_NAMES,
  resolveLecturnMcpSummaryAction,
  resolveLecturnMcpToolDefinition,
  resolveLecturnMcpToolPresentation,
} from "./lecturnMcpToolPresentation.ts";

describe("resolveLecturnMcpToolPresentation", () => {
  it("recognizes every Lecturn tool across provider prefixes and completion suffixes", () => {
    for (const tool of LECTURN_MCP_TOOL_NAMES) {
      const presentation = resolveLecturnMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__lecturn__",
        "Lecturn.",
        "lecturn/",
        "lecturn:",
        "mcp_lecturn_",
        "Lecturn ",
        "lecturn · ",
      ]) {
        expect(resolveLecturnMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveLecturnMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("resolves bare tool names that share the server prefix", () => {
    expect(resolveLecturnMcpToolPresentation("lecturn_thread_read")?.displayName).toBe(
      "Read a Lecturn thread",
    );
    expect(resolveLecturnMcpToolPresentation("mcp__t3-code__lecturn_thread_read")).toBeNull();
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveLecturnMcpToolPresentation("lecturn-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveLecturnMcpToolPresentation("lecturn-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });
});

describe("resolveLecturnMcpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveLecturnMcpToolDefinition("mcp__lecturn__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveLecturnMcpToolDefinition("preview_type")?.labels);
    expect(
      resolveLecturnMcpToolDefinition("lecturn_thread_transfer", { action: "fork" })?.displayName,
    ).toBe(resolveLecturnMcpToolDefinition("lecturn_thread_fork")?.displayName);
    expect(resolveLecturnMcpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("resolveLecturnMcpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveLecturnMcpSummaryAction("mcp__lecturn__lecturn_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveLecturnMcpSummaryAction("lecturn_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveLecturnMcpSummaryAction("lecturn_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveLecturnMcpSummaryAction("lecturn_thread_configure", {})).toBe(
      "thread-configuration",
    );
    expect(resolveLecturnMcpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveLecturnMcpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});
