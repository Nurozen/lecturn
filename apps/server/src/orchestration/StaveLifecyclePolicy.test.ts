import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type StaveProjectInfo,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { StaveLifecycleRow } from "../persistence/Services/StaveLifecycleRepository.ts";
import type { ProjectionThreadLifecycleAnchor } from "./Services/ProjectionSnapshotQuery.ts";
import { evaluateDeletedProject, resolveArchiveDeadline } from "./StaveLifecyclePolicy.ts";

const NOW = "2026-09-01T00:00:00.000Z";
const OLD = "2026-08-01T00:00:00.000Z";
const LATER = "2026-09-02T00:00:00.000Z";
const policy = DEFAULT_SERVER_SETTINGS.stave.lifecycle;
const manifest: StaveProjectInfo = {
  spaceId: "space",
  createdAt: OLD,
  isSaga: false,
  repos: [],
  memories: [],
  state: "live",
};
const row: StaveLifecycleRow = {
  projectId: ProjectId.make("project"),
  workspaceRoot: "/space",
  spaceId: "space",
  manifestCreatedAt: OLD,
  disposition: "pending_evaluation",
  deleteIntentSequence: 42,
  sagaRemoveConfirmed: false,
  sagaTeardown: null,
  refusalCode: null,
  refusalMessage: null,
  anchorAt: null,
  scheduledAt: null,
  archiveDeadlineAt: null,
  archiveBasename: null,
  leaseEpoch: 0,
  ownerToken: null,
  leaseUntil: null,
  updatedAt: NOW,
  refreshedAt: null,
};
const thread: ProjectionThreadLifecycleAnchor = {
  threadId: ThreadId.make("thread"),
  createdAt: OLD,
  updatedAt: OLD,
  settledAt: OLD,
  unsettledAt: null,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
};
const deadline = (
  anchors: ReadonlyArray<ProjectionThreadLifecycleAnchor>,
  lifecycle: StaveLifecycleRow | null = null,
  now = NOW,
  graceDays = 7,
) => resolveArchiveDeadline({ anchors, row: lifecycle, now, graceDays });

describe("delete lifecycle policy", () => {
  it.each(["destroy", "archive", "keep"] as const)(
    "honors %s for a verified live space",
    (onProjectDelete) => {
      expect(
        evaluateDeletedProject(row, manifest, { ...policy, onProjectDelete }).disposition,
      ).toBe(onProjectDelete === "keep" ? "kept" : `pending_${onProjectDelete}`);
    },
  );
  it.each(["destroyed", "not_stave", "kept", "archived"] as const)(
    "clears terminal %s without acting on a replacement manifest",
    (disposition) => {
      expect(
        evaluateDeletedProject(
          { ...row, disposition },
          { ...manifest, spaceId: "replacement" },
          policy,
        ),
      ).toEqual({ disposition: disposition === "archived" ? "kept" : disposition });
    },
  );
  it("keeps archived manifests and does not require identity for keep", () => {
    expect(evaluateDeletedProject(row, { ...manifest, state: "archived" }, policy)).toEqual({
      disposition: "kept",
    });
    expect(
      evaluateDeletedProject({ ...row, manifestCreatedAt: null }, null, {
        ...policy,
        onProjectDelete: "keep",
      }),
    ).toEqual({ disposition: "kept" });
  });
  it("distinguishes verified disappearance from a plain project", () => {
    expect(evaluateDeletedProject(row, null, policy)).toEqual({ disposition: "destroyed" });
    expect(
      evaluateDeletedProject({ ...row, spaceId: null, manifestCreatedAt: null }, null, policy),
    ).toEqual({ disposition: "not_stave" });
  });
  it.each([null, "0001-01-01T00:00:00Z", "invalid"])(
    "refuses missing/zero/invalid recorded creation %s",
    (stamp) => {
      expect(
        evaluateDeletedProject({ ...row, manifestCreatedAt: stamp }, manifest, policy),
      ).toMatchObject({ disposition: "refused", code: "incarnation_mismatch" });
      expect(
        evaluateDeletedProject({ ...row, manifestCreatedAt: stamp }, null, policy).disposition,
      ).toBe("refused");
    },
  );
  it.each([undefined, "0001-01-01T00:00:00Z", "2026-08-02T00:00:00Z"])(
    "refuses missing/zero/changed current creation %s",
    (stamp) => {
      const { createdAt: _, ...unstamped } = manifest;
      const candidate = stamp === undefined ? unstamped : { ...unstamped, createdAt: stamp };
      expect(evaluateDeletedProject(row, candidate, policy)).toMatchObject({
        disposition: "refused",
        code: "incarnation_mismatch",
      });
    },
  );
  it("requires both ids and compares instants with full fractional precision", () => {
    expect(
      evaluateDeletedProject(row, { ...manifest, spaceId: "replacement" }, policy).disposition,
    ).toBe("refused");
    expect(evaluateDeletedProject({ ...row, spaceId: null }, manifest, policy).disposition).toBe(
      "refused",
    );
    expect(
      evaluateDeletedProject(row, { ...manifest, createdAt: "2026-07-31T16:00:00-08:00" }, policy)
        .disposition,
    ).toBe("pending_destroy");
    expect(
      evaluateDeletedProject(
        { ...row, manifestCreatedAt: "2026-08-01T00:00:00.000000001Z" },
        { ...manifest, createdAt: "2026-08-01T00:00:00.000000002Z" },
        policy,
      ).disposition,
    ).toBe("refused");
  });
});

describe("archive deadlines", () => {
  it("starts a visible grace period when enabled for an old settled project", () => {
    expect(deadline([thread])).toEqual({
      anchorAt: OLD,
      scheduledAt: NOW,
      deadlineAt: "2026-09-08T00:00:00.000Z",
      reset: true,
      kept: false,
    });
  });
  it("does not archive empty projects or a project with any active thread", () => {
    expect(deadline([])).toBeNull();
    expect(deadline([thread, { ...thread, settledAt: null }])).toBeNull();
    expect(deadline([{ ...thread, settledOverride: "active" }])).toBeNull();
    expect(deadline([{ ...thread, unsettledAt: NOW }])).toBeNull();
    expect(deadline([{ ...thread, unsettledAt: OLD }])).toBeNull();
  });
  it("treats archived and deleted threads as inactive even when pinned active", () => {
    expect(
      deadline([{ ...thread, archivedAt: NOW, settledAt: null, settledOverride: "active" }])
        ?.anchorAt,
    ).toBe(NOW);
    expect(
      deadline([{ ...thread, deletedAt: NOW, settledAt: null, settledOverride: "active" }])
        ?.anchorAt,
    ).toBe(NOW);
  });
  it("honors explicit settled state and a subsequent settle after un-settle", () => {
    expect(deadline([{ ...thread, settledOverride: "settled", settledAt: null }])).not.toBeNull();
    expect(deadline([{ ...thread, unsettledAt: OLD, settledAt: NOW }])?.anchorAt).toBe(NOW);
  });
  it.each([
    "createdAt",
    "updatedAt",
    "settledAt",
    "unsettledAt",
    "archivedAt",
    "deletedAt",
  ] as const)("anchors to latest %s across all rows", (field) => {
    expect(
      deadline([thread, { ...thread, settledOverride: "settled", [field]: LATER }])?.anchorAt,
    ).toBe(LATER);
  });
  it("preserves the original schedule despite lease/refresh updates and changed grace", () => {
    const existing = { ...row, anchorAt: OLD, scheduledAt: NOW, updatedAt: LATER };
    expect(deadline([thread], existing, LATER)).toMatchObject({
      scheduledAt: NOW,
      deadlineAt: "2026-09-08T00:00:00.000Z",
      reset: false,
    });
    expect(deadline([thread], existing, LATER, 2)?.deadlineAt).toBe("2026-09-03T00:00:00.000Z");
  });
  it("suppresses a kept episode only until an anchor changes", () => {
    const existing = { ...row, disposition: "kept" as const, anchorAt: OLD, scheduledAt: NOW };
    expect(deadline([thread], existing, LATER)).toMatchObject({ kept: true, reset: false });
    expect(deadline([{ ...thread, settledAt: LATER }], existing, LATER)).toEqual({
      anchorAt: LATER,
      scheduledAt: LATER,
      deadlineAt: "2026-09-09T00:00:00.000Z",
      reset: true,
      kept: false,
    });
  });
  it("uses the later anchor during clock skew and supports zero grace", () => {
    expect(deadline([{ ...thread, settledAt: LATER }], null, NOW, 0)?.deadlineAt).toBe(LATER);
  });
});
