import "~/index.css";
import "../../embed/embed.css";

import { RegistryProvider } from "@effect/atom-react";
import {
  appToolApprovalsOf,
  placeAppToolApprovals,
} from "@lecturn/client-runtime/state/app-tool-approval-placement";
import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import {
  AppId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@lecturn/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as DateTime from "effect/DateTime";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { EmbedPresentationContext } from "../../embed/EmbedPresentationContext";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  type PendingApproval,
} from "../../session-logic";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { useEmbedTimelineEntries } from "./embedPendingApprovalRows";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("approval-wait-thread");
const RUN_ID = RunId.make("run-approval-wait");
const REQUEST_ID = RuntimeRequestId.make("request-engine-simulate");
const presentation = { projectRef: scopeProjectRef(ENVIRONMENT_ID, ProjectId.make("project-1")) };
// RocketWright's agent pane, which is the embed's whole viewport.
const PANE_WIDTH = 352;
const APP_SOURCE = { key: "app:rocketwright", name: "RocketWright", kind: "integration" } as const;

const ENGINE_TOOL = {
  appId: AppId.make("io.rocketwright"),
  appName: "RocketWright",
  toolName: "rw_engine_simulate",
  reason: "engine_simulate duration not set",
  source: "app",
} as const;

const approval: PendingApproval = {
  requestId: REQUEST_ID,
  requestKind: "permission",
  createdAt: at(12),
  responseCapability: "live",
  connectedAppTool: ENGINE_TOOL,
};

function at(seconds: number) {
  return new Date(Date.UTC(2026, 9, 25, 10, 0, seconds)).toISOString();
}

function base(id: string, second: number, status: OrchestrationV2TurnItem["status"]) {
  const time = DateTime.makeUnsafe(at(second));
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
    status,
    title: null,
    startedAt: time,
    completedAt: status === "running" || status === "waiting" ? null : time,
    updatedAt: time,
  };
}

function appCall(id: string, tool: string, second: number, status: "running" | "completed") {
  return {
    ...base(id, second, status),
    type: "dynamic_tool",
    toolName: `lecturn.${tool}`,
    toolSource: APP_SOURCE,
    input: {},
  } satisfies OrchestrationV2TurnItem;
}

/** `settled` is `finished` once the run has ended and the timeline no longer folds it live. */
type Stage = "pending" | "approved" | "finished" | "settled";

/** The capture's turn: a request, a finished check, then the call the approval card holds. */
function turnItems(stage: Stage, parallel: boolean): OrchestrationV2TurnItem[] {
  const items: OrchestrationV2TurnItem[] = [
    {
      ...base("user-item", 0, "completed"),
      type: "user_message",
      messageId: MessageId.make("user-1"),
      text: "Check the fins and run baseline.",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    },
    appCall("design-check", "rw_design_check", 2, "completed"),
    appCall(
      "engine-simulate",
      "rw_engine_simulate",
      10,
      stage === "finished" || stage === "settled" ? "completed" : "running",
    ),
    {
      ...base("engine-approval", 12, stage === "pending" ? "waiting" : "completed"),
      type: "approval_request",
      requestId: REQUEST_ID,
      requestKind: "permission",
      appName: "RocketWright",
      prompt: "Approve rw_engine_simulate · engine_simulate duration not set",
    },
  ];
  // Started beside the held call and not gated, so it really runs while the card waits.
  if (parallel) {
    items.splice(
      2,
      0,
      appCall(
        "motor-search",
        "rw_motor_search",
        8,
        stage === "finished" || stage === "settled" ? "completed" : "running",
      ),
    );
  }
  return items;
}

/**
 * The rows as the thread detail atom hands them to ChatView. `raced` commits the approval before
 * the row of the call it holds, as the gate does when the provider's row is still in flight.
 */
function entriesFor(stage: Stage, parallel: boolean, raced: boolean) {
  const items = turnItems(stage, parallel).map((item): OrchestrationV2TurnItem => {
    if (!raced) return item;
    if (item.id === "engine-approval") {
      return { ...item, ordinal: 9, startedAt: DateTime.makeUnsafe(at(9)) };
    }
    return item.id === "engine-simulate" && item.completedAt !== null
      ? { ...item, completedAt: DateTime.makeUnsafe(at(14)) }
      : item;
  });
  items.sort((left, right) => left.ordinal - right.ordinal);
  const request: OrchestrationV2RuntimeRequest = {
    id: REQUEST_ID,
    nodeId: NodeId.make("engine-approval-node"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "permission",
    status: stage === "pending" ? "pending" : "resolved",
    responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
    createdAt: DateTime.makeUnsafe(at(raced ? 9 : 12)),
    resolvedAt: stage === "pending" ? null : DateTime.makeUnsafe(at(12)),
    connectedAppTool: ENGINE_TOOL,
  };
  const rows = items.map((item, position) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: THREAD_ID,
    sourceItemId: item.id,
    item,
  }));
  return deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: placeAppToolApprovals(rows, appToolApprovalsOf([request])),
    optimisticMessages: [],
  });
}

/** ChatView's wiring: the composer card's approvals filter the entries and mark the turn as waiting. */
function Timeline(props: { stage: Stage; parallel: boolean; raced: boolean; threadKey: string }) {
  const approvals = props.stage === "pending" ? [approval] : [];
  const timelineEntries = useEmbedTimelineEntries(
    entriesFor(props.stage, props.parallel, props.raced),
    approvals,
  );
  const live = props.stage !== "settled";
  return (
    <MessagesTimeline
      isWorking={live}
      activeTurnInProgress={live}
      awaitingUser={approvals.length > 0}
      activeTurnStartedAt={at(0)}
      listRef={createRef<LegendListRef | null>()}
      latestRun={{
        runId: RUN_ID,
        status: live ? "running" : "completed",
        startedAt: at(0),
        completedAt: live ? null : at(20),
      }}
      runningRunId={live ? RUN_ID : null}
      turnDiffSummaries={[]}
      runs={[]}
      routeThreadKey={props.threadKey}
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
      timelineEntries={timelineEntries}
    />
  );
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

async function mount(embedded: boolean, parallel = true, raced = false) {
  await page.viewport(PANE_WIDTH, 900);
  if (embedded) document.documentElement.dataset.lecturnEmbed = "";
  container.style.cssText = `height: 900px; width: ${PANE_WIDTH}px; display: flex; flex-direction: column;`;
  threadCount += 1;
  const threadKey = `environment-local:approval-wait-${threadCount}`;
  return async (stage: Stage) => {
    const timeline = (
      <Timeline stage={stage} parallel={parallel} raced={raced} threadKey={threadKey} />
    );
    await act(async () =>
      root.render(
        <RegistryProvider>
          {embedded ? (
            <EmbedPresentationContext value={presentation}>{timeline}</EmbedPresentationContext>
          ) : (
            timeline
          )}
        </RegistryProvider>,
      ),
    );
  };
}

const rowKinds = () =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-timeline-row-kind]")).map(
    (row) => row.dataset.timelineRowKind,
  );
const text = () => container.textContent ?? "";
/** The app tool rows top to bottom, the approval named by its kind. */
const workRows = () =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-v2-item-type]")).map((row) =>
    row.dataset.v2ItemType === "approval_request"
      ? "approval"
      : (row.textContent?.match(/rw_[a-z_]+/)?.[0] ?? row.dataset.v2ItemType),
  );
// A live row's label shines and a working or thinking row shimmers.
const liveMarks = () => container.querySelectorAll(".live-tool-shine, .live-activity-focus").length;

describe(`a turn held on an app approval in a ${PANE_WIDTH} px embed pane`, () => {
  it("shows neither the working row nor the held call's row until the card is answered", async () => {
    const render = await mount(true);

    await render("pending");
    expect(text()).not.toContain("rw_engine_simulate");
    expect(text()).not.toMatch(/Working|Waiting for you|Thinking/);
    expect(rowKinds()).not.toContain("working");
    expect(text()).toContain("rw_motor_search");
    expect(liveMarks()).toBe(1);

    await render("approved");
    expect(text()).toContain("rw_engine_simulate");
    expect(text()).toContain("Working for");

    await render("finished");
    expect(text()).toContain("rw_engine_simulate");
  });

  it("leaves nothing live beside the card when no other call runs", async () => {
    const render = await mount(true, false);

    await render("pending");
    expect(text()).toContain("rw_design_check");
    expect(text()).not.toMatch(/rw_engine_simulate|Working|Thinking/);
    expect(liveMarks()).toBe(0);

    await render("approved");
    expect(text()).toContain("rw_engine_simulate");
    expect(text()).toContain("Working for");
  });
});

describe("the same turn in full Lecturn", () => {
  it("keeps the call's row and stops the working timer while the approval waits", async () => {
    const render = await mount(false);

    await render("pending");
    expect(text()).toContain("rw_engine_simulate");
    expect(text()).toContain("Waiting for you");
    expect(text()).not.toContain("Working for");

    await render("approved");
    expect(text()).toContain("Working for");
    expect(text()).not.toContain("Waiting for you");
  });
});

/** Opens a settled turn's fold and then its work log. */
async function expandSettledTurn() {
  for (const kind of ["turn-fold", "work-toggle"]) {
    const toggle = container.querySelector<HTMLElement>(
      `[data-timeline-row-kind="${kind}"] button, [data-timeline-row-kind="${kind}"] [role="button"]`,
    );
    expect(toggle, kind).not.toBeNull();
    await act(async () => toggle?.click());
  }
}

describe("an approval that committed before the call it holds", () => {
  it("is the live row in full Lecturn while it waits, as when the call landed first", async () => {
    const render = await mount(false, true, true);

    await render("pending");
    const liveRow = container.querySelector('[data-timeline-row-kind="work-live"]');
    expect(liveRow?.textContent).toContain("Approve rw_engine_simulate");
  });

  it("sits just below that call in full Lecturn once answered and settled", async () => {
    const render = await mount(false, true, true);

    await render("settled");
    await expandSettledTurn();
    // The expanded turn's rows mount after the list measures, not in the click's act().
    await expect
      .poll(workRows)
      .toEqual(["rw_design_check", "rw_motor_search", "rw_engine_simulate", "approval"]);
  });

  it("still hides the held call's row in the embed", async () => {
    const render = await mount(true, true, true);

    await render("pending");
    expect(text()).not.toContain("rw_engine_simulate");
    expect(text()).toContain("rw_motor_search");
  });
});
