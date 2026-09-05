import * as Schema from "effect/Schema";

import { ForwardCompatibleOptional, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RepositoryIdentity } from "./environment.ts";

// ── Stave read models ──────────────────────────────────────────
// Projections of a Stave space manifest (`.stave.yaml`) attached to a
// Lecturn project. Produced server-side by the manifest reader; clients only
// consume them, so every field that later Stave versions may add or widen is
// optional or forward-compatible.

/** How a repository participates in a space: `edit` worktrees are writable,
    `reference` checkouts are read-only context. */
export const StaveRepoMode = Schema.Literals(["edit", "reference"]);
export type StaveRepoMode = typeof StaveRepoMode.Type;

export const StaveRepoEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  mode: StaveRepoMode,
  path: TrimmedNonEmptyString,
  base: Schema.optionalKey(TrimmedNonEmptyString),
  ref: Schema.optionalKey(TrimmedNonEmptyString),
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  bareRepoPath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type StaveRepoEntry = typeof StaveRepoEntry.Type;

export const StaveMemoryEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  /** Whether the space created (and will tear down) this memory, versus
      attaching one that outlives it. */
  owned: Schema.Boolean,
});
export type StaveMemoryEntry = typeof StaveMemoryEntry.Type;

/** `live` spaces have a manifest on disk under the workspace root; `archived`
    ones exist only as a Stave archive (see `archiveBasename`). */
export const StaveProjectState = Schema.Literals(["live", "archived"]);
export type StaveProjectState = typeof StaveProjectState.Type;

export const StaveProjectInfo = Schema.Struct({
  spaceId: TrimmedNonEmptyString,
  /** Manifest `kind`; Stave omits it for ordinary spaces and writes `saga`
      for coordinating spaces. Kept as an open string so new kinds decode. */
  kind: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: Schema.optionalKey(IsoDateTime),
  isSaga: Schema.Boolean,
  /** Space id of the saga this space is a member of, when any. */
  memberOf: Schema.optionalKey(TrimmedNonEmptyString),
  repos: Schema.Array(StaveRepoEntry),
  memories: Schema.Array(StaveMemoryEntry),
  primaryRepoPath: Schema.optionalKey(TrimmedNonEmptyString),
  primaryBranch: Schema.optionalKey(TrimmedNonEmptyString),
  primaryRepositoryIdentity: Schema.optionalKey(RepositoryIdentity),
  /** Absent when a newer server reports a state this build does not know. */
  state: ForwardCompatibleOptional(StaveProjectState),
  archiveBasename: Schema.optionalKey(TrimmedNonEmptyString),
});
export type StaveProjectInfo = typeof StaveProjectInfo.Type;

/** Lifecycle state the server wants surfaced on the project row: an archive
    is scheduled, an automatic action was refused, or cleanup is still owed. */
export const StaveProjectNoticeKind = Schema.Literals([
  "archive_scheduled",
  "refused",
  "pending_cleanup",
]);
export type StaveProjectNoticeKind = typeof StaveProjectNoticeKind.Type;

export const StaveProjectNotice = Schema.Struct({
  /** Absent when a newer server emits a notice kind this build does not know. */
  kind: ForwardCompatibleOptional(StaveProjectNoticeKind),
  /** When the scheduled action fires (for `archive_scheduled`) or when the
      notice was raised. */
  at: Schema.optionalKey(IsoDateTime),
  code: Schema.optionalKey(TrimmedNonEmptyString),
  message: Schema.optionalKey(TrimmedNonEmptyString),
});
export type StaveProjectNotice = typeof StaveProjectNotice.Type;
