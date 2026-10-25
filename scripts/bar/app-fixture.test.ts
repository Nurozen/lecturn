// @effect-diagnostics nodeBuiltinImport:off - The fixture under test is host-side tooling that owns temp directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  BAR_FIXTURE,
  barGitStateProblems,
  barProjectId,
  barWorkspaceRoot,
  fetchBarShellSnapshot,
  issueBarReadToken,
  seedBarFixture,
} from "../seed-bar-fixture.ts";
import {
  BAR_APP_BUNDLE_PATH,
  BAR_APP_ID,
  BAR_APP_STAGED_THREADS,
  BAR_PENDING_APP_ID,
  BAR_PROJECTS_APPROVAL_THREAD,
  type BarAppManifest,
  barAppBundle,
  barAppLiveStateProblems,
  barAppRegistration,
  barAppSceneParams,
  barAppWorkspaceRoot,
  barPendingAppRegistration,
  expectedBarAppSections,
  readBarAppManifest,
} from "./app-fixture.ts";
import { barAppStagingChecks, sidebarSectionChecks } from "./app-scenes.ts";
import {
  BAR_APP_WEB_SCENES,
  barAppPreflightProblems,
  parseCaptureWebArgs,
  resolveScenePath,
} from "./capture-web.ts";
import { type ProbeRoot, stagingProblems } from "./probe-dom.ts";

const SERVER_TEST_TIMEOUT_MS = 300_000;

const rawBundle = () => JSON.parse(NodeFS.readFileSync(BAR_APP_BUNDLE_PATH, "utf8")) as unknown;

it("retargets the checked-in bundle at this app and base dir, unpinned", () => {
  const bundle = barAppBundle(rawBundle(), "/fixture");
  assert.equal(bundle.appId, BAR_APP_ID);
  assert.deepEqual(
    bundle.projects.map((project) => [project.title, project.workspaceRoot]),
    [
      ["ws-a", barAppWorkspaceRoot("/fixture", "ws-a")],
      ["ws-b", barAppWorkspaceRoot("/fixture", "ws-b")],
    ],
  );
  assert.isTrue(
    bundle.projects.every((project) => project.threads.every((thread) => !thread.pinned)),
  );
  assert.isAbove(bundle.assets.length, 0);
});

it("places one pinned thread per workspace, the staged threads as active and the rest settled", () => {
  const sections = expectedBarAppSections(barAppBundle(rawBundle(), "/fixture"));
  assert.deepEqual(sections, {
    "ws-a": { pinned: 1, active: 2, settled: 4 },
    "ws-b": { pinned: 1, active: 2, settled: 2 },
  });
  const working = BAR_APP_STAGED_THREADS.filter((thread) => thread.settles === "hold");
  assert.lengthOf(working, 2);
  // The live-host threads run before the lease is cleared, so the app ends Closed.
  const firstLocal = BAR_APP_STAGED_THREADS.findIndex((thread) => !thread.needsLiveHost);
  assert.isTrue(BAR_APP_STAGED_THREADS.slice(firstLocal).every((thread) => !thread.needsLiveHost));
});

it("registers Embed Host with its gated live flash and lock-free tool listing", () => {
  const registration = barAppRegistration("/usr/bin/node");
  assert.deepEqual(registration.gatedTools, ["window_flash"]);
  assert.isTrue(registration.liveTools);
  const counter = registration.headlessTools?.args[0];
  assert.isTrue(counter !== undefined && NodeFS.existsSync(counter));
  assert.include(registration.headlessTools?.listArgs ?? [], "--list-tools");
});

it("stages a second app that sorts after Embed Host and claims no tool prefix of its own", () => {
  const pending = barPendingAppRegistration();
  assert.equal(pending.appId, BAR_PENDING_APP_ID);
  assert.notEqual(pending.toolPrefix, barAppRegistration().toolPrefix);
  assert.isAbove(pending.name.localeCompare(barAppRegistration().name), 0);
});

const manifest: BarAppManifest = {
  version: 1,
  appId: BAR_APP_ID,
  appName: "Embed Host",
  environmentId: "env",
  stagedAt: "2026-10-25T12:00:00.000Z",
  approvalExpiresAt: "2026-10-25T12:10:00.000Z",
  pendingPairing: {
    appId: BAR_PENDING_APP_ID,
    appName: "Sketch Pad",
    requestId: "request",
    expiresAt: "2026-10-25T12:10:30.000Z",
  },
  workspaces: [
    {
      key: "ws-a",
      projectId: "a",
      workspaceRoot: "/a",
      expected: { pinned: 1, active: 2, settled: 1 },
    },
    {
      key: "ws-b",
      projectId: "b",
      workspaceRoot: "/b",
      expected: { pinned: 0, active: 2, settled: 0 },
    },
  ],
  threads: {
    mockup: "mockup",
    supervised: "supervised",
    fullAccess: "full",
    workingA: "wa",
    workingB: "wb",
  },
  latestThreadId: "wb",
  pinnedImportThreadIds: [],
  projectsApprovalThreadId: "run38",
};

const shellThread = (
  id: string,
  projectId: string,
  overrides: Partial<{
    status: string;
    pinnedAt: string | null;
    settledOverride: string | null;
    pendingRuntimeRequest: unknown;
  }> = {},
) => ({
  id,
  projectId,
  status: "completed",
  pinnedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  ...overrides,
});

const stagedShell = () => ({
  threads: [
    shellThread("mockup", "a", { pinnedAt: "2026-10-25T12:00:00.000Z" }),
    shellThread("supervised", "a", { status: "running", pendingRuntimeRequest: { id: "r" } }),
    shellThread("full", "a"),
    shellThread("old", "a", { settledOverride: "settled" }),
    shellThread("wa", "b", { status: "running" }),
    shellThread("wb", "b", { status: "waiting" }),
    shellThread("run38", "hopper", { status: "running", pendingRuntimeRequest: { id: "c" } }),
  ],
});

it("accepts the live states as staged and names each kind of drift", () => {
  assert.deepEqual(barAppLiveStateProblems(stagedShell(), manifest), []);

  const released = stagedShell();
  released.threads[4] = shellThread("wa", "b");
  assert.match(
    barAppLiveStateProblems(released, manifest).join("\n"),
    /1 app threads are working/u,
  );

  const answered = stagedShell();
  answered.threads[1] = shellThread("supervised", "a", { status: "running" });
  assert.match(
    barAppLiveStateProblems(answered, manifest).join("\n"),
    /pending approvals on \[\]/u,
  );

  const unpinned = stagedShell();
  unpinned.threads[0] = shellThread("mockup", "a");
  const problems = barAppLiveStateProblems(unpinned, manifest).join("\n");
  assert.match(problems, /ws-a has 0 pinned threads, expected 1/u);
  assert.match(problems, /mockup is not pinned/u);

  // The Projects-mode approval is outside the app workspaces, so only its own check sees it.
  const copilotAnswered = stagedShell();
  copilotAnswered.threads[6] = shellThread("run38", "hopper");
  assert.deepEqual(barAppLiveStateProblems(copilotAnswered, manifest), [
    "run38 is not waiting on its approval",
  ]);
});

it("refuses to capture once the staged approval or the pairing request has expired", () => {
  const before = Date.parse(manifest.approvalExpiresAt) - 1;
  assert.deepEqual(barAppPreflightProblems({ manifest, liveProblems: [], now: before }), []);
  assert.match(
    barAppPreflightProblems({ manifest, liveProblems: [], now: before + 1 }).join(),
    /staged approval expired/u,
  );
  const pairingLapsed = { ...manifest, approvalExpiresAt: "2026-10-25T13:00:00.000Z" };
  assert.match(
    barAppPreflightProblems({
      manifest: pairingLapsed,
      liveProblems: [],
      now: Date.parse(manifest.pendingPairing.expiresAt),
    }).join(),
    /Sketch Pad pairing request expired/u,
  );
  assert.match(
    barAppPreflightProblems({
      manifest,
      liveProblems: [],
      gitProblems: ["hopper-38mm is inside the Git repository /x"],
      now: before,
    }).join(),
    /inside the Git repository/u,
  );
});

it("opens the Apps list scenes on an app thread, not the Projects-mode draft", () => {
  const params = { ...barAppSceneParams(manifest), environmentId: "env" };
  assert.equal(resolveScenePath(BAR_APP_WEB_SCENES["apps-list"], params), "/env/wb?sidebar=apps");
  assert.equal(
    resolveScenePath(BAR_APP_WEB_SCENES["apps-app-selected"], params),
    `/env/wb?sidebar=apps&app=${encodeURIComponent(BAR_APP_ID)}`,
  );
});

interface FakeNode {
  readonly text?: string;
  readonly points?: number;
  readonly children?: FakeTree;
  readonly frame?: FakeTree;
}
type FakeTree = Readonly<Record<string, ReadonlyArray<FakeNode>>>;

function fakeRoot(tree: FakeTree): ProbeRoot {
  const nodes = (selector: string) => tree[selector] ?? [];
  return {
    count: async (selector) => nodes(selector).length,
    texts: async (selector) => nodes(selector).map((node) => node.text ?? ""),
    scopes: async (selector) => nodes(selector).map((node) => fakeRoot(node.children ?? {})),
    frame: async (selector) => {
      const frame = nodes(selector)[0]?.frame;
      return frame === undefined ? null : fakeRoot(frame);
    },
    pointCounts: async (selector) => nodes(selector).map((node) => node.points ?? 0),
  };
}

const workspace = (sections: FakeTree): FakeNode => ({ children: sections });
const pinnedHeading = { '[data-testid="app-section-heading"][data-section="pinned"]': [{}] };
const activeHeading = { '[data-testid="app-section-heading"][data-section="active"]': [{}] };
const settledLabel = (count: number) => ({
  '[data-testid="app-section-heading"][data-section="settled"] [data-testid="app-section-heading-label"]':
    [{ text: `Settled (${count})` }],
});

const sidebarTree = (settledA: number): FakeTree => ({
  '[data-testid="sidebar-app-workspace"]': [
    workspace({ ...pinnedHeading, ...activeHeading, ...settledLabel(settledA) }),
    workspace({ ...activeHeading }),
  ],
  '[data-testid="app-thread-row"]': [{}, {}, {}, {}, {}],
});

it("reads section placement per workspace from the Settled count and the visible rows", async () => {
  const checks = sidebarSectionChecks(manifest);
  assert.deepEqual(await stagingProblems(checks, fakeRoot(sidebarTree(1))), []);
  assert.match(
    (await stagingProblems(checks, fakeRoot(sidebarTree(3)))).join("\n"),
    /^sections-ws-a: /mu,
  );
});

const card = (layout: "wide" | "narrow"): FakeNode => ({
  frame: {
    [`[data-card-layout="${layout}"][data-state="saved"]`]: [{}],
    '[data-card-layout][data-state="saved"]': [{}],
    "[data-card-stat]": [{}, {}, {}],
    "[data-card-chart] polyline": [{ points: 12 }],
  },
});

const threadPane = (input: { approval: boolean; layout: "wide" | "narrow" }): FakeTree => ({
  '[data-testid="app-thread-row"][data-selected="true"]': [{}],
  '[data-testid="app-closed-banner"]': [{}],
  '[data-testid="mcp-app-card"]': [{ children: { iframe: [card(input.layout)] } }],
  '[data-slot="composer-shell"] button': [{ text: "Full access" }],
  ...(input.approval ? { '[data-testid="app-approval-card"]': [{}] } : {}),
});

it("holds the mockup and Full access scenes to no approval card, and Supervised to one", async () => {
  const fullAccess = barAppStagingChecks("app-thread-full-access", manifest);
  assert.deepEqual(
    await stagingProblems(fullAccess, fakeRoot(threadPane({ approval: false, layout: "wide" }))),
    [],
  );
  assert.match(
    (
      await stagingProblems(fullAccess, fakeRoot(threadPane({ approval: true, layout: "wide" })))
    ).join(),
    /no-approval-card/u,
  );
  const supervised = barAppStagingChecks("app-thread-supervised", manifest);
  assert.match(
    (
      await stagingProblems(supervised, fakeRoot(threadPane({ approval: false, layout: "wide" })))
    ).join(),
    /pending-approval-card/u,
  );
  const mockup = barAppStagingChecks("apps-desktop-mockup-scene", manifest);
  const narrow = await stagingProblems(
    mockup,
    fakeRoot({ ...sidebarTree(1), ...threadPane({ approval: false, layout: "narrow" }) }),
  );
  assert.include(narrow.join("\n"), "card-ready-wide");
});

const pairingRow = (buttons: ReadonlyArray<string>): FakeTree => ({
  '[data-testid="app-pairing-row"]': [{ children: { button: buttons.map((text) => ({ text })) } }],
});

it("holds the Apps list to the waiting app's Approve and Deny row and an open app thread", async () => {
  const draft: FakeTree = {
    '[data-testid="sidebar-mode-option"][data-selected="true"]': [{ text: "Apps" }],
    '[data-testid="sidebar-app-row"]': [
      { children: { '[data-testid="sidebar-app-state"]': [{ text: "Closed" }] } },
      { children: { '[data-testid="sidebar-app-state"]': [{ text: "Pairing" }] } },
    ],
  };
  const appRow: FakeTree = {
    ...draft,
    '[data-testid="app-thread-row"][data-selected="true"]': [{}],
  };
  const checks = barAppStagingChecks("apps-list", manifest);
  assert.deepEqual(
    await stagingProblems(checks, fakeRoot({ ...appRow, ...pairingRow(["Deny", "Approve"]) })),
    [],
  );
  const problems = (await stagingProblems(checks, fakeRoot(appRow))).join("\n");
  assert.match(problems, /^pairing-row: /mu);
  // The wide chip CP3 found crowding the waiting app's name.
  const wideChip: FakeTree = {
    ...appRow,
    ...pairingRow(["Deny", "Approve"]),
    '[data-testid="sidebar-app-row"]': [
      { children: { '[data-testid="sidebar-app-state"]': [{ text: "Closed" }] } },
      { children: { '[data-testid="sidebar-app-state"]': [{ text: "Pairing requested" }] } },
    ],
  };
  assert.match((await stagingProblems(checks, fakeRoot(wideChip))).join(), /app-row-pairing/u);
  assert.match(
    (
      await stagingProblems(
        checks,
        fakeRoot({
          ...appRow,
          ...pairingRow(["Deny", "Approve"]),
          '[data-testid="app-pairing-prompt"]': [{}],
        }),
      )
    ).join(),
    /no-pairing-prompt/u,
  );
  assert.match(
    (
      await stagingProblems(checks, fakeRoot({ ...draft, ...pairingRow(["Deny", "Approve"]) }))
    ).join(),
    /selected-thread-row/u,
  );
});

it("holds Projects mode to CP0's non-Git workspace and its waiting approval row", async () => {
  const projects = (buttons: ReadonlyArray<string>, extra: FakeTree = {}): FakeTree => ({
    '[data-testid="sidebar-mode-option"][data-selected="true"]': [{ text: "Projects" }],
    '[data-testid="sidebar-scope-label"]': [{ text: "All projects" }],
    '[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]': [
      { text: "Baseline flight 12m" },
      { text: "Run 38 m… Approval" },
    ],
    button: buttons.map((text) => ({ text })),
    ...extra,
  });
  const checks = barAppStagingChecks("projects-mode", manifest);
  assert.deepEqual(await stagingProblems(checks, fakeRoot(projects(["Initialize Git"]))), []);
  // Before the status loads, the client draws a repository.
  const loading = await stagingProblems(
    checks,
    fakeRoot(
      projects(["Select ref"], {
        'button:has-text("Select ref")': [{}, {}],
        'button:has-text("Current checkout")': [{}],
      }),
    ),
  );
  assert.match(loading.join(), /^not-git-repo: /u);
});

it("captures the app scenes with --after and needs the base dir for their manifest", () => {
  const base = ["--pairing-url", "http://127.0.0.1:1/pair#token=x", "--out", "/tmp/out"];
  assert.throws(() => parseCaptureWebArgs([...base, "--after"]), /--base-dir/u);
  const after = parseCaptureWebArgs([...base, "--after", "--base-dir", "/tmp/home"]);
  assert.includeMembers(
    [...after.scenes],
    [
      "apps-desktop-mockup-scene",
      "apps-list",
      "apps-app-selected",
      "app-thread-supervised",
      "app-thread-full-access",
      "settings-connected-apps",
      "projects-mode",
    ],
  );
  assert.deepEqual(
    [...parseCaptureWebArgs(base).scenes],
    ["projects-sidebar", "thread-approval", "settings-connections"],
  );
});

it(
  "stages every live state on a real server and keeps them until capture",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-bar-app-"));
    // A home inside a repository: the fixture workspaces must still read as no repository.
    NodeChildProcess.execFileSync("git", ["init", "--quiet", root]);
    const baseDir = NodePath.join(await NodeFSP.realpath(root), "home");
    const { server, app } = await seedBarFixture({ baseDir, app: true });
    try {
      assert.isNotNull(app);
      assert.deepEqual(await readBarAppManifest(baseDir), app);
      const snapshot = await fetchBarShellSnapshot(
        server!.origin,
        await issueBarReadToken(baseDir),
      );
      assert.deepEqual(barAppLiveStateProblems(snapshot, app!), []);
      assert.deepEqual(await barGitStateProblems(baseDir), []);
      const hopper = BAR_FIXTURE.find((project) => project.key === "hopper-38mm")!;
      assert.isTrue(barWorkspaceRoot(baseDir, hopper).startsWith(await NodeFSP.realpath(root)));
      const approval = snapshot.threads.find(
        (thread) => String(thread.id) === app!.projectsApprovalThreadId,
      );
      assert.equal(String(approval?.projectId), barProjectId(hopper));
      assert.equal(approval?.title, BAR_PROJECTS_APPROVAL_THREAD.title);
      assert.equal(app!.pendingPairing.appId, BAR_PENDING_APP_ID);
      assert.isAbove(Date.parse(app!.pendingPairing.expiresAt), Date.parse(app!.stagedAt));
      // The Apps list scenes open the app thread updated last.
      const appProjects = new Set(app!.workspaces.map((workspace) => workspace.projectId));
      const appThreads = snapshot.threads.filter((thread) =>
        appProjects.has(String(thread.projectId)),
      );
      const updatedAt = (thread: (typeof appThreads)[number]) =>
        Date.parse(String(thread.updatedAt));
      const latest = appThreads.find((thread) => String(thread.id) === app!.latestThreadId)!;
      assert.isTrue(appThreads.every((thread) => updatedAt(thread) <= updatedAt(latest)));
      // The mockup thread's two tool rows and its card ran on the headless tools alone.
      const calls = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(barAppWorkspaceRoot(baseDir, "ws-a"), ".embed-host", "counter-calls.json"),
          "utf8",
        ),
      ) as ReadonlyArray<unknown>;
      assert.lengthOf(calls, 3);
    } finally {
      await server?.stop();
      await NodeFSP.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  SERVER_TEST_TIMEOUT_MS,
);
