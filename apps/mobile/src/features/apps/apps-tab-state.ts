import { appGroups, type AppWorkspaceGroup } from "@lecturn/client-runtime/state/app-projects";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import {
  appGrantFingerprintSource,
  type AppBinding,
  type AppEmbedContext,
  type AppId,
  type AppStatus,
  type EnvironmentId,
} from "@lecturn/contracts";
import { expandAppOpenUrl } from "@lecturn/shared/appReferences";

import type { HomeAppWorkspaceHeaderListItem, HomeGroupDisplayState } from "../home/homeListItems";
import {
  buildThreadListV2Items,
  resolveThreadListV2Status,
  type ThreadListV2Status,
} from "../threads/threadListV2";

export type AppStatusTone = "running" | "closed" | "attention" | "off";

export interface AppStatusPresentation {
  readonly label: string;
  readonly tone: AppStatusTone;
}

/** Running means a live lease: the server drops an unrenewed one and streams the change. */
export function appStatusPresentation(
  app: Pick<AppStatus, "state" | "live">,
): AppStatusPresentation {
  switch (app.state) {
    case "pairing-requested":
      return { label: "Pairing requested", tone: "attention" };
    case "denied":
      return { label: "Denied", tone: "off" };
    case "revoked":
      return { label: "Revoked", tone: "off" };
    case "granted":
      return app.live !== null
        ? { label: "Running", tone: "running" }
        : { label: "Closed", tone: "closed" };
  }
}

/**
 * Why a pending request waits, as Settings > Connected apps words it on web: `changed` asks to
 * run a different command or frame from other origins than approved, `repair` comes back after
 * a revoke or denial, and `renew` is a granted app asking for a new credential.
 */
export type AppPairingKind = "new" | "changed" | "renew" | "repair";

export function appPairingKind(
  app: Pick<AppStatus, "state" | "headlessTools" | "embedOrigins" | "pendingRequest">,
): AppPairingKind | null {
  const request = app.pendingRequest;
  if (request === null) return null;
  if (app.state === "revoked" || app.state === "denied") return "repair";
  const approved = appGrantFingerprintSource({
    ...(app.headlessTools === null ? {} : { headlessTools: app.headlessTools }),
    embedOrigins: app.embedOrigins,
  });
  if (approved !== appGrantFingerprintSource(request.registration)) return "changed";
  return app.state === "granted" ? "renew" : "new";
}

export const APP_PAIRING_APPROVE_LABEL: Readonly<Record<AppPairingKind, string>> = {
  new: "Approve",
  changed: "Approve changes",
  renew: "Approve",
  repair: "Re-pair",
};

export const APP_PAIRING_DESCRIPTION: Readonly<Record<AppPairingKind, string>> = {
  new: "Wants to connect",
  changed: "Asks to run a different command",
  renew: "Asks for a new credential",
  repair: "Asks to pair again",
};

export interface AppEnvironmentStatus {
  readonly environmentId: EnvironmentId;
  readonly app: AppStatus;
}

// The header shows one status for an app that spans machines: the one that can do the most.
function statusRank(app: AppStatus): number {
  if (app.state === "granted" && app.live !== null) return 0;
  if (app.pendingRequest !== null) return 1;
  if (app.state === "granted") return 2;
  return app.state === "revoked" ? 3 : 4;
}

const BUSY_STATUSES: ReadonlySet<ThreadListV2Status> = new Set(["working", "approval", "input"]);

/** Running, or waiting on the user: what the card's "N working" chip counts. */
export function isAppThreadBusy(thread: Parameters<typeof resolveThreadListV2Status>[0]): boolean {
  return BUSY_STATUSES.has(resolveThreadListV2Status(thread));
}

export interface AppCard {
  readonly key: string;
  readonly appId: AppId;
  readonly name: string;
  readonly iconDataUrl: string | null;
  /** Null when no environment reported the app, for example a session without `access:read`. */
  readonly primary: AppEnvironmentStatus | null;
  readonly statuses: ReadonlyArray<AppEnvironmentStatus>;
  readonly workingCount: number;
  readonly spansEnvironments: boolean;
  readonly workspaces: ReadonlyArray<AppWorkspaceGroup<EnvironmentProject, EnvironmentThreadShell>>;
}

/**
 * One card per app, merged across environments: an app appears once it reports a status or owns
 * a workspace, so threads stay reachable after the app is removed or the session cannot read it.
 */
export function buildAppCards(input: {
  readonly statuses: ReadonlyMap<EnvironmentId, ReadonlyArray<AppStatus>>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
}): ReadonlyArray<AppCard> {
  const statusesByApp = new Map<AppId, AppEnvironmentStatus[]>();
  for (const [environmentId, apps] of input.statuses) {
    for (const app of apps) {
      const bucket = statusesByApp.get(app.appId);
      if (bucket === undefined) statusesByApp.set(app.appId, [{ environmentId, app }]);
      else bucket.push({ environmentId, app });
    }
  }
  const groupsByApp = new Map(
    appGroups({
      projects: input.projects,
      threads: input.threads,
      environmentLabels: input.environmentLabels,
    }).map((group) => [group.appId, group] as const),
  );
  const appIds = new Set<AppId>([...statusesByApp.keys(), ...groupsByApp.keys()]);
  return [...appIds]
    .map((appId): AppCard => {
      const statuses = statusesByApp.get(appId) ?? [];
      const primary =
        statuses.length === 0
          ? null
          : statuses.reduce((best, next) =>
              statusRank(next.app) < statusRank(best.app) ? next : best,
            );
      const group = groupsByApp.get(appId);
      const workspaces = group?.workspaces ?? [];
      return {
        key: `app:${appId}`,
        appId,
        name: primary?.app.name ?? appId,
        iconDataUrl: primary?.app.iconDataUrl ?? null,
        primary,
        statuses,
        workingCount: workspaces.reduce(
          (count, workspace) =>
            count +
            workspace.threads.filter(
              (thread) => thread.archivedAt === null && isAppThreadBusy(thread),
            ).length,
          0,
        ),
        spansEnvironments:
          (group?.spansEnvironments ?? false) ||
          new Set(statuses.map((status) => status.environmentId)).size > 1,
        workspaces,
      };
    })
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.appId.localeCompare(right.appId),
    );
}

function latestActivity(
  workspace: AppWorkspaceGroup<EnvironmentProject, EnvironmentThreadShell>,
): string {
  return workspace.threads.reduce(
    (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
    workspace.project.updatedAt,
  );
}

/** The header's + and open-in act on the workspace the user touched last. */
export function appCardTargetWorkspace(
  card: Pick<AppCard, "workspaces">,
): EnvironmentProject | null {
  let best: AppWorkspaceGroup<EnvironmentProject, EnvironmentThreadShell> | null = null;
  for (const workspace of card.workspaces) {
    if (best === null || latestActivity(workspace) > latestActivity(best)) best = workspace;
  }
  return best?.project ?? null;
}

export function appOpenUrl(input: {
  readonly template: string | null;
  readonly binding: AppBinding | undefined;
  readonly threadId: string | null;
}): string | null {
  if (input.template === null || input.binding === undefined) return null;
  return expandAppOpenUrl(input.template, {
    workspaceRoot: input.binding.workspaceRoot,
    threadId: input.threadId,
  });
}

export interface AppClosedBannerState {
  readonly title: string;
  readonly openLabel: string;
  readonly openUrl: string | null;
}

/**
 * Closed means granted with no live lease. A revoked or unpaired app has no tools at all, so
 * "closed" would mislead.
 */
export function appClosedBannerState(input: {
  readonly context: AppEmbedContext | null;
  readonly binding: AppBinding | undefined;
  readonly threadId: string;
}): AppClosedBannerState | null {
  const { context } = input;
  if (context === null || input.binding === undefined) return null;
  if (context.state !== "granted" || context.live !== null) return null;
  return {
    title: `${context.name} closed: live tools unavailable`,
    openLabel: `Open in ${context.name}`,
    openUrl: appOpenUrl({
      template: context.openUrlTemplate,
      binding: input.binding,
      threadId: input.threadId,
    }),
  };
}

const STATUS_SUBTITLE: Partial<Record<ThreadListV2Status, string>> = {
  working: "Working",
  approval: "Needs approval",
  input: "Needs input",
  waiting: "Waiting",
  failed: "Failed",
  limited: "Usage limit reached",
};

/** The app's own subtitle, otherwise what the thread is doing; an idle thread has none. */
export function appThreadSubtitle(thread: EnvironmentThreadShell): string | null {
  const subtitle = thread.source.appSubtitle?.trim();
  if (subtitle) return subtitle;
  return STATUS_SUBTITLE[resolveThreadListV2Status(thread)] ?? null;
}

export interface AppCardHeaderItem {
  readonly type: "app-card-header";
  readonly key: string;
  readonly card: AppCard;
  readonly collapsed: boolean;
  readonly depth: 0;
}

export interface AppPairingItem {
  readonly type: "app-pairing";
  readonly key: string;
  readonly card: AppCard;
  readonly environmentId: EnvironmentId;
  readonly app: AppStatus;
  readonly kind: AppPairingKind;
  readonly machineLabel: string | null;
  readonly depth: number;
}

export interface AppSectionLabelItem {
  readonly type: "app-section-label";
  readonly key: string;
  readonly label: "Pinned" | "Active";
  readonly depth: number;
}

export interface AppThreadItem {
  readonly type: "app-thread";
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly depth: number;
}

export interface AppSettledShelfItem {
  readonly type: "app-settled-shelf";
  readonly key: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly depth: number;
}

export interface AppEmptyItem {
  readonly type: "app-empty";
  readonly key: string;
  readonly message: string;
  readonly depth: number;
}

export type AppsTabItem =
  | AppCardHeaderItem
  | AppPairingItem
  | (HomeAppWorkspaceHeaderListItem & { readonly depth: number })
  | AppSectionLabelItem
  | AppThreadItem
  | AppSettledShelfItem
  | AppEmptyItem;

export const appCardCollapseKey = (appId: AppId) => `app:${appId}`;
export const appSettledShelfKey = (workspaceKey: string) => `settled:${workspaceKey}`;

/**
 * The Apps tab as one flat tree for a virtualized list: each app's header, its pairing requests,
 * then its workspaces with visible Pinned and Active labels and a Settled shelf that starts
 * collapsed. Searching filters threads by title (an app whose name matches keeps them all) and
 * opens every collapsed group.
 */
export function buildAppsTabItems(input: {
  readonly cards: ReadonlyArray<AppCard>;
  readonly displayStates: ReadonlyMap<string, HomeGroupDisplayState>;
  readonly searchQuery: string;
  readonly now: string;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
}): ReadonlyArray<AppsTabItem> {
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const searching = query.length > 0;
  const collapsed = (key: string) => !searching && input.displayStates.get(key)?.collapsed === true;
  const items: AppsTabItem[] = [];

  for (const card of input.cards) {
    const nameMatches = searching && card.name.toLocaleLowerCase().includes(query);
    const threadQuery = nameMatches ? "" : query;
    const workspaces = card.workspaces.map((workspace) => ({
      workspace,
      layout: buildThreadListV2Items({
        threads: workspace.threads,
        environmentId: null,
        searchQuery: threadQuery,
        now: input.now,
      }),
    }));
    const matchingWorkspaces = searching
      ? workspaces.filter(({ layout }) => layout.items.length > 0)
      : workspaces;
    if (searching && !nameMatches && matchingWorkspaces.length === 0) continue;

    const cardCollapsed = collapsed(appCardCollapseKey(card.appId));
    items.push({
      type: "app-card-header",
      key: card.key,
      card,
      collapsed: cardCollapsed,
      depth: 0,
    });
    if (cardCollapsed) continue;

    for (const status of card.statuses) {
      const kind = appPairingKind(status.app);
      if (kind === null) continue;
      items.push({
        type: "app-pairing",
        key: `pairing:${status.environmentId}:${card.appId}`,
        card,
        environmentId: status.environmentId,
        app: status.app,
        kind,
        machineLabel: card.spansEnvironments
          ? (input.environmentLabels.get(status.environmentId) ?? null)
          : null,
        depth: 1,
      });
    }

    if (matchingWorkspaces.length === 0) {
      items.push({
        type: "app-empty",
        key: `empty:${card.appId}`,
        message: `Threads started from ${card.name} appear here.`,
        depth: 1,
      });
      continue;
    }

    for (const { workspace, layout } of matchingWorkspaces) {
      const workspaceCollapsed = collapsed(workspace.key);
      items.push({
        type: "app-workspace-header",
        key: `workspace:${workspace.key}`,
        groupKey: workspace.key,
        project: workspace.project,
        machineLabel: workspace.machineLabel,
        collapsed: workspaceCollapsed,
        depth: 1,
      });
      if (workspaceCollapsed) continue;

      const pinned: EnvironmentThreadShell[] = [];
      const active: EnvironmentThreadShell[] = [];
      const snoozed: EnvironmentThreadShell[] = [];
      const settled: EnvironmentThreadShell[] = [];
      for (const row of layout.items) {
        if (row.pinned) pinned.push(row.thread);
        else if (row.snoozed) snoozed.push(row.thread);
        else if (row.variant === "card") active.push(row.thread);
        else settled.push(row.thread);
      }
      // A snoozed thread is not settled; it waits at the end of Active.
      active.push(...snoozed);

      const pushSection = (
        label: AppSectionLabelItem["label"],
        threads: EnvironmentThreadShell[],
      ) => {
        if (threads.length === 0) return;
        items.push({
          type: "app-section-label",
          key: `${label.toLowerCase()}:${workspace.key}`,
          label,
          depth: 2,
        });
        for (const thread of threads) {
          items.push({
            type: "app-thread",
            key: `thread:${thread.environmentId}:${thread.id}`,
            thread,
            depth: 2,
          });
        }
      };
      pushSection("Pinned", pinned);
      pushSection("Active", active);
      if (settled.length > 0) {
        const shelfKey = appSettledShelfKey(workspace.key);
        const expanded = searching || input.displayStates.get(shelfKey)?.collapsed === false;
        items.push({
          type: "app-settled-shelf",
          key: shelfKey,
          count: settled.length,
          expanded,
          depth: 2,
        });
        if (expanded) {
          for (const thread of settled) {
            items.push({
              type: "app-thread",
              key: `thread:${thread.environmentId}:${thread.id}`,
              thread,
              depth: 2,
            });
          }
        }
      }
      if (pinned.length === 0 && active.length === 0 && settled.length === 0) {
        items.push({
          type: "app-empty",
          key: `empty:${workspace.key}`,
          message: "No threads yet",
          depth: 2,
        });
      }
    }
  }
  return items;
}

/** Section boundaries let a virtualized list draw each app as one continuous box. */
export function appCardFrames(
  items: ReadonlyArray<Pick<AppsTabItem, "key" | "type">>,
): ReadonlyMap<string, { readonly first: boolean; readonly last: boolean }> {
  return new Map(
    items.map((item, index) => [
      item.key,
      {
        first: index === 0 || item.type === "app-card-header",
        last: index === items.length - 1 || items[index + 1]?.type === "app-card-header",
      },
    ]),
  );
}
