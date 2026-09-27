import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  ContextualCandidate,
  ContextualEquivalenceCheckRequest,
  ContextualConflict,
  ContextualConflictResolution,
  ContextualDeliveryReceipt,
  ContextualEvaluationRequest,
  ContextualEvidence,
  ContextualPacket,
  ContextualPreparation,
  ContextualRetrieveResult,
  ContextualSourceConfiguration,
  ContextualTaskSnapshot,
} from "./contextual.ts";

const decodeUnknownSyncContextualEvaluationRequest = Schema.decodeUnknownSync(
  ContextualEvaluationRequest,
);
const encodeSyncContextualEvaluationRequest = Schema.encodeSync(ContextualEvaluationRequest);
const isContextualCandidate = Schema.is(ContextualCandidate);
const isContextualConflict = Schema.is(ContextualConflict);
const isContextualConflictResolution = Schema.is(ContextualConflictResolution);
const isContextualDeliveryReceipt = Schema.is(ContextualDeliveryReceipt);
const isContextualEquivalenceCheckRequest = Schema.is(ContextualEquivalenceCheckRequest);
const isContextualEvaluationRequest = Schema.is(ContextualEvaluationRequest);
const isContextualEvidence = Schema.is(ContextualEvidence);
const isContextualPacket = Schema.is(ContextualPacket);
const isContextualPreparation = Schema.is(ContextualPreparation);
const isContextualRetrieveResult = Schema.is(ContextualRetrieveResult);
const isContextualSourceConfiguration = Schema.is(ContextualSourceConfiguration);
const isContextualTaskSnapshot = Schema.is(ContextualTaskSnapshot);
const now = "2026-09-25T00:00:00.000Z";
const coverage = {
  complete: true,
  missingAntecedents: false,
  truncated: false,
  unexaminedCount: 0,
};
const evidence = {
  id: "e1",
  sourceId: "source",
  sourceKind: "slack",
  occurrenceId: "o1",
  sourceRevision: 1,
  sourceHash: "hash",
  canonicalVersion: "v1",
  coordinateSystem: "utf16",
  quote: "Use 🚀",
  start: 4,
  end: 10,
  prefix: "",
  suffix: "",
  author: "Synthetic",
  occurredAt: now,
  observedAt: now,
  sourceUrl: null,
  availability: "available",
  lineageIds: ["original"],
  locator: {
    sourceKind: "slack",
    workspaceId: "workspace",
    channelId: "channel",
    messageTs: "1720000000.123456",
    threadTs: null,
  },
};
const candidate = {
  id: "candidate",
  sourceId: "source",
  occurrenceId: "o1",
  recordRevision: 1,
  guidanceId: "guidance",
  contentFingerprint: "content",
  lineageIds: ["original"],
  coverage,
  evidence: [evidence],
  state: "not-yet-evaluated",
  sourceKind: "slack",
  workspaceId: "workspace",
  channelId: "channel",
  messageTs: "1720000000.123456",
  threadTs: null,
};
const task = {
  environmentId: "env",
  projectId: "project",
  threadId: "thread",
  submissionId: "submission",
  messageId: "message",
  turnId: null,
  providerInstanceId: "provider",
  providerContextEpoch: "epoch",
  taskFingerprint: "task",
  knownContextFingerprint: "known",
  threadSettingsRevision: 1,
  projectSettingsRevision: 1,
  sourceScopeRevision: 1,
  threadExclusionRevision: 1,
  fundingGeneration: 1,
  purgeGeneration: 1,
  newestMessage: "Build the rocket",
  projectDescription: "Synthetic",
  explicitReferences: [],
  recentContext: "",
  trigger: "submission",
};
const request = {
  featureId: "contextual",
  requestId: "request",
  runId: "run",
  fundingGeneration: 1,
  templateVersion: "contextual-v1",
  task,
  targets: [candidate],
};
const receipt = {
  id: "receipt",
  preparationId: "preparation",
  packetId: "packet",
  dispatchId: "dispatch",
  threadId: "thread",
  submissionId: "submission",
  turnId: "turn",
  providerInstanceId: "provider",
  providerContextEpoch: "epoch",
  providerReceiptId: "native-receipt",
  disposition: "fresh",
  acceptance: "accepted",
  evidenceIncluded: true,
  suppliedEvidenceIds: ["e1"],
  receivedAt: now,
};
const group = {
  candidateId: "candidate",
  occurrenceId: "o1",
  guidanceId: "guidance",
  contentFingerprint: "content",
  recordRevision: 1,
  evidence: [evidence],
  attribution: null,
  derivedSummary: null,
  reasons: ["constraint"],
};
const packet = {
  id: "packet",
  preparationId: "preparation",
  task,
  groups: [group],
  tokenCount: 100,
  tokenCounting: "provider",
  payloadRef: "payload",
  createdAt: now,
  resolutionIds: [],
  purpose: "new-context",
};

describe("Contextual contract conformance", () => {
  it("round trips exact Unicode quotes and task fences before a native turn exists", () => {
    const decoded = decodeUnknownSyncContextualEvaluationRequest(request);
    expect(encodeSyncContextualEvaluationRequest(decoded)).toEqual(request);
    expect(isContextualTaskSnapshot(task)).toBe(true);
    expect(isContextualEvidence({ ...evidence, end: 9 })).toBe(false);
    expect(isContextualEvidence({ ...evidence, coordinateSystem: "utf8" })).toBe(false);
    expect(isContextualEvidence({ ...evidence, sourceKind: "lecturn-decision" })).toBe(false);
    expect(isContextualCandidate({ ...candidate, messageTs: 1720000000.123456 })).toBe(false);
  });
  it("rejects duplicate target and evidence identities, stale templates and funding fences", () => {
    for (const invalid of [
      { ...request, targets: [candidate, candidate] },
      { ...request, templateVersion: "contextual-v0" },
      { ...request, fundingGeneration: 2 },
      { ...request, targets: [{ ...candidate, evidence: [evidence, evidence] }] },
    ]) {
      expect(isContextualEvaluationRequest(invalid)).toBe(false);
    }
  });
  it("bounds total candidate count, batch count and aggregate cloud characters", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...candidate, id: `c${i}` }));
    expect(
      isContextualRetrieveResult({
        candidates: many.slice(0, 24),
        coverage,
        sourceGeneration: 1,
        purgeGeneration: 1,
      }),
    ).toBe(true);
    expect(
      isContextualRetrieveResult({
        candidates: many,
        coverage,
        sourceGeneration: 1,
        purgeGeneration: 1,
      }),
    ).toBe(false);
    expect(isContextualEvaluationRequest({ ...request, targets: many.slice(0, 9) })).toBe(false);
    const long = many.slice(0, 8).map((c, i) => ({
      ...c,
      evidence: [{ ...evidence, id: `e${i}`, quote: "x".repeat(7000), start: 0, end: 7000 }],
    }));
    expect(isContextualEvaluationRequest({ ...request, targets: long })).toBe(false);
  });
  it("does not equate queue acceptance, rejected or uncertain dispatch with supplied evidence", () => {
    expect(isContextualDeliveryReceipt(receipt)).toBe(true);
    for (const invalid of [
      { ...receipt, acceptance: "unknown" },
      { ...receipt, acceptance: "rejected" },
      { ...receipt, turnId: null },
      { ...receipt, providerReceiptId: null },
      { ...receipt, disposition: "skipped" },
      { ...receipt, disposition: "steered" },
      { ...receipt, evidenceIncluded: false },
    ])
      expect(isContextualDeliveryReceipt(invalid)).toBe(false);
    expect(
      isContextualDeliveryReceipt({
        ...receipt,
        acceptance: "unknown",
        turnId: null,
        providerReceiptId: null,
        suppliedEvidenceIds: [],
      }),
    ).toBe(true);
    const queued = {
      ...receipt,
      disposition: "provider-queued",
      evidenceIncluded: false,
      suppliedEvidenceIds: [],
      turnId: null,
    };
    expect(isContextualDeliveryReceipt(queued)).toBe(true);
    expect(
      isContextualDeliveryReceipt({
        ...queued,
        acceptance: "unknown",
        providerReceiptId: null,
      }),
    ).toBe(true);
  });
  it("bounds packets and rejects repeated guidance or conflicting evidence", () => {
    expect(isContextualPacket(packet)).toBe(true);
    expect(isContextualPacket({ ...packet, tokenCount: 1501 })).toBe(false);
    expect(isContextualPacket({ ...packet, groups: [group, group] })).toBe(false);
    expect(
      isContextualPacket({
        ...packet,
        groups: [
          group,
          { ...group, guidanceId: "other", evidence: [{ ...evidence, quote: "use 🚀" }] },
        ],
      }),
    ).toBe(false);
  });
  it("requires coherent lifecycle and paid work bounds", () => {
    const preparation = {
      id: "prep",
      task,
      revision: 1,
      state: "requested",
      packetId: null,
      dispatchId: null,
      conflictIds: [],
      attemptsUsed: 0,
      comparisonPairsChecked: 0,
      coverage,
      updatedAt: now,
    };
    expect(isContextualPreparation(preparation)).toBe(true);
    for (const invalid of [
      { ...preparation, state: "awaiting-conflict-review" },
      { ...preparation, state: "dispatching", packetId: "packet" },
      { ...preparation, attemptsUsed: 7 },
      { ...preparation, comparisonPairsChecked: 13 },
    ])
      expect(isContextualPreparation(invalid)).toBe(false);
  });
  it("requires scope clarification and checks returned conflict span identities", () => {
    const resolution = {
      actionId: "action",
      conflictId: "conflict",
      expectedRevision: 1,
      leftRevision: 1,
      rightRevision: 1,
      threadId: "thread",
      taskFingerprint: "task",
      action: "different-scopes",
      clarification: "Production only",
    };
    expect(isContextualConflictResolution(resolution)).toBe(true);
    expect(isContextualConflictResolution({ ...resolution, clarification: " " })).toBe(false);
    const claim = {
      id: "left",
      candidateId: "candidate",
      occurrenceId: "o1",
      revision: 1,
      evidence: [evidence],
      attribution: null,
      scope: "production",
      temporalApplicability: "current",
      acceptedReplacementIds: [],
    };
    const conflict = {
      id: "conflict",
      threadId: "thread",
      taskFingerprint: "task",
      revision: 1,
      pair: { id: "pair", left: claim, right: { ...claim, id: "right" } },
      judgment: {
        pairId: "pair",
        relation: "incompatible",
        materialToTask: 0.9,
        leftEvidenceIds: ["e1"],
        rightEvidenceIds: ["e1"],
        reasons: ["conflict"],
      },
      state: "awaiting-review",
      createdAt: now,
    };
    expect(isContextualConflict(conflict)).toBe(true);
    expect(
      isContextualConflict({
        ...conflict,
        pair: {
          ...conflict.pair,
          left: { ...claim, derivedSummary: "User-edited saved Decision: Storage\nUse Postgres." },
        },
      }),
    ).toBe(true);
    expect(
      isContextualConflict({
        ...conflict,
        pair: { ...conflict.pair, left: { ...claim, derivedSummary: "x".repeat(6001) } },
      }),
    ).toBe(false);
    expect(
      isContextualConflict({
        ...conflict,
        judgment: { ...conflict.judgment, rightEvidenceIds: ["invented"] },
      }),
    ).toBe(false);
  });
  it("restricts equivalence to independent decisions in the same authorized scope", () => {
    const decision = {
      ...candidate,
      sourceKind: "lecturn-decision",
      environmentId: "env",
      projectId: "project",
      threadId: "thread",
      decisionId: "decision-one",
      decisionRevision: 1,
      attribution: "agent-chosen",
      reviewState: "unreviewed",
      lifecycle: "current",
      replacementIds: [],
      derivedSummary: {
        title: "Use rockets",
        body: "Use a rocket",
        rationale: null,
        userEdited: false,
      },
    };
    const pair = {
      id: "pair",
      left: decision,
      right: { ...decision, id: "second", decisionId: "decision-two" },
    };
    const check = {
      featureId: "decisions",
      requestId: "request",
      runId: "run",
      fundingGeneration: 1,
      environmentId: "env",
      projectId: "project",
      templateVersion: "decisions-equivalence-v1",
      targets: [pair],
    };
    expect(isContextualEquivalenceCheckRequest(check)).toBe(true);
    expect(isContextualEquivalenceCheckRequest({ ...check, projectId: "other" })).toBe(false);
    expect(
      isContextualEquivalenceCheckRequest({ ...check, targets: [{ ...pair, right: decision }] }),
    ).toBe(false);
    expect(
      isContextualEquivalenceCheckRequest({
        ...check,
        targets: [{ ...pair, right: { ...pair.right, projectId: "other" } }],
      }),
    ).toBe(false);
  });
  it("requires a next policy revision and explicit unique selected sources", () => {
    const update = {
      expectedRevision: 1,
      policy: {
        allowedSourceIds: ["source"],
        allowDirectMessages: false,
        allowGroupDirectMessages: false,
        unknownConversationPolicy: "exclude",
        draftsPolicy: "exclude",
        revision: 2,
      },
    };
    expect(isContextualSourceConfiguration(update)).toBe(true);
    expect(isContextualSourceConfiguration({ ...update, expectedRevision: 0 })).toBe(false);
    expect(
      isContextualSourceConfiguration({
        ...update,
        policy: { ...update.policy, allowedSourceIds: ["source", "source"] },
      }),
    ).toBe(false);
  });
});

it("permits shared exact evidence across distinct packet groups without permitting conflicting source spans", () => {
  const other = { ...group, guidanceId: "other-guidance", candidateId: "other-candidate" };
  expect(isContextualPacket({ ...packet, groups: [group, other] })).toBe(true);
  expect(
    isContextualPacket({
      ...packet,
      groups: [
        group,
        { ...other, evidence: [{ ...evidence, quote: evidence.quote.toUpperCase() }] },
      ],
    }),
  ).toBe(false);
  expect(
    isContextualPacket({ ...packet, groups: [{ ...group, evidence: [evidence, evidence] }] }),
  ).toBe(false);
});
