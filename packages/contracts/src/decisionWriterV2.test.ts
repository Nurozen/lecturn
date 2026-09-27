import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { DecisionWriterOutput, DecisionWriterOutputV2 } from "./threadDecisions.ts";

const isLegacy = Schema.is(DecisionWriterOutput);
const isV2 = Schema.is(DecisionWriterOutputV2);
const legacyDuplicate = {
  action: "duplicate",
  candidateId: "new-occurrence",
  existingId: "old-choice",
  expectedRevision: 1,
  evidence: [{ evidenceId: "new-evidence", quote: "I selected SQLite." }],
};
const occurrence = {
  ...legacyDuplicate,
  action: "duplicate_occurrence",
  title: "Local storage",
  body: "Use SQLite.",
  rationale: null,
  attribution: "agent-chosen",
};
describe("independently attributed writer occurrences", () => {
  it("keeps persisted legacy outputs readable without pretending they are restorable occurrences", () => {
    const output = { actions: [legacyDuplicate], complete: true, unresolvedCandidateIds: [] };
    expect(isLegacy(output)).toBe(true);
    expect(isV2({ ...output, version: 2 })).toBe(false);
  });
  it("requires each duplicate occurrence to carry its own note and attribution", () => {
    const output = {
      version: 2,
      actions: [occurrence],
      complete: true,
      unresolvedCandidateIds: [],
    };
    expect(isV2(output)).toBe(true);
    for (const missing of ["title", "body", "attribution", "evidence"] as const) {
      const action = { ...occurrence };
      delete (action as Partial<typeof occurrence>)[missing];
      expect(isV2({ ...output, actions: [action] })).toBe(false);
    }
    expect(isV2({ ...output, actions: Array.from({ length: 9 }, () => occurrence) })).toBe(false);
  });
});
