// @effect-diagnostics nodeBuiltinImport:off - The fixture under test is host-side tooling that owns temp directories.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { fetchBarShellSnapshot, issueBarReadToken, seedBarFixture } from "../seed-bar-fixture.ts";
import {
  BAR_APP_BUNDLE_PATH,
  BAR_APP_ID,
  BAR_APP_STAGED_THREADS,
  type BarAppManifest,
  barAppBundle,
  barAppLiveStateProblems,
  barAppRegistration,
  barAppWorkspaceRoot,
  expectedBarAppSections,
  readBarAppManifest,
} from "./app-fixture.ts";
import { barAppStagingChecks, sidebarSectionChecks } from "./app-scenes.ts";
import { barAppPreflightProblems, parseCaptureWebArgs } from "./capture-web.ts";
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

const manifest: BarAppManifest = {
  version: 1,
  appId: BAR_APP_ID,
  appName: "Embed Host",
  environmentId: "env",
  stagedAt: "2026-10-25T12:00:00.000Z",
  approvalExpiresAt: "2026-10-25T12:10:00.000Z",
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
  pinnedImportThreadIds: [],
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
});

it("refuses to capture once the staged approval has expired", () => {
  const before = Date.parse(manifest.approvalExpiresAt) - 1;
  assert.deepEqual(barAppPreflightProblems({ manifest, liveProblems: [], now: before }), []);
  assert.match(
    barAppPreflightProblems({ manifest, liveProblems: [], now: before + 1 }).join(),
    /expired/u,
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
