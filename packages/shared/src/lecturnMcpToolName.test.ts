import { describe, expect, it } from "vite-plus/test";

import { lecturnMcpToolName } from "./lecturnMcpToolName.ts";

describe("lecturnMcpToolName", () => {
  it("reads the tool from every adapter's recorded form", () => {
    expect(lecturnMcpToolName("mcp__lecturn__rw_set_fins")).toBe("rw_set_fins");
    expect(lecturnMcpToolName("lecturn.rw_set_fins")).toBe("rw_set_fins");
    expect(lecturnMcpToolName("lecturn-3f2a9c1e-8b7d-4c6e-9a0b-1d2e3f4a5b6c_rw_set_fins")).toBe(
      "rw_set_fins",
    );
    expect(lecturnMcpToolName("lecturn-0123456789abcdef_lecturn_thread_list")).toBe(
      "lecturn_thread_list",
    );
  });

  it("rejects other servers and malformed names", () => {
    expect(lecturnMcpToolName("mcp__github__create_issue")).toBeNull();
    expect(lecturnMcpToolName("github.create_issue")).toBeNull();
    expect(lecturnMcpToolName("mcp__lecturn__")).toBeNull();
    expect(lecturnMcpToolName("lecturn.")).toBeNull();
    expect(lecturnMcpToolName("lecturn-_rw_x")).toBeNull();
    expect(lecturnMcpToolName("lecturn_rw_x")).toBeNull();
    expect(lecturnMcpToolName("xlecturn.rw_x")).toBeNull();
    expect(lecturnMcpToolName("rw_x")).toBeNull();
    expect(lecturnMcpToolName(null)).toBeNull();
    expect(lecturnMcpToolName(undefined)).toBeNull();
  });
});
