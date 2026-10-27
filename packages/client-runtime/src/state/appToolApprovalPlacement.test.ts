import {
  AppId,
  MessageId,
  NodeId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  appToolApprovalsOf,
  createAppToolApprovalPlacer,
  placeAppToolApprovals,
} from "./appToolApprovalPlacement.ts";

const threadId = ThreadId.make("thread-approval-placement");
const runId = RunId.make("run-approval-placement");
const APP_SOURCE = { key: "app:rocketwright", name: "RocketWright", kind: "integration" } as const;
const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 27, 9, 0, second));

function base(id: string, ordinal: number, status: OrchestrationV2TurnItem["status"]) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status,
    title: null,
    startedAt: at(ordinal),
    completedAt: null,
    updatedAt: at(ordinal),
  };
}

const call = (
  id: string,
  ordinal: number,
  options: { tool?: string; completedAt?: number; runId?: RunId } = {},
): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, options.completedAt === undefined ? "running" : "completed"),
  ...(options.runId === undefined ? {} : { runId: options.runId }),
  completedAt: options.completedAt === undefined ? null : at(options.completedAt),
  type: "dynamic_tool",
  toolName: options.tool ?? "lecturn.rw_engine_simulate",
  toolSource: APP_SOURCE,
  input: {},
});

const approval = (id: string, ordinal: number, answeredAt?: number): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, answeredAt === undefined ? "waiting" : "completed"),
  completedAt: answeredAt === undefined ? null : at(answeredAt),
  type: "approval_request",
  requestId: RuntimeRequestId.make(`request-${id}`),
  requestKind: "permission",
  appName: "RocketWright",
  prompt: "Approve Simulate engine · Burn duration not set",
});

const reply = (id: string, ordinal: number): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, "completed"),
  type: "assistant_message",
  messageId: MessageId.make(`message-${id}`),
  text: "Running the engine simulation.",
  streaming: false,
});

const request = (
  approvalId: string,
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
  toolName = "rw_engine_simulate",
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(`request-${approvalId}`),
  nodeId: NodeId.make(`node-${approvalId}`),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "permission",
  status,
  responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
  createdAt: at(0),
  resolvedAt: null,
  connectedAppTool: {
    appId: AppId.make("io.rocketwright"),
    appName: "RocketWright",
    toolName,
    reason: "Burn duration not set",
    source: "app",
  },
});

const rows = (items: ReadonlyArray<OrchestrationV2TurnItem>): OrchestrationV2ProjectedTurnItem[] =>
  items.map((item, position) => ({
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  }));

const place = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  requests: ReadonlyArray<OrchestrationV2RuntimeRequest>,
) => placeAppToolApprovals(rows(items), appToolApprovalsOf(requests));
const ids = (placed: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) =>
  placed.map((row) => row.item.id);

describe("placeAppToolApprovals", () => {
  it("draws an approval that committed first just below the running call it holds", () => {
    for (const tool of [
      "lecturn.rw_engine_simulate",
      "mcp__lecturn__rw_engine_simulate",
      "lecturn-0f3c9a_rw_engine_simulate",
    ]) {
      const placed = place(
        [
          call("earlier-call", 1, { completedAt: 2 }),
          approval("approval", 3),
          reply("reply", 4),
          call("held-call", 5, { tool }),
          reply("after", 6),
        ],
        [request("approval")],
      );
      expect(ids(placed)).toEqual(["earlier-call", "reply", "held-call", "approval", "after"]);
    }
  });

  it("leaves the rows alone when the call already sorts above its approval", () => {
    const shown = rows([call("held-call", 1), approval("approval", 2), call("later-call", 3)]);
    expect(placeAppToolApprovals(shown, appToolApprovalsOf([request("approval")]))).toBe(shown);
  });

  it("keeps an answered approval below its call, whether the call still runs or has ended", () => {
    const items = [approval("approval", 3, 8), reply("reply", 4)];
    expect(ids(place([...items, call("held-call", 5)], [request("approval", "resolved")]))).toEqual(
      ["reply", "held-call", "approval"],
    );
    expect(
      ids(
        place(
          [...items, call("held-call", 5, { completedAt: 9 })],
          [request("approval", "resolved")],
        ),
      ),
    ).toEqual(["reply", "held-call", "approval"]);
  });

  it("does not take a call that had ended before the approval was raised", () => {
    const placed = place(
      [call("finished-call", 1, { completedAt: 2 }), approval("approval", 3, 8), call("held", 5)],
      [request("approval", "resolved")],
    );
    expect(ids(placed)).toEqual(["finished-call", "held", "approval"]);
  });

  it("gives each of two raced approvals its own call", () => {
    const placed = place(
      [
        approval("first", 1),
        call("first-call", 2),
        approval("second", 3),
        call("second-call", 4),
        call("free-call", 5, { tool: "lecturn.rw_design_check" }),
      ],
      [request("first"), request("second")],
    );
    expect(ids(placed)).toEqual(["first-call", "first", "second-call", "second", "free-call"]);
  });

  it("never claims a call of another tool or another run", () => {
    const shown = rows([
      approval("approval", 1),
      call("other-tool", 2, { tool: "lecturn.rw_design_check" }),
      call("other-run", 3, { runId: RunId.make("run-other") }),
    ]);
    expect(placeAppToolApprovals(shown, appToolApprovalsOf([request("approval")]))).toBe(shown);
  });

  it("ignores requests that no connected app raised", () => {
    const { connectedAppTool: _, ...providerRequest } = request("approval");
    expect(appToolApprovalsOf([providerRequest])).toEqual([]);
  });
});

describe("createAppToolApprovalPlacer", () => {
  it("hands back the same rows until the rows or the requests change", () => {
    const placer = createAppToolApprovalPlacer();
    const requests = [request("approval")];
    const shown = rows([approval("approval", 1), call("held-call", 2)]);

    const placed = placer(shown, requests);
    expect(ids(placed)).toEqual(["held-call", "approval"]);
    expect(placer(shown, requests)).toBe(placed);

    const unrelated = rows([call("held-call", 1)]);
    expect(placer(unrelated, [])).toBe(unrelated);
  });
});
