/** A prepared packet can contain excerpts that the provider never accepted. */
export function deliveredGroups<T extends { evidence: ReadonlyArray<{ id: string }> }>(
  groups: ReadonlyArray<T>,
  receipt: {
    acceptance: string;
    evidenceIncluded: boolean;
    suppliedEvidenceIds: ReadonlyArray<string>;
  },
): Array<T> {
  if (receipt.acceptance !== "accepted" || !receipt.evidenceIncluded) return [];
  const supplied = new Set(receipt.suppliedEvidenceIds);
  return groups
    .map((group) => ({
      ...group,
      evidence: group.evidence.filter((evidence) => supplied.has(evidence.id)),
    }))
    .filter((group) => group.evidence.length > 0);
}
