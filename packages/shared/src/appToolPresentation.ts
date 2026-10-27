import type { ToolActivitySource } from "@lecturn/contracts";

import { lecturnMcpToolName } from "./lecturnMcpToolName.ts";

/** What a tool row needs from a connected app's registration. */
export interface AppToolPresentationApp {
  readonly appId: string;
  readonly name: string;
  readonly toolPrefix: string;
  readonly iconDataUrl?: string;
  /** Titles the app's tools declare, keyed by the unprefixed tool name. */
  readonly toolTitles?: ReadonlyMap<string, string>;
}

export interface AppToolPresentation {
  readonly app: AppToolPresentationApp;
  /** The prefixed name the agent called, e.g. `rw_simulate`. */
  readonly toolName: string;
  /** What the tool row reads instead of `toolName`, when the tool declares one. */
  readonly title?: string;
  readonly toolSource: ToolActivitySource;
}

const MAX_APP_TOOL_TITLE_LENGTH = 80;

/** Where an app puts a short, per-call summary for its tool row, in the tool result's `_meta`. */
export const APP_TOOL_SUMMARY_META_KEY = "lecturn/summary";
const MAX_APP_TOOL_SUMMARY_LENGTH = 120;

// Control and bidi-override characters could hide or reorder the text beside them.
const UNSAFE_TEXT = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu;

/** One line of plain text, or undefined when there is none or it is over `maxLength`. */
function plainLine(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim();
  return text.length > 0 && text.length <= maxLength ? text : undefined;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** MCP's display title for a tool: `title`, else the older `annotations.title`. */
export function appToolTitle(tool: {
  readonly title?: unknown;
  readonly annotations?: unknown;
}): string | undefined {
  return (
    plainLine(tool.title, MAX_APP_TOOL_TITLE_LENGTH) ??
    plainLine(
      isRecord(tool.annotations) ? tool.annotations.title : undefined,
      MAX_APP_TOOL_TITLE_LENGTH,
    )
  );
}

/** An app tool approval's heading: the tool's declared title, else the name the agent called. */
export function appToolApprovalLabel(tool: {
  readonly toolName: string;
  readonly toolTitle?: string | undefined;
}): string {
  return `Approve ${tool.toolTitle?.trim() || tool.toolName}`;
}

/** The summary an app put in a tool result's `_meta`, if it is valid. */
export function appToolSummaryFromMeta(meta: unknown): string | undefined {
  return isRecord(meta)
    ? plainLine(meta[APP_TOOL_SUMMARY_META_KEY], MAX_APP_TOOL_SUMMARY_LENGTH)
    : undefined;
}

const LECTURN_META_KEY_PREFIX = "lecturn/";

/**
 * The `lecturn/*` keys of a tool result's `_meta` (the toolkit's summary and
 * source), or undefined when there are none. Other servers' keys stay out of
 * stored tool items.
 */
export function lecturnResultMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isRecord(meta)) return undefined;
  const kept = Object.entries(meta).filter(([key]) => key.startsWith(LECTURN_META_KEY_PREFIX));
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/**
 * `ToolActivityIcon.logoUrl` is capped here, and every turn item carries its
 * source, so a larger icon is left off the row instead of bloating the item.
 */
export const MAX_APP_TOOL_ICON_URL_LENGTH = 4096;

const APP_TOOL_SOURCE_KEY_PREFIX = "app:";

export function appToolSource(app: AppToolPresentationApp): ToolActivitySource {
  const icon = app.iconDataUrl;
  return {
    key: `${APP_TOOL_SOURCE_KEY_PREFIX}${app.appId}`,
    name: app.name,
    kind: "integration",
    ...(icon !== undefined && icon.length > 0 && icon.length <= MAX_APP_TOOL_ICON_URL_LENGTH
      ? { icon: { _tag: "themed-logo", logoUrl: icon } }
      : {}),
  };
}

/** Clients tell app rows apart by the source the server stamped, never by the tool name. */
export function isAppToolSource(source: ToolActivitySource | undefined): boolean {
  return source?.key.startsWith(APP_TOOL_SOURCE_KEY_PREFIX) === true;
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
  if (app === undefined) return null;
  const title = app.toolTitles?.get(localName.slice(separator + 1));
  return {
    app,
    toolName: localName,
    ...(title === undefined ? {} : { title }),
    toolSource: appToolSource(app),
  };
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

/**
 * The name the agent called, for a row that reads the tool's title instead,
 * so the expanded row still shows what ran.
 */
export function appToolRawName(item: {
  readonly toolSource?: ToolActivitySource | undefined;
  readonly toolName?: string | null | undefined;
  readonly title?: string | null | undefined;
}): string | undefined {
  if (!isAppToolSource(item.toolSource)) return undefined;
  const name = lecturnMcpToolName(item.toolName) ?? item.toolName?.trim();
  return name && name !== item.title?.trim() ? name : undefined;
}
