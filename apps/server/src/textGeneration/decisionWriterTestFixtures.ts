import * as Schema from "effect/Schema";
import { DecisionWriterInput, DecisionWriterOutput } from "@lecturn/contracts";

export const decisionWriterInputFixture = Schema.decodeUnknownSync(DecisionWriterInput)({
  modelSelection: {
    instanceId: "codex-work",
    model: "gpt-6-sol",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ],
  },
  description: "Architecture choices",
  descriptionRevision: 1,
  sourceFingerprint: "source-hash",
  candidates: [{ id: "candidate-1", evidenceIds: ["evidence-1"] }],
  evidence: [
    {
      id: "evidence-1",
      threadId: "thread-1",
      messageId: "message-1",
      messageRole: "user",
      sourceHash: "hash",
      sourceGeneration: 1,
      canonicalVersion: "1",
      quote: "Use SQLite.",
      start: 0,
      end: 11,
      prefix: "",
      suffix: "",
      occurrence: 0,
      availability: "available",
    },
  ],
  context: "User chose local persistence.",
  existingDecisions: [],
  resolvedCandidateIds: [],
});
export const decisionWriterOutputFixture = Schema.decodeUnknownSync(DecisionWriterOutput)({
  actions: [
    {
      action: "create",
      candidateId: "candidate-1",
      title: "Use SQLite",
      body: "Store application data in SQLite.",
      rationale: null,
      attribution: "user-directed",
      evidence: [{ evidenceId: "evidence-1", quote: "Use SQLite." }],
    },
  ],
  complete: true,
  unresolvedCandidateIds: [],
});
