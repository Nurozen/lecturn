import { scopedThreadKey, scopeThreadRef } from "@lecturn/client-runtime/environment";
import { appGroups } from "@lecturn/client-runtime/state/app-projects";
import {
  appPairingKind,
  primaryAppStatus,
  type AppEnvironmentStatus,
  type AppPairingKind,
} from "@lecturn/client-runtime/state/app-status";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import { effectiveSnoozed } from "@lecturn/client-runtime/state/thread-settled";
import { sortSettledThreads } from "@lecturn/client-runtime/state/thread-sort";
import type { AppId, AppStatus, EnvironmentId } from "@lecturn/contracts";
import { expandAppOpenUrl } from "@lecturn/shared/appReferences";

import {
  filterSidebarV2VisibleThreads,
  resolveProjectStatusIndicator,
  resolveSidebarThreadSection,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  type ThreadStatusPill,
} from "../Sidebar.logic";
import {
  connectedAppStatus,
  type ConnectedAppStatusTone,
} from "../settings/ConnectedAppsSettings.logic";

type AppStatusChipVariant = "success" | "warning" | "error" | "outline";

const CHIP_VARIANT = {
  success: "success",
  warning: "warning",
  error: "error",
  muted: "outline",
} as const satisfies Record<ConnectedAppStatusTone, AppStatusChipVariant>;

/**
 * `label` is the chip's short form, sized so the app name keeps the row's room; `description`
 * is the full status for the chip's tooltip and for surfaces with space to spare.
 */
export function appStatusChip(app: Pick<AppStatus, "state" | "live">): {
  readonly label: string;
  readonly description: string;
  readonly variant: AppStatusChipVariant;
} {
  const status = connectedAppStatus(app);
  return {
    label: app.state === "pairing-requested" ? "Pairing" : status.label,
    description: status.label,
    variant: CHIP_VARIANT[status.tone],
  };
}

export interface AppsSidebarSections {
  readonly pinned: ReadonlyArray<EnvironmentThreadShell>;
  readonly active: ReadonlyArray<EnvironmentThreadShell>;
  readonly settled: ReadonlyArray<EnvironmentThreadShell>;
}

export interface AppsSidebarWorkspace {
  readonly key: string;
  readonly project: EnvironmentProject;
  readonly machineLabel: string | null;
  readonly sections: AppsSidebarSections;
  /** The most urgent thread state in the workspace, as Projects mode badges a project. */
  readonly status: ThreadStatusPill | null;
  /** Latest thread or project update, for picking where the app row's actions land. */
  readonly lastActivityAt: string;
}

export interface AppsSidebarPairing {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly app: AppStatus;
  readonly kind: AppPairingKind;
  readonly machineLabel: string | null;
}

export interface AppsSidebarApp {
  readonly appId: AppId;
  readonly name: string;
  readonly iconDataUrl: string | null;
  /** Null when no environment reported the app, e.g. a session without `access:read`. */
  readonly primary: AppEnvironmentStatus | null;
  readonly pairing: ReadonlyArray<AppsSidebarPairing>;
  /** Threads running or waiting on the user. */
  readonly workingCount: number;
  readonly workspaces: ReadonlyArray<AppsSidebarWorkspace>;
}

const BUSY_STATUSES = new Set(["working", "approval", "input"]);

function isAppThreadBusy(thread: Parameters<typeof resolveSidebarThreadStatus>[0]): boolean {
  return BUSY_STATUSES.has(resolveSidebarThreadStatus(thread));
}

/** Snoozed threads wait at the end of Active: Apps mode has no snooze shelf. */
export function partitionAppWorkspaceThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: {
    readonly now: string;
    readonly supports: (environmentId: EnvironmentId) => {
      readonly settlement: boolean;
      readonly snooze: boolean;
    };
  },
): AppsSidebarSections {
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  for (const thread of threads) {
    const supports = options.supports(thread.environmentId);
    const section = resolveSidebarThreadSection({
      snoozed: supports.snooze && effectiveSnoozed(thread, { now: options.now }),
      settled: supports.settlement && thread.settledOverride === "settled",
      pinned: thread.pinnedAt != null,
    });
    (section === "pinned"
      ? pinned
      : section === "settled"
        ? settled
        : section === "snoozed"
          ? snoozed
          : active
    ).push(thread);
  }
  return {
    pinned: sortPinnedThreadsForSidebar(pinned),
    active: [...sortThreadsForSidebar(active), ...sortThreadsForSidebar(snoozed)],
    settled: sortSettledThreads(settled),
  };
}

/**
 * Apps mode's list: one entry per app merged across environments. An app shows once it
 * reports a status or owns a workspace, so its threads stay reachable after it is removed
 * or when the session cannot read app statuses.
 */
export function buildAppsSidebarApps(input: {
  readonly statuses: ReadonlyArray<AppEnvironmentStatus>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  readonly now: string;
  readonly supports: (environmentId: EnvironmentId) => {
    readonly settlement: boolean;
    readonly snooze: boolean;
  };
}): ReadonlyArray<AppsSidebarApp> {
  const statusesByApp = new Map<AppId, AppEnvironmentStatus[]>();
  for (const status of input.statuses) {
    const bucket = statusesByApp.get(status.app.appId);
    if (bucket === undefined) statusesByApp.set(status.app.appId, [status]);
    else bucket.push(status);
  }
  const groupsByApp = new Map(
    appGroups({
      projects: input.projects,
      threads: filterSidebarV2VisibleThreads(input.threads, null),
      environmentLabels: input.environmentLabels,
    }).map((group) => [group.appId, group] as const),
  );

  return [...new Set<AppId>([...statusesByApp.keys(), ...groupsByApp.keys()])]
    .map((appId): AppsSidebarApp => {
      const statuses = statusesByApp.get(appId) ?? [];
      const primary = primaryAppStatus(statuses);
      const spansEnvironments =
        (groupsByApp.get(appId)?.spansEnvironments ?? false) ||
        new Set(statuses.map((status) => status.environmentId)).size > 1;
      const workspaces = (groupsByApp.get(appId)?.workspaces ?? []).map(
        (workspace): AppsSidebarWorkspace => ({
          key: workspace.key,
          project: workspace.project,
          machineLabel: workspace.machineLabel,
          sections: partitionAppWorkspaceThreads(workspace.threads, input),
          status: resolveProjectStatusIndicator(
            workspace.threads.map((thread) => resolveThreadStatusPill({ thread })),
          ),
          lastActivityAt: workspace.threads.reduce(
            (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
            workspace.project.updatedAt,
          ),
        }),
      );
      const pairing = statuses.flatMap((status): AppsSidebarPairing[] => {
        const kind = appPairingKind(status.app);
        return kind === null
          ? []
          : [
              {
                key: `pairing:${status.environmentId}:${appId}`,
                environmentId: status.environmentId,
                app: status.app,
                kind,
                machineLabel: spansEnvironments
                  ? (input.environmentLabels.get(status.environmentId) ?? null)
                  : null,
              },
            ];
      });
      return {
        appId,
        name: primary?.app.name ?? appId,
        iconDataUrl: primary?.app.iconDataUrl ?? null,
        primary,
        pairing,
        workingCount: workspaces.reduce(
          (count, workspace) =>
            count +
            [
              ...workspace.sections.pinned,
              ...workspace.sections.active,
              ...workspace.sections.settled,
            ].filter(isAppThreadBusy).length,
          0,
        ),
        workspaces,
      };
    })
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.appId.localeCompare(right.appId),
    );
}

/** The workspace the user touched last: where the app row's New thread and Open in land. */
export function appTargetWorkspace(
  app: Pick<AppsSidebarApp, "workspaces">,
): AppsSidebarWorkspace | null {
  let best: AppsSidebarWorkspace | null = null;
  for (const workspace of app.workspaces) {
    if (best === null || workspace.lastActivityAt > best.lastActivityAt) best = workspace;
  }
  return best;
}

/**
 * The app's working count as its row and header show it. Revoking an app does not stop its
 * threads' runs, which go on without its tools, so a revoked or denied app shows no count: it
 * is not the app that is working. Gold while a thread waits on an approval, as Lecturn marks
 * Pending Approval, and Working's blue otherwise.
 */
export function appWorkingBadge(
  app: Pick<AppsSidebarApp, "workingCount" | "workspaces">,
  state: AppStatus["state"] | null,
): { readonly count: number; readonly variant: "warning" | "info" } | null {
  if (app.workingCount === 0 || state === "revoked" || state === "denied") return null;
  const approval = app.workspaces.some(
    (workspace) => workspace.status?.label === "Pending Approval",
  );
  return { count: app.workingCount, variant: approval ? "warning" : "info" };
}

/** Where "Open in <App>" points for a workspace: the app's own scheme, at that folder. */
export function appWorkspaceOpenUrl(
  template: string | null,
  workspace: Pick<AppsSidebarWorkspace, "project"> | null,
): string | null {
  const binding = workspace?.project.appBinding;
  if (template === null || binding === undefined) return null;
  return expandAppOpenUrl(template, { workspaceRoot: binding.workspaceRoot, threadId: null });
}

/** A scope whose app has not loaded (or was removed) lists every app instead of nothing. */
export function resolveAppsSidebarScope<App extends Pick<AppsSidebarApp, "appId">>(
  apps: ReadonlyArray<App>,
  scopeKey: string | null,
): App | null {
  return scopeKey === null ? null : (apps.find((app) => app.appId === scopeKey) ?? null);
}

export type AppTreeGroup =
  | { readonly kind: "app"; readonly appId: AppId }
  | { readonly kind: "workspace"; readonly workspaceKey: string }
  | {
      readonly kind: "section";
      readonly section: keyof AppsSidebarSections;
      readonly workspaceKey: string;
    };

export function appTreeGroupKey(group: AppTreeGroup): string {
  switch (group.kind) {
    case "app":
      return `app:${group.appId}`;
    case "workspace":
      return `workspace:${group.workspaceKey}`;
    case "section":
      return `${group.section}:${group.workspaceKey}`;
  }
}

/** Settled starts folded, as the Projects tree's Settled shelf does; everything else open. */
export function isAppTreeGroupCollapsed(
  collapsedByKey: Readonly<Record<string, boolean>>,
  group: AppTreeGroup,
): boolean {
  return (
    collapsedByKey[appTreeGroupKey(group)] ??
    (group.kind === "section" && group.section === "settled")
  );
}

export const APP_SECTION_ORDER = ["pinned", "active", "settled"] as const satisfies ReadonlyArray<
  keyof AppsSidebarSections
>;

/**
 * The thread rows Apps mode shows, top to bottom, so jump and next/previous shortcuts walk what
 * the user sees. Folded apps, workspaces and sections hide their rows.
 */
export function appsSidebarVisibleThreads(input: {
  readonly apps: ReadonlyArray<AppsSidebarApp>;
  readonly selected: AppsSidebarApp | null;
  readonly collapsedByKey: Readonly<Record<string, boolean>>;
}): ReadonlyArray<EnvironmentThreadShell> {
  const folded = (group: AppTreeGroup) => isAppTreeGroupCollapsed(input.collapsedByKey, group);
  const shown =
    input.selected === null
      ? input.apps.filter((app) => !folded({ kind: "app", appId: app.appId }))
      : [input.selected];
  return shown.flatMap((app) =>
    app.workspaces.flatMap((workspace) =>
      folded({ kind: "workspace", workspaceKey: workspace.key })
        ? []
        : APP_SECTION_ORDER.flatMap((section) =>
            folded({ kind: "section", section, workspaceKey: workspace.key })
              ? []
              : workspace.sections[section],
          ),
    ),
  );
}

/**
 * Where the sidebar's New thread lands in Apps mode: the open app thread's workspace when it
 * belongs to the apps in view, otherwise the workspace of those apps the user touched last.
 */
export function appsNewThreadWorkspace(input: {
  readonly apps: ReadonlyArray<AppsSidebarApp>;
  readonly selected: AppsSidebarApp | null;
  readonly activeThreadKey: string | null;
}): AppsSidebarWorkspace | null {
  const workspaces = (input.selected === null ? input.apps : [input.selected]).flatMap(
    (app) => app.workspaces,
  );
  const active =
    input.activeThreadKey === null
      ? undefined
      : workspaces.find((workspace) =>
          APP_SECTION_ORDER.some((section) =>
            workspace.sections[section].some(
              (thread) =>
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                input.activeThreadKey,
            ),
          ),
        );
  return active ?? appTargetWorkspace({ workspaces });
}
