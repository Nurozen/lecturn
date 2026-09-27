import { assert, it } from "@effect/vitest";
import * as C from "@lecturn/contracts";
import { Effect, Result, Schema } from "effect";
import { validateActions } from "./DecisionWorker.ts";
const decodeOutput = Schema.decodeUnknownEffect(C.DecisionWriterOutputV2);
const decodeOutputSync = Schema.decodeUnknownSync(C.DecisionWriterOutputV2);
const anchor = (
  id: string,
  role: "user" | "assistant",
  occurrence: number,
  quote = "Use SQLite",
): C.DecisionEvidence => ({
  id: C.DecisionEvidenceId.make(id),
  threadId: C.ThreadId.make("thread"),
  messageId: C.MessageId.make(id),
  messageRole: role,
  occurrence,
  sourceHash: id,
  sourceGeneration: 0,
  canonicalVersion: "1",
  quote,
  start: 0,
  end: quote.length,
  prefix: "",
  suffix: "",
  availability: "available",
});
const proposal = anchor("proposal", "assistant", 1);
const acceptance = anchor("acceptance", "user", 2, "Yes, use SQLite");
const input: Omit<C.DecisionWriterInput, "modelSelection"> = {
  description: "Track choices",
  descriptionRevision: 1,
  sourceFingerprint: "source",
  context: "",
  resolvedCandidateIds: [],
  candidates: [{ id: "candidate", evidenceIds: [acceptance.id] }],
  evidence: [proposal, acceptance],
  existingDecisions: [],
  contextualOrigins: [],
};
const action = {
  action: "create" as const,
  candidateId: "candidate",
  title: "Use SQLite",
  body: "Use SQLite",
  rationale: null,
  attribution: "user-accepted" as const,
  evidence: [
    { evidenceId: proposal.id, quote: proposal.quote },
    { evidenceId: acceptance.id, quote: acceptance.quote },
  ],
  occurrenceEvidenceId: acceptance.id,
  acceptanceEvidence: { proposalEvidenceId: proposal.id, acceptanceEvidenceId: acceptance.id },
  liveChoice: "new-choice" as const,
  sourceLineageIds: [],
};
const output = (value: C.DecisionWriterActionV2): C.DecisionWriterOutputV2 => ({
  version: 2,
  actions: [value],
  complete: true,
  unresolvedCandidateIds: [],
});
it.effect(
  "requires a real earlier assistant proposal and later user acceptance for the same live occurrence",
  () =>
    Effect.gen(function* () {
      const valid = yield* decodeOutput(output(action));
      assert.equal((yield* validateActions(valid, input, "acceptance")).length, 1);
      const reversed = { ...input, evidence: [{ ...proposal, occurrence: 3 }, acceptance] };
      assert.isTrue(
        Result.isFailure(yield* validateActions(valid, reversed, "acceptance").pipe(Effect.result)),
      );
      assert.throws(() => decodeOutputSync(output({ ...action, acceptanceEvidence: null })));
    }),
);
it.effect(
  "rejects copied agent context and unknown lineage but permits a supported live user reaffirmation",
  () =>
    Effect.gen(function* () {
      const occurrence = anchor("live", "assistant", 3);
      const origins = [
        {
          sourceId: "slack",
          evidenceId: "original",
          sourceHash: "original",
          quote: occurrence.quote,
        },
      ];
      const next = {
        ...input,
        candidates: [{ id: "candidate", evidenceIds: [occurrence.id] }],
        evidence: [occurrence],
        contextualOrigins: origins,
      };
      const copied: C.DecisionWriterActionV2 = {
        ...action,
        attribution: "agent-chosen",
        occurrenceEvidenceId: occurrence.id,
        acceptanceEvidence: null,
        evidence: [{ evidenceId: occurrence.id, quote: occurrence.quote }],
        sourceLineageIds: ["original"],
      };
      assert.isTrue(
        Result.isFailure(yield* validateActions(output(copied), next, "live").pipe(Effect.result)),
      );
      const reaffirmed = {
        ...copied,
        attribution: "user-directed" as const,
        liveChoice: "explicit-reaffirmation" as const,
      };
      assert.equal(
        (yield* validateActions(
          output(reaffirmed),
          { ...next, evidence: [{ ...occurrence, messageRole: "user" }] },
          "live",
        )).length,
        1,
      );
      assert.isTrue(
        Result.isFailure(
          yield* validateActions(
            output({ ...reaffirmed, sourceLineageIds: ["invented"] }),
            { ...next, evidence: [{ ...occurrence, messageRole: "user" }] },
            "live",
          ).pipe(Effect.result),
        ),
      );
    }),
);
