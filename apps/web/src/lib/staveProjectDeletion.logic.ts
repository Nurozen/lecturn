import type {
  StaveSpaceStatus,
  StaveSagaReview,
  StaveSagaTeardownAuthorization,
} from "@lecturn/contracts";

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

/** This scope is rendered in both project deletion and explicit saga confirmation. */
export function staveSagaReviewLines(
  review: StaveSagaReview,
  coordinatorProjectConfirmed = false,
): string[] {
  const projects = review.participants.filter(
    (participant) =>
      participant.projectId !== undefined &&
      (!coordinatorProjectConfirmed || participant.workspaceRoot !== review.sagaRoot),
  );
  const threads = projects.reduce((count, participant) => count + participant.threadIds.length, 0);
  return [
    `Stave will ${review.target} the saga and the following spaces:`,
    ...review.participants.map(
      (participant) =>
        `• ${participant.spaceId}: ${participant.workspaceRoot}${participant.projectId ? ` — project "${participant.projectTitle ?? participant.projectId}", ${participant.threadIds.length} threads` : ""}`,
    ),
    ...(review.target === "destroy" && projects.length > 0
      ? [
          `This also deletes ${projects.length} ${coordinatorProjectConfirmed ? "member" : "imported"} project${projects.length === 1 ? "" : "s"} and permanently clears their ${threads} thread${threads === 1 ? "" : "s"}, including archived conversation history.`,
        ]
      : []),
    "If saga membership or the affected projects change, cleanup will wait for another review.",
  ];
}

export function staveSagaTeardownAuthorization(
  review: StaveSagaReview,
): StaveSagaTeardownAuthorization | undefined {
  if (!review.projectDeletionFingerprint) return undefined;
  return {
    expectedSagaReview: review.projectDeletionFingerprint,
    target: review.target,
    force: review.force,
    memory: review.memory,
  };
}
