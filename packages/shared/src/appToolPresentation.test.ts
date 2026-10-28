import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  appToolPresentationMap,
  appToolRawName,
  appToolSource,
  appToolTitle,
  MAX_APP_TOOL_ICON_URL_LENGTH,
  resolveAppToolPresentation,
  setRegisteredAppToolPresentations,
} from "./appToolPresentation.ts";
import {
  resolveLecturnMcpToolDefinition,
  resolveLecturnMcpToolPresentation,
} from "./lecturnMcpToolPresentation.ts";

const icon = "data:image/png;base64,iVBORw0KGgo=";
const rocketwright = {
  appId: "dev.rocketwright.app",
  name: "RocketWright",
  toolPrefix: "rw",
  iconDataUrl: icon,
};
const rocketwrightSource = {
  key: "app:dev.rocketwright.app",
  name: "RocketWright",
  kind: "integration",
  icon: { _tag: "themed-logo", logoUrl: icon },
};
const apps = appToolPresentationMap([rocketwright]);

afterEach(() => setRegisteredAppToolPresentations([]));

describe("resolveAppToolPresentation", () => {
  it("brands a registered prefix under every name adapters record for Lecturn's server", () => {
    for (const toolName of [
      "mcp__lecturn__rw_simulate",
      "lecturn.rw_simulate",
      "lecturn-0f9a1c2e-4b7d-4a39-9d5e-6c1f2b3a4d5e_rw_simulate",
    ]) {
      expect(resolveAppToolPresentation({ toolName }, apps)).toEqual({
        app: rocketwright,
        toolName: "rw_simulate",
        toolSource: rocketwrightSource,
      });
    }
    for (const serverName of ["lecturn", "lecturn-0f9a1c2e"]) {
      expect(
        resolveAppToolPresentation({ serverName, toolName: "rw_engine_simulate" }, apps)?.toolName,
      ).toBe("rw_engine_simulate");
    }
  });

  it("leaves other servers, unregistered prefixes and bare prefixes alone", () => {
    for (const input of [
      { serverName: "rocketwright", toolName: "rw_simulate" },
      { toolName: "mcp__firecrawl__rw_simulate" },
      { toolName: "rw_simulate" },
      { toolName: "mcp__lecturn__ex_simulate" },
      { toolName: "mcp__lecturn__rw_" },
      { toolName: "mcp__lecturn__rw" },
      { toolName: null },
    ]) {
      expect(resolveAppToolPresentation(input, apps)).toBeNull();
    }
  });

  it("leaves an icon too large for a turn item off the source", () => {
    const large = `data:image/png;base64,${"A".repeat(MAX_APP_TOOL_ICON_URL_LENGTH)}`;
    const presentation = resolveAppToolPresentation(
      { toolName: "mcp__lecturn__rw_simulate" },
      appToolPresentationMap([{ ...rocketwright, iconDataUrl: large }]),
    );
    expect(presentation?.toolSource).toEqual({
      key: "app:dev.rocketwright.app",
      name: "RocketWright",
      kind: "integration",
    });
  });

  it("follows the registered apps until they are cleared", () => {
    expect(resolveAppToolPresentation({ toolName: "lecturn.rw_simulate" })).toBeNull();
    setRegisteredAppToolPresentations([rocketwright]);
    expect(resolveAppToolPresentation({ toolName: "lecturn.rw_simulate" })?.app).toEqual(
      rocketwright,
    );
    setRegisteredAppToolPresentations([]);
    expect(resolveAppToolPresentation({ toolName: "lecturn.rw_simulate" })).toBeNull();
  });

  it("keeps an app tool ending in a Lecturn tool's name off Lecturn's own rows", () => {
    const openCodeName = "lecturn-0f9a1c2e_rw_task_status";
    expect(resolveLecturnMcpToolDefinition(openCodeName)).not.toBeNull();
    setRegisteredAppToolPresentations([rocketwright]);
    expect(resolveLecturnMcpToolDefinition(openCodeName)).toBeNull();
    expect(resolveLecturnMcpToolPresentation("mcp__lecturn__task_status")).not.toBeNull();
  });
});

describe("app tool titles", () => {
  it("reads MCP's title, then the annotation title, as one plain line", () => {
    expect(appToolTitle({ title: " Find\n motors ", annotations: { title: "Other" } })).toBe(
      "Find motors",
    );
    expect(appToolTitle({ annotations: { title: "Check design" } })).toBe("Check design");
    expect(appToolTitle({ title: "x".repeat(81), annotations: { title: "Fallback" } })).toBe(
      "Fallback",
    );
    expect(appToolTitle({ title: 7, annotations: [] })).toBeUndefined();
  });

  it("titles a registered app's tool and keeps its called name for the detail", () => {
    const titled = appToolPresentationMap([
      { ...rocketwright, toolTitles: new Map([["motor_search", "Find motors"]]) },
    ]);
    expect(resolveAppToolPresentation({ toolName: "lecturn.rw_motor_search" }, titled)?.title).toBe(
      "Find motors",
    );
    expect(
      resolveAppToolPresentation({ toolName: "lecturn.rw_simulate" }, titled)?.title,
    ).toBeUndefined();

    const row = {
      toolSource: appToolSource(rocketwright),
      toolName: "mcp__lecturn__rw_motor_search",
    };
    expect(appToolRawName({ ...row, title: "Find motors" })).toBe("rw_motor_search");
    expect(appToolRawName({ ...row, title: "rw_motor_search" })).toBeUndefined();
    expect(appToolRawName({ ...row, toolSource: undefined, title: "Find motors" })).toBeUndefined();
  });
});
