import { describe, expect, it } from "vite-plus/test";
import type { StaveOperation } from "@t3tools/contracts";
import {
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
