import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ForwardCompatibleOptional,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
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

export const StavePendingCleanup = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  spaceId: Schema.NullOr(Schema.String),
  manifestCreatedAt: Schema.NullOr(Schema.String),
  disposition: Schema.String,
  refusalCode: Schema.NullOr(Schema.String),
  refusalMessage: Schema.NullOr(Schema.String),
  scheduledAt: Schema.NullOr(IsoDateTime),
});
export type StavePendingCleanup = typeof StavePendingCleanup.Type;

/** Adapter configuration support; this is not a report of an active MCP connection. */
export const StaveMemoryWiringProvider = Schema.Struct({
  provider: Schema.String,
  supported: Schema.Boolean,
  limitation: Schema.optionalKey(Schema.String),
});
export type StaveMemoryWiringProvider = typeof StaveMemoryWiringProvider.Type;
export const StaveFeatureCommand = Schema.Struct({
  verb: Schema.String,
  available: Schema.Boolean,
  flags: Schema.Array(Schema.String),
});
export type StaveFeatureCommand = typeof StaveFeatureCommand.Type;
export const StaveFeatures = Schema.Struct({
  source: Schema.Literals(["bundled", "help"]),
  commands: Schema.Array(StaveFeatureCommand),
  /** Conservative UI gate: an operation is listed when any supported option is unavailable. */
  unsupportedOperations: Schema.Array(Schema.String),
});
export type StaveFeatures = typeof StaveFeatures.Type;
export const StaveMemoryWiringStatus = Schema.Struct({
  state: ForwardCompatibleOptional(Schema.Literals(["absent", "configured", "unavailable"])),
  code: Schema.optionalKey(Schema.String),
});
export type StaveMemoryWiringStatus = typeof StaveMemoryWiringStatus.Type;

export const StaveStatus = Schema.Struct({
  features: Schema.optionalKey(StaveFeatures),
  diagnostics: Schema.optionalKey(Schema.Array(StaveStatusFailure)),
  memoryWiringProviders: Schema.optionalKey(Schema.Array(StaveMemoryWiringProvider)),
  /** The binary the server would run, or null with `runnableError` set. */
  runnable: Schema.NullOr(StaveBinaryStatus),
  runnableError: Schema.NullOr(StaveStatusFailure),
  configPath: Schema.String,
  configExists: Schema.Boolean,
  roots: Schema.NullOr(StaveRootsStatus),
  marmot: StaveMarmotStatus,
  lastFailure: Schema.NullOr(StaveLastFailure),
  pendingCleanups: Schema.Array(StavePendingCleanup),
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

export const StaveSagaMembership = Schema.Struct({
  sagaId: Schema.String,
  sagaRoot: Schema.String,
  dependentEdges: Schema.Array(Schema.Struct({ memberId: Schema.String, after: Schema.String })),
});
export type StaveSagaMembership = typeof StaveSagaMembership.Type;

export const StaveSpaceStatus = Schema.Struct({
  memoryWiring: Schema.optionalKey(StaveMemoryWiringStatus),
  sagaMembership: Schema.optional(Schema.NullOr(StaveSagaMembership)),
  membershipUnknown: Schema.optional(Schema.Boolean),
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

// ── Stave operations (Phase 3) ────────────────────────────────
// `stave.runOperation` takes ONE discriminated payload instead of a verb per
// RPC (deviation 1). Every variant is fully typed: ids are checked against the
// Stave name charset, modes and memory fates are closed literal sets, and no
// argv passes through. Space-scoped variants name the space by the Lecturn
// project's `workspaceRoot` (the server resolves the manifest there), the
// create verbs by the id being created.

/** Mirrors `STAVE_NAME_PATTERN` in `@t3tools/shared/stave`; contracts cannot
    depend on shared. */
const STAVE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A space, saga, repo or member id in Stave's charset. */
export const StaveName = TrimmedNonEmptyString.check(Schema.isPattern(STAVE_NAME_PATTERN));
export type StaveName = typeof StaveName.Type;

/** `keep` leaves owned memory alone, `contribute` proposes it upstream then
    keeps it; archive never destroys. */
export const StaveArchiveMemoryFate = Schema.Literals(["keep", "contribute"]);
export type StaveArchiveMemoryFate = typeof StaveArchiveMemoryFate.Type;

export const StaveDestroyMemoryFate = Schema.Literals(["keep", "destroy", "contribute"]);
export type StaveDestroyMemoryFate = typeof StaveDestroyMemoryFate.Type;

export const StaveDetachMemoryFate = Schema.Literals(["keep", "destroy"]);
export type StaveDetachMemoryFate = typeof StaveDetachMemoryFate.Type;

/** An editable worktree to create: `base` may be `space:<id>` to stack on that
    space's branch. */
export const StaveEditSpec = Schema.Struct({
  repo: StaveName,
  base: Schema.optional(TrimmedNonEmptyString),
});
export type StaveEditSpec = typeof StaveEditSpec.Type;

/** A read-only reference checkout to create, pinned to `ref` when given. */
export const StaveReferenceSpec = Schema.Struct({
  repo: StaveName,
  ref: Schema.optional(TrimmedNonEmptyString),
});
export type StaveReferenceSpec = typeof StaveReferenceSpec.Type;

/** Stave's `--memory [provider:]<spec>`; `.` is a fresh task store. */
export const StaveMemorySpec = Schema.Struct({
  spec: TrimmedNonEmptyString,
});
export type StaveMemorySpec = typeof StaveMemorySpec.Type;

const SpaceScoped = Schema.Struct({
  /** Root of the Lecturn project that carries the space's `.stave.yaml`. */
  workspaceRoot: TrimmedNonEmptyString,
  expectedManifestCreatedAt: Schema.optional(IsoDateTime),
});

export const StaveCreateSpaceOperation = Schema.Struct({
  kind: Schema.Literal("createSpace"),
  spaceId: StaveName,
  /** Title of the Lecturn project created on success; defaults to the id. */
  title: Schema.optional(TrimmedNonEmptyString),
  /** Stave space kind (ticket, spike, audit, ...); `kind` is the discriminator. */
  spaceKind: Schema.optional(TrimmedNonEmptyString),
  /** Spec pasted in the wizard; the server writes it to a file for `--spec`. */
  specText: Schema.optional(Schema.String),
  /** Spec file or directory on the server, copied into the space. */
  specPath: Schema.optional(TrimmedNonEmptyString),
  edits: Schema.Array(StaveEditSpec),
  references: Schema.Array(StaveReferenceSpec),
  memory: Schema.Array(StaveMemorySpec),
  /** Enrol the new space in this saga. */
  saga: Schema.optional(StaveName),
  /** Member ids the new space lands behind (requires `saga`). */
  after: Schema.Array(StaveName),
  /** Also add reference worktrees for the edited repos' strong learned tethers. */
  common: Schema.Boolean,
  includeWeak: Schema.Boolean,
  noLearn: Schema.Boolean,
});
export type StaveCreateSpaceOperation = typeof StaveCreateSpaceOperation.Type;

export const StaveRegisterRepoOperation = Schema.Struct({
  kind: Schema.Literal("registerRepo"),
  name: StaveName,
  url: TrimmedNonEmptyString,
  /** Reuse a bare cache already at the derived path (refused with `cache_exists` otherwise). */
  adopt: Schema.Boolean,
});
export type StaveRegisterRepoOperation = typeof StaveRegisterRepoOperation.Type;

export const StaveAddRepoOperation = Schema.Struct({
  kind: Schema.Literal("addRepo"),
  ...SpaceScoped.fields,
  repo: StaveName,
  mode: StaveRepoMode,
  /** Base branch/ref for edit repos (or `space:<id>`), ref for reference repos. */
  base: Schema.optional(TrimmedNonEmptyString),
  /** Branch name for editable repos. */
  branch: Schema.optional(TrimmedNonEmptyString),
  noFetch: Schema.Boolean,
  /** Resolve an added reference repo into a read-only memory link. */
  linkMemory: Schema.Boolean,
});
export type StaveAddRepoOperation = typeof StaveAddRepoOperation.Type;

export const StaveRemoveRepoOperation = Schema.Struct({
  kind: Schema.Literal("removeRepo"),
  ...SpaceScoped.fields,
  repo: StaveName,
  /** Required by Stave when the repo is present in both modes (`repo_mode_ambiguous`). */
  mode: Schema.optional(StaveRepoMode),
  /** Remove even when the edit worktree is dirty or other spaces stack on its branch. */
  force: Schema.Boolean,
});
export type StaveRemoveRepoOperation = typeof StaveRemoveRepoOperation.Type;

export const StaveSyncSpaceOperation = Schema.Struct({
  kind: Schema.Literal("syncSpace"),
  ...SpaceScoped.fields,
  referencesOnly: Schema.Boolean,
});
export type StaveSyncSpaceOperation = typeof StaveSyncSpaceOperation.Type;

export const StaveRetargetOperation = Schema.Struct({
  kind: Schema.Literal("retarget"),
  ...SpaceScoped.fields,
  repo: StaveName,
  /** New base ref; may be `space:<id>`. */
  base: TrimmedNonEmptyString,
});
export type StaveRetargetOperation = typeof StaveRetargetOperation.Type;

export const StaveArchiveSpaceOperation = Schema.Struct({
  kind: Schema.Literal("archiveSpace"),
  ...SpaceScoped.fields,
  force: Schema.Boolean,
  memory: StaveArchiveMemoryFate,
});
export type StaveArchiveSpaceOperation = typeof StaveArchiveSpaceOperation.Type;

export const StaveDestroySpaceOperation = Schema.Struct({
  kind: Schema.Literal("destroySpace"),
  ...SpaceScoped.fields,
  force: Schema.Boolean,
  memory: StaveDestroyMemoryFate,
  /** The manifest `createdAt` the caller saw; the server refuses when the
      space on disk carries another stamp (deviation 26). */
  expectedManifestCreatedAt: Schema.optional(IsoDateTime),
  sagaRemoveConfirmed: Schema.optional(Schema.Boolean),
});
export type StaveDestroySpaceOperation = typeof StaveDestroySpaceOperation.Type;

export const StaveRestoreSpaceOperation = Schema.Struct({
  kind: Schema.Literal("restoreSpace"),
  ...SpaceScoped.fields,
  /** The `.archive/` entry to restore. */
  from: TrimmedNonEmptyString,
});
export type StaveRestoreSpaceOperation = typeof StaveRestoreSpaceOperation.Type;

/** The wizard's explicit "Remove partial space" after a failed create: a
    destroy bound to the manifest stamp that create produced. */
export const StaveRemovePartialSpaceOperation = Schema.Struct({
  kind: Schema.Literal("removePartialSpace"),
  spaceId: StaveName,
  expectedManifestCreatedAt: IsoDateTime,
  sagaRemoveConfirmed: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
});
export type StaveRemovePartialSpaceOperation = typeof StaveRemovePartialSpaceOperation.Type;

export const StaveSetupOperation = Schema.Struct({
  kind: Schema.Literal("setup"),
  /** Rewrite an existing config file (refused with `config_exists` otherwise). */
  force: Schema.Boolean,
});
export type StaveSetupOperation = typeof StaveSetupOperation.Type;

export const StaveMemoryAttachOperation = Schema.Struct({
  kind: Schema.Literal("memoryAttach"),
  ...SpaceScoped.fields,
  specs: Schema.Array(StaveMemorySpec),
});
export type StaveMemoryAttachOperation = typeof StaveMemoryAttachOperation.Type;

export const StaveMemoryDetachOperation = Schema.Struct({
  kind: Schema.Literal("memoryDetach"),
  ...SpaceScoped.fields,
  /** Attachment alias; Stave detaches `default` when omitted. */
  alias: Schema.optional(TrimmedNonEmptyString),
  fate: StaveDetachMemoryFate,
});
export type StaveMemoryDetachOperation = typeof StaveMemoryDetachOperation.Type;

export const StaveCreateSagaOperation = Schema.Struct({
  kind: Schema.Literal("createSaga"),
  sagaId: StaveName,
  title: Schema.optional(TrimmedNonEmptyString),
  specText: Schema.optional(Schema.String),
  references: Schema.Array(StaveReferenceSpec),
  memory: Schema.Array(StaveMemorySpec),
});
export type StaveCreateSagaOperation = typeof StaveCreateSagaOperation.Type;

const SagaScoped = Schema.Struct({
  /** Root of the Lecturn project that carries the saga space's `.stave.yaml`. */
  sagaRoot: TrimmedNonEmptyString,
  expectedManifestCreatedAt: Schema.optionalKey(IsoDateTime),
});

export const StaveSagaAddOperation = Schema.Struct({
  kind: Schema.Literal("sagaAdd"),
  ...SagaScoped.fields,
  memberRoot: TrimmedNonEmptyString,
  expectedMemberCreatedAt: Schema.optionalKey(IsoDateTime),
  /** Member ids this space lands behind. */
  after: Schema.Array(StaveName),
  /** Reset the member's after edges before applying `after`. */
  clearAfter: Schema.Boolean,
});
export type StaveSagaAddOperation = typeof StaveSagaAddOperation.Type;

export const StaveSagaRemoveOperation = Schema.Struct({
  kind: Schema.Literal("sagaRemove"),
  ...SagaScoped.fields,
  memberRoot: TrimmedNonEmptyString,
  expectedMemberCreatedAt: Schema.optionalKey(IsoDateTime),
});
export type StaveSagaRemoveOperation = typeof StaveSagaRemoveOperation.Type;

export const StaveSagaSyncOperation = Schema.Struct({
  kind: Schema.Literal("sagaSync"),
  ...SagaScoped.fields,
});
export type StaveSagaSyncOperation = typeof StaveSagaSyncOperation.Type;

export const StaveSagaArchiveOperation = Schema.Struct({
  kind: Schema.Literal("sagaArchive"),
  ...SagaScoped.fields,
  force: Schema.Boolean,
  memory: StaveArchiveMemoryFate,
});
export type StaveSagaArchiveOperation = typeof StaveSagaArchiveOperation.Type;

export const StaveSagaDestroyOperation = Schema.Struct({
  kind: Schema.Literal("sagaDestroy"),
  ...SagaScoped.fields,
  force: Schema.Boolean,
  memory: StaveDestroyMemoryFate,
});
export type StaveSagaDestroyOperation = typeof StaveSagaDestroyOperation.Type;

/** Durable cleanup controls share operation progress and confirmation with disk mutations. */
export const StaveLifecycleActionOperation = Schema.Struct({
  kind: Schema.Literal("lifecycleAction"),
  projectId: ProjectId,
  ...SpaceScoped.fields,
  action: Schema.Literals(["keep", "retry", "archiveNow", "dismiss"]),
  /** Required for retry so a settings change cannot change the reviewed disk verb. */
  target: Schema.optional(Schema.Literals(["archive", "destroy"])),
  force: Schema.Boolean,
  memory: StaveDestroyMemoryFate,
  sagaRemoveConfirmed: Schema.optional(Schema.Boolean),
});
export type StaveLifecycleActionOperation = typeof StaveLifecycleActionOperation.Type;

export const StaveOperation = Schema.Union([
  StaveLifecycleActionOperation,
  StaveCreateSpaceOperation,
  StaveRegisterRepoOperation,
  StaveAddRepoOperation,
  StaveRemoveRepoOperation,
  StaveSyncSpaceOperation,
  StaveRetargetOperation,
  StaveArchiveSpaceOperation,
  StaveDestroySpaceOperation,
  StaveRestoreSpaceOperation,
  StaveRemovePartialSpaceOperation,
  StaveSetupOperation,
  StaveMemoryAttachOperation,
  StaveMemoryDetachOperation,
  StaveCreateSagaOperation,
  StaveSagaAddOperation,
  StaveSagaRemoveOperation,
  StaveSagaSyncOperation,
  StaveSagaArchiveOperation,
  StaveSagaDestroyOperation,
]);
export type StaveOperation = typeof StaveOperation.Type;
export type StaveOperationKind = StaveOperation["kind"];

// ── Stave operation results ───────────────────────────────────
// camelCase wire shapes of Stave's `--json` success payloads (deviation 4),
// as the server's staveJson decoders normalise them: nil slices are `[]`,
// closed string sets read unknown members as `"unknown"`.

/** A closed string set that reads any member this build does not know as `fallback`. */
const ForwardCompatibleLiteral = <
  const Literals extends ReadonlyArray<string>,
  const Fallback extends string,
>(
  literals: Literals,
  fallback: Fallback,
) => {
  const known: ReadonlySet<string> = new Set(literals);
  const target = Schema.Union([Schema.Literals(literals), Schema.Literal(fallback)]);
  type Target = Literals[number] | Fallback;
  return Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transform<Target, string>({
        decode: (raw) => (known.has(raw) ? (raw as Literals[number]) : fallback),
        encode: (value) => value,
      }),
    ),
  );
};

const Notes = Schema.Array(Schema.String);

/** The fate that applied to a memory store on archive/destroy/detach. */
export const StaveMemoryFate = ForwardCompatibleLiteral(
  ["keep", "contribute", "destroy"],
  "unknown",
);
export type StaveMemoryFate = typeof StaveMemoryFate.Type;

export const StaveManifestRepo = Schema.Struct({
  name: Schema.String,
  mode: StaveSpaceStatusRepoMode,
  path: Schema.String,
  base: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  bareRepoPath: Schema.String,
});
export type StaveManifestRepo = typeof StaveManifestRepo.Type;

export const StaveSagaPr = Schema.Struct({
  repo: Schema.String,
  number: Schema.Number,
});
export type StaveSagaPr = typeof StaveSagaPr.Type;

export const StaveSagaMember = Schema.Struct({
  id: Schema.String,
  after: Schema.Array(Schema.String),
  /** Stamp of the member manifest when it was enrolled. */
  createdAt: Schema.optionalKey(IsoDateTime),
  prs: Schema.Array(StaveSagaPr),
});
export type StaveSagaMember = typeof StaveSagaMember.Type;

/** The `.stave.yaml` a mutation left behind, as Stave reports it. */
export const StaveManifest = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  id: Schema.String,
  kind: Schema.optionalKey(Schema.String),
  createdAt: IsoDateTime,
  specPath: Schema.optionalKey(Schema.String),
  repos: Schema.Array(StaveManifestRepo),
  memories: Schema.Array(StaveMemoryEntry),
  /** Only saga spaces carry a roster. */
  saga: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ members: Schema.Array(StaveSagaMember) })),
  ),
});
export type StaveManifest = typeof StaveManifest.Type;

/** `space create|add|remove|restore|retarget`. */
export const StaveSpaceMutationResult = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifest,
  notes: Notes,
});
export type StaveSpaceMutationResult = typeof StaveSpaceMutationResult.Type;

/** `createSpace` ends with the Lecturn project created server-side; clients
    wait for `snapshotSequence >= sequence` before opening it (deviation 26). */
export const StaveCreateSpaceResult = Schema.Struct({
  ...StaveSpaceMutationResult.fields,
  projectId: ProjectId,
  sequence: NonNegativeInt,
});
export type StaveCreateSpaceResult = typeof StaveCreateSpaceResult.Type;

export const StaveArchiveResult = Schema.Struct({
  spaceId: Schema.String,
  archivedPath: Schema.String,
  memory: StaveMemoryFate,
  notes: Notes,
});
export type StaveArchiveResult = typeof StaveArchiveResult.Type;

export const StaveDestroyResult = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  destroyed: Schema.Boolean,
  memory: StaveMemoryFate,
  notes: Notes,
});
export type StaveDestroyResult = typeof StaveDestroyResult.Type;

export const StaveSyncAction = ForwardCompatibleLiteral(
  ["fetched", "updated", "skipped", "drift-reported"],
  "unknown",
);
export type StaveSyncAction = typeof StaveSyncAction.Type;

/** One per-repo row of `space sync` / `saga sync`. */
export const StaveSyncRepoRow = Schema.Struct({
  name: Schema.String,
  mode: StaveSpaceStatusRepoMode,
  action: StaveSyncAction,
  ahead: Schema.Number,
  behind: Schema.Number,
  note: Schema.optionalKey(Schema.String),
});
export type StaveSyncRepoRow = typeof StaveSyncRepoRow.Type;

export const StaveSyncReport = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifest,
  repos: Schema.Array(StaveSyncRepoRow),
  notes: Notes,
});
export type StaveSyncReport = typeof StaveSyncReport.Type;

export const StaveRegisterRepoResult = Schema.Struct({
  name: Schema.String,
  /** Redacted by Stave when it looks like a secret. */
  url: Schema.String,
  bareRepoPath: Schema.String,
  defaultBranch: Schema.optionalKey(Schema.String),
  adopted: Schema.Boolean,
  notes: Notes,
});
export type StaveRegisterRepoResult = typeof StaveRegisterRepoResult.Type;

export const StaveSetupResult = Schema.Struct({
  configPath: Schema.String,
  root: Schema.String,
  bareReposDir: Schema.String,
  agentWorkDir: Schema.String,
  created: Schema.Array(Schema.String),
  existed: Schema.Array(Schema.String),
});
export type StaveSetupResult = typeof StaveSetupResult.Type;

export const StaveMemoryLinkedRow = Schema.Struct({
  reference: Schema.String,
  target: Schema.optionalKey(Schema.String),
  kind: Schema.String,
  resolvedVia: Schema.optionalKey(Schema.String),
});
export type StaveMemoryLinkedRow = typeof StaveMemoryLinkedRow.Type;

export const StaveMemoryAttachedRow = Schema.Struct({
  ...StaveMemoryEntry.fields,
  linked: Schema.Array(StaveMemoryLinkedRow),
});
export type StaveMemoryAttachedRow = typeof StaveMemoryAttachedRow.Type;

export const StaveMemoryAttachResult = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifest,
  attachments: Schema.Array(StaveMemoryAttachedRow),
  notes: Notes,
});
export type StaveMemoryAttachResult = typeof StaveMemoryAttachResult.Type;

export const StaveMemoryDetachedRow = Schema.Struct({
  ...StaveMemoryEntry.fields,
  /** The fate that applied (an unowned store is always kept). */
  fate: StaveMemoryFate,
});
export type StaveMemoryDetachedRow = typeof StaveMemoryDetachedRow.Type;

export const StaveMemoryDetachResult = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifest,
  detached: Schema.Array(StaveMemoryDetachedRow),
  notes: Notes,
});
export type StaveMemoryDetachResult = typeof StaveMemoryDetachResult.Type;

/** `saga create|add|remove`. */
export const StaveSagaMutationResult = Schema.Struct({
  sagaId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifest,
  notes: Notes,
});
export type StaveSagaMutationResult = typeof StaveSagaMutationResult.Type;
export const StaveSagaCreateResult = Schema.Struct({
  ...StaveSagaMutationResult.fields,
  projectId: ProjectId,
  sequence: NonNegativeInt,
});
export type StaveSagaCreateResult = typeof StaveSagaCreateResult.Type;

export const StaveSagaTeardownAction = ForwardCompatibleLiteral(
  ["archived", "destroyed"],
  "unknown",
);
export type StaveSagaTeardownAction = typeof StaveSagaTeardownAction.Type;

export const StaveSagaMemberOutcome = ForwardCompatibleLiteral(
  ["archived", "destroyed", "skipped"],
  "unknown",
);
export type StaveSagaMemberOutcome = typeof StaveSagaMemberOutcome.Type;

/** One member's outcome of `saga archive|destroy`, in teardown order (v0.4). */
export const StaveSagaMemberTeardownRow = Schema.Struct({
  id: Schema.String,
  action: StaveSagaMemberOutcome,
  note: Schema.optionalKey(Schema.String),
  /** The member's live root before teardown. */
  path: Schema.String,
  /** Archive destination, or the existing archive of a skipped member. */
  archivedPath: Schema.optionalKey(Schema.String),
});
export type StaveSagaMemberTeardownRow = typeof StaveSagaMemberTeardownRow.Type;

export const StaveSagaLifecycleResult = Schema.Struct({
  sagaId: Schema.String,
  action: StaveSagaTeardownAction,
  memory: StaveMemoryFate,
  members: Schema.Array(StaveSagaMemberTeardownRow),
  notes: Notes,
  /** The saga space's own live root before teardown. */
  sagaPath: Schema.String,
  /** The saga space's `.archive/` destination (archive only). */
  sagaArchivedPath: Schema.optionalKey(Schema.String),
});
export type StaveSagaLifecycleResult = typeof StaveSagaLifecycleResult.Type;

export const StaveSagaMemberState = ForwardCompatibleLiteral(
  ["live", "archived", "missing", "corrupt"],
  "unknown",
);
export type StaveSagaMemberState = typeof StaveSagaMemberState.Type;

export const StaveSagaBaseHealth = ForwardCompatibleLiteral(
  ["ok", "merged", "missing", "owner_archived"],
  "unknown",
);
export const StaveSagaMergedVia = ForwardCompatibleLiteral(["ancestry", "pr"], "unknown");
export const StaveSagaRepoStatus = Schema.Struct({
  name: Schema.String,
  branch: Schema.String,
  base: Schema.String,
  ahead: Schema.Number,
  behind: Schema.Number,
  baseHealth: StaveSagaBaseHealth,
  mergedVia: Schema.optionalKey(StaveSagaMergedVia),
  note: Schema.optionalKey(Schema.String),
});
export type StaveSagaRepoStatus = typeof StaveSagaRepoStatus.Type;
export const StaveSagaPrStatus = Schema.Struct({
  repo: Schema.String,
  number: Schema.Number,
  state: Schema.optionalKey(Schema.String),
  mergedAt: Schema.optionalKey(Schema.String),
  baseRefName: Schema.optionalKey(Schema.String),
});
export type StaveSagaPrStatus = typeof StaveSagaPrStatus.Type;
export const StaveSagaMemberStatus = Schema.Struct({
  id: Schema.String,
  after: Schema.Array(Schema.String),
  state: StaveSagaMemberState,
  error: Schema.optionalKey(Schema.String),
  dirty: Schema.Boolean,
  repos: Schema.Array(StaveSagaRepoStatus),
  prs: Schema.Array(StaveSagaPrStatus),
});
export type StaveSagaMemberStatus = typeof StaveSagaMemberStatus.Type;
export const StaveSagaNote = Schema.Struct({
  kind: ForwardCompatibleLiteral(["degraded", "suggestion"], "unknown"),
  member: Schema.optionalKey(Schema.String),
  text: Schema.String,
});
export type StaveSagaNote = typeof StaveSagaNote.Type;
/** Members retain the CLI's topological order. */
export const StaveSagaStatus = Schema.Struct({
  sagaId: Schema.String,
  members: Schema.Array(StaveSagaMemberStatus),
  notes: Schema.Array(StaveSagaNote),
});
export type StaveSagaStatus = typeof StaveSagaStatus.Type;
export const StaveSagaStatusInput = Schema.Struct({ sagaRoot: TrimmedNonEmptyString });
export type StaveSagaStatusInput = typeof StaveSagaStatusInput.Type;

export const StaveSagaSyncMemberRow = Schema.Struct({
  id: Schema.String,
  state: StaveSagaMemberState,
  repos: Schema.Array(StaveSyncRepoRow),
  /** Why a non-live member was skipped. */
  note: Schema.optionalKey(Schema.String),
});
export type StaveSagaSyncMemberRow = typeof StaveSagaSyncMemberRow.Type;

export const StaveSagaSyncReport = Schema.Struct({
  sagaId: Schema.String,
  spacePath: Schema.String,
  members: Schema.Array(StaveSagaSyncMemberRow),
  /** The saga space's own reference rows. */
  repos: Schema.Array(StaveSyncRepoRow),
  notes: Notes,
});
export type StaveSagaSyncReport = typeof StaveSagaSyncReport.Type;

/** `--dry-run --json`: the steps Stave would take, one line each. */
export const StaveDryRunPlan = Schema.Struct({
  dryRun: Schema.Literal(true),
  plan: Schema.Array(Schema.String),
});
export type StaveDryRunPlan = typeof StaveDryRunPlan.Type;

const operationResult = <Kind extends StaveOperationKind, Result extends Schema.Top>(
  kind: Kind,
  result: Result,
) => Schema.Struct({ kind: Schema.Literal(kind), result });

/** Terminal pairing of an operation kind with its result schema (deviation 2). */
export const StaveOperationResult = Schema.Union([
  operationResult(
    "lifecycleAction",
    Schema.Struct({ projectId: ProjectId, disposition: Schema.String }),
  ),
  operationResult("createSpace", StaveCreateSpaceResult),
  operationResult("registerRepo", StaveRegisterRepoResult),
  operationResult("addRepo", StaveSpaceMutationResult),
  operationResult("removeRepo", StaveSpaceMutationResult),
  operationResult("syncSpace", StaveSyncReport),
  operationResult("retarget", StaveSpaceMutationResult),
  operationResult("archiveSpace", StaveArchiveResult),
  operationResult("destroySpace", StaveDestroyResult),
  operationResult("restoreSpace", StaveSpaceMutationResult),
  operationResult("removePartialSpace", StaveDestroyResult),
  operationResult("setup", StaveSetupResult),
  operationResult("memoryAttach", StaveMemoryAttachResult),
  operationResult("memoryDetach", StaveMemoryDetachResult),
  operationResult("createSaga", StaveSagaCreateResult),
  operationResult("sagaAdd", StaveSagaMutationResult),
  operationResult("sagaRemove", StaveSagaMutationResult),
  operationResult("sagaSync", StaveSagaSyncReport),
  operationResult("sagaArchive", StaveSagaLifecycleResult),
  operationResult("sagaDestroy", StaveSagaLifecycleResult),
]);
export type StaveOperationResult = typeof StaveOperationResult.Type;

// ── Stave operation errors ────────────────────────────────────

/** Codes Stave itself emits (errcode.go + errcode_repos.go, v0.4). */
export const STAVE_CLI_ERROR_CODES = [
  "dirty_worktrees",
  "dependent_spaces",
  "memory_in_use",
  "space_exists",
  "space_not_found",
  "repo_not_found",
  "repo_not_in_space",
  "repo_already_in_space",
  "repo_mode_ambiguous",
  "saga_space",
  "saga_member",
  "invalid_name",
  "branch_missing",
  "ambiguous_archive",
  "archive_not_found",
  "invalid_arguments",
  "unknown",
  "repo_exists",
  "clone_failed",
  "cache_exists",
  "config_exists",
] as const;

/** Codes Lecturn synthesises around the spawn and the operation registry. */
export const STAVE_HOST_ERROR_CODES = [
  "unsupported_feature",
  "binary_missing",
  "not_setup",
  "disabled",
  "non_json_output",
  "spawn_failed",
  "timeout",
  "nested_project",
  "archived_project",
  "incarnation_mismatch",
  "membership_unknown",
  "unreadable",
  "space_transitioning",
  "turn_running",
  "stave_worktree_forbidden",
  /** The operation id is unknown, or its tombstone has been reaped. */
  "operation_expired",
] as const;

export const STAVE_OPERATION_ERROR_CODES = [
  ...STAVE_CLI_ERROR_CODES,
  ...STAVE_HOST_ERROR_CODES,
] as const;

/** Forward-compatible: a code this build does not know decodes as `unknown`. */
export const StaveOperationErrorCode = ForwardCompatibleLiteral(
  STAVE_OPERATION_ERROR_CODES,
  "unknown",
);
export type StaveOperationErrorCode = typeof StaveOperationErrorCode.Type;

/** Why an operation failed: Stave's error envelope, or a Lecturn pre-flight refusal. */
export const StaveOperationError = Schema.Struct({
  code: StaveOperationErrorCode,
  message: Schema.String,
  /** Stave's structured `details` (repo lists, candidates, saga teardown progress) or null. */
  details: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  /** The Stave verb that failed, e.g. `space create`; absent for pre-flight refusals. */
  verb: Schema.optionalKey(Schema.String),
});
export type StaveOperationError = typeof StaveOperationError.Type;

/** `runOperation`/`observeOperation` refused before any event: the id is
    unknown or reaped (`operation_expired`), or it is already running with a
    different payload (`invalid_arguments`). */
export class StaveOperationRejectedError extends Schema.TaggedErrorClass<StaveOperationRejectedError>()(
  "StaveOperationRejectedError",
  {
    operationId: Schema.String,
    code: Schema.Literals(["operation_expired", "invalid_arguments"]),
    message: Schema.String,
  },
) {}

// ── Stave progress events ─────────────────────────────────────
// Streamed by `stave.runOperation` and `stave.observeOperation`. Events are
// keyed on the client-supplied `operationId` and numbered by a per-operation
// monotonic `sequence`, so a client that reattaches passes the last sequence
// it saw and receives only what it missed (deviation 26).

const StaveProgressBase = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  sequence: NonNegativeInt,
});

/** A step of the operation, one per Stave invocation it issues plus Lecturn's
    own `pre-flight` / `verify` / `project.create` steps. */
export const StaveOperationPhase = TrimmedNonEmptyString;
export type StaveOperationPhase = typeof StaveOperationPhase.Type;

/** `notes` and `plan` carry Stave's `--json` `notes[]` / `plan[]` lines;
    `stdout`/`stderr` carry raw lines from json-less verbs. */
export const StaveProgressOutputStream = Schema.Literals(["stdout", "stderr", "notes", "plan"]);
export type StaveProgressOutputStream = typeof StaveProgressOutputStream.Type;

export const StavePhaseStartedEvent = Schema.Struct({
  ...StaveProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: StaveOperationPhase,
  /** The `stave ...` command line this phase runs, for the progress view. */
  commandLine: Schema.optionalKey(Schema.String),
});
export type StavePhaseStartedEvent = typeof StavePhaseStartedEvent.Type;

export const StaveOutputEvent = Schema.Struct({
  ...StaveProgressBase.fields,
  kind: Schema.Literal("output"),
  phase: StaveOperationPhase,
  stream: StaveProgressOutputStream,
  text: Schema.String,
});
export type StaveOutputEvent = typeof StaveOutputEvent.Type;

export const StavePhaseFinishedEvent = Schema.Struct({
  ...StaveProgressBase.fields,
  kind: Schema.Literal("phase_finished"),
  phase: StaveOperationPhase,
  durationMs: NonNegativeInt,
});
export type StavePhaseFinishedEvent = typeof StavePhaseFinishedEvent.Type;

/** The requested `afterSequence` was evicted from the server's buffer; the
    client drops what it holds and replays from `earliestSequence`. */
export const StaveResetEvent = Schema.Struct({
  ...StaveProgressBase.fields,
  kind: Schema.Literal("reset"),
  earliestSequence: NonNegativeInt,
});
export type StaveResetEvent = typeof StaveResetEvent.Type;

export const StaveFinishedEvent = Schema.Struct({
  ...StaveProgressBase.fields,
  kind: Schema.Literal("finished"),
  result: StaveOperationResult,
});
export type StaveFinishedEvent = typeof StaveFinishedEvent.Type;

export const StaveFailedEvent = Schema.Struct({
  ...StaveProgressBase.fields,
  kind: Schema.Literal("failed"),
  error: StaveOperationError,
});
export type StaveFailedEvent = typeof StaveFailedEvent.Type;

export const StaveProgressEvent = Schema.Union([
  StavePhaseStartedEvent,
  StaveOutputEvent,
  StavePhaseFinishedEvent,
  StaveResetEvent,
  StaveFinishedEvent,
  StaveFailedEvent,
]);
export type StaveProgressEvent = typeof StaveProgressEvent.Type;

// ── Stave read DTOs ───────────────────────────────────────────

/** One `repos list` row: a registered bare-repo cache. */
export const StaveRepoRow = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  bareRepoPath: Schema.String,
  defaultBranch: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  tetherCount: Schema.Number,
});
export type StaveRepoRow = typeof StaveRepoRow.Type;

/**
 * One `space list` row. `id` is the DIRECTORY name (the `.archive/` basename
 * for archived rows); `logicalId` + `manifestCreatedAt` identify the space
 * incarnation (v0.4).
 */
export const StaveSpaceListRow = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  kind: Schema.optionalKey(Schema.String),
  /** Whole-second RFC3339; kept for compatibility. */
  createdAt: Schema.optionalKey(IsoDateTime),
  isSaga: Schema.Boolean,
  memberOf: Schema.optionalKey(Schema.String),
  repos: Schema.Array(Schema.Struct({ name: Schema.String, mode: StaveSpaceStatusRepoMode })),
  archived: Schema.Boolean,
  /** Manifest read error; such rows carry no manifest-derived fields. */
  error: Schema.optionalKey(Schema.String),
  logicalId: Schema.NullOr(Schema.String),
  archiveBasename: Schema.optionalKey(Schema.String),
  /** RFC3339Nano (UTC), equal to the stamp in `.stave.yaml`. */
  manifestCreatedAt: Schema.optionalKey(IsoDateTime),
  manifestVersion: Schema.Number,
  memories: Schema.Array(StaveMemoryEntry),
});
export type StaveSpaceListRow = typeof StaveSpaceListRow.Type;

export const StaveSagaListRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.optionalKey(Schema.String),
  isSaga: Schema.Boolean,
  members: Schema.Array(Schema.String),
  memberOf: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  path: Schema.String,
  logicalId: Schema.NullOr(Schema.String),
});
export type StaveSagaListRow = typeof StaveSagaListRow.Type;

/** One `memory providers` row. */
export const StaveMemoryProvider = Schema.Struct({
  name: Schema.String,
  binary: Schema.optionalKey(Schema.String),
  default: Schema.Boolean,
  available: Schema.Boolean,
  version: Schema.optionalKey(Schema.String),
  capabilities: Schema.Array(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type StaveMemoryProvider = typeof StaveMemoryProvider.Type;

// ── Stave RPC inputs ──────────────────────────────────────────

export const StaveListSpacesInput = Schema.Struct({
  includeArchived: Schema.Boolean,
});
export type StaveListSpacesInput = typeof StaveListSpacesInput.Type;

export const StaveDryRunInput = Schema.Struct({
  operation: StaveOperation,
});
export type StaveDryRunInput = typeof StaveDryRunInput.Type;

/** Start-or-attach: starts the operation when `operationId` is new, else
    replays events after `afterSequence` (default: from the beginning) as long
    as `operation` matches what is running. */
export const StaveRunOperationInput = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  afterSequence: Schema.optional(NonNegativeInt),
  operation: StaveOperation,
});
export type StaveRunOperationInput = typeof StaveRunOperationInput.Type;

export const StaveObserveOperationInput = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  afterSequence: Schema.optional(NonNegativeInt),
});
export type StaveObserveOperationInput = typeof StaveObserveOperationInput.Type;
