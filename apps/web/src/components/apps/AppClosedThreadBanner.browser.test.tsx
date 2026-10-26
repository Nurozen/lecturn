import "../../index.css";

import {
  AppId,
  type AppEmbedContext,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@lecturn/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const MAC = EnvironmentId.make("mac");
const PROJECT = ProjectId.make("hopper-38mm");
const APP_ID = AppId.make("com.example.rocket");
let embedContext: AppEmbedContext | null = null;

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: { threadId: string } | null) =>
    ref === null
      ? null
      : {
          id: ref.threadId,
          environmentId: MAC,
          projectId: PROJECT,
          title: "Counter baseline",
        }) as never,
  useProject: ((ref: unknown) =>
    ref === null
      ? null
      : { appBinding: { appId: APP_ID, workspaceRoot: "/work/hopper-38mm" } }) as never,
}));

vi.mock(import("../../state/apps"), async (original) => ({
  ...(await original()),
  useAppEmbedContext: ((ref: unknown) => (ref === null ? null : embedContext)) as never,
}));

import { MessagesTimeline } from "../chat/MessagesTimeline";

const context = (overrides: Partial<AppEmbedContext> = {}): AppEmbedContext => ({
  appId: APP_ID,
  name: "Rocket",
  iconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
  refPrefixes: [],
  openUrlTemplate: null,
  live: null,
  state: "granted",
  embedOrigins: [],
  ...overrides,
});

let threadCount = 0;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 900px; width: 900px; display: flex; flex-direction: column;";
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderEmptyAppThread() {
  threadCount += 1;
  const props: ComponentProps<typeof MessagesTimeline> = {
    timelineEntries: [],
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `${MAC}:${ThreadId.make(`t-empty-${threadCount}`)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: MAC,
    markdownCwd: undefined,
    resolvedTheme: "dark",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
  await act(async () => root.render(<MessagesTimeline {...props} />));
}

const banner = () => container.querySelector<HTMLElement>('[data-testid="app-closed-banner"]');

describe("AppClosedThreadBanner on an empty app thread", () => {
  it("heads a thread with no messages yet when its app is closed", async () => {
    embedContext = context();
    await renderEmptyAppThread();

    await vi.waitFor(() => expect(banner()?.textContent).toContain("Rocket closed"));
    expect(container.textContent).not.toContain("Send a message to start the conversation.");
  });

  it("heads it when the app's access was revoked", async () => {
    embedContext = context({ state: "revoked" });
    await renderEmptyAppThread();

    await vi.waitFor(() => expect(banner()?.textContent).toContain("Rocket access revoked"));
  });

  it("keeps the start placeholder while the app is running", async () => {
    embedContext = context({ live: { expiresAt: "2026-10-26T12:00:00.000Z" } });
    await renderEmptyAppThread();

    expect(container.textContent).toContain("Send a message to start the conversation.");
    expect(banner()).toBeNull();
  });
});
