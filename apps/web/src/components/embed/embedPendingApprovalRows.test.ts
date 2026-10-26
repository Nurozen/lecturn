import {
  AppId,
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

const approvalItem = (id: string, requestId: string, second: number): OrchestrationV2TurnItem => ({
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
