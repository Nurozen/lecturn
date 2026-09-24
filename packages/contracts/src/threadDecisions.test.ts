import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import {
  DecisionEvidence,
  DecisionWriterInput,
  DecisionWriterOutput,
  ThreadDecisionExportInput,
  ThreadDecisionListInput,
  ThreadDecisionMutateInput,
  ThreadDecisionSettingsInput,
} from "./threadDecisions.ts";

const decodeDecisionEvidence = Schema.decodeUnknownSync(DecisionEvidence);
const isDecisionEvidence = Schema.is(DecisionEvidence);
const decodeDecisionWriterInput = Schema.decodeUnknownSync(DecisionWriterInput);
const isDecisionWriterInput = Schema.is(DecisionWriterInput);
const isDecisionWriterOutput = Schema.is(DecisionWriterOutput);
const decodeDecisionWriterOutputStrict = Schema.decodeUnknownSync(DecisionWriterOutput, {
  onExcessProperty: "error",
});
const isThreadDecisionMutateInput = Schema.is(ThreadDecisionMutateInput);
const isThreadDecisionListInput = Schema.is(ThreadDecisionListInput);
const isThreadDecisionExportInput = Schema.is(ThreadDecisionExportInput);
const decodeExecutionEnvironmentCapabilities = Schema.decodeUnknownSync(
  ExecutionEnvironmentCapabilities,
);
const isThreadDecisionSettingsInput = Schema.is(ThreadDecisionSettingsInput);

const evidence = {
  id: "evidence-1",
  threadId: "thread-1",
  messageId: "message-1",
  messageRole: "user",
  sourceHash: "hash",
  sourceGeneration: 0,
  canonicalVersion: "1",
  quote: " use 🚀 ",
  start: 2,
  end: 10,
  prefix: "",
  suffix: "",
  occurrence: 0,
  availability: "available",
};
const create = {
  action: "create",
  candidateId: "candidate-1",
  title: "Use Postgres",
  body: "Use Postgres for storage.",
  rationale: null,
  attribution: "user-directed",
  evidence: [{ evidenceId: "evidence-1", quote: " use 🚀 " }],
};
const writerInput = {
  modelSelection: { instanceId: "custom-codex", model: "gpt-5.6-luna" },
  description: "Technical choices",
  descriptionRevision: 1,
  sourceFingerprint: "fingerprint",
  candidates: [{ id: "candidate-1", evidenceIds: ["evidence-1"] }],
  evidence: [evidence],
  context: "",
  existingDecisions: [],
  resolvedCandidateIds: [],
};

describe("Decisions contracts", () => {
  it("preserves exact quotes and enforces half-open UTF-16 offsets", () => {
    expect(decodeDecisionEvidence(evidence).quote).toBe(" use 🚀 ");
    for (const invalid of [
      { end: 9 },
      { start: -1 },
      { end: 2 },
      { start: 1.5 },
      { quote: " " },
      { quote: "x".repeat(8001) },
      { messageRole: "tool" },
    ]) {
      expect(isDecisionEvidence({ ...evidence, ...invalid })).toBe(false);
    }
  });
  it("requires an exact writer instance and bounds evidence without trimming it", () => {
    expect(decodeDecisionWriterInput(writerInput).modelSelection.instanceId).toBe("custom-codex");
    expect(
      isDecisionWriterInput({
        ...writerInput,
        modelSelection: { provider: "codex", model: "gpt-5.6-luna" },
      }),
    ).toBe(false);
    expect(isDecisionWriterInput({ ...writerInput, description: "x".repeat(2001) })).toBe(false);
    expect(isDecisionWriterInput({ ...writerInput, evidence: [] })).toBe(false);
  });
  it("limits writer creation to eight notes and never claims complete with unresolved work", () => {
    const valid = isDecisionWriterOutput;
    expect(valid({ actions: [create], complete: true, unresolvedCandidateIds: [] })).toBe(true);
    expect(valid({ actions: [create], complete: false, unresolvedCandidateIds: [] })).toBe(false);
    expect(
      valid({
        actions: Array.from({ length: 8 }, () => create),
        complete: false,
        unresolvedCandidateIds: ["more"],
      }),
    ).toBe(true);
    expect(
      valid({
        actions: Array.from({ length: 9 }, () => create),
        complete: false,
        unresolvedCandidateIds: ["more"],
      }),
    ).toBe(false);
    expect(valid({ actions: [create], complete: true, unresolvedCandidateIds: ["more"] })).toBe(
      false,
    );
    for (const fields of [
      { title: "x".repeat(161) },
      { body: "x".repeat(4001) },
      { rationale: "x".repeat(2001) },
      { evidence: [] },
    ]) {
      expect(
        valid({ actions: [{ ...create, ...fields }], complete: true, unresolvedCandidateIds: [] }),
      ).toBe(false);
    }
    expect(() =>
      decodeDecisionWriterOutputStrict({
        actions: [{ ...create, projectId: "other", reviewState: "confirmed" }],
        complete: true,
        unresolvedCandidateIds: [],
      }),
    ).toThrow();
  });
  it("requires ownership and conflict revisions for user mutations", () => {
    const valid = isThreadDecisionMutateInput;
    const review = {
      operation: "review",
      projectId: "project",
      id: "note",
      expectedRevision: 1,
      reviewState: "confirmed",
    };
    expect(valid(review)).toBe(true);
    expect(valid({ ...review, expectedRevision: undefined })).toBe(false);
    expect(valid({ ...review, projectId: undefined })).toBe(false);
    expect(
      valid({
        operation: "propose-replacement",
        projectId: "project",
        predecessorId: "same",
        successorId: "same",
        expectedPredecessorRevision: 1,
        expectedSuccessorRevision: 1,
      }),
    ).toBe(false);
    expect(
      valid({
        operation: "accept-replacement",
        projectId: "project",
        relationshipId: "relation",
        expectedRevision: 1,
        expectedPredecessorRevision: 2,
        expectedSuccessorRevision: 1,
      }),
    ).toBe(true);
    expect(
      valid({
        operation: "accept-replacement",
        projectId: "project",
        relationshipId: "relation",
        expectedRevision: 1,
      }),
    ).toBe(false);
  });
  it("bounds lists and requires a fixed export revision", () => {
    const valid = isThreadDecisionListInput;
    expect(valid({ projectId: "project" })).toBe(true);
    expect(valid({ projectId: "project", limit: 100 })).toBe(true);
    for (const invalid of [
      {},
      { projectId: "project", limit: 101 },
      { projectId: "project", limit: 0 },
      { projectId: "project", search: "x".repeat(501) },
    ])
      expect(valid(invalid)).toBe(false);
    expect(
      isThreadDecisionExportInput({
        projectId: "project",
        format: "json",
        expectedProjectRevision: 3,
      }),
    ).toBe(true);
    expect(isThreadDecisionExportInput({ projectId: "project", format: "json" })).toBe(false);
  });
  it("supports old servers and checks settings revision and description bounds", () => {
    expect(decodeExecutionEnvironmentCapabilities({}).threadDecisions).toBeUndefined();
    expect(decodeExecutionEnvironmentCapabilities({ threadDecisions: true }).threadDecisions).toBe(
      true,
    );
    const settings = {
      operation: "update",
      projectId: "project",
      expectedRevision: 0,
      enabled: true,
      description: "x".repeat(2000),
    };
    expect(isThreadDecisionSettingsInput(settings)).toBe(true);
    expect(isThreadDecisionSettingsInput({ ...settings, description: "x".repeat(2001) })).toBe(
      false,
    );
  });
});
