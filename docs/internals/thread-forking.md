# Thread forking

> For maintainers. Using Lecturn? See [Forking threads](../user/forking-threads.md) and
> [Importing sessions](../user/importing-sessions.md).

A fork is a new thread aggregate that carries a copy of its source thread's history through a
fork point (a turn boundary, inclusive), plus lineage, and whose provider session is forked
natively the first time the user sends a message in it. The guiding invariant: the fork is a
perfect reconstruction of its parent at the fork point, and deviates only through user or agent
action afterwards.

## Command and planning

Clients dispatch `thread.fork` ([`orchestrationV2.ts`][contracts]): a client-minted
`targetThreadId`, the source thread, a `sourcePoint` (`latest_stable`, a run, or a checkpoint),
an optional title, and three Lecturn fields: `sourceMessageId` (the user message the fork is cut
at, inclusive), `workspace` (`inherit` by default, or `new-worktree`), and `prepareWorktree`
(required with `new-worktree`). The ws dispatcher ([`ws.ts`][ws]) applies the kill-switch below,
then hands the command to the V2 orchestrator and records `client.thread.forked` on success.

`dispatchThreadFork` in [`Orchestrator.ts`][orchestrator] resolves the source run. A
message-anchored fork cuts at the run that user message started (`resolveForkCut` in
[`ThreadForkDeltas.ts`][deltas]); otherwise the run comes from the source point. Only
provider-finished runs are forkable: completed, waiting (checkpoint capture pending), failed,
interrupted, or cancelled. In-progress and rolled-back runs are rejected. A message inside
imported history has no run and is rejected too; fork after a turn sent in Lecturn instead.

The upstream [`ThreadForkService.ts`][forkservice] plans the child as a copy of the source app
thread with fork `lineage`, `forkedFrom: { type: "run", threadId, runId }`, no provider thread,
and a default title of "&lt;parent title&gt; fork". It also plans a pending `fork` context
transfer. The spread of the source thread carries `importedFrom` and the linked pull request onto
the child. `applyForkDeltas` then adds the Lecturn fields: `forkOrigin` (`{ threadId, messageId }`,
with `messageId` null for a fork at the end) and, for `new-worktree`, the branch and worktree that
`provisionForkWorktree` created. A child on a new branch drops only the branch pull request found
for the parent's branch. The orchestrator emits `thread.created` and `context-transfer.created`.

## Inherited history

Nothing is copied. The child's projection reads the source's turn items through the fork run,
adds a synthetic `fork` marker item, then appends its own items (`buildVisibleTurnItems` in
[`ProjectionStore.ts`][projection]). History paging follows `forkedFrom` into the source, and a
fork of a fork chains. Shell item counts include the inherited prefix. A V1 fork migrated by the
[legacy importer](./legacy-orchestration-migration.md) is different: V1 copied the parent's
history into the child, so the importer keeps that copy as the child's own transcript, records
the parent in `lineage`, leaves `forkedFrom` null, and keeps the user-facing fork point in
`forkOrigin`. `forkOrigin` exists for that reason; V1 fork points have no V2 run to reference.

## Native fork or portable handoff

The child has no provider session until its first send. At turn start the pending fork transfer
is resolved by `decideForkExecution` in [`CommandPolicy.ts`][policy]. A native fork needs a
provider-finished run that completed (or is waiting), the same provider instance as the source,
a strong native thread ref on the source, and adapter capabilities `threads.canForkThread`
(plus `canForkFromTurn` when cutting at a specific run). The turn start then calls the adapter's
`forkThread` with the source provider thread and the provider turn of the fork run
([`ProviderTurnStartService.ts`][turnstart]). Codex uses `thread/fork`, Claude calls the Agent
SDK's `forkSession` (with `upToMessageId` for a mid-thread cut), and OpenCode calls `session.fork`.
Capability declarations are in [providers.md](./providers.md#adapter-capabilities).

Everything else takes a portable context handoff: the child starts a fresh provider session
seeded with a bounded transcript of the source up to the fork point (`full_thread_summary`; see
[context-handoffs.md](./context-handoffs.md)). That covers providers without a native fork
(Cursor and ACP agents that do not advertise `session.fork`), a different provider instance than
the source's, and sources whose run failed, was interrupted, or has no strong native thread id.
Every provider can fork.

A child that still has its default fork title generates a real title on its first new turn
(`shouldGenerateForkChildTitle`). An explicit title is kept.

## Kill-switch

The `LECTURN_THREAD_FORKING` server config toggle (default on) drives the `threadForking`
capability advertised by [`ServerEnvironment.ts`][env]. `forkKillSwitchRejection` in
[`ws.ts`][ws] enforces it again: it rejects `thread.fork` and `thread.import` (which natively forks
the external session) before either reaches the orchestrator. Disabling it hides the action on
clients and hard-stops forks from older or misbehaving ones.

## Importing external sessions

An imported thread is a new thread created from an
[external session](./providers.md#external-sessions), a provider session made outside Lecturn. It
is not a fork: there is no parent thread, and the imported history belongs to no run, so it has no
checkpoint and nothing to revert or queue. The native provider fork is cut eagerly while the
command is dispatched, and the new thread binds it as its provider thread, so the first send
plainly resumes that fork as run 1. The original session is never resumed or written. The fork is
eager because Codex serves no turns for a thread it has not loaded, and forking is what loads one
without touching the source; because both providers' forks are local, cheap, and need no auth or
model call; and because a session that cannot be forked then fails the import rather than the
first message.

Clients dispatch `thread.import` ([`orchestrationV2.ts`][contracts]): a client-minted `threadId`,
the project, the provider instance, the `sessionId` from `externalSessions.list`, an optional
title, and the usual thread settings. The fork cannot be undone, so everything is validated
first: the kill-switch in [`ws.ts`][ws], the V2 command receipt (a retried import returns the
recorded outcome instead of forking twice), Stave admission through the orchestration hooks, and,
in `dispatchThreadImport` ([`Orchestrator.ts`][orchestrator]), a model selection on the instance
the session comes from, an existing project, and an unused thread id. Only then does
`ExternalSessionImporterV2` ([`ThreadImport.ts`][threadimport]) call the optional
`ProviderInstance.importExternalSession` seam ([`ProviderDriver.ts`][driver]), which returns the
fork's native thread id, the session's title and cwd, and a provider-neutral transcript. The
orchestrator emits `thread.created`, `provider-thread.updated` (the fork, with a strong native
ref), one `message.updated` or `turn-item.updated` per history row (all with a null `runId`), and
`thread.imported`. The app thread payload carries `importedFrom` (`ThreadImportOrigin`):
instance, driver kind, the original session's id, cwd and title, `importedAt`, and
`historyTruncated`. The fork's native id lives only on the provider thread, which is also how
`externalSessions.list` hides sessions Lecturn already owns: a Claude fork keeps its source's
entrypoint and would otherwise be listed and importable again.

`buildImportedThreadHistoryV2` ([`ThreadImport.ts`][threadimport]) is pure. It keeps the session's
last 200 messages (and, within that window, the newest 1,000 activities), caps message text at
20,000 characters with a visible suffix, and reduces activities to summary rows — a title, an item
type, one short detail line — that never carry a tool input or output. Every row has a null `runId`,
and ids derive from the thread id and position, so a replayed plan is identical. Timestamps are
rewritten to be strictly increasing and no later than `importedFrom.importedAt`, so ties cannot
shuffle the transcript. `historyTruncated` records that rows were
dropped or text was capped. Titles, the session's and a client-supplied one, are capped at 200
characters in `importExternalSession` ([`externalSessions.ts`][external-service]).

Those two properties define an imported history row: `isImportedHistoryMessage` in
[`orchestrationV2.ts`][contracts] is true for a run-less message stamped at or before
`importedFrom.importedAt`. The boundary is the import time rather than the thread's creation
because a fork of an imported thread keeps `importedFrom` (it rides the spread of the source
thread) and inherits the imported rows, while its own creation time would also cover genuine
run-less messages. The queued-turn heuristics (`threadHasQueuedTurnStart` in
[`ThreadSettlementService.ts`][settlement], the client's `hasQueuedTurnStart` in
[`threadSettled.ts`][settled]) never treat an imported user message as a pending start. A fork
can only be cut at a run, so a message inside imported history cannot be a fork point.

- **Claude** ([`ClaudeExternalSessionImport.ts`][claude-import]) forks the whole session with no
  anchor message and no `cwd`: the SDK rejects a fork directed at another project, and a fork
  written beside its source resumes from any cwd. The source is read first, so a session with no
  messages fails as `empty-session` before a fork file exists; the history is then read back from
  the fork, so it is what the model resumes with. A half-written final line, as left by a session still being
  appended to, is tolerated. The SDK readers follow `process.env`, so only an instance on the
  server process's own Claude home has an importer.
- **Codex** ([`CodexExternalSessionImport.ts`][codex-import]) calls `thread/fork` on a
  short-lived app-server, then reads the fork's turns newest first and stops once it holds more
  messages than the import keeps, so a very large session costs a few pages instead of timing out
  after the fork exists. When the tail is unfinished it forks again at the last completed turn, leaving the first fork as an unused rollout that never shows in
  `thread/list`. The fork references the original rollout rather than copying it, so deleting the
  original session breaks the imported thread. An archived source cannot be forked.

Nameable failures travel as `threadImportFailure` on the dispatch error
(`ExternalSessionImportFailure` in [`externalSessions.ts`][external-contract]):
`forking-disabled`, `provider-unsupported`, `provider-unavailable`, `session-not-found`,
`unreadable`, and `empty-session`. The other pre-fork rejections are plain dispatch errors.

The web client derives an imported thread's look from `importedFrom` alone, in
[`ChatView.logic.ts`][web-logic]. `resolveThreadImportDivider` draws the import divider above the
first message that is not imported history, or at the end until one exists; a fork of an import
also gets the fork line from its inherited V2 items. `deriveUnsentImportInstanceId` pins the
composer to `importedFrom.providerInstanceId` until the thread's first run, unless it is a fork;
the fork only resumes on the instance that cut it. Models within that instance stay selectable.
`shouldShowImportTruncatedNote` waits for the oldest page, so the truncated-history note appears
only once there is nothing earlier to load.

The picker is a command palette sub-page, opened by the palette's "Import session…" action (and the
legacy sidebar's project menu, which opens the same page). A session is importable only when its
cwd equals a project root or a known thread `worktreePath`; every other cwd, including a git
worktree Lecturn does not manage, renders as a disabled row, so a thread's `worktreePath` never
points at an unmanaged folder and never differs from the session's folder. The import carries
runtime and interaction mode from the viewed thread through the same `resolveCarriedThreadModes`
helper a new thread uses, falling back to the contract defaults only when nothing is being viewed.

Known limits: a forked session is never cleaned up, so an orphan stays in the provider home when
a Codex fork holds no messages (its turns cannot be read before forking) or the dispatch fails
after the fork. Title generation on a first send counts imported user messages, so an imported
thread's first send generates no title; the title already comes from the external session. The message cap bounds
only what Lecturn shows: the first resumed turn makes the provider re-read the whole session.

[contracts]: ../../packages/contracts/src/orchestrationV2.ts
[web-logic]: ../../apps/web/src/components/ChatView.logic.ts
[ws]: ../../apps/server/src/ws.ts
[orchestrator]: ../../apps/server/src/orchestration-v2/Orchestrator.ts
[forkservice]: ../../apps/server/src/orchestration-v2/ThreadForkService.ts
[deltas]: ../../apps/server/src/orchestration-v2/fork/ThreadForkDeltas.ts
[projection]: ../../apps/server/src/orchestration-v2/ProjectionStore.ts
[policy]: ../../apps/server/src/orchestration-v2/CommandPolicy.ts
[turnstart]: ../../apps/server/src/orchestration-v2/ProviderTurnStartService.ts
[env]: ../../apps/server/src/environment/ServerEnvironment.ts
[threadimport]: ../../apps/server/src/orchestration-v2/fork/ThreadImport.ts
[external-contract]: ../../packages/contracts/src/externalSessions.ts
[external-service]: ../../apps/server/src/provider/externalSessions.ts
[driver]: ../../apps/server/src/provider/ProviderDriver.ts
[claude-import]: ../../apps/server/src/provider/Drivers/ClaudeExternalSessionImport.ts
[codex-import]: ../../apps/server/src/provider/Drivers/CodexExternalSessionImport.ts
[settlement]: ../../apps/server/src/orchestration-v2/ThreadSettlementService.ts
[settled]: ../../packages/client-runtime/src/state/threadSettled.ts
