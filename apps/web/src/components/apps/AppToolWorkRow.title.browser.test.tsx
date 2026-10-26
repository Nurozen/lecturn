import "~/index.css";
import "../../embed/embed.css";

import { RegistryProvider } from "@effect/atom-react";
import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as DateTime from "effect/DateTime";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { EmbedPresentationContext } from "../../embed/EmbedPresentationContext";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { serverEnvironment } from "../../state/server";
import { MessagesTimeline } from "../chat/MessagesTimeline";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-app-titles");
const RUN_ID = RunId.make("run-titles");
const APP_SOURCE = {
  key: "app:dev.rocketwright.app",
  name: "RocketWright",
  kind: "integration",
} as const;
const presentation = { projectRef: scopeProjectRef(ENVIRONMENT_ID, ProjectId.make("project-1")) };

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
const runs = [
  {
    id: RUN_ID,
    ordinal: 1,
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  },
] as never;

const time = (second: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, second)).toISOString();

function base(id: string, second: number) {
  return {
    id: TurnItemId.make(id),
    threadId: THREAD_ID,
    runId: RUN_ID,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    status: "completed" as const,
    title: null,
    startedAt: DateTime.makeUnsafe(time(second)),
    completedAt: DateTime.makeUnsafe(time(second)),
    updatedAt: DateTime.makeUnsafe(time(second)),
  };
}

/** App tool rows as the server sends them: the title on the item, the summary in the wire output. */
function appTool(
  id: string,
  second: number,
  toolName: string,
  title: string,
  summary?: string,
): OrchestrationV2TurnItem {
  return {
    ...base(id, second),
    type: "dynamic_tool",
    title,
    toolName: `mcp__lecturn__${toolName}`,
    toolSource: APP_SOURCE,
    input: { query: "H128" },
    ...(summary === undefined ? {} : { output: { _meta: { "lecturn/summary": summary } } }),
  };
}

const items: OrchestrationV2TurnItem[] = [
  {
    ...base("user", 0),
    type: "user_message",
    messageId: MessageId.make("user"),
    text: "Find a motor and check the design.",
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
  },
  appTool("tool-motors", 2, "rw_motor_search", "Find motors", "3 candidates"),
  appTool("tool-check", 4, "rw_design_check", "Check design"),
  {
    ...base("reply", 6),
    type: "assistant_message",
    messageId: MessageId.make("reply"),
    text: "The H128 fits the motor mount.",
    streaming: false,
  },
];

const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = items.map((item, position) => ({
  position,
  visibility: "local",
  sourceThreadId: THREAD_ID,
  sourceItemId: item.id,
  item,
}));

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

async function renderTimeline(embedded: boolean, width: number) {
  await page.viewport(width, 900);
  if (embedded) document.documentElement.dataset.lecturnEmbed = "";
  container.style.cssText = `height: 900px; width: ${width}px; display: flex; flex-direction: column;`;
  threadCount += 1;
  const timeline = (
    <MessagesTimeline
      isWorking={false}
      activeTurnInProgress={false}
      listRef={createRef<LegendListRef | null>()}
      latestRun={{ runId: RUN_ID, status: "completed", startedAt: time(0), completedAt: time(6) }}
      turnDiffSummaries={[]}
      runs={runs}
      routeThreadKey={`environment-local:app-titles-${threadCount}`}
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
      timelineEntries={deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems,
        optimisticMessages: [],
      })}
    />
  );
  await act(async () =>
    root.render(
      <RegistryProvider
        initialValues={[[serverEnvironment.providersValueAtom(ENVIRONMENT_ID), providers]]}
      >
        {embedded ? (
          <EmbedPresentationContext value={presentation}>{timeline}</EmbedPresentationContext>
        ) : (
          timeline
        )}
      </RegistryProvider>,
    ),
  );
  await act(async () => document.fonts.ready);
  if (embedded) return;
  // Outside the embed the calls collapse to one row per integration, and a finished turn may also
  // sit behind its fold. The list renders its rows a frame later, so each control is awaited.
  const usedGroup = () =>
    container.querySelector<HTMLElement>("button[aria-expanded='false'][aria-label^='Used']");
  const fold = await vi.waitFor(() => {
    const found =
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("Worked for"),
      ) ?? usedGroup();
    expect(found).toBeTruthy();
    return found!;
  });
  if (fold !== usedGroup()) await act(async () => fold.click());
  await openWhenShown(usedGroup);
}

async function openWhenShown(find: () => HTMLElement | null | undefined) {
  const control = await vi.waitFor(() => {
    const found = find();
    expect(found).toBeTruthy();
    return found!;
  });
  await act(async () => control.click());
}

function appRows() {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-testid='app-tool-row']"));
}

function part(row: HTMLElement, testId: string) {
  return row.querySelector<HTMLElement>(`[data-testid='${testId}']`);
}

async function expectReadableRows() {
  const [motors, check] = await vi.waitFor(() => {
    const rows = appRows();
    expect(rows).toHaveLength(2);
    return rows;
  });
  expect(motors).toBeDefined();
  expect(check).toBeDefined();
  expect(part(motors!, "app-tool-row-label")?.textContent).toBe("Find motors");
  expect(part(motors!, "app-tool-row-summary")?.textContent).toBe("· 3 candidates");
  expect(motors!.getAttribute("aria-label")).toBe("Find motors, 3 candidates");
  expect(part(check!, "app-tool-row-label")?.textContent).toBe("Check design");
  expect(part(check!, "app-tool-row-summary")).toBeNull();
  for (const row of [motors!, check!]) expect(row.textContent).not.toMatch(/rw_/);

  // The label and summary share one line inside the row.
  const label = part(motors!, "app-tool-row-label")!.firstElementChild!.getBoundingClientRect();
  const summary = part(motors!, "app-tool-row-summary")!.getBoundingClientRect();
  expect(Math.abs(label.top + label.height / 2 - (summary.top + summary.height / 2))).toBeLessThan(
    2,
  );
  expect(summary.left).toBeGreaterThanOrEqual(label.right);
  expect(summary.right).toBeLessThanOrEqual(motors!.getBoundingClientRect().right);
  return motors!;
}

describe("app tool row titles and summaries", () => {
  it("reads the tool's title and the app's summary in the 352 px embed", async () => {
    await renderTimeline(true, 352);
    const motors = await expectReadableRows();

    await act(async () => motors.click());
    expect(container.querySelector("[data-testid='app-tool-raw-name']")?.textContent).toBe(
      "rw_motor_search",
    );
  });

  it("reads the same in full Lecturn", async () => {
    await renderTimeline(false, 1280);
    await expectReadableRows();
  });
});
