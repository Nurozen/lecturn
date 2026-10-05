import { describe, expect, it } from "vite-plus/test";
import { deliveredGroups } from "./contextualDisclosure";

describe("native delivered evidence disclosure", () => {
  const groups = [
    {
      guidanceId: "chosen",
      evidence: [
        { id: "sent", quote: "Accepted evidence" },
        { id: "omitted", quote: "Never supplied" },
      ],
    },
    { guidanceId: "not-sent", evidence: [{ id: "other", quote: "Other candidate" }] },
  ];
  it("shows only provider-receipted excerpts and drops unsupplied groups", () => {
    expect(
      deliveredGroups(groups, {
        acceptance: "accepted",
        evidenceIncluded: true,
        suppliedEvidenceIds: ["sent"],
      }),
    ).toEqual([{ guidanceId: "chosen", evidence: [{ id: "sent", quote: "Accepted evidence" }] }]);
    expect(groups[0]?.evidence).toHaveLength(2);
  });
  it.each(["unknown", "rejected"])(
    "does not describe %s delivery as supplied context",
    (acceptance) => {
      expect(
        deliveredGroups(groups, {
          acceptance,
          evidenceIncluded: true,
          suppliedEvidenceIds: ["sent"],
        }),
      ).toEqual([]);
    },
  );
  it("does not display prepared evidence for a skipped turn", () => {
    expect(
      deliveredGroups(groups, {
        acceptance: "accepted",
        evidenceIncluded: false,
        suppliedEvidenceIds: [],
      }),
    ).toEqual([]);
  });
});
