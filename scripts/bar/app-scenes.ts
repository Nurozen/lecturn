/**
 * What each after-capture scene must show before it is captured (A38). The
 * checks name the DOM hooks the desktop checklist already pins, plus the
 * example card's own hooks, so a staging miss is told apart from a gap a
 * critic should judge: a scene that fails here is not written.
 */
import type { BarAppManifest } from "./app-fixture.ts";
import type { Probe, StagingCheck } from "./probe-dom.ts";

export const BAR_APP_SCENE_NAMES = [
  "projects-mode",
  "apps-list",
  "apps-app-selected",
  "apps-desktop-mockup-scene",
  "app-thread-supervised",
  "app-thread-full-access",
  "settings-connected-apps",
] as const;
export type BarAppSceneName = (typeof BAR_APP_SCENE_NAMES)[number];

const id = (testId: string) => `[data-testid="${testId}"]`;
const sectionHeading = (section: string) =>
  `${id("app-section-heading")}[data-section="${section}"]`;

const check = (checkId: string, probe: Probe): StagingCheck => ({ id: checkId, probe });

const mode = (label: "Apps" | "Projects") =>
  check(`mode-${label.toLowerCase()}`, {
    kind: "text",
    selector: `${id("sidebar-mode-option")}[data-selected="true"]`,
    equals: label,
  });

const appClosed = check("app-row-closed", {
  kind: "some",
  selector: id("sidebar-app-row"),
  probes: [{ kind: "text", selector: id("sidebar-app-state"), equals: "Closed" }],
});

/** With one app selected, its header carries the state chip in place of the app row. */
const appHeaderClosed = check("app-header-closed", {
  kind: "some",
  selector: id("app-header"),
  probes: [{ kind: "text", selector: id("sidebar-app-state"), equals: "Closed" }],
});

const closedBanner = check("closed-banner", { kind: "count", selector: id("app-closed-banner") });

const fullAccess = check("full-access", {
  kind: "text",
  selector: '[data-slot="composer-shell"] button',
  pattern: "^Full access$",
});

const noApproval = check("no-approval-card", {
  kind: "all",
  probes: [
    { kind: "absent", selector: id("app-approval-card") },
    { kind: "absent", selector: "[data-approval-detail]" },
  ],
});

const pendingApproval = check("pending-approval-card", {
  kind: "count",
  selector: id("app-approval-card"),
});

/** The seeded pairing request prompts every admin client; capture dismisses it first. */
const noPairingPrompt = check("no-pairing-prompt", {
  kind: "absent",
  selector: id("app-pairing-prompt"),
});

/** CP3pol: the short chip, so the waiting app's name keeps its room (the full status is the tooltip). */
const appPairingChip = check("app-row-pairing", {
  kind: "some",
  selector: id("sidebar-app-row"),
  probes: [{ kind: "text", selector: id("sidebar-app-state"), equals: "Pairing" }],
});

const pairingRow = check("pairing-row", {
  kind: "some",
  selector: id("app-pairing-row"),
  probes: [
    { kind: "text", selector: "button", equals: "Approve" },
    { kind: "text", selector: "button", equals: "Deny" },
  ],
});

/**
 * CP0 drew no repository: Initialize Git and no ref picker. Until its status
 * loads the client assumes a repository, so this also waits that out.
 */
const notGitRepo = check("not-git-repo", {
  kind: "all",
  probes: [
    { kind: "text", selector: "button", equals: "Initialize Git" },
    { kind: "absent", selector: 'button:has-text("Select ref")' },
    { kind: "absent", selector: 'button:has-text("Current checkout")' },
  ],
});

/** The mock Copilot thread CP0 drew in hopper-38mm, still waiting on its approval. */
const projectsApprovalRow = check("projects-approval-row", {
  kind: "text",
  selector: '[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]',
  pattern: "Approval",
});

const selectedThread = check("selected-thread-row", {
  kind: "count",
  selector: `${id("app-thread-row")}[data-selected="true"]`,
  min: 1,
  max: 1,
});

/**
 * Ready means the card has its tool result (`data-state="saved"`), drawn three stats and its
 * chart. The Supervised thread stages the counter's first call, whose chart is one point; the
 * later threads draw a curve.
 */
const readyCard = (form?: "wide" | "narrow", minPoints = 2) =>
  check(form === undefined ? "card-ready" : `card-ready-${form}`, {
    kind: "some",
    selector: id("mcp-app-card"),
    probes: [
      {
        kind: "frame",
        selector: "iframe",
        probes: [
          {
            kind: "count",
            selector: `[data-card-layout${form === undefined ? "" : `="${form}"`}][data-state="saved"]`,
          },
          { kind: "count", selector: "[data-card-stat]", min: 3, max: 3 },
          { kind: "chart-points", selector: "[data-card-chart] polyline", min: minPoints },
        ],
      },
    ],
  });

/** Pinned, Active and Settled (n) per workspace as staged, with Settled collapsed as drawn. */
export function sidebarSectionChecks(manifest: BarAppManifest): ReadonlyArray<StagingCheck> {
  const visibleRows = manifest.workspaces.reduce(
    (sum, workspace) => sum + workspace.expected.pinned + workspace.expected.active,
    0,
  );
  return [
    check("workspaces", {
      kind: "count",
      selector: id("sidebar-app-workspace"),
      min: manifest.workspaces.length,
      max: manifest.workspaces.length,
    }),
    ...manifest.workspaces.map((workspace) => {
      const { pinned, active, settled } = workspace.expected;
      const probes: Array<Probe> = [];
      if (pinned > 0) probes.push({ kind: "count", selector: sectionHeading("pinned") });
      if (active > 0) probes.push({ kind: "count", selector: sectionHeading("active") });
      if (settled > 0) {
        probes.push({
          kind: "text",
          selector: `${sectionHeading("settled")} ${id("app-section-heading-label")}`,
          equals: `Settled (${settled})`,
        });
      }
      return check(`sections-${workspace.key}`, {
        kind: "some",
        selector: id("sidebar-app-workspace"),
        probes,
      });
    }),
    check("thread-rows", {
      kind: "count",
      selector: id("app-thread-row"),
      min: visibleRows,
      max: visibleRows,
    }),
  ];
}

export function barAppStagingChecks(
  scene: BarAppSceneName,
  manifest: BarAppManifest,
): ReadonlyArray<StagingCheck> {
  return [...sceneChecks(scene, manifest), noPairingPrompt];
}

function sceneChecks(
  scene: BarAppSceneName,
  manifest: BarAppManifest,
): ReadonlyArray<StagingCheck> {
  switch (scene) {
    case "projects-mode":
      return [
        mode("Projects"),
        check("scope-all-projects", {
          kind: "text",
          selector: id("sidebar-scope-label"),
          equals: "All projects",
        }),
        check("no-apps-group", { kind: "absent", selector: id("sidebar-apps-group") }),
        projectsApprovalRow,
        notGitRepo,
      ];
    case "apps-list":
      return [mode("Apps"), appClosed, appPairingChip, pairingRow, selectedThread];
    case "apps-app-selected":
      return [mode("Apps"), appHeaderClosed, ...sidebarSectionChecks(manifest), selectedThread];
    case "apps-desktop-mockup-scene":
      return [
        mode("Apps"),
        appClosed,
        ...sidebarSectionChecks(manifest),
        selectedThread,
        closedBanner,
        check("user-message", { kind: "count", selector: '[data-message-role="user"]' }),
        check("tool-rows-succeeded", {
          kind: "each",
          selector: id("app-tool-row"),
          min: 2,
          probes: [
            { kind: "count", selector: `${id("app-tool-row-status")}[data-status="success"]` },
          ],
        }),
        readyCard("wide"),
        check("assistant-text", { kind: "count", selector: '[data-message-role="assistant"]' }),
        fullAccess,
        noApproval,
      ];
    case "app-thread-supervised":
      return [selectedThread, closedBanner, pendingApproval, readyCard(undefined, 1)];
    case "app-thread-full-access":
      return [selectedThread, closedBanner, readyCard(), fullAccess, noApproval];
    case "settings-connected-apps":
      return [check("app-status", { kind: "count", selector: id("app-status") })];
  }
}
