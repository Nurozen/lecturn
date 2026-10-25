import "../../index.css";

import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import { scopedThreadKey, scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  AppId,
  type AppStatus,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@lecturn/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { makeThreadFixture } from "../../test-fixtures";

vi.mock(import("./useAppClosedBanner"), async (original) => ({
  ...(await original()),
  useCanOpenApp: (() => true) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
}));

import { TooltipProvider } from "../ui/tooltip";
import { AppHeader } from "./AppHeader";
import { AppRow } from "./AppRow";
import { AppsGroup } from "./AppsGroup";
import { buildAppsSidebarApps, type AppsSidebarApp } from "./AppsSidebar.logic";
import { AppWorkspaceTree, type AppTreeContext } from "./AppWorkspaceTree";

// The default 16rem sidebar less its group's 0.5rem inset on each side.
const SIDEBAR_GROUP_WIDTH = 240;
const NOW = "2026-10-25T12:00:00.000Z";
const MAC = EnvironmentId.make("mac");
const ICON = "data:image/png;base64,iVBORw0KGgo=";

const status: AppStatus = {
  appId: AppId.make("com.example.rocket"),
  name: "RocketWright",
  iconDataUrl: ICON,
  toolPrefix: "rw",
  refPrefixes: ["rw:"],
  openUrlTemplate: "rocketwright://open?workspace={workspaceRoot}",
  state: "granted",
  live: null,
  lastSeenAt: NOW,
  runtimeCeiling: null,
  headlessTools: null,
  gatedTools: [],
  embedOrigins: [],
  pendingRequest: null,
};

const project: EnvironmentProject = {
  environmentId: MAC,
  id: ProjectId.make("hopper-38mm"),
  title: "hopper-38mm",
  workspaceRoot: "/work/hopper-38mm",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  appBinding: { appId: status.appId, workspaceRoot: "/work/hopper-38mm" },
};

function thread(id: string, title: string, running: boolean): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: MAC,
    id: ThreadId.make(id),
    projectId: project.id,
    title,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...(running
      ? {
          runtime: {
            status: "running",
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: null,
            lastErrorClass: null,
            updatedAt: NOW,
          },
        }
      : {}),
  });
}

const selectedThread = thread("t-counter", "Counter baseline", false);

function app(): AppsSidebarApp {
  return buildAppsSidebarApps({
    statuses: [{ environmentId: MAC, app: status }],
    projects: [project],
    threads: [
      selectedThread,
      thread("t-flash", "Flash in Finder", true),
      thread("t-watch", "Watch the counter", true),
      thread("t-long", "Long counter run", true),
    ],
    environmentLabels: new Map([[MAC, "Mac"]]),
    now: NOW,
    supports: () => ({ settlement: true, snooze: true }),
  })[0]!;
}

const SKETCH = AppId.make("com.example.sketch");

function pendingApp(): AppsSidebarApp {
  return buildAppsSidebarApps({
    statuses: [
      {
        environmentId: MAC,
        app: {
          ...status,
          appId: SKETCH,
          name: "Sketch Pad",
          state: "pairing-requested",
          pendingRequest: {
            requestId: "request-1",
            requestedAt: NOW,
            registration: {
              appId: SKETCH,
              name: "Sketch Pad",
              iconDataUrl: ICON,
              toolPrefix: "sk",
              refPrefixes: ["sk:"],
              liveTools: true,
              gatedTools: [],
            },
          },
        },
      },
    ],
    projects: [],
    threads: [],
    environmentLabels: new Map([[MAC, "Mac"]]),
    now: NOW,
    supports: () => ({ settlement: true, snooze: true }),
  })[0]!;
}

const noop = () => undefined;
const context: AppTreeContext = {
  collapsedByKey: {},
  onToggle: noop,
  activeThreadKey: scopedThreadKey(scopeThreadRef(MAC, selectedThread.id)),
  jumpLabelByKey: null,
  actions: {
    open: noop,
    startRename: noop,
    cancelRename: noop,
    commitRename: noop,
    renamingThreadKey: null,
    pin: noop,
    unpin: noop,
    settle: noop,
    unsettle: noop,
    archive: async () => undefined,
  } as never,
  supports: () => ({ pinning: true, settlement: true }),
  onNewThread: noop,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.className = "dark";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(width: number, children: ReactNode) {
  await page.viewport(1440, 900);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <div style={{ width }}>{children}</div>
      </TooltipProvider>,
    ),
  );
}

function readsWhole(element: Element | null) {
  expect(element).not.toBeNull();
  const { clientWidth, scrollWidth } = element as HTMLElement;
  expect(clientWidth).toBeGreaterThan(0);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

describe("Apps sidebar rows at the default sidebar width", () => {
  it("keeps the app name whole beside the Closed chip and the working count", async () => {
    const subject = app();
    expect(subject.workingCount).toBe(3);
    await render(
      SIDEBAR_GROUP_WIDTH,
      <AppsGroup>
        <li className="list-none">
          <AppRow
            app={subject}
            collapsed={false}
            onToggle={noop}
            onSelect={noop}
            onNewThread={noop}
          />
        </li>
      </AppsGroup>,
    );

    readsWhole(container.querySelector('[data-testid="sidebar-app-name"]'));
    expect(container.querySelector('[data-testid="sidebar-app-state"]')?.textContent).toBe(
      "Closed",
    );
    expect(container.querySelector('[data-testid="sidebar-app-new-thread"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-app-open"]')).not.toBeNull();
  });

  it("keeps a pending app's name whole beside its pairing chip", async () => {
    const subject = pendingApp();
    expect(subject.pairing).toHaveLength(1);
    await render(
      SIDEBAR_GROUP_WIDTH,
      <AppsGroup>
        <li className="list-none">
          <AppRow
            app={subject}
            collapsed={false}
            onToggle={noop}
            onSelect={noop}
            onNewThread={noop}
          />
        </li>
        <AppWorkspaceTree app={subject} context={context} />
      </AppsGroup>,
    );

    readsWhole(container.querySelector('[data-testid="sidebar-app-name"]'));
    expect(container.querySelector('[data-testid="sidebar-app-state"]')?.textContent).toBe(
      "Pairing",
    );
    // The pairing row speaks for an app with no threads yet, so no second line runs on below it.
    expect(container.querySelector('[data-testid="app-tree-empty"]')).toBeNull();
  });

  it("keeps the empty-tree note inside its row when it wraps", async () => {
    const subject = { ...app(), workspaces: [], pairing: [] };
    await render(
      SIDEBAR_GROUP_WIDTH,
      <AppsGroup>
        <AppWorkspaceTree app={subject} context={context} />
      </AppsGroup>,
    );

    const note = container.querySelector('[data-testid="app-tree-empty"]') as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.scrollHeight).toBeLessThanOrEqual(note.clientHeight);
  });

  it("keeps the selected app's name whole in its one-row header", async () => {
    await render(SIDEBAR_GROUP_WIDTH, <AppHeader app={app()} onBack={noop} onNewThread={noop} />);

    const header = container.querySelector('[data-testid="app-header"]')!;
    readsWhole(header.querySelector('[data-testid="app-header-name"]'));
    expect(header.querySelector('[data-testid="app-header-working"]')?.textContent).toBe(
      "3 working",
    );
    // One row: the actions sit level with the name rather than stacked under it.
    expect(header.getBoundingClientRect().height).toBeLessThan(40);
  });

  it("reads the selected and unselected thread titles whole under a workspace", async () => {
    await render(
      SIDEBAR_GROUP_WIDTH,
      <AppsGroup>
        <AppWorkspaceTree app={app()} context={context} />
      </AppsGroup>,
    );

    const rows = Array.from(container.querySelectorAll('[data-testid="app-thread-row"]'));
    expect(rows.map((row) => row.getAttribute("aria-label")).toSorted()).toEqual([
      "Counter baseline",
      "Flash in Finder",
      "Long counter run",
      "Watch the counter",
    ]);
    for (const row of rows) readsWhole(row.querySelector("span.truncate"));
  });
});
