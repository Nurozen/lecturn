import {
  APP_STATUS_LABEL,
  appStatusPhase,
  type AppStatusPhase,
} from "@lecturn/client-runtime/state/app-status";
import type { AppHeadlessTools, AppRuntimeCeiling, AppStatus } from "@lecturn/contracts";

export type ConnectedAppStatusTone = "success" | "warning" | "error" | "muted";

const STATUS_TONE = {
  running: "success",
  closed: "muted",
  "pairing-requested": "warning",
  denied: "error",
  revoked: "error",
} as const satisfies Record<AppStatusPhase, ConnectedAppStatusTone>;

export function connectedAppStatus(app: Pick<AppStatus, "state" | "live">): {
  readonly label: string;
  readonly tone: ConnectedAppStatusTone;
} {
  const phase = appStatusPhase(app);
  return { label: APP_STATUS_LABEL[phase], tone: STATUS_TONE[phase] };
}

const RUNTIME_CEILING_NONE = "none";
export type RuntimeCeilingKey = typeof RUNTIME_CEILING_NONE | NonNullable<AppRuntimeCeiling>;

export const RUNTIME_CEILING_OPTIONS: ReadonlyArray<{
  readonly key: RuntimeCeilingKey;
  readonly label: string;
  readonly description: string;
}> = [
  {
    key: RUNTIME_CEILING_NONE,
    label: "Thread's mode",
    description: "Each thread's runtime mode decides whether gated tools ask first.",
  },
  {
    key: "read-only",
    label: "Read-only",
    description: "Gated tools never run, whatever the thread's mode.",
  },
  {
    key: "approval-required",
    label: "Supervised",
    description: "Gated tools ask first, even in Auto and Full access threads.",
  },
  {
    key: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Gated tools ask first, even in Auto and Full access threads.",
  },
  {
    key: "auto",
    label: "Auto",
    description: "Gated tools run without asking in Auto and Full access threads.",
  },
  {
    key: "full-access",
    label: "Full access",
    description: "The same as the thread's mode: nothing is capped.",
  },
];

export function runtimeCeilingKey(ceiling: AppRuntimeCeiling): RuntimeCeilingKey {
  return ceiling ?? RUNTIME_CEILING_NONE;
}

export function runtimeCeilingFromKey(key: RuntimeCeilingKey): AppRuntimeCeiling {
  return key === RUNTIME_CEILING_NONE ? null : key;
}

export function runtimeCeilingLabel(ceiling: AppRuntimeCeiling): string {
  const key = runtimeCeilingKey(ceiling);
  return RUNTIME_CEILING_OPTIONS.find((option) => option.key === key)?.label ?? key;
}

function shellQuote(value: string): string {
  if (value !== "" && /^[A-Za-z0-9_@%+=:,./{}-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The exact argv Lecturn will spawn, quoted so it can be pasted into a shell to check it. */
export function formatAppCommandLine(tools: Pick<AppHeadlessTools, "command" | "args">): string {
  return [tools.command, ...tools.args].map(shellQuote).join(" ");
}

export function appEnvEntries(
  tools: Pick<AppHeadlessTools, "env">,
): ReadonlyArray<readonly [string, string]> {
  return Object.entries(tools.env ?? {}).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** What the app credential lets the app do, in the order the settings page lists it. */
export function connectedAppAccess(
  app: Pick<AppStatus, "toolPrefix" | "headlessTools" | "gatedTools" | "embedOrigins" | "name">,
): ReadonlyArray<{ readonly title: string; readonly detail: string }> {
  const access = [
    {
      title: "Its own workspaces",
      detail: `Creates projects and threads bound to ${app.name}, and reads only those.`,
    },
    {
      title: "Agent tools",
      detail: `Offers tools named ${app.toolPrefix}_* to agents in its threads.`,
    },
  ];
  if (app.gatedTools.length > 0) {
    // Named as agents call them, as the Gated tools list below names them.
    const names = app.gatedTools.map((tool) => `${app.toolPrefix}_${tool}`).join(", ");
    access.push({
      title: "Gated tools",
      detail: `${names} ${app.gatedTools.length === 1 ? "follows" : "follow"} the runtime ceiling below.`,
    });
  }
  if (app.embedOrigins.length > 0) {
    access.push({
      title: "Embedded chat",
      detail: `Shows Lecturn threads inside ${app.embedOrigins.join(", ")}.`,
    });
  }
  return access;
}

export function deleteConnectedAppConfirmMessage(
  app: Pick<AppStatus, "name">,
  deleteThreads: boolean,
): string {
  return deleteThreads
    ? `Remove ${app.name} and delete its projects and threads?\n\nThe app loses access and its threads are deleted. This cannot be undone.`
    : `Remove ${app.name}?\n\nThe app loses access and must pair again to reconnect. Its threads stay on this machine.`;
}

export type ConnectedAppAction = "approve" | "deny" | "revoke" | "ceiling" | "delete";

const ACTION_FALLBACK: Readonly<Record<ConnectedAppAction, string>> = {
  approve: "Could not approve the app.",
  deny: "Could not deny the app.",
  revoke: "Could not revoke the app.",
  ceiling: "Could not change the runtime ceiling.",
  delete: "Could not remove the app.",
};

/**
 * The user-facing reason a command failed. Deleting an app's threads is
 * refused as `unavailable` by servers that cannot do it yet, which leaves the
 * app in place, so the message says so instead of echoing the server's text.
 */
export function connectedAppActionError(
  action: ConnectedAppAction,
  error: unknown,
  options: { readonly deleteThreads?: boolean } = {},
): string {
  if (
    action === "delete" &&
    options.deleteThreads === true &&
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "AppsError" &&
    "code" in error &&
    error.code === "unavailable"
  ) {
    return "This server cannot delete an app's threads yet. Nothing was removed; remove the app alone to keep its threads.";
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return ACTION_FALLBACK[action];
}
