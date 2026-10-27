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

import { makeThreadShellFixture } from "../../test-fixtures";
import type { HomeGroupDisplayState } from "../home/homeListItems";
import {
  appCardCollapseKey,
  appCardFrames,
  appCardTargetWorkspace,
  appClosedBannerState,
  appPairingKind,
  appScreenTitle,
  appSettledShelfKey,
  appStatusPresentation,
  appThreadSubtitle,
  buildAppCards,
  buildAppsTabItems,
  type AppsTabItem,
} from "./apps-tab-state";

const NOW = "2026-10-25T12:00:00.000Z";
const MAC = EnvironmentId.make("mac");
const SERVER = EnvironmentId.make("server");
const ROCKET = AppId.make("com.example.rocket");
const ICON = "data:image/png;base64,iVBORw0KGgo=";

function makeStatus(overrides: Partial<AppStatus> = {}): AppStatus {
  return {
    appId: ROCKET,
    name: "RocketWright",
    iconDataUrl: ICON,
    toolPrefix: "rw",
    refPrefixes: ["rw:"],
    openUrlTemplate: "rocketwright://open?root={workspaceRoot}&thread={threadId}",
    state: "granted",
    live: { expiresAt: "2026-10-25T12:01:00.000Z" },
    lastSeenAt: NOW,
    runtimeCeiling: null,
    headlessTools: null,
    gatedTools: [],
    embedOrigins: [],
    pendingRequest: null,
    ...overrides,
  };
}

function pendingRequest(registration: Partial<AppStatus["pendingRequest"]> = {}) {
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
    ...registration,
  } satisfies AppStatus["pendingRequest"];
}

function makeProject(
  id: string,
  environmentId: EnvironmentId,
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

const running = {
  status: "running",
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  lastErrorClass: null,
  updatedAt: NOW,
} satisfies EnvironmentThreadShell["runtime"];

function makeThread(
  id: string,
  project: EnvironmentProject,
  overrides: Partial<EnvironmentThreadShell> & { readonly appSubtitle?: string } = {},
): EnvironmentThreadShell {
  const { appSubtitle, ...rest } = overrides;
  const thread = makeThreadShellFixture({
    environmentId: project.environmentId,
    id: ThreadId.make(id),
    projectId: project.id,
    title: id,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...rest,
  });
  return appSubtitle === undefined
    ? thread
    : { ...thread, source: { ...thread.source, appSubtitle } };
}

const labels = new Map([
  [MAC, "Mac"],
  [SERVER, "Server"],
]);

function summarize(items: ReadonlyArray<AppsTabItem>): string[] {
  return items.flatMap((item) => {
    const indent = "  ".repeat(item.depth);
    switch (item.type) {
      case "app-card-header":
        return `${indent}app ${item.card.name}${item.collapsed ? " (collapsed)" : ""}`;
      case "app-pairing":
        return `${indent}pairing ${item.kind}${item.machineLabel ? ` on ${item.machineLabel}` : ""}`;
      case "app-workspace-header":
        return `${indent}workspace ${item.project.title}${item.collapsed ? " (collapsed)" : ""}`;
      case "app-thread":
        return [
          ...(item.sectionLabel === null ? [] : [`${indent}${item.sectionLabel}`]),
          `${indent}- ${item.thread.title}`,
        ];
      case "app-settled-shelf":
        return `${indent}Settled (${item.count})${item.expanded ? " open" : ""}`;
      case "app-empty":
        return `${indent}${item.message}`;
    }
  });
}

function build(input: {
  readonly statuses?: ReadonlyMap<EnvironmentId, ReadonlyArray<AppStatus>>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly displayStates?: ReadonlyMap<string, HomeGroupDisplayState>;
  readonly searchQuery?: string;
}) {
  const cards = buildAppCards({
    statuses: input.statuses ?? new Map([[MAC, [makeStatus()]]]),
    projects: input.projects,
    threads: input.threads,
    environmentLabels: labels,
  });
  return {
    cards,
    items: buildAppsTabItems({
      cards,
      displayStates: input.displayStates ?? new Map(),
      searchQuery: input.searchQuery ?? "",
      now: NOW,
      environmentLabels: labels,
    }),
  };
}

describe("app status", () => {
  it("is Running only with a live lease", () => {
    expect(appStatusPresentation(makeStatus())).toEqual({ label: "Running", tone: "running" });
    expect(appStatusPresentation(makeStatus({ live: null }))).toEqual({
      label: "Closed",
      tone: "closed",
    });
    expect(appStatusPresentation(makeStatus({ state: "revoked", live: null })).label).toBe(
      "Revoked",
    );
    expect(appStatusPresentation(makeStatus({ state: "pairing-requested" })).tone).toBe(
      "attention",
    );
  });

  it("names why a pairing request waits", () => {
    expect(appPairingKind(makeStatus())).toBeNull();
    expect(
      appPairingKind(makeStatus({ state: "pairing-requested", pendingRequest: pendingRequest() })),
    ).toBe("new");
    expect(appPairingKind(makeStatus({ state: "revoked", pendingRequest: pendingRequest() }))).toBe(
      "repair",
    );
    expect(appPairingKind(makeStatus({ pendingRequest: pendingRequest() }))).toBe("renew");
    const changed = pendingRequest();
    expect(
      appPairingKind(
        makeStatus({
          pendingRequest: {
            ...changed,
            registration: { ...changed.registration, embedOrigins: ["http://localhost:5173"] },
          },
        }),
      ),
    ).toBe("changed");
  });
});

describe("app cards", () => {
  it("merges an app across environments and counts busy threads", () => {
    const hopper = makeProject("hopper", MAC);
    const liquid = makeProject("liquid", SERVER);
    const plain = makeProject("plain", MAC, null);
    const { cards } = build({
      statuses: new Map([
        [MAC, [makeStatus({ live: null })]],
        [SERVER, [makeStatus()]],
      ]),
      projects: [hopper, liquid, plain],
      threads: [
        makeThread("working", hopper, { runtime: running }),
        makeThread("approval", liquid, { hasPendingApprovals: true }),
        makeThread("idle", hopper),
        makeThread("plain-working", plain, { runtime: running }),
      ],
    });
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.primary?.environmentId).toBe(SERVER);
    expect(appStatusPresentation(card.primary!.app).label).toBe("Running");
    expect(card.workingCount).toBe(2);
    expect(card.spansEnvironments).toBe(true);
    expect(card.workspaces.map((workspace) => workspace.machineLabel)).toEqual(["Mac", "Server"]);
  });

  it("keeps an app's threads reachable when no environment reports the app", () => {
    const hopper = makeProject("hopper", MAC);
    const { cards } = build({
      statuses: new Map(),
      projects: [hopper],
      threads: [makeThread("a", hopper)],
    });
    expect(cards.map((card) => [card.name, card.primary])).toEqual([[ROCKET, null]]);
  });

  it("targets the most recently active workspace", () => {
    const quiet = makeProject("quiet", MAC);
    const busy = makeProject("busy", MAC);
    const { cards } = build({
      projects: [quiet, busy],
      threads: [
        makeThread("old", quiet),
        makeThread("new", busy, { updatedAt: "2026-10-24T00:00:00.000Z" }),
      ],
    });
    expect(appCardTargetWorkspace(cards[0]!)?.id).toBe(busy.id);
  });
});

describe("apps tab items", () => {
  const hopper = makeProject("hopper-38mm", MAC);
  const liquid = makeProject("liquid-demo", MAC);
  const threads = [
    makeThread("Baseline flight", hopper, {
      pinnedAt: "2026-10-21T00:00:00.000Z",
      appSubtitle: "baseline / 305.23 m",
    }),
    makeThread("Fin clearance", hopper, { runtime: running }),
    makeThread("Old run", hopper, { settledOverride: "settled", settledAt: NOW }),
    makeThread("Older run", hopper, { settledOverride: "settled", settledAt: NOW }),
    makeThread("Feed system review", liquid, { runtime: running }),
    makeThread("Dusty", liquid, { settledOverride: "settled", settledAt: NOW }),
  ];

  it("draws the mockup tree with Pinned and Active labels and a collapsed Settled shelf", () => {
    const { items } = build({ projects: [hopper, liquid], threads });
    expect(summarize(items)).toEqual([
      "app RocketWright",
      "  workspace hopper-38mm",
      "    Pinned",
      "    - Baseline flight",
      "    Active",
      "    - Fin clearance",
      "    Settled (2)",
      "  workspace liquid-demo",
      "    Active",
      "    - Feed system review",
      "    Settled (1)",
    ]);
    expect(
      items.filter((item) => item.type === "app-thread").map((item) => item.sectionLabel),
    ).toEqual(["Pinned", "Active", "Active"]);
  });

  it("labels only each section's first thread, as one row with it", () => {
    const { items } = build({
      projects: [hopper],
      threads: [
        makeThread("Fin clearance", hopper, { runtime: running }),
        makeThread("Nose cone", hopper, { runtime: running }),
      ],
    });
    expect(
      items.flatMap((item) =>
        item.type === "app-thread" ? [[item.thread.title, item.sectionLabel]] : [],
      ),
    ).toEqual([
      ["Fin clearance", "Active"],
      ["Nose cone", null],
    ]);
  });

  it("gives each workspace header the thread list's count and spacing", () => {
    const { items } = build({ projects: [hopper, liquid], threads });
    expect(
      items.flatMap((item) =>
        item.type === "app-workspace-header"
          ? [[item.project.title, item.threadCount, item.isFirst]]
          : [],
      ),
    ).toEqual([
      ["hopper-38mm", 4, true],
      ["liquid-demo", 2, false],
    ]);
  });

  it("opens a Settled shelf and collapses workspaces and apps on request", () => {
    const shelf = appSettledShelfKey(`${MAC}:${hopper.id}`);
    const expanded = build({
      projects: [hopper, liquid],
      threads,
      displayStates: new Map([
        [shelf, { collapsed: false, visibleCount: 6 }],
        [`${MAC}:${liquid.id}`, { collapsed: true, visibleCount: 6 }],
      ]),
    });
    expect(summarize(expanded.items).slice(6)).toEqual([
      "    Settled (2) open",
      "    - Old run",
      "    - Older run",
      "  workspace liquid-demo (collapsed)",
    ]);

    const collapsedApp = build({
      projects: [hopper, liquid],
      threads,
      displayStates: new Map([[appCardCollapseKey(ROCKET), { collapsed: true, visibleCount: 6 }]]),
    });
    expect(summarize(collapsedApp.items)).toEqual(["app RocketWright (collapsed)"]);
  });

  it("searches thread titles, opening collapsed groups, unless the app's name matches", () => {
    const collapsed = new Map([[appCardCollapseKey(ROCKET), { collapsed: true, visibleCount: 6 }]]);
    const byThread = build({
      projects: [hopper, liquid],
      threads,
      displayStates: collapsed,
      searchQuery: "old",
    });
    expect(summarize(byThread.items)).toEqual([
      "app RocketWright",
      "  workspace hopper-38mm",
      "    Settled (2) open",
      "    - Old run",
      "    - Older run",
    ]);

    const byName = build({ projects: [hopper, liquid], threads, searchQuery: "rocket" });
    expect(byName.items.filter((item) => item.type === "app-thread")).toHaveLength(6);

    expect(build({ projects: [hopper, liquid], threads, searchQuery: "zzz" }).items).toEqual([]);
  });

  it("puts pairing requests under the app, labelled by machine when it spans several", () => {
    const remote = makeProject("remote", SERVER);
    const { items } = build({
      statuses: new Map([
        [
          MAC,
          [
            makeStatus({
              state: "pairing-requested",
              live: null,
              pendingRequest: pendingRequest(),
            }),
          ],
        ],
        [SERVER, [makeStatus({ state: "revoked", live: null, pendingRequest: pendingRequest() })]],
      ]),
      projects: [remote],
      threads: [],
    });
    expect(summarize(items)).toEqual([
      "app RocketWright",
      "  pairing new on Mac",
      "  pairing repair on Server",
      "  workspace remote",
      "    No threads yet",
    ]);
  });

  it("says where threads will appear for an app with no workspace", () => {
    const { items } = build({ projects: [], threads: [] });
    expect(summarize(items)).toEqual([
      "app RocketWright",
      "  Threads started from RocketWright appear here.",
    ]);
  });

  it("frames each app as one box", () => {
    const other = makeStatus({ appId: AppId.make("com.example.zeta"), name: "Zeta" });
    const { items } = build({
      statuses: new Map([[MAC, [makeStatus(), other]]]),
      projects: [hopper],
      threads: [makeThread("a", hopper)],
    });
    const frames = appCardFrames(items);
    expect(items.map((item) => frames.get(item.key))).toEqual([
      { first: true, last: false },
      { first: false, last: false },
      { first: false, last: true },
      { first: true, last: false },
      { first: false, last: true },
    ]);
  });
});

describe("app thread rows", () => {
  const project = makeProject("hopper", MAC);

  it("prefer the app's subtitle, then the status, and leave idle threads plain", () => {
    expect(appThreadSubtitle(makeThread("a", project, { appSubtitle: "baseline / 305 m" }))).toBe(
      "baseline / 305 m",
    );
    expect(appThreadSubtitle(makeThread("b", project, { runtime: running }))).toBe("Working");
    expect(appThreadSubtitle(makeThread("c", project, { hasPendingApprovals: true }))).toBe(
      "Needs approval",
    );
    expect(appThreadSubtitle(makeThread("d", project, { appSubtitle: "  " }))).toBeNull();
  });
});

describe("app screen title", () => {
  it("uses the name the card shows, preferring the environment where the app runs", () => {
    const statuses = new Map([
      [MAC, [makeStatus({ name: "RocketWright (old)", live: null })]],
      [SERVER, [makeStatus()]],
    ]);
    expect(appScreenTitle(statuses, ROCKET)).toBe("RocketWright");
    expect(
      buildAppCards({ statuses, projects: [], threads: [], environmentLabels: labels })[0]?.name,
    ).toBe("RocketWright");
  });

  it("stays blank until an environment reports the app", () => {
    expect(appScreenTitle(new Map(), ROCKET)).toBeNull();
    expect(
      appScreenTitle(
        new Map([[MAC, [makeStatus({ appId: AppId.make("com.example.other"), name: "Other" })]]]),
        ROCKET,
      ),
    ).toBeNull();
  });
});

describe("closed banner", () => {
  const binding = { appId: ROCKET, workspaceRoot: "/work/hopper 38" };
  const context = {
    appId: ROCKET,
    name: "RocketWright",
    iconDataUrl: ICON,
    refPrefixes: ["rw:"],
    openUrlTemplate: "rocketwright://open?root={workspaceRoot}&thread={threadId}",
    embedOrigins: [],
    live: null,
    state: "granted" as const,
  };

  it("shows for a granted app without a live lease, with an encoded open link", () => {
    expect(appClosedBannerState({ context, binding, threadId: "t-1" })).toEqual({
      title: "RocketWright closed: live tools unavailable",
      openLabel: "Open in RocketWright",
      openUrl: "rocketwright://open?root=%2Fwork%2Fhopper%2038&thread=t-1",
    });
  });

  it("stays hidden while the app runs, after a revoke, and on normal projects", () => {
    expect(
      appClosedBannerState({
        context: { ...context, live: { expiresAt: NOW } },
        binding,
        threadId: "t-1",
      }),
    ).toBeNull();
    expect(
      appClosedBannerState({ context: { ...context, state: "revoked" }, binding, threadId: "t-1" }),
    ).toBeNull();
    expect(appClosedBannerState({ context, binding: undefined, threadId: "t-1" })).toBeNull();
  });
});
