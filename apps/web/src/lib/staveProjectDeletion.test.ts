import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ThreadId, type StaveSagaReview } from "@lecturn/contracts";
import {
  staveMembershipDeletionWarning,
  staveSagaReviewLines,
  staveSagaTeardownAuthorization,
} from "./staveProjectDeletion.logic";

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

describe("saga cascade confirmation", () => {
  const review: StaveSagaReview = {
    fingerprint: "reviewed-roster",
    projectDeletionFingerprint: "project-delete-roster",
    sagaRoot: "/spaces/saga",
    sagaCreatedAt: "2026-01-01T00:00:00Z",
    target: "destroy",
    force: false,
    memory: "destroy",
    participants: [
      {
        spaceId: "saga",
        createdAt: "2026-01-01T00:00:00Z",
        workspaceRoot: "/spaces/saga",
        state: "live",
        threadIds: [],
      },
      {
        spaceId: "member",
        createdAt: "2026-01-01T00:00:00Z",
        workspaceRoot: "/spaces/member",
        state: "live",
        projectId: ProjectId.make("member-project"),
        projectTitle: "Member app",
        threadIds: [ThreadId.make("active"), ThreadId.make("archived")],
      },
    ],
  };
  it("names every affected space, member project and archived-inclusive conversation count", () => {
    const text = staveSagaReviewLines(review).join("\n");
    expect(text).toContain("saga: /spaces/saga");
    expect(text).toContain('member: /spaces/member — project "Member app", 2 threads');
    expect(text).toContain("deletes 1 imported project");
    expect(text).toContain("including archived conversation history");
    expect(staveSagaTeardownAuthorization(review)).toEqual({
      expectedSagaReview: "project-delete-roster",
      target: "destroy",
      force: false,
      memory: "destroy",
    });
  });
  it("includes coordinator history for explicit destroy and separates it in project deletion", () => {
    const withCoordinator = {
      ...review,
      participants: review.participants.map((participant) =>
        participant.workspaceRoot === review.sagaRoot
          ? {
              ...participant,
              projectId: ProjectId.make("saga-project"),
              projectTitle: "Coordinator",
              threadIds: [ThreadId.make("coordinator-thread")],
            }
          : participant,
      ),
    };
    const explicit = staveSagaReviewLines(withCoordinator).join("\n");
    expect(explicit).toContain("deletes 2 imported projects");
    expect(explicit).toContain("their 3 threads");
    const projectDeletion = staveSagaReviewLines(withCoordinator, true).join("\n");
    expect(projectDeletion).toContain("deletes 1 member project");
    expect(projectDeletion).toContain("their 2 threads");
  });
  it("does not authorize a durable cascade with only an explicit-operation fingerprint", () => {
    const { projectDeletionFingerprint: _ignored, ...explicitOnly } = review;
    expect(staveSagaTeardownAuthorization(explicitOnly)).toBeUndefined();
  });
  it("does not claim conversations are removed by archive", () => {
    expect(
      staveSagaReviewLines({ ...review, target: "archive", memory: "keep" }).join("\n"),
    ).not.toContain("permanently clears");
  });
});
