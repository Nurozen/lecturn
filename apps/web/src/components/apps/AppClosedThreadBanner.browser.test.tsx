import "../../index.css";

import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  AppId,
  type AppEmbedContext,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@lecturn/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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

const REVOKED_TURN_ERROR = "Turn failed: Rocket was revoked (approval cancelled).";
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

type TimelineProps = ComponentProps<typeof MessagesTimeline>;

function ChatCanvas({
  timeline,
  threadError,
}: {
  readonly timeline: TimelineProps;
  readonly threadError: string | null;
}) {
  const [error, setError] = useState(threadError);
  // The chat canvas as ChatView lays it out: the banner lane over the timeline.
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatBannerLane>
        <ThreadErrorBanner error={error} onDismiss={() => setError(null)} />
      </ChatBannerLane>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessagesTimeline {...timeline} />
      </div>
    </div>
  );
}

async function renderAppThread({
  threadError = null,
  timelineEntries = [],
}: {
  readonly threadError?: string | null;
  readonly timelineEntries?: TimelineProps["timelineEntries"];
} = {}) {
  threadCount += 1;
  const threadRef = scopeThreadRef(MAC, ThreadId.make(`t-app-${threadCount}`));
  const listRef = createRef<LegendListRef | null>();
  const props: TimelineProps = {
    timelineEntries,
    isWorking: false,
    activeTurnInProgress: false,
    listRef,
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
  await act(async () => root.render(<ChatCanvas timeline={props} threadError={threadError} />));
  return listRef;
}

const CREATED_AT = "2026-10-26T12:00:00.000Z";
const reply = (index: number): TimelineProps["timelineEntries"][number] => ({
  id: `entry-${index}`,
  kind: "message",
  createdAt: CREATED_AT,
  message: {
    id: MessageId.make(`message-${index}`),
    role: "assistant",
    text: `Reply ${index}. ${"The counter moved once and the flash was refused. ".repeat(6)}`,
    runId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    streaming: false,
  },
});

/** A finished thread a little taller than the screen, so the notice and the end are both close. */
const SLIGHTLY_OVERFLOWING_THREAD = Array.from({ length: 10 }, (_, index) => reply(index));

const banner = () => container.querySelector<HTMLElement>('[data-testid="app-closed-banner"]');
const threadErrorAlert = () => container.querySelector<HTMLElement>('[data-slot="alert"]');
const nextFrames = async (count: number) => {
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
};
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
    await renderAppThread();

    await vi.waitFor(() => expect(banner()?.textContent).toContain("Rocket closed"));
    await vi.waitFor(() => expect(concealer(banner())).toBeNull());
    expect(container.textContent).not.toContain("Send a message to start the conversation.");
  });

  it("heads it when the app's access was revoked", async () => {
    embedContext = context({ state: "revoked" });
    await renderAppThread();

    await vi.waitFor(() => expect(banner()?.textContent).toContain("Rocket access revoked"));
    await vi.waitFor(() => expect(concealer(banner())).toBeNull());
  });

  it("keeps a thread error from covering the revoked notice", async () => {
    embedContext = context({ state: "revoked" });
    await renderAppThread({ threadError: REVOKED_TURN_ERROR });

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
    await renderAppThread();

    await vi.waitFor(() => expect(concealer(placeholder())).toBeNull());
    expect(banner()).toBeNull();
  });
});

describe("AppClosedThreadBanner when the thread error is dismissed", () => {
  async function renderRevokedThreadWithError() {
    embedContext = context({ state: "revoked" });
    const listRef = await renderAppThread({
      threadError: REVOKED_TURN_ERROR,
      timelineEntries: SLIGHTLY_OVERFLOWING_THREAD,
    });
    await vi.waitFor(() => expect(concealer(banner())).toBeNull());
    const viewport = listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
    expect(viewport.scrollHeight - viewport.clientHeight).toBeLessThan(viewport.clientHeight);
    return viewport;
  }

  const distanceFromEnd = (viewport: HTMLElement) =>
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;

  async function dismissThreadError() {
    await userEvent.click(container.querySelector<HTMLElement>('[aria-label="Dismiss error"]')!);
    await vi.waitFor(() => expect(threadErrorAlert()).toBeNull());
    // The list re-pins to the end from an animation frame after it re-measures.
    await nextFrames(4);
  }

  it("keeps the revoked notice in view for a reader at the top", async () => {
    const viewport = await renderRevokedThreadWithError();
    await vi.waitFor(() => expect(distanceFromEnd(viewport)).toBeLessThanOrEqual(1));
    await act(async () => viewport.scrollTo({ top: 0 }));
    await nextFrames(2);
    expect(viewport.scrollTop).toBe(0);

    await dismissThreadError();

    const notice = banner()!.getBoundingClientRect();
    const visible = viewport.getBoundingClientRect();
    expect(viewport.scrollTop).toBe(0);
    expect(notice.top).toBeGreaterThanOrEqual(visible.top);
    expect(notice.bottom).toBeLessThanOrEqual(visible.bottom);
  });

  it("keeps a reader at the end at the end", async () => {
    const viewport = await renderRevokedThreadWithError();
    await vi.waitFor(() => expect(distanceFromEnd(viewport)).toBeLessThanOrEqual(1));

    await dismissThreadError();

    expect(distanceFromEnd(viewport)).toBeLessThanOrEqual(1);
  });
});
