import {
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
