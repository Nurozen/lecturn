# Stave integration (fork)

> For maintainers. This page is fork-specific: it describes Lecturn's support for
> [Stave](https://github.com/Nurozen/stave) spaces, which upstream T3 Code does not have.
> Fork framing and release differences live in
> [docs/operations/lecturn-release.md](../operations/lecturn-release.md).

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
  members are enriched from best-effort Stave roster reads.

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
  never set to `undefined`. `memberOf` is enriched from a best-effort display cache; manifest recognition still works without a binary.
- `primaryRepositoryIdentity` is resolved through `RepositoryIdentityResolver` on
  `primaryRepoPath` after the pure projection and attached only when non-null.
- **Cache.** An `effect/Cache` keyed by root (capacity 512) with separate TTLs: 30s for a found
  manifest, 60s for a negative result (both overridable via `StaveWorkspaceReaderOptions`).
  `invalidate(root)` drops one entry so the next `load` re-reads disk; `invalidateAll()` drops
  everything. Every mutation in [`StaveOperations`](#staveoperations) that touches a space root
  calls `invalidate` on it (`createSpace` after verify, `removePartialSpace` through
  `afterMutation`).
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
  adds `deletedAt` on top. Lifecycle notices (`archive_scheduled`, `refused`,
  `pending_cleanup`) are derived from the lifecycle repository. The only producer
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
- `afterMutation` in [`StaveOperations`](#staveoperations) invalidates the reader after
  every space mutation and dispatches `project.refresh` for active projects with a
  `server:stave:refresh:<uuid>` command id. Lifecycle reconciliation also refreshes projects
  after retargeting their workspace roots.

## `StaveAdmission`

`apps/server/src/stave/StaveAdmission.ts` (service `t3/stave/StaveAdmission`), built on the
reader. `check(input)` succeeds or fails with a typed refusal; it never fails for a non-Stave
root.

- **Worktree rule.** `intentUsesWorktree` detects `vcs.createWorktree`, generic `pr.prepare`,
  `prepareWorktree: true`, or a non-null worktree path. Admission reads the manifest for local
  thread activity too, so archived and leased spaces cannot accept work through a local-mode
  bypass. Intents include create, metadata update, turn start, fork, and unsettle.
- **Lease/archived rules.** `StaveArchivedProjectError` and
  `StaveSpaceTransitioningError` fence archived spaces and active lifecycle leases.
  Admission resolves roots and primary-repo paths and rechecks at engine commit.
- `layer` is live (wired in `server.ts` over the live reader); `layerNoop` admits everything.

Where it is invoked:

| Path                          | File                                              | Intent(s)                                                  | Error surface                                                                |
| ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Normalizer (WS, HTTP, mobile) | `apps/server/src/orchestration/Normalizer.ts`     | `thread.create`, `thread.meta.update`, `thread.turn.start` | `OrchestrationDispatchCommandError` with the refusal as `cause`              |
| Fork materialization          | `apps/server/src/ws.ts` (`dispatchThreadFork`)    | `thread.fork`                                              | `OrchestrationDispatchCommandError` with the refusal as `cause`              |
| Git RPCs                      | `apps/server/src/ws.ts` (`admitStaveWorktreeRpc`) | `vcs.createWorktree`, `pr.prepare`                         | `GitCommandError` with `detail` = refusal message and the refusal as `cause` |

Details per path:

- **Normalizer.** `describeWorktreeIntent` identifies relevant thread activity and worktree
  requests. `enforceStaveWorktreeRule` resolves the owning project, or bootstrap project cwd,
  before attachments are claimed. Unknown projects/threads are left to the decider. The engine
  repeats admission under the canonical-root lock immediately before commit. On the HTTP
  transport, normalization failures use the existing `invalid_command` envelope.
- **Fork.** Forks skip the normalizer and the materialized command inherits the source's
  `worktreePath` (`threadFork.ts`), so `dispatchThreadFork` checks `thread.fork` with that path:
  a Stave-owned source that still runs in a worktree cannot be forked.
- **Git RPCs.** `ws.gitPreparePullRequestThread` and `ws.vcsCreateWorktree` carry only a cwd, so
  the owning project is resolved by exact root first, then by Stave primary-repo path.
  Generic PR preparation is refused in both worktree and local modes for those projects.

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
`StaveConfigReaderLayerLive` → `StaveRootsLayerLive`, merged into `StaveLayerLive`). The only
caller of the mutating verbs is [`StaveOperations`](#staveoperations), including space edits,
archive, restore, destroy, and memory actions. Saga operations use the same registry and progress stream.

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
  path. Live status and command gates use that same configured selection, so an invalid override
  reports its own error. `resolveRunnable` remains the internal settings-independent fallback
  candidate walk; it does not determine which binary the status line describes.
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

`apps/server/src/stave/StaveCli.ts` (service `t3/stave/StaveCli`) owns typed Stave command execution.
`StaveBinary` separately probes executable versions and command help. Every command is a typed method (`version`, `configShow`, `reposList`,
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
`incarnation_mismatch`, `membership_unknown`, `unreadable`, `operation_expired`). Phase 3 uses
`not_setup`, `incarnation_mismatch`, `unreadable`, and `operation_expired` from the operation
registry and its pre-flight refusals; `nested_project`, `archived_project`, and
`membership_unknown` are used by lifecycle admission and reconciliation.

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
reader's filesystem-only path, so Git never waits for Stave binary/config probes; `layerNoop`
answers none for hosts and tests without Stave; `layerFixed(dir)` pins one.

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
  - `runnable: { path, source, version, commit } | null` from the authoritative `resolve`, with
    `runnableError: { code: "binary_missing" | "binary_not_executable", message } | null`.
  - `configPath`, `configExists`, `roots: { root, bareReposDir, agentWorkDir } | null` from the
    config reader (`roots` is null when the snapshot lacks any of the three).
  - `marmot: { available, version }` from `stave memory providers --json` — the row for the
    configured provider (default `marmot`), else the provider Stave marks default — probed only
    when a binary is runnable _and_ the config exists, because read verbs construct Stave's
    service, which needs the config on disk. Otherwise `{ available: false, version: null }`.
  - `lastFailure: { at, verb, code, message } | null` — the most recent failed `StaveCli` call
    (every handler taps its CLI errors through `recordFailure`).
  - `pendingCleanups` — durable refused or pending lifecycle rows whose projects are deleted;
    the recurring sweep and settings actions share those durable records.
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

## Stave operations (Phase 3)

Long Stave mutations are _operations_: one discriminated payload (`StaveOperation` in
`packages/contracts/src/stave.ts`, deviation 1) run by an application-lifetime service and
streamed back as sequence-numbered progress events (deviations 18, 22, 25, 26). Phase 3
implements `createSpace`, `registerRepo`, `removePartialSpace`, and `setup`. Phase 4 adds
`addRepo`, `removeRepo`, `syncSpace`, `retarget`, `archiveSpace`, `destroySpace`,
`restoreSpace`, `memoryAttach`, and `memoryDetach`. Saga operations add all-participant fencing and reconciliation.

### `StaveOperations`

`apps/server/src/stave/StaveOperations.ts` (service `t3/stave/StaveOperations`). Built **once**
per server process in `apps/server/src/server.ts` (`StaveOperations.layer`, over
`ProcessRunner`) and handed to every per-socket RPC layer in `ws.ts` with `Layer.succeed`, so an
operation is owned by the service's scope and outlives the WebSocket that started it (a
socket-bound fiber would die with the tab). Its public shape provides `run`, `observe`,
`dryRun`, `summary`, and the internal automatic `executeLifecycle` bridge.

- **Keyed mutex.** `StaveSpaceLock.withSpaceLock(root, effect)` canonicalizes an existing
  root, or its existing parent for a new space, and shares one semaphore across operations and
  admission. Saga operations acquire all participant roots in deterministic order. Repository
  registration and setup serialize on the config path. The runtime shares this lock service with
  the lifecycle sweep, closing preflight-to-commit races.
- **Registry.** A `Map` keyed by the client-supplied `operationId`. An entry holds `kind`,
  `fingerprint` (sha256 of `stableStringify(operation)`), `state` (`running | finished | failed`),
  the event ring buffer with its byte count, `nextSequence` (1-based), `terminalAtMs`,
  `lastAccessMs`, `partialSpace`, and a `PubSub` for live followers. Bounds:
  `STAVE_OPERATION_EVENT_LIMIT` (2,000 events) and `STAVE_OPERATION_BYTE_LIMIT` (4 MiB) per
  operation, whichever is hit first; `STAVE_REGISTRY_BYTE_LIMIT` (64 MiB) registry-wide, enforced
  by evicting the oldest events of the least recently attached entry. The newest event is never
  evicted, so a retained entry can always replay its terminal event and a running one its latest
  phase. `emit` numbers, buffers, and publishes one event in a single uninterruptible step, so no
  follower sees a gap, and `finish` flips `state` inside the same step that buffers the terminal
  event.
- **Tombstones.** A terminal entry is kept for `STAVE_OPERATION_RETENTION` (24h from
  `terminalAtMs`). `reapExpired` runs at the start of every `run`/`observe`: it deletes the entry,
  shuts its PubSub, and adds the id to an `expired` set. Both live in process memory; a restart
  forgets them. Incarnation binding (below), not the registry, is what makes a replayed request
  safe (deviation 26).
- **`run { operationId, afterSequence?, operation }`** is start-or-attach. Unknown id → new entry,
  attach first (so the very first event is seen live), then fork the body into the service scope
  (`Effect.forkIn`). Known id with the same fingerprint → attach from `afterSequence`, whatever
  the state. Known id with a different fingerprint → `StaveOperationRejectedError { code:
"invalid_arguments" }`. Reaped id → `operation_expired`. The stream ends after the terminal
  event.
- **`observe { operationId, afterSequence? }`** attaches only: unknown id → `invalid_arguments`,
  reaped → `operation_expired`.
- **`attach`** subscribes to the PubSub _before_ snapshotting the buffer (running entries only),
  replays every buffered event with `sequence > afterSequence`, then concatenates the live
  subscription filtered by sequence and `takeUntil` a terminal event. When `afterSequence + 1 <
earliestSequence` (the cursor was evicted) the replay is prefixed with
  `reset { earliestSequence }`, numbered `earliestSequence - 1`, and the client is expected to
  drop what it holds.
- **Events** (`StaveProgressEvent`): `phase_started { phase, commandLine? }`,
  `output { phase, stream: stdout | stderr | notes | plan, text }`,
  `phase_finished { phase, durationMs }`, `reset { earliestSequence }`,
  `finished { result: { kind, result } }` (the kind/result pairing is the `StaveOperationResult`
  union, deviation 2), `failed { error: StaveOperationError }`. Every Stave invocation is one
  phase named after its verb (`invoke`): `phase()` emits `phase_finished` on failure too, so the
  UI can close the step; `notes[]` from a `--json` answer arrive as `output` with
  `stream: "notes"` inside the phase; raw stdout lines are forwarded only for prose verbs
  (`STAVE_VERB_POLICY`), which no mutation is on the shipped binary. The `commandLine` shown is
  built by `buildStaveArgv` (`commandLineOf`); `registerRepo` redacts URL userinfo in the shown
  line (`redactUrl`) but hands Stave the original.
- **`createSpace`**, inside `withSpaceLock(<agentWorkDir>/<spaceId>)`, in order:
  1. `pre-flight` (no command line): `not_setup` when the config does not exist; `after` without
     `saga` → `invalid_arguments`; any entry at the exact candidate name in `agentWorkDir`
     (dangling symlinks included — Stave would create inside a manifest-less directory) →
     `space_exists`; the realpath of the candidate equal to the realpath of any active project's
     `workspaceRoot` → `space_exists` with the project in `details` (deviation 25). Warnings, as
     `notes` output rather than refusals: leftover `stave/<id>/*` branches in the edited repos'
     bare repos (`git branch --list`), and two or more `.archive/` entries matching `<id>` or
     `<id>-<14 digits>` (`archiveEntriesMatching`; that is the later `ambiguous_archive` case).
  2. `space create`: `specText` is written to a scoped temp file (`stave-spec-*.md`) for
     `--spec`, otherwise `specPath` passes through; `edits` become `repo[:base]`, `references`
     `repo[:ref]`, `memory[].spec` → `--memory`, plus `saga`, `after`, `common`, `includeWeak`,
     `noLearn`. As soon as it returns, `entry.partialSpace = { spaceId, spacePath,
manifestCreatedAt }` is recorded. There is no separate "attach memory" phase: memory rides
     on `--memory` of the create (the plan's phase list named one).
  3. `verify`: `space status <id>`; `incarnation_mismatch` unless `manifest.createdAt` equals
     the stamp the create returned. Then `workspaceReader.invalidate(spacePath)`.
  4. `project.create`: dispatched server-side through `normalizeDispatchCommand` (so
     `StaveAdmission` and the usual normalisation apply) with command id
     `server:stave:create:<basename>:<uuid>`, `title` defaulting to the space id, and
     `createWorkspaceRootIfMissing: false`. The engine's `sequence` is returned.

  Result: `StaveCreateSpaceResult` = `StaveSpaceMutationResult` (`spaceId`, `spacePath`,
  `manifest`, `notes`) plus `{ projectId, sequence }`; clients wait for
  `snapshotSequence >= sequence` before opening the project (deviation 26).

- **Failure and no compensation.** `finish` maps the cause with `toOperationError` (a
  `StaveError` keeps `verb`; a pre-flight `StaveRefusalError` has none; an interruption becomes
  `unknown`) and, when `partialSpace` is set, merges it into `error.details.partialSpace`.
  Nothing is rolled back: a create that failed after `space create` leaves the space on disk
  (spec §3.6 forbids automatic force).
- **`removePartialSpace { spaceId, expectedManifestCreatedAt }`** is the explicit recovery, under
  the same root lock: `pre-flight` runs `space status` and refuses `incarnation_mismatch` unless
  `manifest.createdAt === expectedManifestCreatedAt`, so a replayed or late request can never
  destroy a space recreated under the same id; then guarded `space destroy --memory destroy`
  (Stave applies the `destroy` fate only to owned stores and keeps shared dens). Force defaults
  to false and requires an explicit retry after a coded refusal. Saga removal needs separate
  confirmation; the dry-run plan explains that destruction can refuse after removal. Finally,
  `afterMutation(spacePath)`. Result: `StaveDestroyResult`.
- **`registerRepo { name, url, adopt }`** runs `repos add` under the config-path lock and
  invalidates `StaveConfigReader` (the registry is read from config). **`setup { force }`** runs
  `setup` under the same lock and invalidates the same cache.
- **`dryRun(operation)`** is unary and covers creation, repo edits, memory, lifecycle and saga
  operations. It uses the matching Stave preview and the same preflight constraints as execution;
  metadata-only Keep and Dismiss produce host plans. Saga teardown also returns the reviewed
  participant fingerprints. `STAVE_OPERATION_VERB` maps each kind to its verb so errors raised
  before a spawn still name it.
- `summary(operationId)` exposes `{ kind, state, earliestSequence, nextSequence,
bufferedEvents, manifestCreatedAt }` for tests and diagnostics.

### RPC surface

Contracts in `packages/contracts/src/rpc.ts`, handlers in
`apps/server/src/stave/staveRpcHandlers.ts` (same `makeStaveRpcHandlers` as the status RPCs),
scopes in `apps/server/src/auth/RpcAuthorization.ts`. Every method below runs `requireEnabled`
(kill switch, `settings.stave.enabled`, runnable binary); read failures are recorded in
`StaveRpcRuntime.lastFailure` and mapped to `StaveCommandError`.

| Method                                                          | Scope                           | Serves                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stave.listRepos`                                               | `AuthOrchestrationReadScope`    | `repos list --json` → `StaveRepoRow[]`                                                                                                                               |
| `stave.listSpaces { includeArchived }`                          | `AuthOrchestrationReadScope`    | `space list --json` (+ `--archived` rows appended) → `StaveSpaceListRow[]`, incl. v0.4 identity (`logicalId`, `archiveBasename`, `manifestCreatedAt`) and `memories` |
| `stave.listSagas`                                               | `AuthOrchestrationReadScope`    | `saga list --json` → `StaveSagaListRow[]`                                                                                                                            |
| `stave.memoryProviders`                                         | `AuthOrchestrationReadScope`    | `memory providers --json` → `StaveMemoryProvider[]`                                                                                                                  |
| `stave.dryRun { operation }`                                    | `AuthOrchestrationReadScope`    | `StaveOperations.dryRun` → `StaveDryRunPlan { dryRun: true, plan[] }`                                                                                                |
| `stave.runOperation { operationId, afterSequence?, operation }` | `AuthOrchestrationOperateScope` | stream of `StaveProgressEvent` (`StaveOperations.run`)                                                                                                               |
| `stave.observeOperation { operationId, afterSequence? }`        | `AuthOrchestrationReadScope`    | stream of `StaveProgressEvent` (`StaveOperations.observe`); watching is a read                                                                                       |

Stream errors are `StaveUnavailableError | StaveNotSpaceError | StaveOperationRejectedError`
(plus authorization); a Stave failure _inside_ a running operation is a `failed` event, never a
stream error. `packages/client-runtime/src/rpc/client.ts` lists the two stream methods with the
other streaming RPCs.

### Client runtime

`packages/client-runtime/src/state/staveOperation.ts` is the consumer, keyed on `operationId`
and `sequence`:

- `StaveOperationState { operationId, status: idle | running | finished | failed |
disconnected, phases[], lastSequence, earliestSequence?, truncated, result?, error?,
disconnectReason? }`; each phase keeps `commandLine?`, `startedAt`, `finishedAt?`,
  `durationMs?`, and its retained `lines[]` (`{ stream, text }`).
- `reduceStaveProgressEvent` is pure: it ignores events for another id, events at or below
  `lastSequence` (replays, reordering), and anything after a terminal event; `reset` drops the
  phases, sets `lastSequence = earliestSequence - 1` and `truncated`; output for a phase whose
  start was never seen opens that phase lazily.
- `runStaveOperation` / `reattachStaveOperation` never fail: a `StaveOperationRejectedError`
  becomes `failed`, a stream that ends without a terminal event becomes `disconnected` with a
  `reattach()` that calls `stave.observeOperation` from `lastSequence` and keeps the retained
  phases.
- `createStaveOperationManager(runtime)` returns `{ stateAtom, run, reattach }`: one keep-alive
  atom per id and two commands serialised per id; `run` on a `disconnected` state resumes from
  its `lastSequence` instead of restarting.
- `packages/client-runtime/src/operations/projects.ts`: `AddProjectSource` gains
  `"stave-space" | "stave-saga"` (`ADD_PROJECT_STAVE_SOURCES`, labels "New Stave space" /
  "New Stave saga"), and `findExistingAddProject` is shared with the palette.

### Web

- `apps/web/src/state/staveOperations.ts` binds the manager to `connectionAtomRuntime`
  (`staveOperations.stateAtom(operationId)` is what the progress step reads) and adds
  `waitForStaveProjectVisible { environmentId, projectId, sequence }`, which resolves once the
  environment shell has applied that sequence.
- `apps/web/src/state/stave.ts` adds the query atom families `staveRepos`, `staveSpaces`,
  `staveSagas`, `staveMemoryProviders`, the `staveDryRun` command, and `useStaveFeatureAvailable`.
- `apps/web/src/lib/addProject.ts` is the shared "add project" tail: `addProjectAndOpenThread`
  (reuse the project at the path, else `project.create` with optional `title` /
  `createWorkspaceRootIfMissing`, then start a thread — the palette's folder and clone sources
  route through it) and `openExistingProjectAndThread({ projectId, sequence? })`, which the
  wizard calls after the server created the project: wait for `sequence`, then open the latest
  thread or start one.
- `apps/web/src/staveWizard.ts` is the bus on the `confirmDialog.ts` pattern:
  `openStaveWizard({ environmentId, kind: "space" | "saga", saga?: { root } })`,
  `readStaveWizardState`, `subscribeStaveWizard`, `closeStaveWizard`,
  `resetStaveWizardForTests`. The host, `StaveWizardDialog`, is mounted in
  `apps/web/src/routes/__root.tsx` beside the confirm dialog host (deviation 18).
- Palette: `buildStaveAddProjectItems` in `apps/web/src/components/CommandPalette.logic.ts`
  returns nothing unless `available`; `CommandPalette.tsx` feeds it
  `useStaveFeatureAvailable(addProjectEnvironmentId).available` and launches the bus with the
  chosen kind.
- `apps/web/src/components/stave/staveSpaceWizard.logic.ts` holds every rule of the wizard, so
  the dialog and step components only render. Steps `identity → repos → memory → saga → review →
progress`, with `memory` present only when some `stave.memoryProviders` row is `available`
  (`wizardSteps`). `validateSpaceId`: charset via `isValidStaveSpaceId`, a live row (`id` or
  `logicalId`) blocks, archived matches (`logicalId`, `archiveBasename`, or `<id>-<14 digits>`)
  only warn. Kind chips `ticket | spike | audit | custom`; `review` and `saga` are reserved.
  `spaceBaseOptions` offers `space:<logicalId | id>` for live, error-free spaces that edit the
  same repo. `memorySuggestions` is `.` plus `provider:id` for every memory on the listed spaces
  (deviation 22). `canAdvance` gates each step (at least one repo or `emptySpace`; a well-formed
  `space:` base; `after` only with a saga; spec text or path, not both).
  `buildCreateSpaceOperation` / `buildRegisterRepoOperation` produce the wire payloads;
  `describeCreateSpaceCommand` renders the review line (pasted spec shown as
  `--spec <pasted spec>`); `partialSpaceFromError` reads `failed.error.details.partialSpace` and
  `buildRemovePartialSpaceOperation` binds the recovery to `manifestCreatedAt` (null, and the
  button disabled, when the stamp is unknown). The saga variant (`buildCreateSagaOperation`) follows its own form and returns the
  server-created project id and sequence before navigation.
- Components under `apps/web/src/components/stave/`: `StaveWizardDialog.tsx` (the host
  `__root.tsx` mounts; steps in `steps/IdentityStep.tsx`, `ReposStep.tsx`, `MemoryStep.tsx`,
  `SagaStep.tsx`, `ReviewStep.tsx`, plus `SagaCreateForm.tsx` for the saga variant);
  `useStaveWizardData.ts` folds the four reads (`staveRepos`, `staveSpaces` with
  `includeArchived: true`, `staveSagas`, `staveMemoryProviders`) into one `StaveWizardContext`
  with `isPending`/`error` and `refreshRepos`/`refreshSpaces` (called after an inline register);
  `StaveOperationProgress.tsx` renders one operation from `staveOperations.stateAtom` — every
  phase with its command line, retained output and duration, a **Reattach** button while the
  state is `disconnected` (manual, `staveOperations.reattach`), and the nested **Remove partial
  space** operation on a failed create. Its rules live in `staveOperationProgress.logic.ts`:
  `phaseStatus` (`running | done | failed | interrupted`, where `interrupted` is an open phase of
  a disconnected operation), `removePartialSpaceAvailability` (available only with a manifest
  stamp; otherwise a hint that nothing was created), `outputRuns` (consecutive lines of one
  stream collapse into a block), `truncatedNotice` after a `reset`.

## Git ceiling

Git discovers its repository by walking up from cwd. Inside Stave's agent-work directory that
walk would adopt whatever repository contains agent-work (a dotfiles-managed `$HOME`, for
instance), so a space root that is not a repo would masquerade as a worktree of its ancestor.
`makeGitVcsDriverCore` (`apps/server/src/vcs/GitVcsDriverCore.ts`) takes `StaveRootsProvider`
as an optional service and, for every git spawn whose cwd is a path-segment descendant of
`agentWorkDir`, sets `GIT_CEILING_DIRECTORIES=<agentWorkDir>` (prepended to any existing value
with the platform list delimiter). Independently, canonical ancestor discovery finds a
`.stave.yaml` boundary and sets its parent as the ceiling, including when cwd is the space root
itself. This still protects imported spaces outside the selected installation, with missing config
or disabled integration. `server.ts` provides `StaveRootsLayerLive` to `GitVcsDriverLayerLive`.

## Diagnostics

The Diagnostics page (`apps/web/src/components/settings/DiagnosticsSettings.tsx`) gains a Stave
block fed entirely by `stave.getStatus`: the runnable binary (path, source, version) or the
`runnableError`, the config path and whether it exists, the three roots, marmot availability and
version, and the last failed verb (`lastFailure`). It is rendered whenever `capabilities.stave`
is present, independent of `settings.stave.enabled`, so a disabled or broken install is still
inspectable. `StaveCli` records failures at its shared invocation boundary, including streamed
mutations and automatic lifecycle work. `StaveRpcRuntime` combines that with read-side failures
and returns the latest record for the life of the process.

## Client rules

Shared resolvers in `packages/client-runtime/src/state/projectGit.ts` are the single place
these choices are made so web and mobile cannot disagree:

- `isStaveProject(project)` — `project.stave != null`.
- `staveForcedEnvMode(project)` — `"local"` for a space, else `undefined`.
- `resolveProjectGitCwd({ project, thread })` — for Stave, `primaryRepoPath` or explicit `null`
  when no editable repo exists. Ordinary projects retain `thread.worktreePath` then `workspaceRoot`.
- `resolveProjectGitBranch({ project, thread })` — the thread's `branch`, else
  `stave.primaryBranch`, else `null`; Stave without a primary repo always returns `null`. This is the **effective branch**: new local threads carry
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
  (`resolveThreadGitTarget` → `cwd`, `branch`, `isStave`, `statusEnabled`, where a space with an editable repo
  enables status; `resolveThreadGitRepositoryRoot` uses `stave.primaryRepositoryIdentity.rootPath`
  for diff-file links). Mobile wraps them in `apps/mobile/src/state/thread-git-target.ts` and
  routes every git consumer (status, actions, branches, PR, review, commit sheets) through it;
  files and terminals keep the workspace cwd.
- **Checkpoints unavailable.** `resolveCheckpointsUnavailableReason` in `threadGitTarget.ts`
  returns `STAVE_CHECKPOINTS_UNAVAILABLE_REASON` for a space; `ChatView` and `DiffPanel` gate
  checkpoint/diff UI on it. Server checkpoint diff and revert handlers also refuse Stave roots.
- **Disabled env-mode control.** `ProjectSettingsPanel.tsx` treats a project group with any
  Stave member as `isStaveGroup`: the default-env-mode control shows `local`, is disabled, and
  explains "Stave spaces always run in the space root". The panel renders
  `StaveProjectSection` (space id, kind, state, member-of, repos, memories, and available actions)
  for the selected checkout's Stave metadata, without borrowing another checkout's identity.
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
- **Operations** (`apps/server/src/stave/StaveOperations.test.ts`): a `scenario` harness builds
  the service over a recording `StaveCli` mock (every call's method and input is captured) with
  real temp roots for `agentWorkDir` and `.archive/`, a fake `ProcessRunner` for the `git branch
--list` probe, and stubbed engine/snapshot services so the server-side `project.create` is
  observable. Streams are collected with `Stream.runCollect(ops.run(...))` and asserted by
  event outline; `Deferred` gates hold a phase open to test attach-from-cursor, `reset` after
  eviction (small `layerWith` limits), a second attacher following live, and the same-id
  serialisation; the
  24h retention is crossed with `TestClock.adjust`. Covered: phase order, title default, temp
  spec file cleanup, fingerprint mismatch, unknown/expired ids, root lock, every pre-flight
  refusal and warning, partial space reporting, `removePartialSpace` stamp binding and refresh,
  URL redaction, `setup`, `dryRun` per kind, lifecycle cancellation, and saga participant fencing.
- **Client consumer** (`packages/client-runtime/src/state/staveOperation.test.ts`): the reducer
  is exercised with hand-built events (retention per phase, replay/foreign/out-of-order
  rejection, lazy phase open, `reset`, terminal settling); `runStaveOperation` runs against
  scripted streams to cover rejection, disconnect, and `reattach`; the manager test checks the
  atom family is keyed by id.

## Lifecycle fencing and edits (Phase 4)

Migration `049_StaveProjectLifecycle` creates `stave_project_lifecycle`. It stores the project,
canonical root, manifest `(id, createdAt)`, disposition, durable delete intent and saga-removal
confirmation, refusal, archive/schedule metadata, and a lease epoch, owner token, and expiry.
The lifecycle projector upserts delete intent inside the event's SQL transaction. A new delete
rearms a previous live archive schedule, Keep, or refusal; completed archive/destroy and in-flight
dispositions are preserved. Missing event identity fields retain the journaled incarnation. Historical events without roots are ignored. Migration seeds
the projector at the current event sequence; a separate operational cursor survives projection
resets so rebuilding read models cannot revive historical cleanup intents. Both lifecycle tables
are excluded from resets. This is lifecycle recovery state, not an operation replay ledger.

`StaveLifecycleRepository` lives under persistence `Services/` and `Layers/`. Lease acquisition,
renewal, terminal writes, and release compare the epoch and owner. Ordinary lease updates do
not slide `scheduled_at`. An explicit lease-checked schedule reset starts or cancels an inactive
episode. The recurring lifecycle sweep consumes persisted deletion intents.

`StaveSpaceLock` supplies the canonical-root mutex shared by operations and admission.
The engine tries to acquire that lock without waiting, rejects contention, and rechecks relevant
thread commands while holding it through commit. A blocked command cannot stall the single
worker that an operation needs for refresh and quiescence. This closes the normalization-to-dispatch race. Archived roots reject thread starts; leased roots
reject new work. Internal lifecycle refresh/meta/delete and turn-interrupt commands can complete
while an operation owns the lock. Generic PR preparation is refused for Stave-owned repos in
both modes; PR resolution uses the primary repo identity and effective branch. Checkpoint diff
and revert are explicitly unavailable for spaces.

Space-scoped edits carry `expectedManifestCreatedAt`; destructive execution refuses missing
or mismatching incarnations. Archive, restore, and destroy persist intent before quiescing
provider and terminal sessions, then reconcile live and archived roots after the CLI outcome.
A shared `StaveRuntimeFence` rejects new starts and drains admitted starts under every participant
root before session enumeration. Provider start/resume and terminal open/restart participate;
the fence remains held through teardown, including descendant and canonical aliases.
Restore always uses the exact archive basename. Symlink aliases and nested active projects
are refused at pre-flight. Reconciliation uses the full manifest timestamp rather than an id
alone; unreadable or ambiguous matches remain repairable refusals. No operation writes Stave's
manifest directly or automatically forces a failed command.

`spaceStatus` adds a fresh `sagaMembership` scan and `membershipUnknown` flag. Both web delete
entry points request it immediately before confirmation. The prompt names the saga and dropped
dependent ordering edges, then sets `staveSagaRemoveConfirmed` on the delete command. A failed
or older-server read never authorizes roster changes. Explicit destroy has a separate
`sagaRemoveConfirmed` payload field and a combined removal confirmation after `saga_member`.

`StaveSpaceActions` and `StaveConfirmDialog` supply edits, per-mode removal, sync, retarget,
memory fate, archive/destroy, and Unarchive. Confirmation is tied to the exact payload whose
dry-run plan is displayed. Only coded dirty/dependent refusals offer Force, with a second
plan and confirmation. The dialog is scoped to environment, root, and incarnation. Its progress
uses the existing replayable operation consumer. New-thread affordances explain that archived
spaces must be restored; mobile restores remain a web/desktop action. Setup now invokes the
existing server operation directly and refreshes status when it completes.

## Related

- [Glossary](./glossary.md) — Stave space, Saga, Den, Stave operation
- [Stave spaces (user guide)](../user/stave.md)
- [Workspace layout](./workspace-layout.md)
- [Lecturn releases (fork)](../operations/lecturn-release.md)

## Sagas (Phase 5)

`stave.sagaStatus { sagaRoot }` returns the frozen CLI status shape in camelCase. Its
15-second success cache shares an invalidation generation with mutation paths. The manifest
reader stays binary-independent; a separate best-effort display enrichment supplies `memberOf`.
Destructive decisions use fresh authoritative roster and manifest reads, never the display cache.

Saga creation normalizes and dispatches `project.create` server-side and returns `projectId`
and `sequence`. Clients wait for that shell sequence before opening once. Saga/member edits
carry their expected creation timestamps. Saga teardown acquires canonical-root mutexes and
leases across all participants in deterministic order, journals member intents before the CLI,
and reconciles every participant after success or partial failure. Durable per-project rows
support restart recovery without persisting the streamed operation registry.

`buildSagaProjectTree(groups, sagaIndex)` adds one level over existing `ProjectGroup` objects.
Index entries are scoped by environment and saga root; children retain their original group
keys and navigation targets. Stave's status order overrides drag order. Ambiguous membership
or mixed physical groups stay flat; no group is dropped or duplicated. Web isolates its new
section in `SagaSidebarSection`; the legacy sidebar excludes nested children from drag sorting.
Mobile preserves flat thread-list semantics with a separate tablet saga roster and nests headers
in its optional legacy list. Its `sidebarNestSagas` preference is stored only on the device.

`StaveMergeSignal` produces project-id candidates from fresh live saga status and matching
manifest incarnations. A member needs at least one editable repo and every repo must report
`baseHealth: merged`; missing, corrupt, replaced, unknown, or partial results are ineligible.
`ThreadSettlementReactor` retains its ordinary eligibility guards and snapshot-sequenced
auto-settle commands. The Stave merge toggle is independent of the ordinary PR-merge toggle.
The existing primary repository path/branch supplies Stave PR fallback queries.

## Lifecycle automation (Phase 6)

`StaveLifecycleService` is an application-lifetime reactor with one drainable worker. Engine
events and settings changes nudge that worker; a parked loop also schedules an immediate sweep
and subsequent sweeps every minute. The server switch, enabled setting, and configured binary
must all permit cleanup. The runtime provides one `StaveOperations` instance to both the RPC
handlers and this service, sharing its operation registry, fencing, and reconciliation logic.

For deleted projects, the sweep consumes durable delete intent and waits for
`ThreadDeletionReactor.drainThrough` at the recorded sequence. The policy chooses destroy,
archive, or keep. An already archived space is kept. Incarnation mismatch, unreadable disk
state, or missing saga-removal consent refuses cleanup. Refused rows require an explicit user
retry; the periodic sweep does not automatically force them. The delete intent is checked again
after waiting for thread deletion and inside the operation lease, so Dismiss can cancel a queued
cleanup before the CLI starts.

For live spaces, `StaveLifecyclePolicy.resolveArchiveDeadline` considers every thread row,
including archived and deleted rows as inactive timestamp anchors. No threads, or any active
thread, means no archive schedule. A schedule uses the later of the thread anchor and immutable
`scheduledAt`, plus the configured grace. Ordinary lease updates cannot move that deadline.
Keep suppresses the current inactive episode; a changed anchor starts another episode.
Re-enabling automatic cleanup starts a fresh grace period. Generation tracking retains that
reset for a project temporarily skipped because another operation holds its lease.
`archive` uses zero grace, `archive-after-grace` uses the configured days, `suggest` only shows a
notice, and `nothing` cancels scheduling. Automatic execution rechecks policy and thread state
under the operation's lease before invoking the CLI. An automatic saga archive also waits for
each registered member's inactive episode and grace period, honoring member Keep. A fresh roster
precheck leaves the coordinator pending while members are ineligible; checks under all participant
leases catch races before quiescence and again before the CLI. A race at that point becomes a
reviewable refusal. Explicit saga archive uses its separate reviewed operation.

The existing streamed operation union carries `lifecycleAction` for Keep, Dismiss, Archive now,
and Retry. Retry freezes the archive/destroy target from its preview. Keep and Dismiss update
only the durable row, so they remain available when the binary or manifest cannot be read.
Disk-changing actions require a matching creation timestamp and reuse the ordinary explicit
Force and saga-removal confirmation rules. No lifecycle operation bypasses incarnation,
nested-root, or lease admission checks.

`listDeletedCleanups` joins lifecycle intent to the soft-deleted project projection. Live
archive schedules and unprojected records therefore cannot appear in Settings pending cleanups.
Derived project notices are refreshed after lifecycle changes; a durable refresh marker allows
a later sweep to repair an interrupted notification. Web settings poll deleted cleanups while
mounted. Project banners and sidebar badges show live notices; mobile exposes read-only badges
and directs cleanup management to web or desktop.

## Provider memory and compatibility (Phase 8)

`StaveMemoryWiring.resolve(cwd)` is a read-only per-session resolver. It requires enabled Stave,
a valid live manifest at exactly that root, and a Marmot attachment before reading that root's
`.mcp.json`. It selects only the `mcpServers.context-marmot` entry, requiring an absolute command,
string arguments, and optional string-valued environment. It does not walk ancestors, invent one
server per den, or rewrite provider configuration. Missing/invalid generated configuration is an
unavailable result; non-Stave, archived, and disabled roots produce an absent result.

Provider drivers receive this service in the production graph. Codex adds per-session
`-c mcp_servers.context-marmot.*` arguments with safe TOML value encoding. Cursor and Grok append
an ACP stdio MCP entry for both new and loaded sessions. OpenCode registers a local MCP entry
before readiness and disconnects it with the session scope, including failed startup and
unexpected exit. MCP additions have a 10-second bound and Stave disconnection a 1-second bound;
requests receive abort signals, and interruption still closes the owned server. Existing T3 MCP entries are preserved. External OpenCode servers are excluded:
the local absolute binary/home configuration is not meaningful on an arbitrary remote server,
and mutating shared external MCP state would require a separate ownership contract. Claude keeps
its project cwd and user/project/local settings sources; its SDK test establishes that
configuration, not actual executable pickup or connectivity.

Optional status fields preserve older-server compatibility: `features` reports command/flag
support and conservative `unsupportedOperations`; `diagnostics` reports compatibility issues;
`memoryWiringProviders` reports adapter support and limitations. Per-space `memoryWiring`
contains only state/diagnostic, never command, arguments, or environment. Clients distinguish
support and configured state from a verified live connection.

Nonbundled executables are probed with read-only nested command help, consuming stdout and
stderr and checking the command's usage and relevant flags. Feature results are cached and
invalidated with binary resolution. Cached executables are cheaply checked for file identity,
modification time, size, and mode; replacement/removal refreshes resolution and help results,
while unchanged polling does not spawn new probes. Each command gates against features for
the same selected binary snapshot. Bundled binaries have the known feature set. Desktop
bootstrap paths are probed because they may point to developer-installed executables. The CLI boundary
refuses unsupported requested commands/flags, covering old clients and the automatic sweep as
well as web controls. Windows candidates use `.exe` and do not require POSIX executable bits;
`.cmd` and `.bat` wrappers receive an explicit unsupported diagnostic. CLI notes stay verbatim in
the existing progress stream.

`StaveTelemetry` constructs the four closed event names `stave.space.created`, `.archived`,
`.destroyed`, and `.failed`. Properties are operation/trigger enums, a numeric count, and a
normalized closed error code on failure. It never spreads payloads, manifests, commands, or CLI
output into analytics. Interactive events are recorded once for a new operation's terminal
outcome; observing or attaching to that operation does not record again. Automatic lifecycle
execution records once at its own completion boundary. Delivery uses the existing AnalyticsService
and its opt-out behavior. This guarantee concerns analytics properties, not every diagnostic log.

## Operation execution configuration

`StaveExecution` captures one settings selection and executable for an operation. Workspace
operations read a private configuration snapshot for preflight, CLI commands, and reconciliation,
so switching the configured root mid-operation cannot redirect a mutation by space id to another
installation. The temporary directory/file use restrictive permissions and are removed with the
operation scope. Configuration reads bypass their shared cache under that execution context,
while diagnostics retain the original configuration path. Setup and repo registration retain the
captured original file because those operations intentionally write configuration. Metadata-only
Keep and Dismiss require neither a binary nor a configuration snapshot.

Recovery verifies that a journaled workspace belongs directly to the selected agent-work or
archive directory before interpreting its CLI inventory. A row belonging to another configured
installation remains a refusal with its project intact. Already-recorded destruction and empty
recovery do not require binary/config capture, so metadata cleanup still works when Stave is
unavailable.

### Reviewed saga cascades

`StaveDryRunPlan.sagaReview` carries the participant roots, incarnations, member project/thread
identities and a fingerprint bound to the roster, dependency edges, target, Force and memory
fate. Explicit saga teardown and saga lifecycle retries submit `expectedSagaReview`. The server
rechecks it under the participant locks before mutation. Ordinary coordinator project deletion
persists `staveSagaTeardown` using the preview's `projectDeletionFingerprint` in its command/event
and lifecycle row. That fingerprint excludes the coordinator project which is deleted before
cleanup; the full explicit-operation fingerprint includes it. The worker verifies the durable
scope after restart and refuses a replacement project at the coordinator root. Missing or changed authorization requires another review;
it cannot silently authorize newly imported member projects or conversations.

The client preserves an explicit null Git target for spaces without editable repositories,
including through legacy web/mobile wrappers. Branch selection for Stave keeps the primary
checkout and a null thread worktree; it never reuses a sibling space's checkout. An operation
request refused before it starts is terminal in the client, while lost access to an already
admitted operation remains resumable. Failed creates expose guarded partial removal only when
the server can establish ownership; an uncertain post-command outcome requires inspection.

Migration `050_StaveLifecycleRecovery` adds `saga_teardown_json` to the lifecycle row plus
`stave_lifecycle_policy` and `stave_lifecycle_schedule_resets`. These operational tables retain
policy observations and pending schedule resets across restart and are excluded from projection
resets. Completed archive disposition is written only after the project path follows the archive;
restore recovery resets its schedule episode before marking it live. Recovery retries incomplete
rows independently, so a temporarily unavailable execution configuration does not permanently
strand unrelated rows.
