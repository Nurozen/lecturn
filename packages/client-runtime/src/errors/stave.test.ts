import { describe, expect, it } from "vite-plus/test";

import {
  isStaveAdmissionError,
  isStaveRpcError,
  staveAdmissionErrorMessage,
  staveAdmissionErrorTag,
  staveRpcErrorMessage,
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

describe("staveRpcErrorMessage", () => {
  it("maps each StaveUnavailableError reason", () => {
    expect(
      staveRpcErrorMessage({ _tag: "StaveUnavailableError", reason: "disabled_by_server" }),
    ).toBe("Stave is turned off on this server (LECTURN_STAVE=false).");
    expect(
      staveRpcErrorMessage({ _tag: "StaveUnavailableError", reason: "disabled_in_settings" }),
    ).toMatch(/disabled in settings/);
    expect(
      staveRpcErrorMessage({ _tag: "StaveUnavailableError", reason: "binary_missing" }),
    ).toMatch(/No runnable Stave binary/);
  });

  it("falls back to the server message for an unknown unavailable reason", () => {
    expect(
      staveRpcErrorMessage({ _tag: "StaveUnavailableError", reason: "later", message: "soon" }),
    ).toBe("soon");
  });

  it("describes a project that is not a space", () => {
    expect(staveRpcErrorMessage({ _tag: "StaveNotSpaceError", workspaceRoot: "/x" })).toBe(
      "This project is not a Stave space (no .stave.yaml at its root).",
    );
  });

  it("quotes the verb, code and message of a failed command", () => {
    expect(
      staveRpcErrorMessage({
        _tag: "StaveCommandError",
        verb: "status",
        code: "git_failed",
        message: "fatal: not a git repository",
      }),
    ).toBe("`stave status` failed (git_failed): fatal: not a git repository");
  });

  it("finds the typed error nested under an envelope or cause", () => {
    expect(
      staveRpcErrorMessage({ error: { _tag: "StaveNotSpaceError", workspaceRoot: "/x" } }),
    ).toMatch(/not a Stave space/);
    const wrapped = new Error("request failed", {
      cause: { _tag: "StaveUnavailableError", reason: "binary_missing" },
    });
    expect(staveRpcErrorMessage(wrapped)).toMatch(/No runnable Stave binary/);
    expect(isStaveRpcError(wrapped)).toBe(true);
  });

  it("returns null for admission refusals and unrelated failures", () => {
    expect(staveRpcErrorMessage({ _tag: "StaveArchivedProjectError" })).toBeNull();
    expect(staveRpcErrorMessage(new Error("boom"))).toBeNull();
    expect(staveRpcErrorMessage(null)).toBeNull();
    expect(isStaveRpcError(undefined)).toBe(false);
  });

  it("does not loop on self-referential causes", () => {
    const error: { _tag: string; cause?: unknown } = { _tag: "Other" };
    error.cause = error;
    expect(isStaveRpcError(error)).toBe(false);
  });
});
