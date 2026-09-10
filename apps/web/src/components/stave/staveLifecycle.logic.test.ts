import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_UNIFIED_SETTINGS, ProjectId } from "@t3tools/contracts";
import {
  lifecycleNoticeDescription,
  lifecycleNoticeLabel,
  lifecycleOperation,
} from "./staveLifecycle.logic";
import { canForceStaveOperation, staveOperationLossCopy } from "./staveConfirm.logic";

const policy = DEFAULT_UNIFIED_SETTINGS.stave.lifecycle;
const input = {
  projectId: ProjectId.make("project"),
  workspaceRoot: "/spaces/one",
  createdAt: "2026-01-01T00:00:00Z",
  policy,
};

describe("lifecycle review payload", () => {
  it("binds retry to the reviewed incarnation, deletion verb and memory fate", () => {
    const operation = lifecycleOperation({
      ...input,
      action: "retry",
      policy: { ...policy, onProjectDelete: "destroy", memoryFateOnDestroy: "contribute" },
    });
    expect(operation).toMatchObject({
      target: "destroy",
      memory: "contribute",
      force: false,
      expectedManifestCreatedAt: input.createdAt,
    });
    expect(
      lifecycleOperation({
        ...input,
        action: "retry",
        policy: { ...policy, onProjectDelete: "archive", memoryFateOnDestroy: "destroy" },
      }),
    ).toMatchObject({ target: "archive", memory: "keep" });
  });
  it.each(["retry", "archiveNow"] as const)("refuses %s without an incarnation", (action) => {
    expect(lifecycleOperation({ ...input, action, createdAt: null })).toBeNull();
  });
  it.each(["keep", "dismiss"] as const)(
    "permits metadata-only %s without a stamp and never forces it",
    (action) => {
      const operation = lifecycleOperation({ ...input, action, createdAt: null, force: true })!;
      expect(operation).not.toHaveProperty("expectedManifestCreatedAt");
      expect(operation.force).toBe(false);
      expect(canForceStaveOperation(operation, "dirty_worktrees")).toBe(false);
      expect(staveOperationLossCopy(operation)).toContain("in place");
      expect(staveOperationLossCopy(operation)).not.toContain("permanently removes");
    },
  );
  it("does not invent a destructive retry under keep policy", () => {
    expect(
      lifecycleOperation({
        ...input,
        action: "retry",
        policy: { ...policy, onProjectDelete: "keep" },
      }),
    ).toBeNull();
  });
  it("archive now never inherits destroy memory fate", () => {
    const operation = lifecycleOperation({
      ...input,
      action: "archiveNow",
      policy: { ...policy, memoryFateOnDestroy: "destroy" },
    })!;
    expect(operation.memory).toBe("keep");
    expect(operation).not.toHaveProperty("target");
    expect(staveOperationLossCopy(operation)).toContain("survive");
  });
  it("force requires an explicit supported refusal", () => {
    const operation = lifecycleOperation({ ...input, action: "retry" })!;
    expect(canForceStaveOperation(operation, undefined)).toBe(false);
    expect(canForceStaveOperation(operation, "dirty_worktrees")).toBe(true);
    expect(canForceStaveOperation(operation, "membership_unknown")).toBe(false);
    expect(canForceStaveOperation(operation, "incarnation_mismatch")).toBe(false);
  });
});

describe("lifecycle notices", () => {
  it("does not promise an automatic archive under suggest", () => {
    expect(
      lifecycleNoticeDescription(
        { kind: "archive_scheduled", at: input.createdAt },
        { ...policy, onAllThreadsSettled: "suggest" },
      ),
    ).toContain("when ready");
    expect(lifecycleNoticeLabel({ kind: "archive_scheduled", code: "archive_suggested" })).toBe(
      "Archive suggested",
    );
  });
  it("preserves the server refusal and ignores unknown notice kinds", () => {
    expect(
      lifecycleNoticeDescription(
        { kind: "refused", message: "Nested project prevents archive." },
        policy,
      ),
    ).toBe("Nested project prevents archive.");
    expect(lifecycleNoticeLabel({})).toBeNull();
    expect(lifecycleNoticeLabel({ kind: "pending_cleanup" })).toBe("Cleanup pending");
  });
});
