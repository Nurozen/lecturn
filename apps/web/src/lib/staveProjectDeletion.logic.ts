import type { StaveSpaceStatus } from "@t3tools/contracts";

export function staveMembershipDeletionWarning(
  status: Pick<StaveSpaceStatus, "sagaMembership" | "membershipUnknown">,
) {
  if (status.membershipUnknown || status.sagaMembership === undefined) {
    return {
      confirmed: false,
      message:
        "Saga membership could not be verified. Automatic cleanup will be refused if membership is uncertain; review pending cleanups in Stave settings.",
    };
  }
  if (status.sagaMembership === null) return { confirmed: false, message: null };
  const { sagaId, dependentEdges } = status.sagaMembership;
  return {
    confirmed: true,
    message: `This space is a member of saga ${sagaId}. Deleting it also removes it from the saga and drops ${dependentEdges.length} dependent ordering edge${dependentEdges.length === 1 ? "" : "s"}. If cleanup fails, repair the membership manually using the reported edges.`,
  };
}
