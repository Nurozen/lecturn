import type { ToolActivitySource } from "@lecturn/contracts";

import { lecturnMcpToolName } from "./lecturnMcpToolName.ts";

/** What a tool row needs from a connected app's registration. */
export interface AppToolPresentationApp {
  readonly appId: string;
  readonly name: string;
  readonly toolPrefix: string;
  readonly iconDataUrl?: string;
}

export interface AppToolPresentation {
  readonly app: AppToolPresentationApp;
  /** The prefixed name the agent called, e.g. `rw_simulate`. */
  readonly toolName: string;
  readonly toolSource: ToolActivitySource;
}

/**
 * `ToolActivityIcon.logoUrl` is capped here, and every turn item carries its
 * source, so a larger icon is left off the row instead of bloating the item.
 */
export const MAX_APP_TOOL_ICON_URL_LENGTH = 4096;

export function appToolSource(app: AppToolPresentationApp): ToolActivitySource {
  const icon = app.iconDataUrl;
  return {
    key: `app:${app.appId}`,
    name: app.name,
    kind: "integration",
    ...(icon !== undefined && icon.length > 0 && icon.length <= MAX_APP_TOOL_ICON_URL_LENGTH
      ? { icon: { _tag: "themed-logo", logoUrl: icon } }
      : {}),
  };
}

export function appToolPresentationMap(
  apps: Iterable<AppToolPresentationApp>,
): ReadonlyMap<string, AppToolPresentationApp> {
  return new Map(Array.from(apps, (app) => [app.toolPrefix, app] as const));
}

/**
 * Adapters build tool rows synchronously from a tool name alone, so the
 * server keeps the registered apps here instead of threading the registry
 * through every adapter. Clients never set it and so never brand a row
 * themselves; they read the source the server stamped on the item.
 */
let registeredApps: ReadonlyMap<string, AppToolPresentationApp> = new Map();

export function setRegisteredAppToolPresentations(apps: Iterable<AppToolPresentationApp>): void {
  registeredApps = appToolPresentationMap(apps);
}

export function registeredAppToolPresentations(): ReadonlyArray<AppToolPresentationApp> {
  return [...registeredApps.values()];
}

/** The names Lecturn's own MCP server runs under, including OpenCode's per-thread one. */
const LECTURN_MCP_SERVER_NAME = /^lecturn(?:-[A-Za-z0-9-]+)?$/i;

function appForLocalToolName(
  localName: string,
  apps: ReadonlyMap<string, AppToolPresentationApp>,
): AppToolPresentation | null {
  // Prefixes never contain `_`, so the first one ends it.
  const separator = localName.indexOf("_");
  if (separator <= 0 || separator === localName.length - 1) return null;
  const app = apps.get(localName.slice(0, separator));
  return app === undefined ? null : { app, toolName: localName, toolSource: appToolSource(app) };
}

/**
 * App tools reach agents through Lecturn's own MCP server as `<prefix>_<tool>`,
 * so a tool is an app's only when it came from that server and its prefix is
 * registered: another server's `rw_x` stays that server's.
 */
export function resolveAppToolPresentation(
  input: {
    /** The recorded name, qualified (`mcp__lecturn__rw_x`) or bare when `serverName` is given. */
    readonly toolName: string | null | undefined;
    readonly serverName?: string | null | undefined;
  },
  apps: ReadonlyMap<string, AppToolPresentationApp> = registeredApps,
): AppToolPresentation | null {
  if (apps.size === 0 || typeof input.toolName !== "string") return null;
  const toolName = input.toolName.trim();
  if (typeof input.serverName === "string") {
    return LECTURN_MCP_SERVER_NAME.test(input.serverName.trim())
      ? appForLocalToolName(toolName, apps)
      : null;
  }
  const localName = lecturnMcpToolName(toolName);
  return localName === null ? null : appForLocalToolName(localName, apps);
}
