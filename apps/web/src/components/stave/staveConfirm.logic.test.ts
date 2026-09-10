import { describe, expect, it } from "vite-plus/test";
import type { StaveOperation, StaveSagaReview } from "@t3tools/contracts";
import {
  bindStaveSagaReview,
  canForceStaveOperation,
  forceStaveOperation,
  staveOperationLossCopy,
} from "./staveConfirm.logic";

const destroy = {
  kind: "destroySpace",
  workspaceRoot: "/spaces/demo",
  expectedManifestCreatedAt: "2026-01-01T00:00:00Z",
  force: false,
  memory: "keep",
} satisfies StaveOperation;

describe("Stave confirmation safety", () => {
  it.each(["dirty_worktrees", "dependent_spaces"])(
    "offers force for %s only after refusal",
    (code) => {
      expect(canForceStaveOperation(destroy, code)).toBe(true);
      const forced = forceStaveOperation(destroy);
      expect(forced).toEqual({ ...destroy, force: true });
      expect(canForceStaveOperation(forced, code)).toBe(false);
    },
  );
  it.each([
    undefined,
    "memory_in_use",
    "incarnation_mismatch",
    "nested_project",
    "saga_member",
    "membership_unknown",
    "unknown",
  ])("does not offer force for %s", (code) => {
    expect(canForceStaveOperation(destroy, code)).toBe(false);
  });
  it("does not invent force support for retarget", () => {
    const operation = {
      kind: "retarget",
      workspaceRoot: "/space",
      repo: "repo",
      base: "main",
    } satisfies StaveOperation;
    expect(canForceStaveOperation(operation, "dirty_worktrees")).toBe(false);
    expect(forceStaveOperation(operation)).toEqual(operation);
  });
  it("distinguishes archive survival from destroy loss", () => {
    expect(staveOperationLossCopy(destroy)).toContain("permanently removes");
    expect(
      staveOperationLossCopy({
        kind: "archiveSpace",
        workspaceRoot: "/space",
        force: false,
        memory: "keep",
      }),
    ).toContain("Unarchive restores");
  });
  it("describes owned versus shared memory destruction", () => {
    expect(
      staveOperationLossCopy({ kind: "memoryDetach", workspaceRoot: "/space", fate: "destroy" }),
    ).toContain("owned elsewhere is kept");
  });
});

it("discloses replacement whenever saga predecessors are supplied", () => {
  const operation = {
    kind: "sagaAdd",
    sagaRoot: "/saga",
    memberRoot: "/member",
    after: ["new-parent"],
    clearAfter: false,
  } satisfies StaveOperation;
  expect(staveOperationLossCopy(operation)).toContain("replaces");
  expect(staveOperationLossCopy({ ...operation, after: [], clearAfter: true })).toContain(
    "clears all",
  );
  expect(staveOperationLossCopy({ ...operation, after: [] })).toContain("keeping any existing");
});

describe("saga reviewed scope", () => {
  const operation = {
    kind: "sagaDestroy",
    sagaRoot: "/spaces/saga",
    expectedManifestCreatedAt: "2026-01-01T00:00:00Z",
    force: false,
    memory: "keep",
  } satisfies StaveOperation;
  const review = {
    fingerprint: "roster-a",
    sagaRoot: operation.sagaRoot,
    sagaCreatedAt: operation.expectedManifestCreatedAt,
    target: "destroy",
    force: false,
    memory: "keep",
    participants: [],
  } satisfies StaveSagaReview;
  it("attaches the preview fingerprint to the unchanged confirmation payload", () => {
    expect(bindStaveSagaReview(operation, review)).toEqual({
      ...operation,
      expectedSagaReview: "roster-a",
    });
  });
  it("refuses absent, stale-option and different-incarnation previews", () => {
    expect(bindStaveSagaReview(operation, undefined)).toBeNull();
    for (const patch of [
      { force: true },
      { memory: "destroy" as const },
      { target: "archive" as const },
      { sagaRoot: "/spaces/other" },
      { sagaCreatedAt: "2026-01-02T00:00:00Z" },
    ]) {
      expect(bindStaveSagaReview(operation, { ...review, ...patch })).toBeNull();
    }
  });
  it("does not require saga consent for an ordinary space", () => {
    expect(bindStaveSagaReview(destroy, undefined)).toEqual(destroy);
  });
});
