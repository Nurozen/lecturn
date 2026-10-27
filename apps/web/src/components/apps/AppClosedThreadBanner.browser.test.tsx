import "../../index.css";

import { scopeThreadRef } from "@lecturn/client-runtime/environment";
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

import { ChatBannerLane } from "../chat/ChatBannerLane";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { ThreadErrorBanner } from "../chat/ThreadErrorBanner";

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

async function renderEmptyAppThread(threadError: string | null = null) {
  threadCount += 1;
  const threadRef = scopeThreadRef(MAC, ThreadId.make(`t-empty-${threadCount}`));
  const props: ComponentProps<typeof MessagesTimeline> = {
    timelineEntries: [],
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `${MAC}:${threadRef.threadId}`,
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
  // The chat canvas as ChatView lays it out: the banner lane over the timeline.
  await act(async () =>
    root.render(
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatBannerLane threadRef={threadRef}>
          <ThreadErrorBanner error={threadError} onDismiss={() => {}} />
        </ChatBannerLane>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <MessagesTimeline {...props} />
        </div>
      </div>,
    ),
  );
}

const banner = () => container.querySelector<HTMLElement>('[data-testid="app-closed-banner"]');
const threadErrorAlert = () => container.querySelector<HTMLElement>('[data-slot="alert"]');
const placeholder = () =>
  [...container.querySelectorAll<HTMLElement>("p")].find((node) =>
    node.textContent?.includes("Send a message to start the conversation."),
  ) ?? null;

/** Names what keeps `element` from the user; it can be laid out while a transparent ancestor hides it. */
function concealer(element: HTMLElement | null) {
  if (element === null) return "missing";
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (Number(style.opacity) === 0 || style.visibility === "hidden" || node.inert)
      return `${node.tagName.toLowerCase()}.${node.className}`;
  }
  return null;
}

describe("AppClosedThreadBanner on an empty app thread", () => {
  it("heads a thread with no messages yet when its app is closed", async () => {
    embedContext = context();
    await renderEmptyAppThread();

    await vi.waitFor(() => expect(banner()?.textContent).toContain("Rocket closed"));
    await vi.waitFor(() => expect(concealer(banner())).toBeNull());
    expect(container.textContent).not.toContain("Send a message to start the conversation.");
  });

  it("heads it when the app's access was revoked", async () => {
    embedContext = context({ state: "revoked" });
    await renderEmptyAppThread();

    await vi.waitFor(() => expect(banner()?.textContent).toContain("Rocket access revoked"));
    await vi.waitFor(() => expect(concealer(banner())).toBeNull());
  });

  it("keeps a thread error from covering the revoked notice", async () => {
    embedContext = context({ state: "revoked" });
    await renderEmptyAppThread("Turn failed: Rocket was revoked (approval cancelled).");

    await vi.waitFor(() => expect(concealer(banner())).toBeNull());
    expect(concealer(threadErrorAlert())).toBeNull();
    const notice = banner()!.getBoundingClientRect();
    const error = threadErrorAlert()!.getBoundingClientRect();
    expect(notice.height).toBeGreaterThan(0);
    expect(error.height).toBeGreaterThan(0);
    expect(error.bottom).toBeLessThanOrEqual(notice.top);
  });

  it("keeps the start placeholder while the app is running", async () => {
    embedContext = context({ live: { expiresAt: "2026-10-26T12:00:00.000Z" } });
    await renderEmptyAppThread();

    await vi.waitFor(() => expect(concealer(placeholder())).toBeNull());
    expect(banner()).toBeNull();
  });
});
