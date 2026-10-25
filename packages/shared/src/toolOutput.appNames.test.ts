import { describe, expect, it } from "vite-plus/test";

import {
  LECTURN_MCP_APP_SERVER,
  compactDynamicToolOutput,
  mcpAppFromToolItem,
} from "./toolOutput.ts";

const card = {
  attachmentId: "thread-1-abc-html",
  server: LECTURN_MCP_APP_SERVER,
  tool: "ex_counter",
  resourceUri: "ui://ex/counter-card",
};
const envelope = { lecturnMcpApp: card, result: { count: 3 } };

// The forms each adapter records a call to Lecturn's own MCP server under.
const recordedNames = {
  claude: "mcp__lecturn__ex_counter",
  codex: "lecturn.ex_counter",
  opencode: "lecturn-3f2a9c1e-8b7d-4c6e-9a0b-1d2e3f4a5b6c_ex_counter",
};

describe("mcpAppFromToolItem for connected-app cards", () => {
  it.each(Object.entries(recordedNames))("accepts the %s tool name", (_adapter, toolName) => {
    expect(mcpAppFromToolItem({ toolName, output: envelope })).toEqual(card);
    expect(mcpAppFromToolItem({ toolName, output: compactDynamicToolOutput(envelope) })).toEqual(
      card,
    );
  });

  it("reads the envelope whether the adapter kept structuredContent or only its text", () => {
    const toolName = recordedNames.claude;
    expect(mcpAppFromToolItem({ toolName, output: { structuredContent: envelope } })).toEqual(card);
    expect(
      mcpAppFromToolItem({
        toolName,
        output: [{ type: "text", text: JSON.stringify(envelope) }],
      }),
    ).toEqual(card);
    expect(
      mcpAppFromToolItem({ toolName, output: [{ type: "text", text: "count: 3" }] }),
    ).toBeUndefined();
  });

  it("refuses a Lecturn reference from another tool or another server's call", () => {
    for (const toolName of [
      "mcp__lecturn__ex_other",
      "lecturn.ex_other",
      "mcp__weather__ex_counter",
      "weather.ex_counter",
      "ex_counter",
      null,
    ]) {
      expect(mcpAppFromToolItem({ toolName, output: envelope })).toBeUndefined();
    }
  });

  it("keeps other servers to the exact server.tool form", () => {
    const weather = { ...card, server: "weather", tool: "get_weather" };
    const output = { lecturnMcpApp: weather };
    expect(mcpAppFromToolItem({ toolName: "weather.get_weather", output })).toEqual(weather);
    expect(mcpAppFromToolItem({ toolName: "mcp__weather__get_weather", output })).toBeUndefined();
    expect(mcpAppFromToolItem({ toolName: "mcp__lecturn__get_weather", output })).toBeUndefined();
  });
});
