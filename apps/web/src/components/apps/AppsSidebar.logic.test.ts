import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import {
  AppId,
  type AppStatus,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { scopedThreadKey, scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  appsNewThreadWorkspace,
  appsSidebarVisibleThreads,
  appStatusChip,
  appTargetWorkspace,
  appTreeGroupKey,
  appWorkspaceOpenUrl,
  buildAppsSidebarApps,
  isAppTreeGroupCollapsed,
  partitionAppWorkspaceThreads,
  resolveAppsSidebarScope,
} from "./AppsSidebar.logic";

const NOW = "2026-10-25T12:00:00.000Z";
const MAC = EnvironmentId.make("mac");
const SERVER = EnvironmentId.make("server");
const ROCKET = AppId.make("com.example.rocket");
const ATLAS = AppId.make("com.example.atlas");
const ICON = "data:image/png;base64,iVBORw0KGgo=";
const supportsAll = () => ({ settlement: true, snooze: true });

function makeStatus(overrides: Partial<AppStatus> = {}): AppStatus {
  return {
    appId: ROCKET,
    name: "RocketWright",
    iconDataUrl: ICON,
    toolPrefix: "rw",
    refPrefixes: ["rw:"],
    openUrlTemplate: null,
    state: "granted",
    live: null,
    lastSeenAt: NOW,
    runtimeCeiling: null,
    headlessTools: null,
    gatedTools: [],
    embedOrigins: [],
    pendingRequest: null,
    ...overrides,
  };
}

function pendingRequest(): NonNullable<AppStatus["pendingRequest"]> {
  return {
    requestId: "request-1",
    requestedAt: NOW,
    registration: {
      appId: ROCKET,
      name: "RocketWright",
      iconDataUrl: ICON,
      toolPrefix: "rw",
      refPrefixes: ["rw:"],
      liveTools: true,
      gatedTools: [],
    },
  };
}

function makeProject(
  id: string,
  environmentId: EnvironmentId = MAC,
  appId: AppId | null = ROCKET,
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...(appId === null ? {} : { appBinding: { appId, workspaceRoot: `/work/${id}` } }),
  };
}

function makeThread(
  id: string,
  project: EnvironmentProject,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: project.environmentId,
    id: ThreadId.make(id),
    projectId: project.id,
    title: id,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  });
}

const running = {
  status: "running",
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  lastErrorClass: null,
  updatedAt: NOW,
} satisfies EnvironmentThreadShell["runtime"];

const labels = new Map([
  [MAC, "Mac"],
  [SERVER, "Server"],
]);

function build(input: {
  statuses?: ReadonlyArray<{ environmentId: EnvironmentId; app: AppStatus }>;
  projects?: ReadonlyArray<EnvironmentProject>;
  threads?: ReadonlyArray<EnvironmentThreadShell>;
}) {
  return buildAppsSidebarApps({
    statuses: input.statuses ?? [],
    projects: input.projects ?? [],
    threads: input.threads ?? [],
    environmentLabels: labels,
    now: NOW,
    supports: supportsAll,
  });
}

const titles = (threads: ReadonlyArray<EnvironmentThreadShell>) =>
  threads.map((thread) => thread.title);

describe("appStatusChip", () => {
  it.each([
    [{ state: "granted", live: { expiresAt: NOW } }, "Running", "success"],
    [{ state: "granted", live: null }, "Closed", "outline"],
    [{ state: "revoked", live: null }, "Revoked", "error"],
    [{ state: "pairing-requested", live: null }, "Pairing requested", "warning"],
  ] as const)("labels %o as %s", (app, label, variant) => {
    expect(appStatusChip(app)).toEqual({ label, variant });
  });
});

describe("partitionAppWorkspaceThreads", () => {
  const project = makeProject("hopper");

  it("splits threads into Pinned, Active and Settled, parking snoozed ones at the end of Active", () => {
    const sections = partitionAppWorkspaceThreads(
      [
        makeThread("settled", project, { settledOverride: "settled" }),
        makeThread("snoozed", project, { snoozedUntil: "2026-10-26T00:00:00.000Z" }),
        makeThread("pinned", project, { pinnedAt: "2026-10-21T00:00:00.000Z" }),
        makeThread("active", project),
      ],
      { now: NOW, supports: supportsAll },
    );

    expect(titles(sections.pinned)).toEqual(["pinned"]);
    expect(titles(sections.active)).toEqual(["active", "snoozed"]);
    expect(titles(sections.settled)).toEqual(["settled"]);
  });

  it("keeps settled and snoozed threads active on a server without those capabilities", () => {
    const sections = partitionAppWorkspaceThreads(
      [
        makeThread("settled", project, { settledOverride: "settled" }),
        makeThread("snoozed", project, { snoozedUntil: "2026-10-26T00:00:00.000Z" }),
      ],
      { now: NOW, supports: () => ({ settlement: false, snooze: false }) },
    );

    expect(sections.settled).toEqual([]);
    expect(titles(sections.active).sort()).toEqual(["settled", "snoozed"]);
  });
});

describe("buildAppsSidebarApps", () => {
  it("groups an app's workspaces across environments with machine labels", () => {
    const hopper = makeProject("hopper", MAC);
    const liquid = makeProject("liquid", SERVER);
    const apps = build({
      statuses: [{ environmentId: MAC, app: makeStatus() }],
      projects: [hopper, liquid, makeProject("plain", MAC, null)],
      threads: [makeThread("one", hopper), makeThread("two", liquid)],
    });

    expect(apps).toHaveLength(1);
    expect(apps[0]!.workspaces.map((workspace) => workspace.project.title)).toEqual([
      "hopper",
      "liquid",
    ]);
    expect(apps[0]!.workspaces.map((workspace) => workspace.machineLabel)).toEqual([
      "Mac",
      "Server",
    ]);
  });

  it("shows the status that can do the most when an app reports from several machines", () => {
    const apps = build({
      statuses: [
        { environmentId: MAC, app: makeStatus({ state: "revoked" }) },
        { environmentId: SERVER, app: makeStatus({ live: { expiresAt: NOW } }) },
      ],
    });

    expect(apps[0]!.primary?.environmentId).toBe(SERVER);
    expect(appStatusChip(apps[0]!.primary!.app).label).toBe("Running");
  });

  it("lists an app with no workspaces yet, and app projects whose status is unreadable", () => {
    const atlasProject = makeProject("atlas", MAC, ATLAS);
    const apps = build({
      statuses: [{ environmentId: MAC, app: makeStatus() }],
      projects: [atlasProject],
    });

    expect(apps.map((app) => [app.appId, app.name, app.workspaces.length])).toEqual([
      // An app without a readable status falls back to its id, which sorts by that name.
      [ATLAS, ATLAS, 1],
      [ROCKET, "RocketWright", 0],
    ]);
    expect(apps[0]!.primary).toBeNull();
  });

  it("offers one pairing row per environment that holds a request", () => {
    const apps = build({
      statuses: [
        {
          environmentId: MAC,
          app: makeStatus({ state: "pairing-requested", pendingRequest: pendingRequest() }),
        },
        { environmentId: SERVER, app: makeStatus({ live: { expiresAt: NOW } }) },
      ],
    });

    expect(apps[0]!.pairing.map((row) => [row.environmentId, row.kind, row.machineLabel])).toEqual([
      [MAC, "new", "Mac"],
    ]);
  });

  it("counts threads running or waiting on the user, leaving out archived ones", () => {
    const hopper = makeProject("hopper");
    const apps = build({
      statuses: [{ environmentId: MAC, app: makeStatus() }],
      projects: [hopper],
      threads: [
        makeThread("working", hopper, { runtime: running }),
        makeThread("approval", hopper, { hasPendingApprovals: true }),
        makeThread("idle", hopper),
        makeThread("archived", hopper, { runtime: running, archivedAt: NOW }),
      ],
    });

    expect(apps[0]!.workingCount).toBe(2);
    expect(apps[0]!.workspaces[0]!.status?.label).toBe("Pending Approval");
    expect(titles(apps[0]!.workspaces[0]!.sections.active)).not.toContain("archived");
  });
});

describe("appTargetWorkspace", () => {
  it("picks the workspace with the latest thread activity", () => {
    const hopper = makeProject("hopper");
    const liquid = makeProject("liquid");
    const [app] = build({
      projects: [hopper, liquid],
      threads: [
        makeThread("old", hopper, { updatedAt: "2026-10-20T00:00:00.000Z" }),
        makeThread("new", liquid, { updatedAt: "2026-10-24T00:00:00.000Z" }),
      ],
    });

    expect(appTargetWorkspace(app!)?.project.title).toBe("liquid");
    expect(appTargetWorkspace({ workspaces: [] })).toBeNull();
  });
});

describe("appWorkspaceOpenUrl", () => {
  it("fills the app's template with the workspace folder, and has no link without one", () => {
    const hopper = { project: makeProject("hopper") };

    expect(appWorkspaceOpenUrl("rocketwright://open?root={workspaceRoot}", hopper)).toBe(
      "rocketwright://open?root=%2Fwork%2Fhopper",
    );
    expect(appWorkspaceOpenUrl(null, hopper)).toBeNull();
    expect(appWorkspaceOpenUrl("rocketwright://open", null)).toBeNull();
    expect(
      appWorkspaceOpenUrl("rocketwright://open", { project: makeProject("plain", MAC, null) }),
    ).toBeNull();
  });
});

describe("Apps-mode scope and folds", () => {
  it("lists every app while the scoped app is missing", () => {
    const apps = [{ appId: ROCKET }, { appId: ATLAS }];

    expect(resolveAppsSidebarScope(apps, ATLAS)).toEqual({ appId: ATLAS });
    expect(resolveAppsSidebarScope(apps, "com.example.gone")).toBeNull();
    expect(resolveAppsSidebarScope(apps, null)).toBeNull();
  });

  it("starts Settled folded and every other group open until the user chooses", () => {
    const settled = { kind: "section", section: "settled", workspaceKey: "mac:hopper" } as const;
    const pinned = { kind: "section", section: "pinned", workspaceKey: "mac:hopper" } as const;
    const app = { kind: "app", appId: ROCKET } as const;

    expect(isAppTreeGroupCollapsed({}, settled)).toBe(true);
    expect(isAppTreeGroupCollapsed({}, pinned)).toBe(false);
    expect(isAppTreeGroupCollapsed({}, app)).toBe(false);
    expect(isAppTreeGroupCollapsed({ [appTreeGroupKey(settled)]: false }, settled)).toBe(false);
    expect(isAppTreeGroupCollapsed({ [appTreeGroupKey(app)]: true }, app)).toBe(true);
  });
});

describe("Apps-mode shortcuts", () => {
  const hopper = makeProject("hopper");
  const liquid = makeProject("liquid");
  const atlasDesk = makeProject("desk", MAC, ATLAS);
  const threads = [
    makeThread("pinned", hopper, { pinnedAt: "2026-10-21T00:00:00.000Z" }),
    makeThread("active", hopper, { updatedAt: "2026-10-22T00:00:00.000Z" }),
    makeThread("settled", hopper, { settledOverride: "settled" }),
    makeThread("fresh", liquid, { updatedAt: "2026-10-24T00:00:00.000Z" }),
    makeThread("atlas", atlasDesk, { updatedAt: "2026-10-23T00:00:00.000Z" }),
  ];
  const apps = build({ projects: [hopper, liquid, atlasDesk], threads });
  const rocket = apps.find((app) => app.appId === ROCKET)!;
  const atlas = apps.find((app) => app.appId === ATLAS)!;
  const workspaceKey = (title: string) =>
    rocket.workspaces.find((workspace) => workspace.project.title === title)!.key;
  const threadKey = (title: string) => {
    const thread = threads.find((candidate) => candidate.title === title)!;
    return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  };

  it("walks the rows Apps mode shows, in order, leaving folded groups out", () => {
    const visible = (
      collapsedByKey: Record<string, boolean>,
      selected = null as typeof rocket | null,
    ) => titles(appsSidebarVisibleThreads({ apps, selected, collapsedByKey }));

    expect(visible({})).toEqual(["atlas", "pinned", "active", "fresh"]);
    expect(visible({ [appTreeGroupKey({ kind: "app", appId: ATLAS })]: true })).toEqual([
      "pinned",
      "active",
      "fresh",
    ]);
    expect(
      visible({
        [appTreeGroupKey({
          kind: "section",
          section: "settled",
          workspaceKey: workspaceKey("hopper"),
        })]: false,
        [appTreeGroupKey({ kind: "workspace", workspaceKey: workspaceKey("liquid") })]: true,
      }),
    ).toEqual(["atlas", "pinned", "active", "settled"]);
    // A selected app shows under its header even when its row was folded in the list.
    expect(visible({ [appTreeGroupKey({ kind: "app", appId: ROCKET })]: true }, rocket)).toEqual([
      "pinned",
      "active",
      "fresh",
    ]);
  });

  it("starts New thread in the open app thread's workspace, else the latest one in view", () => {
    const target = (selected: typeof rocket | null, activeThreadKey: string | null) =>
      appsNewThreadWorkspace({ apps, selected, activeThreadKey })?.project.title ?? null;

    expect(target(null, threadKey("active"))).toBe("hopper");
    expect(target(null, null)).toBe("liquid");
    expect(target(rocket, threadKey("atlas"))).toBe("liquid");
    expect(target(atlas, threadKey("active"))).toBe("desk");
    expect(target(null, "mac:not-an-app-thread")).toBe("liquid");
    expect(appsNewThreadWorkspace({ apps: [], selected: null, activeThreadKey: null })).toBeNull();
  });
});
