/**
 * Readable messages for the Stave admission refusals the server raises when
 * a mutation would break a space's invariants. Web and mobile both route
 * command failures through here before falling back to `error.message`, so
 * the wording lives in one place. Matching is by typed `_tag` first and by
 * the wire `code` second (the HTTP path serialises errors as `{code}`
 * envelopes), so either transport renders the same text.
 */

export const STAVE_ADMISSION_ERROR_TAGS = [
  "StaveWorktreeForbiddenError",
  "StaveArchivedProjectError",
  "StaveSpaceTransitioningError",
] as const;
export type StaveAdmissionErrorTag = (typeof STAVE_ADMISSION_ERROR_TAGS)[number];

export const STAVE_ADMISSION_ERROR_CODES = [
  "stave_worktree_forbidden",
  "archived_project",
  "space_transitioning",
] as const;
export type StaveAdmissionErrorCode = (typeof STAVE_ADMISSION_ERROR_CODES)[number];

const MESSAGE_BY_TAG: Record<StaveAdmissionErrorTag, string> = {
  StaveWorktreeForbiddenError:
    "Stave spaces always run in the space root. Threads cannot use a separate worktree here.",
  StaveArchivedProjectError:
    "This Stave space is archived. Restore it before starting or changing threads.",
  StaveSpaceTransitioningError:
    "This Stave space is being archived or destroyed. Try again once it settles.",
};

const TAG_BY_CODE: Record<StaveAdmissionErrorCode, StaveAdmissionErrorTag> = {
  stave_worktree_forbidden: "StaveWorktreeForbiddenError",
  archived_project: "StaveArchivedProjectError",
  space_transitioning: "StaveSpaceTransitioningError",
};

function isStaveAdmissionTag(value: unknown): value is StaveAdmissionErrorTag {
  return (
    typeof value === "string" && (STAVE_ADMISSION_ERROR_TAGS as readonly string[]).includes(value)
  );
}

function isStaveAdmissionCode(value: unknown): value is StaveAdmissionErrorCode {
  return (
    typeof value === "string" && (STAVE_ADMISSION_ERROR_CODES as readonly string[]).includes(value)
  );
}

function readField(error: unknown, field: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as Record<string, unknown>)[field];
}

/** Resolve the admission refusal an arbitrary failure represents, if any. */
export function staveAdmissionErrorTag(error: unknown): StaveAdmissionErrorTag | null {
  const tag = readField(error, "_tag");
  if (isStaveAdmissionTag(tag)) return tag;
  const code = readField(error, "code");
  if (isStaveAdmissionCode(code)) return TAG_BY_CODE[code];
  // Squashed causes and RPC envelopes often nest the typed error one level down.
  for (const nested of [readField(error, "error"), readField(error, "cause")]) {
    if (nested !== undefined && nested !== error) {
      const nestedTag = staveAdmissionErrorTag(nested);
      if (nestedTag !== null) return nestedTag;
    }
  }
  return null;
}

export function isStaveAdmissionError(error: unknown): boolean {
  return staveAdmissionErrorTag(error) !== null;
}

/**
 * Human-readable description for a Stave admission refusal, or `null` when
 * the failure is something else and the caller's usual message applies.
 */
export function staveAdmissionErrorMessage(error: unknown): string | null {
  const tag = staveAdmissionErrorTag(error);
  return tag === null ? null : MESSAGE_BY_TAG[tag];
}

/**
 * Readable messages for the failures the Stave RPCs themselves raise
 * (feature gate, not-a-space, non-zero verb exit). These never come back as
 * wire `code` envelopes, so matching is by `_tag` only, with the same nested
 * `error`/`cause` lookup the admission mapping uses.
 */

export const STAVE_RPC_ERROR_TAGS = [
  "StaveUnavailableError",
  "StaveNotSpaceError",
  "StaveCommandError",
] as const;
export type StaveRpcErrorTag = (typeof STAVE_RPC_ERROR_TAGS)[number];

const UNAVAILABLE_MESSAGE_BY_REASON: Record<string, string> = {
  disabled_by_server: "Stave is turned off on this server (T3CODE_STAVE=false).",
  disabled_in_settings:
    "Stave is disabled in settings. Turn it on under Settings → General → Stave.",
  binary_missing:
    "No runnable Stave binary was found. Set a binary path under Settings → General → Stave.",
};

function isStaveRpcTag(value: unknown): value is StaveRpcErrorTag {
  return typeof value === "string" && (STAVE_RPC_ERROR_TAGS as readonly string[]).includes(value);
}

function readString(error: unknown, field: string): string | null {
  const value = readField(error, field);
  return typeof value === "string" ? value : null;
}

/** Resolve the typed RPC failure an arbitrary error wraps, or `null`. */
function findStaveRpcError(error: unknown): { tag: StaveRpcErrorTag; error: unknown } | null {
  const tag = readField(error, "_tag");
  if (isStaveRpcTag(tag)) return { tag, error };
  for (const nested of [readField(error, "error"), readField(error, "cause")]) {
    if (nested !== undefined && nested !== error) {
      const found = findStaveRpcError(nested);
      if (found !== null) return found;
    }
  }
  return null;
}

export function isStaveRpcError(error: unknown): boolean {
  return findStaveRpcError(error) !== null;
}

/**
 * Human-readable description for a Stave RPC failure, or `null` when the
 * failure is something else and the caller's usual message applies.
 */
export function staveRpcErrorMessage(error: unknown): string | null {
  const found = findStaveRpcError(error);
  if (found === null) return null;
  switch (found.tag) {
    case "StaveUnavailableError": {
      const reason = readString(found.error, "reason");
      return (
        (reason === null ? undefined : UNAVAILABLE_MESSAGE_BY_REASON[reason]) ??
        readString(found.error, "message") ??
        "Stave is unavailable."
      );
    }
    case "StaveNotSpaceError":
      return "This project is not a Stave space (no .stave.yaml at its root).";
    case "StaveCommandError": {
      const verb = readString(found.error, "verb") ?? "?";
      const code = readString(found.error, "code") ?? "unknown";
      const message = readString(found.error, "message") ?? "";
      return `\`stave ${verb}\` failed (${code}): ${message}`;
    }
  }
}
