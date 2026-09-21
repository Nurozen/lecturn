# Thread forking

> For maintainers. Using Lecturn? See [Forking threads](../user/forking-threads.md).

A fork is a new thread aggregate that carries a copy of its source thread's history through a
fork point (a turn boundary, inclusive), plus lineage, and whose provider session is forked
natively the first time the user sends a message in it. The guiding invariant: the fork is a
perfect reconstruction of its parent at the fork point, and deviates only through user or agent
action afterwards.

## Command and materialization

Clients dispatch a small `thread.fork` command ([`orchestration.ts`][contracts],
`ClientThreadForkCommand`): a client-minted child `ThreadId`, the source thread, the fork turn
(`throughTurnId`), and a workspace choice that defaults to inheriting the parent's
branch/worktree. The server-materialized shape shares the `"thread.fork"` type literal but lives
in the dispatch union only; the normalizer rejects a raw client fork on any transport that skips
materialization, so a partial fork can never reach the decider ([`Normalizer.ts`][normalizer]).

The ws dispatcher ([`ws.ts`][ws]) materializes the command before normal dispatch. It
canonicalizes the client timestamps first — the child's `createdAt` becomes server time, which
the auto-retitle gate and message ordering depend on — then feeds the source thread's detail,
its turn rows (`listThreadTurnsById`), its full activity history, its fork context, and its live
provider binding into the pure assembler `assembleThreadFork`
([`threadFork.ts`][threadfork]). The branch also enforces the guards: the `threadForking`
capability/kill-switch, an existing and non-deleted source in the same project, no running turn
at the fork point, and (in v1) workspace inheritance only.

`assembleThreadFork` does no IO. It slices the history through the fork turn, mints child-side
ids for copied messages, activities, and proposed plans — turn ids are preserved, so the
fork-point reference and checkpoint turn numbering stay stable across the copy — re-namespaces
canonical checkpoint refs to the child's `turn/<n>` names, plans deterministic attachment copies (child attachment ids are uuid-v5 of the source id
and child thread id, so retries land on the same files), and snapshots the provider session into
`forkSource`. Open async questions (a message-mode `user-input.requested` with no later
`user-input.resolved` in the copied range) stay with the source: the decider derives the
answer's activity and message ids from the request id alone, so a copied request answered in both
threads would re-parent the first answer's rows onto the second thread. Answered questions copy
as request/resolution pairs, so the child rejects a second answer the same way the source does. It returns the materialized command plus the side-effect plans. The dispatcher
runs those side effects before dispatch — checkpoint ref aliasing all-or-nothing with
compensation of partial aliases, attachment file copies rolled back on failure — then dispatches
and records the `client.thread.forked` analytics event once on success.

## Decider and projection

The `thread.fork` case in [`decider.ts`][decider] validates the materialized command against the
read model and emits two events on the child aggregate: `thread.created` followed by
`thread.forked`. The `thread.forked` payload carries `forkedFrom` lineage, the nullable
`forkSource` provider snapshot, the full `ThreadForkHistory`, and the source thread's linked
pull request (inherited per the reconstruction invariant). As a belt, a `thread.fork` without a
materialized history is rejected with an invariant error.

Projection splits by arm. The SQL arms in [`ProjectionPipeline.ts`][pipeline] turn the history
into real rows — messages, activities, proposed plans, and the inherited turn rows including each
turn's `providerTurnRef` — while its threads arm stamps the `forkedFrom`/`forkSource` lineage on
the child row, sets `latestTurnId` to the fork turn, and refreshes the thread shell summary. The
in-memory model in [`projector.ts`][projector] projects only lineage and summary state (fork
origin, linked pull request, latest turn, proposed plans); message and activity bodies stay empty
there because the in-memory model mirrors post-boot hydration, which seeds those arrays empty.
Migration [`048_ProjectionThreadForkLineage.ts`][mig048] adds `forked_from_json` and
`fork_source_json` to `projection_threads` and `provider_turn_ref` to `projection_turns`.
[`ProjectionSnapshotQuery.ts`][snapshot] exposes the lineage via `getThreadForkContextById` and
the turn rows via `listThreadTurnsById`. Inherited rows keep their original timestamps; only the
child thread's `createdAt` is the fork time.

Checkpoint refs live under a shared per-repository ref store, so the child's inherited
checkpoints are plain ref aliases: `CheckpointStore.aliasCheckpointRefs`
([`CheckpointStore.ts`][ckpt]) points the child's canonical `turn/<n>` refs — the names already
embedded in the copied history — at the source's checkpoint commits. Turn diffs and reverts into
inherited history then work in the child without copying any git data.

## Lazy native provider fork

The child has no provider session until its first send, like any new thread. When the first turn
starts, `resolveForkStartOptions` in [`ProviderCommandReactor.ts`][reactor] checks the fork
context: only a child with a `forkSource` and no provider binding of its own forks; once a
binding exists, restarts resume the child's own cursor and never re-fork. The parent's live
cursor is preferred over the persisted snapshot (the snapshot goes stale if the parent keeps
working), and the session start receives a `fork` input with the source cursor, the fork point's
`providerTurnRef`, `throughTurnOrdinal`, and an `atEnd` flag.

Each adapter maps that input onto its provider's native mechanism
(capability declarations in [providers.md](./providers.md#adapter-capabilities)):

- **Codex** passes a `fork` runtime option whose `lastTurnId` is the recorded provider turn ref
  (falling back to the Lecturn turn id). The child never inherits the source's resume cursor — the
  forked session mints its own.
- **Claude** resumes the parent session with `forkSession: true`, plus `resumeSessionAt` set to
  the fork point's provider turn ref for mid-thread forks; the SDK mints the child session id at
  init. Seeding a session id instead would write into the parent's history.
- **OpenCode** calls `session.fork` and, for a mid-thread fork, `session.revert` to the fork
  turn's assistant message in the forked session.
- **Cursor** and **Grok** declare `conversationFork: "unsupported"` and fail a start that
  carries a `fork` input with a `ProviderAdapterValidationError` — no silent cold session.

The `providerTurnRef` anchors come from turn completion: a `thread.session-set` event carries
the provider's native turn id in its event metadata alongside the completed turn id, and
[`ProjectionPipeline.ts`][pipeline] stamps it onto the completed turn row. Turns completed
before this feature shipped have no anchor, which is why mid-thread fork points on such Claude
turns are unavailable (fork at end still works).

A fork also auto-titles like a fresh thread: the first-turn title gate in
[`ProviderCommandReactor.ts`][reactor] treats the first user message newer than the thread's
`createdAt` as the first turn, and clients seed the title with "&lt;parent title&gt; (fork)" so
replacement is allowed.

## Kill-switch

The `LECTURN_THREAD_FORKING` server config toggle (default on) drives the `threadForking`
capability advertised by [`ServerEnvironment.ts`][env] and is enforced again inside the ws fork
branch with a typed "unsupported" rejection, so disabling it both hides the action on clients
and hard-stops forks from older or misbehaving ones.

## Importing external sessions

An imported thread is a new thread aggregate created from an
[external session](./providers.md#external-sessions), a provider session made outside Lecturn. It
reuses the fork history payload and projection arms but is not a fork: there is no parent thread,
the history carries no turns and no checkpoints, and the native provider fork is cut eagerly while
the command is materialized, so the first send plainly resumes that fork. The original session is
never resumed or written. The fork is eager because Codex serves no turns for a thread it has not
loaded, and forking is what loads one without touching the source; because both providers' forks
are local, cheap, and need no auth or model call; and because a session that cannot be forked then
fails the import rather than the first message.

Clients dispatch `thread.import` (`ClientThreadImportCommand` in [`orchestration.ts`][contracts]):
a client-minted `ThreadId`, the project, the provider instance, the `sessionId` from
`externalSessions.list`, an optional title, and the usual thread settings. As with forks, the
materialized `ThreadImportCommand` shares the type literal, lives in the dispatch union only, and
the normalizer rejects the client shape. The fork is the materializer's only side effect and
cannot be undone, so `dispatchThreadImport` in [`ws.ts`][ws] validates first: the `threadForking`
kill-switch, the command's receipt (a retried import returns the recorded outcome instead of
forking twice), an existing project, an unused thread id, a model selection on the instance the
session comes from, and the Stave worktree rule the skipped normalizer would have applied. Only
then does it call the optional `ProviderInstance.importExternalSession` seam
([`ProviderDriver.ts`][driver]), which returns the fork's resume cursor, the session's title and
cwd, and a provider-neutral transcript. The `thread.import` case in [`decider.ts`][decider] keeps
the fork's materialization belt, requires the project and an absent thread, and emits
`thread.created` then `thread.imported`. The fork arms in [`ProjectionPipeline.ts`][pipeline]
write the message and activity rows; the threads arm leaves `latestTurnId` null.

Two things are stored, in columns added by [`053_ProjectionThreadImportOrigin.ts`][mig053].
`importedFrom` (`ThreadImportOrigin`) is client-visible on thread shells and details: instance,
driver kind, the original session's id, cwd and title, `importedAt`, and `historyTruncated`.
`importSource` (`ThreadImportSource`) holds the fork's opaque resume cursor and is server-only: it
rides the persisted event but never a wire thread shape, and is read only through
`getThreadImportSourceById` and `listThreadImportSources` in
[`ProjectionSnapshotQuery.ts`][snapshot]. On the first send, `resolveImportStartOptions` in
[`ProviderCommandReactor.ts`][reactor] passes it as the session start's `resumeCursor` when the
thread has no provider binding yet. The cursor only means something to the instance that cut the
fork, so a first send on any other instance fails the turn start rather than binding a cold
session under history it never saw; switching back resumes as usual. Until that first send the
fork has no binding, so `externalSessions.list` also hides every stored import cursor: a Claude
fork keeps its source's entrypoint and would otherwise be listed and importable again.

`buildImportedThreadHistory` ([`threadImport.ts`][threadimport]) is pure. It keeps the session's
last 200 messages (and, within that window, the newest 1,000 activities), caps message text at
20,000 characters with a visible suffix, and reduces activities to summary rows — a title, an item
type, one short detail line — that never carry a tool input or output. Every row has a null
`turnId`. Timestamps are rewritten to be strictly increasing and no later than the command's
`createdAt`, which is also `importedFrom.importedAt`, because projections order by timestamp and
then by random id, so ties would shuffle the transcript. `historyTruncated` records that rows were
dropped or text was capped. Titles, the session's and a client-supplied one, are capped at 200
characters in `importExternalSession` ([`externalSessions.ts`][external-service]).

Those two properties define an imported history row: `isImportedHistoryRow` in
[`orchestration.ts`][contracts] is true for a turnless row stamped at or before
`importedFrom.importedAt`. The boundary is the import time rather than the thread's `createdAt`
because a fork of an imported thread copies the imported rows: `assembleThreadFork` carries
`importedFrom` onto the child when it keeps at least one of them (never `importSource`; the child
forks the parent's live session), and the child's own creation time would also cover the parent's
genuine turnless user messages. Three places depend on it. `retainProjectionMessagesAfterRevert`
always keeps imported messages and leaves them out of its per-turn fallbacks. The queued-turn
heuristics (`threadHasQueuedTurnStart` in [`ThreadSettlementPolicy.ts`][settlement], the client's
`hasQueuedTurnStart` in [`threadSettled.ts`][settled]) never treat an imported user message as a
pending start. The client revert reducer ([`threadReducer.ts`][reducer]) keeps imported messages
as the server does. One windowing rule completes this: in `getThreadDetailSnapshot`, the page that
holds the thread's oldest turn has no lower bound, so it also returns the older turnless rows,
which have no older page to land on.

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

Known limits: a forked session is never cleaned up, so an orphan stays in the provider home when
a Codex fork holds no messages (its turns cannot be read before forking) or the dispatch fails
after the fork. The first-turn gate in
[`ProviderCommandReactor.ts`][reactor] counts imported user messages, so an imported thread's first
send generates no title; the title already comes from the external session. The message cap bounds
only what Lecturn shows: the first resumed turn makes the provider re-read the whole session.

[contracts]: ../../packages/contracts/src/orchestration.ts
[normalizer]: ../../apps/server/src/orchestration/Normalizer.ts
[ws]: ../../apps/server/src/ws.ts
[threadfork]: ../../apps/server/src/orchestration/threadFork.ts
[decider]: ../../apps/server/src/orchestration/decider.ts
[projector]: ../../apps/server/src/orchestration/projector.ts
[pipeline]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[snapshot]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[mig048]: ../../apps/server/src/persistence/Migrations/048_ProjectionThreadForkLineage.ts
[ckpt]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[reactor]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[env]: ../../apps/server/src/environment/ServerEnvironment.ts
[threadimport]: ../../apps/server/src/orchestration/threadImport.ts
[mig053]: ../../apps/server/src/persistence/Migrations/053_ProjectionThreadImportOrigin.ts
[external-contract]: ../../packages/contracts/src/externalSessions.ts
[external-service]: ../../apps/server/src/provider/externalSessions.ts
[driver]: ../../apps/server/src/provider/ProviderDriver.ts
[claude-import]: ../../apps/server/src/provider/Drivers/ClaudeExternalSessionImport.ts
[codex-import]: ../../apps/server/src/provider/Drivers/CodexExternalSessionImport.ts
[settlement]: ../../apps/server/src/orchestration/ThreadSettlementPolicy.ts
[settled]: ../../packages/client-runtime/src/state/threadSettled.ts
[reducer]: ../../packages/client-runtime/src/state/threadReducer.ts
