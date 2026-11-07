import { describe, expect, it } from "@effect/vitest";
import { setRegisteredAppToolPresentations } from "@lecturn/shared/appToolPresentation";
import { mcpToolPresentation, mcpToolResultOutput } from "./mcpToolPresentation.ts";

describe("mcpToolPresentation", () => {
  it.each([
    "javascript:alert(1)",
    "file:///tmp/logo.png",
    "not a URL",
    "https://example.com/" + "x".repeat(4096),
  ])("ignores an invalid logo %s", (iconUrl) => {
    expect(
      mcpToolPresentation({
        serverName: "weather",
        toolName: "get_weather",
        iconUrl,
        title: "x".repeat(161),
      }),
    ).toEqual({
      title: "get weather",
      toolSource: { key: "mcp:weather", name: "weather", kind: "integration" },
    });
  });
  it("brands a registered app's tools with the app instead of Lecturn's server", () => {
    const icon = "data:image/png;base64,iVBORw0KGgo=";
    setRegisteredAppToolPresentations([
      { appId: "dev.rocketwright.app", name: "RocketWright", toolPrefix: "rw", iconDataUrl: icon },
    ]);
    try {
      const branded = {
        title: "rw_simulate",
        toolIcon: { _tag: "themed-logo", logoUrl: icon },
        toolSource: {
          key: "app:dev.rocketwright.app",
          name: "RocketWright",
          kind: "integration",
          icon: { _tag: "themed-logo", logoUrl: icon },
        },
      };
      expect(mcpToolPresentation({ toolName: "mcp__lecturn__rw_simulate" })).toEqual(branded);
      expect(mcpToolPresentation({ serverName: "lecturn", toolName: "rw_simulate" })).toEqual(
        branded,
      );
      expect(
        mcpToolPresentation({ serverName: "lecturn-0f9a1c2e", toolName: "rw_task_status" })
          .toolSource?.key,
      ).toBe("app:dev.rocketwright.app");
      expect(
        mcpToolPresentation({ serverName: "rocketwright", toolName: "rw_simulate" }).toolSource
          ?.key,
      ).toBe("mcp:rocketwright");
      expect(mcpToolPresentation({ serverName: "lecturn", toolName: "task_status" })).toEqual({});
      setRegisteredAppToolPresentations([
        {
          appId: "dev.rocketwright.app",
          name: "RocketWright",
          toolPrefix: "rw",
          iconDataUrl: icon,
          toolTitles: new Map([["simulate", "Simulate flight"]]),
        },
      ]);
      expect(
        mcpToolPresentation({ toolName: "mcp__lecturn__rw_simulate", title: "rw_simulate" }).title,
      ).toBe("Simulate flight");
      expect(
        mcpToolPresentation({ serverName: "lecturn", toolName: "rw_motor_search" }).title,
      ).toBe("rw_motor_search");
    } finally {
      setRegisteredAppToolPresentations([]);
    }
  });
});

describe("mcpToolResultOutput", () => {
  const content = [{ type: "text", text: "3 motors" }];

  it("keeps structured content, else the content blocks", () => {
    expect(mcpToolResultOutput({ content, structuredContent: { count: 3 } })).toEqual({
      count: 3,
    });
    expect(mcpToolResultOutput({ content, structuredContent: null })).toEqual(content);
    expect(mcpToolResultOutput({ content, _meta: { "openai/outputTemplate": "ui://x" } })).toEqual(
      content,
    );
    expect(mcpToolResultOutput(null)).toBeUndefined();
  });

  it("keeps a result's lecturn/* _meta in its MCP shape, without other keys", () => {
    expect(
      mcpToolResultOutput({
        content,
        structuredContent: { count: 3 },
        _meta: { "lecturn/summary": "3 candidates", "openai/outputTemplate": "ui://x" },
      }),
    ).toEqual({
      content,
      structuredContent: { count: 3 },
      _meta: { "lecturn/summary": "3 candidates" },
    });
    expect(mcpToolResultOutput({ content, _meta: { "lecturn/summary": "3 candidates" } })).toEqual({
      content,
      _meta: { "lecturn/summary": "3 candidates" },
    });
  });
});
