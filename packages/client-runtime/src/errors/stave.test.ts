import { describe, expect, it } from "vite-plus/test";

import {
  isStaveAdmissionError,
  staveAdmissionErrorMessage,
  staveAdmissionErrorTag,
} from "./stave.ts";

describe("staveAdmissionErrorMessage", () => {
  it("maps each typed admission tag to a readable message", () => {
    expect(staveAdmissionErrorMessage({ _tag: "StaveWorktreeForbiddenError" })).toMatch(
      /space root/,
    );
    expect(staveAdmissionErrorMessage({ _tag: "StaveArchivedProjectError" })).toMatch(/archived/);
    expect(staveAdmissionErrorMessage({ _tag: "StaveSpaceTransitioningError" })).toMatch(
      /archived or destroyed/,
    );
  });

  it("maps the wire codes the HTTP path emits", () => {
    expect(staveAdmissionErrorTag({ code: "stave_worktree_forbidden" })).toBe(
      "StaveWorktreeForbiddenError",
    );
    expect(staveAdmissionErrorTag({ code: "archived_project" })).toBe("StaveArchivedProjectError");
    expect(staveAdmissionErrorTag({ code: "space_transitioning" })).toBe(
      "StaveSpaceTransitioningError",
    );
  });

  it("finds the typed error nested under an envelope or cause", () => {
    expect(staveAdmissionErrorTag({ error: { _tag: "StaveArchivedProjectError" } })).toBe(
      "StaveArchivedProjectError",
    );
    const wrapped = new Error("request failed", {
      cause: { _tag: "StaveSpaceTransitioningError" },
    });
    expect(staveAdmissionErrorTag(wrapped)).toBe("StaveSpaceTransitioningError");
  });

  it("returns null for unrelated failures so callers keep their own wording", () => {
    expect(staveAdmissionErrorMessage({ _tag: "WorktreeError", message: "boom" })).toBeNull();
    expect(staveAdmissionErrorMessage(new Error("boom"))).toBeNull();
    expect(staveAdmissionErrorMessage(null)).toBeNull();
    expect(staveAdmissionErrorMessage("stave_worktree_forbidden")).toBeNull();
    expect(isStaveAdmissionError(undefined)).toBe(false);
  });

  it("does not loop on self-referential causes", () => {
    const error: { _tag: string; cause?: unknown } = { _tag: "Other" };
    error.cause = error;
    expect(staveAdmissionErrorTag(error)).toBeNull();
  });
});
