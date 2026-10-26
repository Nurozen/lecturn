import "~/index.css";
import "../../embed/embed.css";

import { RegistryProvider } from "@effect/atom-react";
import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import { EnvironmentId, MessageId, ProjectId, RunId } from "@lecturn/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { EmbedPresentationContext } from "../../embed/EmbedPresentationContext";
import { serverEnvironment } from "../../state/server";
import { MessagesTimeline } from "../chat/MessagesTimeline";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const presentation = { projectRef: scopeProjectRef(ENVIRONMENT_ID, ProjectId.make("project-1")) };
// RocketWright's agent pane, which is the embed's whole viewport.
const PANE_WIDTH = 352;
const EARLIER = RunId.make("run-earlier");
const LATEST = RunId.make("run-latest");
const APP_SOURCE = { key: "app:rocketwright", name: "RocketWright", kind: "integration" };

const providers = [
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {},
    checkedAt: "2026-10-25T10:00:00.000Z",
    models: [{ slug: "claude-opus-5", name: "Opus 5", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
] as never;

const runs = [EARLIER, LATEST].map((id, index) => ({
  id,
  ordinal: index + 1,
  providerInstanceId: "claudeAgent",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
})) as never;

function at(seconds: number) {
  return new Date(Date.UTC(2026, 9, 25, 10, 0, seconds)).toISOString();
}

function message(id: string, role: "user" | "assistant", text: string, runId: RunId, time: string) {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: time,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId,
      createdAt: time,
      updatedAt: time,
      streaming: false,
    },
  } as Entry;
}

type ToolSource = typeof APP_SOURCE | undefined;

function tool(id: string, label: string, runId: RunId, time: string, toolSource: ToolSource) {
  return {
    id,
    kind: "work",
    createdAt: time,
    entry: {
      id,
      createdAt: time,
      runId,
      label,
      toolTitle: label,
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      ...(toolSource === undefined ? {} : { toolSource }),
    },
  } as Entry;
}

/**
 * Two finished turns, each the mockup's shape: a request, two tool calls, a prose reply. Without a
 * source the calls are what CP-W1's copied fixture threads carry; app calls never fold (A27a).
 */
function turns(toolSource: ToolSource): Entry[] {
  return [
    message("user-1", "user", "Check the fins and simulate baseline.", EARLIER, at(0)),
    tool("tool-1", "rw_design_check", EARLIER, at(2), toolSource),
    tool("tool-2", "rw_simulate baseline", EARLIER, at(4), toolSource),
    message("reply-1", "assistant", "The baseline passes the design check.", EARLIER, at(20)),
    message("user-2", "user", "Try a little more fin span with less sweep.", LATEST, at(30)),
    tool("tool-3", "rw_component_update", LATEST, at(32), toolSource),
    tool("tool-4", "rw_simulate candidate", LATEST, at(34), toolSource),
    message("reply-2", "assistant", "The proposed fin set is shown in teal.", LATEST, at(50)),
  ];
}

let threadCount = 0;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.classList.add("dark");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete document.documentElement.dataset.lecturnEmbed;
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
});

async function renderTimeline(options: {
  embedded: boolean;
  width: number;
  toolSource?: ToolSource;
}) {
  await page.viewport(options.width, 900);
  if (options.embedded) document.documentElement.dataset.lecturnEmbed = "";
  container.style.cssText = `height: 900px; width: ${options.width}px; display: flex; flex-direction: column;`;
  threadCount += 1;
  const timeline = (
    <MessagesTimeline
      isWorking={false}
      activeTurnInProgress={false}
      listRef={createRef<LegendListRef | null>()}
      latestRun={{ runId: LATEST, status: "completed", startedAt: at(30), completedAt: at(50) }}
      turnDiffSummaries={[]}
      runs={runs}
      routeThreadKey={`environment-local:embed-thread-${threadCount}`}
      onOpenTurnDiff={() => {}}
      onOpenThread={() => {}}
      onForkFromRun={async () => {}}
      onRollbackCheckpoint={() => {}}
      supportsConversationRollback={false}
      onRevertToTurnCount={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      activeThreadEnvironmentId={ENVIRONMENT_ID}
      markdownCwd={undefined}
      resolvedTheme="dark"
      timestampFormat="locale"
      workspaceRoot={undefined}
      anchorMessageId={null}
      onAnchorReady={() => {}}
      onAnchorSizeChanged={() => {}}
      contentInsetEndAdjustment={0}
      liveFollowEnabled
      onIsAtEndChange={() => {}}
      onManualNavigation={() => {}}
      timelineEntries={turns(options.toolSource)}
    />
  );
  await act(async () =>
    root.render(
      <RegistryProvider
        initialValues={[[serverEnvironment.providersValueAtom(ENVIRONMENT_ID), providers]]}
      >
        {options.embedded ? (
          <EmbedPresentationContext value={presentation}>{timeline}</EmbedPresentationContext>
        ) : (
          timeline
        )}
      </RegistryProvider>,
    ),
  );
  await act(async () => document.fonts.ready);
}

function fontSize(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  return Number.parseFloat(getComputedStyle(element!).fontSize);
}

function byText(selector: string, text: string) {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).find((element) =>
    element.textContent?.includes(text),
  );
}

function foldButtons() {
  return Array.from(container.querySelectorAll("button")).filter((button) =>
    button.textContent?.startsWith("Worked for"),
  );
}

function appToolRows() {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-app-tool-outcome]"));
}

function visibleToolLabels() {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-timeline-row-kind^='work'] *"),
  ).flatMap((element) =>
    element.childElementCount === 0 && /rw_|RocketWright/i.test(element.textContent ?? "")
      ? [element.textContent?.toLowerCase()]
      : [],
  );
}

/** The innermost element holding a tool row's label, whether the row stands alone or heads a group. */
function toolLabel() {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-timeline-row-kind^='work'] *"),
  ).find(
    (element) =>
      element.childElementCount === 0 && /rw_|Used \d+ tools/i.test(element.textContent ?? ""),
  );
}

/** Every size the type probe and the mockup read: prose, its row container, bubble, tool row, fold. */
async function measureTypeScale() {
  const prose = byText("[data-message-role='assistant'] .chat-markdown p", "proposed fin set");
  const sizes = {
    prose: fontSize(prose),
    proseContainer: fontSize(prose?.closest("[data-thread-find-text]")),
    userBubble: fontSize(byText("[data-chat-user-message-bubble] p", "fin span")),
    workLogFold: fontSize(foldButtons()[0]),
  };
  // Outside the embed every tool row sits behind a fold.
  for (const fold of foldButtons()) await act(async () => fold.click());
  return { ...sizes, toolRow: fontSize(toolLabel()) };
}

describe("embed timeline at the pane width", () => {
  it("sets the timeline in the desktop type sizes, with the body at 14 px", async () => {
    await renderTimeline({ embedded: true, width: PANE_WIDTH });
    const embedded = await measureTypeScale();
    expect(embedded).toEqual({
      prose: 14,
      proseContainer: 14,
      userBubble: 14,
      toolRow: 14,
      workLogFold: 14,
    });

    await act(async () => root.unmount());
    delete document.documentElement.dataset.lecturnEmbed;
    root = createRoot(container);
    await renderTimeline({ embedded: false, width: 1280 });
    const desktop = await measureTypeScale();
    // Full Lecturn is unchanged: its row containers still inherit the 16 px root.
    expect(desktop).toEqual({ ...embedded, proseContainer: 16 });
  });

  it("keeps the latest turn's tool rows open and folds the earlier turn", async () => {
    await renderTimeline({ embedded: true, width: PANE_WIDTH });
    expect(foldButtons()).toHaveLength(1);
    expect(visibleToolLabels()).toEqual(["rw_component_update", "rw_simulate candidate"]);
    const reply = byText("[data-message-role='assistant']", "proposed fin set")!;
    const lastTool = byText("[data-timeline-row-kind='work']", "simulate candidate")!;
    expect(lastTool.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      reply.getBoundingClientRect().top + 1,
    );
  });

  it("folds every finished turn outside the embed", async () => {
    await renderTimeline({ embedded: false, width: PANE_WIDTH });
    expect(foldButtons()).toHaveLength(2);
    expect(visibleToolLabels()).toEqual([]);
  });

  it("draws the latest turn's app calls as one row each, with the success mark", async () => {
    await renderTimeline({ embedded: true, width: PANE_WIDTH, toolSource: APP_SOURCE });
    const rows = appToolRows();
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("rw_component_update"),
      expect.stringContaining("rw_simulate candidate"),
    ]);
    for (const row of rows) {
      expect(row.dataset.appToolOutcome).toBe("succeeded");
      expect(row.getAttribute("aria-expanded")).toBe("false");
    }
    // The earlier turn keeps its calls grouped behind one summary row.
    expect(visibleToolLabels()).not.toContain("rw_design_check");

    await act(async () => root.unmount());
    delete document.documentElement.dataset.lecturnEmbed;
    root = createRoot(container);
    await renderTimeline({ embedded: false, width: PANE_WIDTH, toolSource: APP_SOURCE });
    expect(appToolRows()).toHaveLength(0);
  });

  it("names the agent above each reply to a user message", async () => {
    await renderTimeline({ embedded: true, width: PANE_WIDTH });
    const names = Array.from(
      container.querySelectorAll<HTMLElement>("[data-testid='embed-agent-name']"),
    );
    expect(names.map((name) => name.textContent)).toEqual(["Claude", "Claude"]);

    const name = names[1]!;
    const prose = byText("[data-message-role='assistant'] .chat-markdown p", "proposed fin set")!;
    expect(name.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      prose.getBoundingClientRect().top,
    );
    expect(fontSize(name)).toBeLessThan(fontSize(prose));
    expect(getComputedStyle(name).color).not.toBe(getComputedStyle(prose).color);
    expect(container.querySelector("[data-message-role='assistant'] img")).toBeNull();
  });

  it("leaves replies unnamed outside the embed", async () => {
    await renderTimeline({ embedded: false, width: PANE_WIDTH });
    expect(container.querySelector("[data-testid='embed-agent-name']")).toBeNull();
  });
});
