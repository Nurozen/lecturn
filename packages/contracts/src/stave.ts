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

// ── Stave live status ──────────────────────────────────────────
// Served by `stave.getStatus`. `capabilities.stave` on the environment
// descriptor is a static build fact (the T3CODE_STAVE kill switch is on);
// this is the live answer to "is a binary runnable, is it configured, is
// marmot reachable", re-probed on every call so the settings page and the
// project sidebar can react to installs and config edits without a restart.

/** Where the server found the binary it runs: an explicit settings path, the
    environment override, the bootstrap installer, the bundled copy, or PATH. */
export const StaveBinarySource = Schema.Literals([
  "settings",
  "env",
  "bootstrap",
  "bundled",
  "path",
]);
export type StaveBinarySource = typeof StaveBinarySource.Type;

export const StaveBinaryStatus = Schema.Struct({
  path: Schema.String,
  source: StaveBinarySource,
  version: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
});
export type StaveBinaryStatus = typeof StaveBinaryStatus.Type;

export const StaveStatusFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
export type StaveStatusFailure = typeof StaveStatusFailure.Type;

/** Directories from Stave's resolved config; null on `StaveStatus` when the
    config could not be read. */
export const StaveRootsStatus = Schema.Struct({
  root: Schema.String,
  bareReposDir: Schema.String,
  agentWorkDir: Schema.String,
});
export type StaveRootsStatus = typeof StaveRootsStatus.Type;

export const StaveMarmotStatus = Schema.Struct({
  available: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
});
export type StaveMarmotStatus = typeof StaveMarmotStatus.Type;

/** The most recent Stave verb the server ran that failed, kept so the UI can
    show why a project row is stale without replaying the command. */
export const StaveLastFailure = Schema.Struct({
  at: IsoDateTime,
  verb: Schema.String,
  code: Schema.String,
  message: Schema.String,
});
export type StaveLastFailure = typeof StaveLastFailure.Type;

export const StaveStatus = Schema.Struct({
  /** The binary the server would run, or null with `runnableError` set. */
  runnable: Schema.NullOr(StaveBinaryStatus),
  runnableError: Schema.NullOr(StaveStatusFailure),
  configPath: Schema.String,
  configExists: Schema.Boolean,
  roots: Schema.NullOr(StaveRootsStatus),
  marmot: StaveMarmotStatus,
  lastFailure: Schema.NullOr(StaveLastFailure),
  /** Placeholder until the lifecycle table lands (Phase 3); always empty today. */
  pendingCleanups: Schema.Array(Schema.Unknown),
});
export type StaveStatus = typeof StaveStatus.Type;

// ── Stave space status ─────────────────────────────────────────
// Mirrors Stave's `spaceStatusJSON` (root.go) in camelCase, minus the manifest
// itself: clients already hold `StaveProjectInfo` for that.

/** `unknown` covers repo modes a newer Stave reports that this build does not
    know; clients treat them as read-only. */
export const StaveSpaceStatusRepoMode = Schema.Literals(["edit", "reference", "unknown"]);
export type StaveSpaceStatusRepoMode = typeof StaveSpaceStatusRepoMode.Type;

export const StaveSpaceStatusRepo = Schema.Struct({
  name: Schema.String,
  mode: StaveSpaceStatusRepoMode,
  path: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  base: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  exists: Schema.Boolean,
  dirty: Schema.Boolean,
  /** Raw `git status --porcelain` output when `dirty` is set. */
  dirtyOutput: Schema.optionalKey(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  /** Why ahead/behind could not be computed (missing upstream, git failure). */
  driftError: Schema.optionalKey(Schema.String),
  /** Set when a `reference` checkout has local edits it should not have. */
  referenceWarn: Schema.optionalKey(Schema.String),
});
export type StaveSpaceStatusRepo = typeof StaveSpaceStatusRepo.Type;

export const StaveSpaceStatusMemory = Schema.Struct({
  name: Schema.String,
  provider: Schema.String,
  id: Schema.String,
  owned: Schema.Boolean,
  /** Compact freshness text ("2 unpushed", "stale"); absent when the probe failed. */
  state: Schema.optionalKey(Schema.String),
});
export type StaveSpaceStatusMemory = typeof StaveSpaceStatusMemory.Type;

export const StaveSpaceStatus = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  kind: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(Schema.String),
  repos: Schema.Array(StaveSpaceStatusRepo),
  memories: Schema.Array(StaveSpaceStatusMemory),
});
export type StaveSpaceStatus = typeof StaveSpaceStatus.Type;

export const StaveSpaceStatusInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
});
export type StaveSpaceStatusInput = typeof StaveSpaceStatusInput.Type;

// ── Stave RPC errors ───────────────────────────────────────────

/** Why a Stave RPC cannot run: `disabled_by_server` is the `T3CODE_STAVE=false`
    kill switch, `disabled_in_settings` is `settings.stave.enabled` turned off,
    `binary_missing` means no runnable binary was found. */
export const StaveUnavailableReason = Schema.Literals([
  "disabled_by_server",
  "disabled_in_settings",
  "binary_missing",
]);
export type StaveUnavailableReason = typeof StaveUnavailableReason.Type;

export class StaveUnavailableError extends Schema.TaggedErrorClass<StaveUnavailableError>()(
  "StaveUnavailableError",
  {
    reason: StaveUnavailableReason,
    message: Schema.String,
  },
) {}

/** The workspace root has no `.stave.yaml`, so space-scoped verbs do not apply. */
export class StaveNotSpaceError extends Schema.TaggedErrorClass<StaveNotSpaceError>()(
  "StaveNotSpaceError",
  {
    workspaceRoot: Schema.String,
    message: Schema.String,
  },
) {}

/** A Stave verb exited non-zero; `code` and `message` come from its `--json`
    error envelope. */
export class StaveCommandError extends Schema.TaggedErrorClass<StaveCommandError>()(
  "StaveCommandError",
  {
    verb: Schema.String,
    code: Schema.String,
    message: Schema.String,
  },
) {}
