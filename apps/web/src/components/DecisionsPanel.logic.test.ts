import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  DecisionProcessingStatus,
  DecisionId,
  ThreadDecisionSourceWindowResult,
  ProjectId,
  ThreadId,
} from "@lecturn/contracts";
import {
  decisionStatusLabel,
  decisionRelationshipLabel,
  decisionSourceHighlight,
  decisionFilterKey,
  reconcileVisibleDecisions,
} from "./DecisionsPanel.logic";
const status = Schema.decodeUnknownSync(DecisionProcessingStatus)({
  projectId: "p",
  threadId: null,
  paused: false,
  pauseEpoch: 0,
  state: "idle",
  blockedReason: null,
  pendingCount: 0,
  incompleteCount: 0,
  unscannedMessageCount: 0,
  lastProcessedAt: null,
  writerSupported: false,
  writerSupportReason: "Unsupported",
  incompleteJobs: [],
  activeScans: [],
});
const source = Schema.decodeUnknownSync(ThreadDecisionSourceWindowResult)({
  outcome: "exact",
  threadId: "t",
  messageId: "m",
  messages: [{ id: "m", role: "user", text: "use 🚀 now", createdAt: "2026-09-23T00:00:00Z" }],
  start: 4,
  end: 6,
  reason: null,
});
describe("decision presentation", () => {
  it("describes replacement direction from each relationship endpoint", () => {
    const relation = {
      predecessorId: DecisionId.make("sqlite"),
      successorId: DecisionId.make("postgres"),
      state: "proposed" as const,
    };
    expect(decisionRelationshipLabel("sqlite", relation)).toBe(
      "A newer decision may replace this one. Approval is required.",
    );
    expect(decisionRelationshipLabel("postgres", relation)).toBe(
      "May replace an earlier decision. Approval is required.",
    );
    expect(decisionRelationshipLabel("sqlite", { ...relation, state: "accepted" })).toBe(
      "Replaced by a newer decision.",
    );
    expect(decisionRelationshipLabel("postgres", { ...relation, state: "accepted" })).toBe(
      "Replaces an earlier decision.",
    );
  });

  it("distinguishes disabled, foreground wait, membership, allowance and incomplete states", () => {
    expect(decisionStatusLabel({ ...status, blockedReason: "disabled" })).toBe("Tracking is off");
    expect(decisionStatusLabel({ ...status, blockedReason: "provider-foreground" })).toContain(
      "conversation",
    );
    expect(decisionStatusLabel({ ...status, blockedReason: "access-expired" })).toContain(
      "expired",
    );
    expect(decisionStatusLabel({ ...status, blockedReason: "allowance-exhausted" })).toContain(
      "exhausted",
    );
    expect(decisionStatusLabel({ ...status, state: "incomplete" })).toContain("unprocessed");
    expect(decisionStatusLabel({ ...status, paused: true })).toContain("Paused");
  });
  it("highlights only an exact bounded source, in UTF-16 offsets", () => {
    expect(decisionSourceHighlight(source, "m")).toEqual({
      before: "use ",
      quote: "🚀",
      after: " now",
    });
    for (const value of [
      { ...source, outcome: "message-only" as const },
      { ...source, outcome: "unavailable" as const },
      { ...source, end: 200 },
      { ...source, start: null },
      { ...source, messages: [] },
    ])
      expect(decisionSourceHighlight(value, "m")).toBeNull();
    expect(decisionSourceHighlight(source, "other")).toBeNull();
  });
  it("keeps existing card order and focus identity when new captures arrive", () => {
    const before = [
      { id: "a", title: "old" },
      { id: "b", title: "b" },
    ];
    expect(
      reconcileVisibleDecisions(before, [
        { id: "new", title: "new" },
        { id: "b", title: "updated b" },
        { id: "a", title: "edited a" },
      ]),
    ).toEqual({
      visible: [
        { id: "a", title: "edited a" },
        { id: "b", title: "updated b" },
      ],
      newCount: 1,
    });
    expect(reconcileVisibleDecisions(before, [{ id: "b", title: "b" }])).toEqual({
      visible: [{ id: "b", title: "b" }],
      newCount: 0,
    });
  });
  it("retains a focused boundary card while new first-page arrivals wait for acceptance", () => {
    const before = Array.from({ length: 50 }, (_, id) => ({ id: String(id) }));
    const result = reconcileVisibleDecisions(before, [{ id: "new" }, ...before.slice(0, 49)]);
    expect(result.visible).toHaveLength(50);
    expect(result.visible[49]).toBe(before[49]);
    expect(result.newCount).toBe(1);
  });
  it("does not confuse all reviews with the default hidden-dismissed filter", () => {
    const projectId = ProjectId.make("p");
    expect(decisionFilterKey({ projectId })).not.toBe(
      decisionFilterKey({ projectId, reviewState: "all" }),
    );
    expect(decisionFilterKey({ projectId })).not.toBe(
      decisionFilterKey({ projectId, threadId: ThreadId.make("t") }),
    );
  });
});
