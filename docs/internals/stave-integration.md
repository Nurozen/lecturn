# Stave integration (fork)

> For maintainers. This page is fork-specific: it describes Lecturn's support for
> [Stave](https://github.com/Nurozen/stave) spaces, which upstream T3 Code does not have.
> Fork framing and release differences live in
> [docs/operations/lecturn-release.md](../operations/lecturn-release.md).

Status: in progress — Phase 2 (binary, settings, status)

## What a Stave space is to Lecturn

- **Project = space.** A Stave space is a Lecturn project whose `workspaceRoot` is the space
  root. Recognition is by manifest only: `<workspaceRoot>/.stave.yaml` exists and decodes.
- **No per-thread worktrees.** Every thread in a space runs in the space root. The worktree
  affordances upstream offers for ordinary projects are refused server-side and hidden on
  clients (see [StaveAdmission](#staveadmission) and [Client rules](#client-rules)).
- **The space root is not a git repository.** It is a directory of repo checkouts (worktrees
  Stave created) described by the manifest's `repos` list. Anything that needs a repository —
  git status, PR lookup, checkpoints, auto-pull — must target a repo inside the space, not the
  root.
- **Primary repo.** The first manifest entry with `mode: edit` is the space's primary repo. Its
  `path` (resolved against the space root when relative) becomes `primaryRepoPath` and its
  `branch` becomes `primaryBranch`. `mode: reference` entries are read-only context and are
  listed but not targeted.
- **Sagas** (`kind: saga`, or any `saga:` block) are recognised and flagged (`isSaga`), but their
  members are not projected yet — planned (Phase 5).

## `StaveWorkspaceReader`

`apps/server/src/stave/StaveWorkspaceReader.ts` (service `t3/stave/StaveWorkspaceReader`),
with the on-disk schema in `apps/server/src/stave/staveManifest.ts`.

- `load(root)` reads exactly `<root>/.stave.yaml`. There is no walk-up, so a project nested
  inside a space is not mistaken for the space. It never fails: a missing, unreadable, or
  invalid manifest resolves to `Option.none` with a debug log, so non-Stave projects pay one
  failed read per cache miss and never see a warning.
- **Manifest tolerance** (mirrors `references/stave/internal/space/manifest.go`, which loads
  legacy manifests): `version` 0, absent, 1, or 2 all decode; unknown keys are ignored; scalar
  fields are accepted as strings, numbers, booleans, or dates and stringified. Repo entries with
  an unknown `mode` or missing `name`/`path` are dropped rather than failing the manifest; the
  same applies to memory entries missing `name`/`provider`/`id`. A manifest with no usable `id`
  is treated as not a space.
- **Projection** (`mapManifestToProjectInfo`, pure): `spaceId`, `kind`, `createdAt` (only when
  parseable), `isSaga`, `repos`, `memories`, `primaryRepoPath`/`primaryBranch` from the first
  `mode: edit` entry, and `state`. `state` is `archived` when the root's parent directory is
  named `.archive` (Stave moves archived spaces to `<agentWorkDir>/.archive/<space>`), in which
  case `archiveBasename` is the root's basename; otherwise `live`. Optional keys are omitted,
  never set to `undefined`. `memberOf` is not populated — planned (Phase 5).
- `primaryRepositoryIdentity` is resolved through `RepositoryIdentityResolver` on
  `primaryRepoPath` after the pure projection and attached only when non-null.
- **Cache.** An `effect/Cache` keyed by root (capacity 512) with separate TTLs: 30s for a found
  manifest, 60s for a negative result (both overridable via `StaveWorkspaceReaderOptions`).
  `invalidate(root)` drops one entry so the next `load` re-reads disk; `invalidateAll()` drops
  everything. Lifecycle operations that mutate a space are expected to call `invalidate` — none
  exist yet (planned, Phase 3+).
- `layer` is the live reader (needs `FileSystem`, `Path`, `RepositoryIdentityResolver`; wired in
  `apps/server/src/server.ts` as `StaveWorkspaceReaderLayerLive`). `layerNoop` finds no manifest
  anywhere, for tests whose roots are never spaces.

## Derived `project.stave` / `notice`

Contracts: `packages/contracts/src/stave.ts` (`StaveProjectInfo`, `StaveProjectNotice`) and the
`stave`/`notice` fields on `OrchestrationProject` and `OrchestrationProjectShell` in
`packages/contracts/src/orchestration.ts`. Both fields are `Schema.optional(Schema.NullOr(...))`
so payloads from pre-Stave servers still decode; `null` means "not a Stave space". `state` and
`notice.kind` use `ForwardCompatibleOptional`, so a newer server's unknown literal decodes as
absent rather than failing the row.

- **Read-time, not stored.** Nothing about a space is written to the projection tables. The
  fields are derived when a project row is read, in
  `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`.
- **One base mapper.** `mapProjectRowBase` maps the stored columns; `mapProjectShellRow` is the
  single place `repositoryIdentity`, `stave`, and `notice` are attached, and `mapProjectRow`
  adds `deletedAt` on top. `notice` is always `null` in Phase 1; lifecycle notices
  (`archive_scheduled`, `refused`, `pending_cleanup`) are planned (Phase 4). The only producer
  that uses `mapProjectRowBase` directly is `getCommandReadModel`, the decider's view, which
  skips derived fields.
- **Outside the SQL transaction, batched.** `resolveDerivedFieldsForRoot` runs the identity
  resolver and the Stave reader together for one root; `resolveProjectDerivedFieldsForProjects`
  resolves once per unique `workspaceRoot` (concurrency 4) and keys the result back by project
  id, after the row query has returned. Deleted rows are skipped unless `includeDeleted` is set.
- **`RepositoryIdentityResolver` returns `null` for space roots**
  (`apps/server/src/project/RepositoryIdentityResolver.ts`): before consulting git it checks for
  `.stave.yaml` at the cwd. A space root must never take its primary repo's (or an ancestor
  repo's) identity, or the space would collapse into that repository's project group in the
  sidebar. The primary repo's own identity is still available as
  `stave.primaryRepositoryIdentity`.

Server consumers of the derived fields in Phase 1:

- `apps/server/src/vcs/VcsStatusBroadcaster.ts`: clients request status for
  `stave.primaryRepoPath`, which the exact-root project lookup cannot find, so the auto-pull
  policy falls back to a shell-snapshot scan by `primaryRepoPath`; auto-pull applies only to
  that path for a space, never to the root.
- `apps/server/src/serverRuntimeStartup.ts`: startup auto-pull skips Stave projects (the root is
  not a repo and edit branches have no upstream), logging `reason: "stave-space"`.

## `project.refresh` / `project.refreshed`

Defined in `packages/contracts/src/orchestration.ts`. `project.refresh` is a member of
`InternalOrchestrationCommand`, so it is server-only: the WebSocket and HTTP dispatch RPCs decode
`ClientOrchestrationCommand` and cannot carry it.

- **What it does.** `apps/server/src/orchestration/decider.ts` requires a live (non-deleted)
  project and emits `project.refreshed` with `{ projectId }` on the project aggregate
  (`commandToAggregateRef` in `Layers/OrchestrationEngine.ts` classifies it as `project`).
- **What it does not do.** The event carries no state. `projector.ts` returns the read model
  unchanged and `Layers/ProjectionPipeline.ts` writes nothing; the stored row is re-read as-is.
- **How it reaches clients.** `toShellStreamEvent` in `apps/server/src/ws.ts` handles
  `project.refreshed` alongside `project.created`/`project.meta-updated` via
  `projectUpsertOrRemove`, so shell subscribers receive a project upsert whose `stave`/`notice`
  were freshly derived (after an `invalidate`, from disk). This is the mechanism for pushing
  derived-state changes without a projection write.
- No production caller dispatches it yet; Stave lifecycle operations will — planned (Phase 3+).

## `StaveAdmission`

`apps/server/src/stave/StaveAdmission.ts` (service `t3/stave/StaveAdmission`), built on the
reader. `check(input)` succeeds or fails with a typed refusal; it never fails for a non-Stave
root.

- **Worktree rule (now).** `intentUsesWorktree` is pure: an intent uses a worktree when it is
  `vcs.createWorktree` or `pr.prepare`, when `prepareWorktree` is true, or when `worktreePath`
  is non-null. Only then is the manifest read; if the root is a space the check fails with
  `StaveWorktreeForbiddenError { projectRoot, intent, message }` (message
  `STAVE_WORKTREE_FORBIDDEN_MESSAGE`). Intents: `thread.create`, `thread.meta.update`,
  `thread.turn.start`, `thread.fork`, `vcs.createWorktree`, `pr.prepare`.
- **Lease/archived rules — planned (Phase 4).** `StaveArchivedProjectError` and
  `StaveSpaceTransitioningError` are reserved names; they will join the `StaveAdmissionError`
  union beside the worktree rule once the lifecycle table exists.
- `layer` is live (wired in `server.ts` over the live reader); `layerNoop` admits everything.

Where it is invoked:

| Path                          | File                                              | Intent(s)                                                  | Error surface                                                                |
| ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Normalizer (WS, HTTP, mobile) | `apps/server/src/orchestration/Normalizer.ts`     | `thread.create`, `thread.meta.update`, `thread.turn.start` | `OrchestrationDispatchCommandError` with the refusal as `cause`              |
| Fork materialization          | `apps/server/src/ws.ts` (`dispatchThreadFork`)    | `thread.fork`                                              | `OrchestrationDispatchCommandError` with the refusal as `cause`              |
| Git RPCs                      | `apps/server/src/ws.ts` (`admitStaveWorktreeRpc`) | `vcs.createWorktree`, `pr.prepare`                         | `GitCommandError` with `detail` = refusal message and the refusal as `cause` |

Details per path:

- **Normalizer.** `describeWorktreeIntent(command)` maps a client command to an intent, or
  `null` when it never binds a worktree (then neither admission nor the projection read
  happens): `thread.create` with non-null `worktreePath`; `thread.meta.update` setting a
  non-null `worktreePath`; `thread.turn.start` whose bootstrap creates a thread with a
  `worktreePath` or carries `prepareWorktree`. `enforceStaveWorktreeRule` resolves the project
  root from the command's project id, or via the thread shell when only a thread id is present,
  or from `bootstrap.prepareWorktree.projectCwd` as a fallback; unknown projects/threads are
  left to the decider's own error. On the HTTP transport (`apps/server/src/orchestration/http.ts`)
  every normalization failure collapses to `invalid_command`, so the typed refusal is only
  visible on the WebSocket path.
- **Fork.** Forks skip the normalizer and the materialized command inherits the source's
  `worktreePath` (`threadFork.ts`), so `dispatchThreadFork` checks `thread.fork` with that path:
  a Stave-owned source that still runs in a worktree cannot be forked.
- **Git RPCs.** `ws.gitPreparePullRequestThread` and `ws.vcsCreateWorktree` carry only a cwd, so
  the owning project is the active project at exactly that root
  (`getActiveProjectByWorkspaceRoot`); a primary-repo reverse lookup is a later phase. A cwd
  with no project passes.

Client rendering (`packages/client-runtime/src/errors/stave.ts`): `staveAdmissionErrorTag`
matches `_tag` first, then a wire `code` (`stave_worktree_forbidden`, `archived_project`,
`space_transitioning` — reserved for the HTTP envelope; no server path emits them yet), and
recurses one level into `error`/`cause` because dispatch errors nest the typed refusal.
`staveAdmissionErrorMessage` returns the readable text or `null` so callers fall back to their
usual message. Web consumers: `useThreadActions`, `useThreadActionMenu`, `useForkThread`,
`BranchToolbarBranchSelector`, `PullRequestThreadDialog`. Mobile:
`apps/mobile/src/state/use-selected-thread-git-actions.ts`.

## Talking to the `stave` binary

Everything below `apps/server/src/stave/` that touches the CLI is built once per server process
in `apps/server/src/server.ts` (`StaveBinaryLayerLive` → `StaveCliLayerLive` →
`StaveConfigReaderLayerLive` → `StaveRootsLayerLive`, merged into `StaveLayerLive`). Nothing here
runs a mutating verb yet; operations (create, add, archive, destroy, setup, memory, saga) are
planned (Phase 3+).

### `StaveBinary`

`apps/server/src/stave/StaveBinary.ts` (service `t3/stave/StaveBinary`) locates the executable
and reports which source supplied it: `{ path, source, version, commit }` with `source` one of
`settings | env | bootstrap | bundled | path`.

- **Resolution order.** `settings.stave.binaryPath` → `T3CODE_STAVE_PATH` → the desktop
  bootstrap envelope's `stavePath` (`ServerConfig.stavePath`; it never arrives as a CLI flag) →
  bundled candidates relative to the server module (`stave/<platformKey>/stave[.exe]`,
  `../stave/...`, and the dev fallback `../../dist/stave/...` where `fetch-stave` extracts) →
  `stave` on PATH via `resolveCommandPath`. Platform keys come from
  `packages/shared/src/stave.ts` (`STAVE_PLATFORM_KEYS`).
- **Settings are authoritative.** When `binaryPath` is set (after `~` expansion) it is the only
  candidate for `resolve`: a missing file fails `StaveBinaryNotFound { candidates: [path] }` and
  an existing file without the executable bit fails `StaveBinaryNotExecutable { path }`. There is
  no silent fallback to a different binary than the one the user named. The same executable-bit
  rule applies to every candidate except on Windows.
- **`resolve` vs `resolveRunnable`.** `resolve` is what `StaveCli` uses and includes the settings
  path. `resolveRunnable` walks the same list _without_ settings and answers "could Stave run on
  this machine at all" for `stave.getStatus` (deviation 5), so a bad user override never hides
  the bundled or PATH binary from the status line. Both fail with `StaveBinaryError`.
- **Version probe.** Each hit runs `stave version` (`STAVE_VERSION_PROBE_TIMEOUT` = 10s,
  `timeoutBehavior: "timedOutResult"`) and parses the three-line output
  (`stave v<semver>` / `commit:` / `date:`) with `parseStaveVersionOutput`; the `v` is stripped. A
  failed, timed-out, or unrecognised probe leaves `version`/`commit` null and does **not** fail
  resolution — a binary that cannot report its version is still runnable.
- **Memoisation.** Two `Ref`s: the runnable resolution, and the configured resolution keyed by
  the `binaryPath` string. Both are dropped by `invalidate` and on _every_ settings change
  (`settings.streamChanges`), because a settings save is also the natural "I installed it, look
  again" signal. `layerFixed(resolution)` answers without touching disk, for tests.

### `StaveCli`

`apps/server/src/stave/StaveCli.ts` (service `t3/stave/StaveCli`) is the **only** place the
server spawns `stave`. Every verb is a typed method (`version`, `configShow`, `reposList`,
`spaceList`, `spaceStatus`, `sagaList`, `sagaStatus`, `memoryProviders`, `memoryList`, and the
mutation methods `setup`, `reposAdd`, `spaceInit/Create/Add/Remove/Sync/Retarget/Archive/Restore/Destroy`,
`sagaCreate/Add/Remove/Sync/Archive/Destroy`, `memoryAttach/Detach`); there is no argv
passthrough.

- **Argv is built, never concatenated.** `buildStaveArgv.<verb>` is a pure `Result`: space,
  saga and repo names must satisfy `isValidStaveSpaceId` (Stave's own name rule); free-form
  values (URLs, refs, paths, provider options) must be non-empty, must not start with `-`, and
  must not contain control characters. A builder failure becomes
  `StaveError { code: "invalid_arguments" }` and nothing is spawned. Flags precede positionals
  because `space create` / `saga create` parse with interspersed flags off.
- **`--json` everywhere.** `STAVE_VERB_POLICY` records `kind: read | mutation` and
  `output: json | prose` per verb. On the shipped Stave every verb except `version` is `json`.
  Ordinary read verbs go straight to their `staveJson.ts` decoder; verbs that accept
  `--dry-run` decode either the real result or a `StaveDryRunPlan`, and a plan answered by a
  verb without `--dry-run` (`space init`) is a contract breach (`unreadable`). The plan's
  earlier `mixed` class (prose followed by a trailing JSON object) is gone: the current binary
  emits clean JSON on `memory attach --json`, so `mixed` handling was not built.
- **`--config`.** `staveGlobalArgs(settings.stave.configPath)` prefixes every call with
  `--config <path>` when the setting is non-empty, and nothing otherwise, so Stave's own default
  config location applies.
- **Spawn discipline** (deviation 7), all through `ProcessRunner`: `stdin: ""` (the pipe is
  written empty and closed at once, so an interactive prompt can never hang the server; an
  undefined stdin would stay an open pipe), `unsetEnv: ["STAVE_CD_FD"]` (Stave must never treat
  the server as its shell wrapper and write a chdir handoff to fd 3), `MARMOT_HOME` forwarded
  verbatim when the host process has it (`STAVE_PASSTHROUGH_ENV`), `timeout` of
  `STAVE_READ_TIMEOUT` (60s) for reads and `STAVE_MUTATION_TIMEOUT` (15 min) for mutations,
  `maxOutputBytes` 8 MiB with `outputMode: "truncate"` (never a failure). An optional
  `StaveStreamOptions.onLine` receives each stdout/stderr line for progress on long mutations.
- **Output policy → `StaveError`.** The exit status decides how stdout is read:
  - exit 0 → run the decoder. `not_json` → `non_json_output` (with `stdoutHead` in details);
    JSON that misses the contract → `unreadable`.
  - non-zero exit → `parseStaveErrorEnvelope(stdout)` looks for exactly one
    `{"error": {code, message, details?}}` object. Found → `StaveError` with that code
    (unknown codes normalise to `unknown`, the raw code kept in `details.rawCode`). Not found
    (cobra argument errors and the read verbs' service errors bypass Stave's envelope) →
    `non_json_output` whose message is the stderr tail.
  - spawn failures map before any output exists: `StaveBinary` failure or ENOENT →
    `binary_missing` (details carry the candidates or the path), `ProcessTimeoutError` →
    `timeout`, anything else → `spawn_failed`.

  Every `StaveError` carries `verb`, `exitCode` (null when the process never completed) and a
  2,000-char `stderrTail` for diagnostics.

- **Never round-trip URLs.** Stave redacts secret-looking values in its JSON (`repos list`,
  `config show`). Values read back from JSON are never turned into argv again; callers pass the
  original inputs.

`StaveError` (`apps/server/src/stave/StaveError.ts`) is the single failure type. `code` is a
closed literal union: the codes Stave emits (`STAVE_CLI_ERROR_CODES`, from
`references/stave/internal/space/errcode.go` and `errcode_repos.go`) plus the codes the server
synthesises (`STAVE_HOST_ERROR_CODES`: `binary_missing`, `not_setup`, `disabled`,
`non_json_output`, `spawn_failed`, `timeout`, `nested_project`, `archived_project`,
`incarnation_mismatch`, `membership_unknown`, `unreadable`, `operation_expired`). Several host
codes are reserved for lifecycle work — planned (Phase 3+).

### `StaveConfigReader` and `StaveRootsProvider`

`apps/server/src/stave/StaveConfigReader.ts` (service `t3/stave/StaveConfigReader`) answers
"where does Stave keep its things": `{ configPath, exists, root?, bareReposDir?, agentWorkDir?,
defaultBase?, repos[], memory?, source }`.

- **`config show` first.** When `StaveBinary.resolve` succeeds, `stave config show --json` is the
  source of truth because it applies the same defaulting every other verb does (deviation 21:
  Stave alone defines what "set up" means). `source` is `stave-config-show`.
- **Filesystem fallback.** When there is no binary or `config show` fails (older Stave, broken
  install), the reader parses the YAML itself and mirrors Stave's `ApplyDefaults`: root defaults
  to `~/stave`, `bareReposDir`/`agentWorkDir` derive from the root, `~` expands against the home
  directory, repo `name`/`bareRepoPath` default from the map key. Fields of the wrong type are
  ignored rather than failing. A missing or unreadable file reports `exists: false` with the
  defaults Stave would use. `source` is `fs-fallback`.
- The config path is `settings.stave.configPath` (`~`-expanded) or Stave's default
  `<home>/.config/stave/config.yaml`.
- **Never fails, never mutates.** `load` has no error channel and never runs `stave setup`.
- **Cache.** One snapshot, 15s TTL (`STAVE_CONFIG_CACHE_TTL`, overridable), dropped by
  `invalidate` and on every settings change (either `configPath` or `binaryPath` changes the
  answer). `layerFixed(snapshot)` for tests.

`StaveRootsProvider` (`apps/server/src/stave/StaveRoots.ts`) is the narrow view git needs:
`agentWorkDir` as `Option<string>`, `some` only when the config **exists** — a config that does
not exist yet has only defaults, and nothing lives under that directory. `layer` is built on the
reader; `layerNoop` answers none for hosts and tests without Stave; `layerFixed(dir)` pins one.

## Capability semantics

Three independent facts, not one (deviation 5):

| Fact      | Where                                          | Nature                                                   |
| --------- | ---------------------------------------------- | -------------------------------------------------------- |
| supported | `capabilities.stave: { protocolVersion }`      | static build fact; absent only when `T3CODE_STAVE=false` |
| runnable  | `stave.getStatus.runnable` (`resolveRunnable`) | live; re-probed per call, memoised until a settings save |
| enabled   | `settings.stave.enabled`                       | user choice; pushed live via `settingsUpdated`           |

- **supported.** `apps/server/src/environment/ServerEnvironment.ts` spreads
  `{ stave: { protocolVersion: STAVE_PROTOCOL_VERSION } }` into the descriptor's capabilities
  when `ServerConfig.staveEnabled` is true (`T3CODE_STAVE`, default on; also carried in the
  desktop/WSL bootstrap envelope). Nothing about binaries or settings feeds it, because there is
  no `environmentUpdated` push: a capability that depended on either would go stale across
  clients. Bump `STAVE_PROTOCOL_VERSION` when the CLI contract the server speaks changes.
- **Clients.** Configuration rows (Enable, status, Binary path, Config path, Set up) render
  whenever `capabilities.stave` is present, so a user can recover from "no binary". Feature UI
  (space actions, wizard, badges) renders only when
  `staveFeatureAvailable(config, status) = capability && settings.stave.enabled && status.runnable`
  (pure, in `client-runtime`).
- **Handlers enforce all three.** `T3CODE_STAVE=false` is the unbypassable kill switch: every
  `stave.*` RPC fails `StaveUnavailableError { reason: "disabled_by_server" }`, like thread
  forking. Space-scoped RPCs additionally require `settings.stave.enabled`
  (`disabled_in_settings`) and a runnable binary (`binary_missing`). `stave.getStatus` checks
  only the kill switch, deliberately, so clients can show what is missing. Errors are defined in
  `packages/contracts/src/stave.ts` (`StaveUnavailableReason`).

## `stave.getStatus` / `stave.spaceStatus`

Both are read RPCs (`AuthOrchestrationReadScope` in `apps/server/src/auth/RpcAuthorization.ts`)
served by `makeStaveRpcHandlers` in `apps/server/src/stave/staveRpcHandlers.ts`, built per
connection in `ws.ts` around the same auth/tracing wrapper as every other unary handler
(`rpc.aggregate: "stave"`). `StaveRpcRuntime` (server-lifetime, `runtimeLayer`) holds the
pieces that must outlive a connection: the last CLI failure and the space-status cache. DTOs
live in `packages/contracts/src/stave.ts`.

- **`stave.getStatus` → `StaveStatus`** (no input; never runs a mutating verb, deviation 21):
  - `runnable: { path, source, version, commit } | null` from `resolveRunnable`, with
    `runnableError: { code: "binary_missing" | "binary_not_executable", message } | null`.
  - `configPath`, `configExists`, `roots: { root, bareReposDir, agentWorkDir } | null` from the
    config reader (`roots` is null when the snapshot lacks any of the three).
  - `marmot: { available, version }` from `stave memory providers --json` — the row for the
    configured provider (default `marmot`), else the provider Stave marks default — probed only
    when a binary is runnable _and_ the config exists, because read verbs construct Stave's
    service, which needs the config on disk. Otherwise `{ available: false, version: null }`.
  - `lastFailure: { at, verb, code, message } | null` — the most recent failed `StaveCli` call
    (every handler taps its CLI errors through `recordFailure`).
  - `pendingCleanups: []` — placeholder until the lifecycle table exists (planned, Phase 4).
- **`stave.spaceStatus { workspaceRoot }` → `StaveSpaceStatus`**: the workspace root is resolved
  to a space id through `StaveWorkspaceReader.load` (no manifest → `StaveNotSpaceError`), then
  `stave space status <id> --json` is mapped by `toSpaceStatusDto` to camelCase minus the
  manifest clients already hold: `spaceId`, `spacePath`, `kind?`, `createdAt?`, `repos[]`
  (`name`, `mode` incl. forward-compatible `unknown`, `path`, `branch?`, `base?`, `ref?`,
  `exists`, `dirty`, `dirtyOutput?`, `ahead`, `behind`, `driftError?`, `referenceWarn?`) and
  `memories[]` (`name`, `provider`, `id`, `owned`, `state?` — Stave's compact freshness text).
  CLI failures surface as `StaveCommandError { verb, code, message }`. Answers are cached per
  root for 15s (`STAVE_SPACE_STATUS_CACHE_TTL`, capacity 256); failures are not cached, so the
  next call asks Stave again.

## Git ceiling

Git discovers its repository by walking up from cwd. Inside Stave's agent-work directory that
walk would adopt whatever repository contains agent-work (a dotfiles-managed `$HOME`, for
instance), so a space root that is not a repo would masquerade as a worktree of its ancestor.
`makeGitVcsDriverCore` (`apps/server/src/vcs/GitVcsDriverCore.ts`) takes `StaveRootsProvider`
as an optional service and, for every git spawn whose cwd is a path-segment descendant of
`agentWorkDir`, sets `GIT_CEILING_DIRECTORIES=<agentWorkDir>` (prepended to any existing value
with the platform list delimiter). No provider, no config, or a cwd elsewhere → the environment
is untouched. `server.ts` provides `StaveRootsLayerLive` to `GitVcsDriverLayerLive`.

## Diagnostics

The Diagnostics page (`apps/web/src/components/settings/DiagnosticsSettings.tsx`) gains a Stave
block fed entirely by `stave.getStatus`: the runnable binary (path, source, version) or the
`runnableError`, the config path and whether it exists, the three roots, marmot availability and
version, and the last failed verb (`lastFailure`). It is rendered whenever `capabilities.stave`
is present, independent of `settings.stave.enabled`, so a disabled or broken install is still
inspectable. Server-side there is nothing to reset: `lastFailure` lives in `StaveRpcRuntime`
for the life of the process.

## Client rules

Shared resolvers in `packages/client-runtime/src/state/projectGit.ts` are the single place
these choices are made so web and mobile cannot disagree:

- `isStaveProject(project)` — `project.stave != null`.
- `staveForcedEnvMode(project)` — `"local"` for a space, else `undefined`.
- `resolveProjectGitCwd({ project, thread })` — `stave.primaryRepoPath`, else the thread's
  `worktreePath`, else `workspaceRoot` (the pre-Stave order, unchanged for ordinary projects).
- `resolveProjectGitBranch({ project, thread })` — the thread's `branch`, else
  `stave.primaryBranch`, else `null`. This is the **effective branch**: new local threads carry
  `branch: null`, which suppresses PR lookup; a space fills that gap with its manifest branch.

Rules built on them:

- **Forced local env mode.** `resolveDefaultThreadEnvMode` in
  `packages/shared/src/threadEnvMode.ts` takes `forcedMode` as the top priority (forced >
  per-project setting > `t3.json` > global default), and `isDefaultThreadEnvModeSettled` treats
  a forced mode as settled immediately. Web passes it from `chatThreadActions.ts`
  (`useHandleNewThread`) and skips the `t3.json` read when forced; `BranchToolbar` /
  `BranchToolbarBranchSelector` pin the composer mode. Mobile passes it in
  `apps/mobile/src/features/threads/new-task-flow-provider.tsx`, never persists a worktree path
  for a Stave draft, and refuses a `worktree` mode pick.
- **Git targeting.** Web wraps the resolvers in `apps/web/src/lib/threadGitTarget.ts`
  (`resolveThreadGitTarget` → `cwd`, `branch`, `isStave`, `statusEnabled`, where a space always
  enables status; `resolveThreadGitRepositoryRoot` uses `stave.primaryRepositoryIdentity.rootPath`
  for diff-file links). Mobile wraps them in `apps/mobile/src/state/thread-git-target.ts` and
  routes every git consumer (status, actions, branches, PR, review, commit sheets) through it;
  files and terminals keep the workspace cwd.
- **Checkpoints unavailable.** `resolveCheckpointsUnavailableReason` in `threadGitTarget.ts`
  returns `STAVE_CHECKPOINTS_UNAVAILABLE_REASON` for a space; `ChatView` and `DiffPanel` gate
  checkpoint/diff UI on it. The server already reports checkpoints unavailable for non-git
  roots, so this is presentation only.
- **Disabled env-mode control.** `ProjectSettingsPanel.tsx` treats a project group with any
  Stave member as `isStaveGroup`: the default-env-mode control shows `local`, is disabled, and
  explains "Stave spaces always run in the space root". The panel also renders the read-only
  `StaveProjectSection` (space id, kind, state, member-of, repos, memories) when the selected
  checkout or its representative carries `stave`.
- **Hidden worktree affordances.** `PullRequestThreadDialog` sets `canCreateWorktree` false for
  a space; `BranchToolbar` receives the same flag; mobile's git actions toast the worktree
  message instead of dispatching.

## Test conventions used

- **Reader fixtures** (`apps/server/src/stave/StaveWorkspaceReader.test.ts`): inline manifest
  strings in Stave's own yaml.v3 layout (4-space sequences) covering v1, v2 saga, versionless
  with unknown keys, and a saga block without `kind`; written into
  `makeTempDirectoryScoped` roots via `NodeServices.layer` (`it.layer`). The reader is built
  with `StaveWorkspaceReader.make(options)` over a stubbed `RepositoryIdentityResolver`
  (null-returning, or fake identity). TTL behaviour is driven with `TestClock.adjust`, never real
  waits; `invalidate`/`invalidateAll` are asserted by re-reading after a rewrite.
- **Admission test layer** (`apps/server/src/stave/StaveAdmission.test.ts`): `StaveAdmission.layer`
  over a `Layer.mock` reader that knows one space root and records every `load` call, so tests
  assert both the refusal shape and that non-worktree intents never read the manifest.
  `Normalizer.stave.test.ts` uses the same shape with mocked project/thread shells.
- **Real manifests in `server.test.ts`**: `makeStaveRoot` writes a minimal
  `version: 1\nid: ...` manifest into a scoped temp dir and runs the live layers, covering fork
  refusal and the `vcs.createWorktree`/PR-preparation RPCs.
- Tests whose roots are never spaces provide `StaveWorkspaceReader.layerNoop` and
  `StaveAdmission.layerNoop` (see the Normalizer attachment/fork tests).
- **Binary candidates** (`apps/server/src/stave/StaveBinary.test.ts`): executables are written
  into a scoped temp dir and `make({ bundledBaseDir })` is pointed at it, so every candidate
  source (settings, env, bootstrap, bundled, PATH) is exercised against real files; the version
  probe runs a fake `stave`.
- **CLI fixtures** (`apps/server/src/stave/StaveCli.test.ts`, `testing/fake-stave.sh`,
  `testing/staveJsonSamples.ts`): the samples are exact stdout/stderr captured from the real
  binary in a throwaway root, one constant per verb and failure shape; the fake script replays
  them by verb. Argv tests assert token order without spawning; the spawn-discipline test
  inspects the `ProcessRunInput` (stdin, `unsetEnv`, `MARMOT_HOME`); timeouts are driven with
  `TestClock.adjust(STAVE_READ_TIMEOUT)`.
- **Config reader** (`StaveConfigReader.test.ts`): `StaveCli` is mocked for the `config show`
  path; the fs fallback writes YAML into a temp home; the TTL is asserted with
  `TestClock.adjust` on either side of 15s. `StaveRoots.layer` is covered in the same file.
- Hosts without Stave provide `StaveBinary.layerFixed`, `StaveConfigReader.layerFixed`, and
  `StaveRootsProvider.layerNoop`.

## Related

- [Glossary](./glossary.md) — Stave space, Saga, Den
- [Stave spaces (user guide)](../user/stave.md)
- [Workspace layout](./workspace-layout.md)
- [Lecturn releases (fork)](../operations/lecturn-release.md)
