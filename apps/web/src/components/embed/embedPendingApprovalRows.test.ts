import {
  AppId,
  MessageId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import { withoutPendingApprovalRows } from "./embedPendingApprovalRows";

const fixture = makeStreamingTimelineFixture("Checking the fins");

const approvalItem = (
  id: string,
  requestId: string,
  second: number,
): Extract<OrchestrationV2TurnItem, { type: "approval_request" }> => ({
  id: TurnItemId.make(id),
  threadId: fixture.threadId,
  runId: fixture.runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: second,
  status: "completed",
  title: "Approve rw_engine_simulate",
  startedAt: DateTime.makeUnsafe(fixture.time(second)),
  completedAt: DateTime.makeUnsafe(fixture.time(second)),
  updatedAt: DateTime.makeUnsafe(fixture.time(second)),
  type: "approval_request",
  requestId: RuntimeRequestId.make(requestId),
  requestKind: "permission",
  prompt: "engine_simulate duration not set",
});

const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = [
  ...fixture.visibleTurnItems.map((row) => row.item),
  approvalItem("answered-approval", "request-answered", 8),
  approvalItem("pending-approval", "request-pending", 9),
].map((item, position) => ({
  position,
  visibility: "local",
  sourceThreadId: fixture.threadId,
  sourceItemId: item.id,
  item,
}));

const entries = deriveTimelineEntriesFromVisibleTurnItems({
  visibleTurnItems,
  optimisticMessages: [],
});
const ids = (list: ReadonlyArray<{ readonly id: string }>) => list.map((entry) => entry.id);

describe("withoutPendingApprovalRows", () => {
  it("drops only the rows of approvals still waiting for an answer", () => {
    const shown = withoutPendingApprovalRows(entries, [
      { requestId: RuntimeRequestId.make("request-pending") },
    ]);

    expect(ids(entries)).toContain("pending-approval");
    expect(ids(shown)).toEqual(ids(entries).filter((id) => id !== "pending-approval"));
    expect(ids(shown)).toContain("answered-approval");
  });

  it("hands back the same list when nothing it shows is pending", () => {
    expect(withoutPendingApprovalRows(entries, [])).toBe(entries);
    expect(
      withoutPendingApprovalRows(entries, [{ requestId: RuntimeRequestId.make("other-request") }]),
    ).toBe(entries);
  });
});

const APP_SOURCE = { key: "app:rocketwright", name: "RocketWright", kind: "integration" } as const;

const appCall = (
  id: string,
  toolName: string,
  second: number,
  status: "running" | "completed",
): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(id),
  threadId: fixture.threadId,
  runId: fixture.runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: second,
  status,
  title: null,
  startedAt: DateTime.makeUnsafe(fixture.time(second)),
  completedAt: status === "completed" ? DateTime.makeUnsafe(fixture.time(second)) : null,
  updatedAt: DateTime.makeUnsafe(fixture.time(second)),
  type: "dynamic_tool",
  toolName,
  toolSource: APP_SOURCE,
  input: {},
});

const appApproval = (requestId: string, toolName: string) => ({
  requestId: RuntimeRequestId.make(requestId),
  connectedAppTool: {
    appId: AppId.make("io.rocketwright"),
    appName: "RocketWright",
    toolName,
    reason: "duration not set",
    source: "app" as const,
  },
});

function entriesOf(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [...fixture.visibleTurnItems.map((row) => row.item), ...items].map(
      (item, position) => ({
        position,
        visibility: "local",
        sourceThreadId: fixture.threadId,
        sourceItemId: item.id,
        item,
      }),
    ),
    optimisticMessages: [],
  });
}

describe("withoutPendingApprovalRows with an app tool's approval", () => {
  it("drops the running row of the call the approval holds, whatever the adapter named it", () => {
    for (const recorded of ["lecturn.rw_engine_simulate", "mcp__lecturn__rw_engine_simulate"]) {
      const appEntries = entriesOf([
        appCall("done-call", recorded, 8, "completed"),
        appCall("held-call", recorded, 9, "running"),
        appCall("other-call", "lecturn.rw_design_check", 10, "running"),
        approvalItem("app-approval", "request-app", 11),
      ]);
      const shown = withoutPendingApprovalRows(appEntries, [
        appApproval("request-app", "rw_engine_simulate"),
      ]);

      expect(ids(shown)).toEqual(
        ids(appEntries).filter((id) => id !== "held-call" && id !== "app-approval"),
      );
    }
  });

  it("holds one call per approval", () => {
    const appEntries = entriesOf([
      appCall("first-call", "lecturn.rw_engine_simulate", 8, "running"),
      appCall("second-call", "lecturn.rw_engine_simulate", 9, "running"),
      approvalItem("first-approval", "request-first", 10),
    ]);
    const shown = withoutPendingApprovalRows(appEntries, [
      appApproval("request-first", "rw_engine_simulate"),
    ]);

    expect(ids(shown)).toContain("first-call");
    expect(ids(shown)).not.toContain("second-call");
  });

  it("keeps the call's row once the approval is answered", () => {
    const appEntries = entriesOf([
      appCall("held-call", "lecturn.rw_engine_simulate", 9, "running"),
      approvalItem("app-approval", "request-app", 10),
    ]);
    expect(withoutPendingApprovalRows(appEntries, [])).toBe(appEntries);
  });
});

/** The order the projection keeps rows in: by ordinal, then by id. */
function entriesInProjectionOrder(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return entriesOf(
    [...items].sort(
      (left, right) => left.ordinal - right.ordinal || String(left.id).localeCompare(right.id),
    ),
  );
}

const withOrdinal = (item: OrchestrationV2TurnItem, ordinal: number): OrchestrationV2TurnItem => ({
  ...item,
  ordinal,
});

describe("withoutPendingApprovalRows when the held call's row commits after its approval", () => {
  // The gate numbers the approval from the rows committed so far, while the provider numbered the
  // call before its row committed, so the approval can take the call's ordinal or one below it.
  const recordedNames = [
    "lecturn.rw_engine_simulate",
    "mcp__lecturn__rw_engine_simulate",
    "lecturn-0f3c9a_rw_engine_simulate",
  ];

  it("drops the call's row when the approval sorts below it", () => {
    for (const recorded of recordedNames) {
      const appEntries = entriesInProjectionOrder([
        appCall("done-call", recorded, 8, "completed"),
        withOrdinal(approvalItem("app-approval", "request-app", 9), 9),
        appCall("held-call", recorded, 10, "running"),
      ]);
      expect(ids(appEntries).indexOf("app-approval")).toBeLessThan(
        ids(appEntries).indexOf("held-call"),
      );

      const shown = withoutPendingApprovalRows(appEntries, [
        appApproval("request-app", "rw_engine_simulate"),
      ]);

      expect(ids(shown)).toEqual(
        ids(appEntries).filter((id) => id !== "held-call" && id !== "app-approval"),
      );
    }
  });

  it("drops the call's row when the approval ties its ordinal and its id sorts first", () => {
    const appEntries = entriesInProjectionOrder([
      approvalItem("turn-item:a-approval", "request-app", 9),
      appCall("turn-item:b-held-call", "lecturn.rw_engine_simulate", 9, "running"),
    ]);
    expect(ids(appEntries).indexOf("turn-item:a-approval")).toBeLessThan(
      ids(appEntries).indexOf("turn-item:b-held-call"),
    );

    const shown = withoutPendingApprovalRows(appEntries, [
      appApproval("request-app", "rw_engine_simulate"),
    ]);

    expect(ids(shown)).not.toContain("turn-item:b-held-call");
    expect(ids(shown)).not.toContain("turn-item:a-approval");
  });

  it("gives each of two raced approvals its own call", () => {
    const appEntries = entriesInProjectionOrder([
      approvalItem("first-approval", "request-first", 8),
      appCall("first-call", "lecturn.rw_engine_simulate", 9, "running"),
      approvalItem("second-approval", "request-second", 10),
      appCall("second-call", "lecturn.rw_engine_simulate", 11, "running"),
      appCall("free-call", "lecturn.rw_design_check", 12, "running"),
    ]);
    const shown = withoutPendingApprovalRows(appEntries, [
      appApproval("request-first", "rw_engine_simulate"),
      appApproval("request-second", "rw_engine_simulate"),
    ]);

    expect(ids(shown)).not.toContain("first-call");
    expect(ids(shown)).not.toContain("second-call");
    expect(ids(shown)).toContain("free-call");
  });

  it("still prefers the call before the approval when there is one", () => {
    const appEntries = entriesInProjectionOrder([
      appCall("held-call", "lecturn.rw_engine_simulate", 8, "running"),
      approvalItem("app-approval", "request-app", 9),
      appCall("later-call", "lecturn.rw_engine_simulate", 10, "running"),
    ]);
    const shown = withoutPendingApprovalRows(appEntries, [
      appApproval("request-app", "rw_engine_simulate"),
    ]);

    expect(ids(shown)).not.toContain("held-call");
    expect(ids(shown)).toContain("later-call");
  });
});

describe("withoutPendingApprovalRows with RocketWright's CP9 page 01 rows", () => {
  // Scripted turn 1 numbers its rows 1001, 1002, ...; the reply and the engine call were still in
  // flight when Lecturn's gate read the highest committed ordinal (1003) and raised the approval.
  const providerTurnId = "provider-turn:provider:scripted:native-turn:cp9-01";
  const requestId =
    "runtime-request:provider:scripted:provider-turn:provider-turn%3Aprovider%3Ascripted%3Anative-turn%3Aprovider-thread%253Aprovider%253Ascripted%253Anative-thread%253Apending%25253Arun%25253Athread%25253Acopy%2525253Arw-fixtures%2525253Arw-01-assembly-review%25253Aordinal%25253A1%253Arun-attempt%253Arun%253Arun%25253Athread%25253Acopy%2525253Arw-fixtures%2525253Arw-01-assembly-review%25253Aordinal%25253A1%253Aattempt%253A1:f949378d-854a-4ca2-9ccd-e90c15805db3";
  const rocketWright = {
    key: "app:dev.rocketwright.app",
    name: "RocketWright",
    kind: "integration",
  } as const;
  const scriptedId = (ordinal: number) =>
    `turn-item:provider:scripted:native-item:scripted%3A${encodeURIComponent(providerTurnId)}%3A${ordinal}`;
  const scriptedTool = (
    ordinal: number,
    tool: string,
    title: string,
    status: "running" | "completed",
  ): OrchestrationV2TurnItem => ({
    ...appCall(scriptedId(ordinal), `lecturn.${tool}`, 8, status),
    ordinal,
    title,
    toolSource: rocketWright,
  });
  const reply: OrchestrationV2TurnItem = {
    id: TurnItemId.make(scriptedId(1004)),
    threadId: fixture.threadId,
    runId: fixture.runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1004,
    status: "completed",
    title: null,
    startedAt: DateTime.makeUnsafe(fixture.time(8)),
    completedAt: DateTime.makeUnsafe(fixture.time(8)),
    updatedAt: DateTime.makeUnsafe(fixture.time(8)),
    type: "assistant_message",
    messageId: MessageId.make("cp9-01-reply"),
    text: "The check flags 2 missing engine inputs.",
    streaming: false,
  };
  const approval: OrchestrationV2TurnItem = {
    ...approvalItem(`turn-item:runtime-request:${encodeURIComponent(requestId)}`, requestId, 8),
    ordinal: 1004,
    status: "waiting",
    title: null,
    completedAt: null,
    appName: "RocketWright",
    prompt: "Approve Simulate engine · Burn duration not set · default 120 s",
    options: [
      { decision: "accept", label: "Approve" },
      { decision: "decline", label: "Decline" },
    ],
  };
  const heldCallId = scriptedId(1005);
  const pending = {
    requestId: RuntimeRequestId.make(requestId),
    connectedAppTool: {
      appId: AppId.make("dev.rocketwright.app"),
      appName: "RocketWright",
      toolName: "rw_engine_simulate",
      toolTitle: "Simulate engine",
      reason: "Burn duration not set · default 120 s",
      source: "app" as const,
    },
  };

  it("drops the running Simulate engine row beside the approval card", () => {
    const appEntries = entriesInProjectionOrder([
      scriptedTool(1001, "rw_design_check", "Check design", "completed"),
      scriptedTool(1002, "rw_simulate", "Run simulation", "completed"),
      scriptedTool(1003, "rw_history_show", "Show history step", "completed"),
      reply,
      approval,
      scriptedTool(1005, "rw_engine_simulate", "Simulate engine", "running"),
    ]);
    expect(ids(appEntries).slice(-3)).toEqual(["cp9-01-reply", approval.id, heldCallId]);

    const shown = withoutPendingApprovalRows(appEntries, [pending]);

    expect(ids(shown)).toEqual(
      ids(appEntries).filter((id) => id !== heldCallId && id !== approval.id),
    );
  });
});
