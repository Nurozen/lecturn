import { describe, expect, it } from "vite-plus/test";

import {
  LECTURN_MCP_TOOL_NAMES,
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
  it("pretty prints Claude and Cursor Lecturn MCP tool names", () => {
    expect(resolveLecturnMcpToolPresentation("mcp__lecturn__lecturn_thread_read")).toEqual({
      displayName: "Read a Lecturn thread",
      logo: "lecturn",
    });
  });

  it("pretty prints Codex Lecturn MCP tool names", () => {
    expect(resolveLecturnMcpToolPresentation("lecturn.create_threads")).toEqual({
      displayName: "Create Lecturn threads",
      logo: "lecturn",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveLecturnMcpToolPresentation("mcp__lecturn__lecturn_thread_update")).toEqual({
      displayName: "Update Lecturn thread metadata",
      logo: "lecturn",
    });
  });

  it("pretty prints bare Lecturn MCP toolkit names", () => {
    expect(resolveLecturnMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "lecturn",
    });
  });

  it("pretty prints worktree Lecturn MCP tool names", () => {
    expect(resolveLecturnMcpToolPresentation("mcp__lecturn__lecturn_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "lecturn",
    });
    expect(resolveLecturnMcpToolPresentation("lecturn.lecturn_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "lecturn",
    });
  });

  it("pretty prints preview Lecturn MCP tool names", () => {
    expect(resolveLecturnMcpToolPresentation("Lecturn.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "lecturn",
    });
    expect(resolveLecturnMcpToolPresentation("mcp__lecturn__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "lecturn",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_lecturn_delegate_task",
      "lecturn:delegate_task",
      "lecturn/delegate_task",
      "lecturn delegate_task",
      "Lecturn delegate_task",
      "lecturn__delegate_task",
    ]) {
      expect(resolveLecturnMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("resolves bare tool names that share the server prefix", () => {
    expect(resolveLecturnMcpToolPresentation("lecturn_thread_read")?.displayName).toBe(
      "Read a Lecturn thread",
    );
    expect(resolveLecturnMcpToolPresentation("mcp__t3-code__lecturn_thread_read")).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveLecturnMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveLecturnMcpToolPresentation("lecturn.not_a_real_tool")).toBeNull();
  });
});
