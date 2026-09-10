import { describe, expect, it } from "vite-plus/test";
import { staveMembershipDeletionWarning } from "./staveProjectDeletion.logic";

describe("Stave member deletion confirmation", () => {
  it("names the saga and counts dropped ordering edges before authorizing removal", () => {
    const warning = staveMembershipDeletionWarning({
      sagaMembership: {
        sagaId: "feature",
        sagaRoot: "/spaces/feature",
        dependentEdges: [{ memberId: "second", after: "first" }],
      },
      membershipUnknown: false,
    });
    expect(warning.confirmed).toBe(true);
    expect(warning.message).toContain("saga feature");
    expect(warning.message).toContain("1 dependent ordering edge.");
  });
  it("fails closed when any saga could not be read", () => {
    expect(
      staveMembershipDeletionWarning({ sagaMembership: null, membershipUnknown: true }).confirmed,
    ).toBe(false);
  });
  it("tolerates old servers without authorizing roster edits", () => {
    expect(staveMembershipDeletionWarning({}).confirmed).toBe(false);
  });
  it("does not authorize roster edits for a nonmember", () => {
    expect(staveMembershipDeletionWarning({ sagaMembership: null })).toEqual({
      confirmed: false,
      message: null,
    });
  });
});
