# Stave integration (fork)

> For maintainers. This page is fork-specific: it describes Lecturn's support for
> [Stave](https://github.com/Nurozen/stave) spaces, which upstream T3 Code does not have.
> Fork framing and release differences live in
> [docs/operations/lecturn-release.md](../operations/lecturn-release.md).

Status: in progress — Phase 1 (recognise existing spaces)

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
  exist yet (planned, Phase 2+).
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
- No production caller dispatches it yet; Stave lifecycle operations will — planned (Phase 2+).

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

## Related

- [Glossary](./glossary.md) — Stave space, Saga, Den
- [Workspace layout](./workspace-layout.md)
- [Lecturn releases (fork)](../operations/lecturn-release.md)
