# Thread forking

> For maintainers. Using T3 Code? See [Forking threads](../user/forking-threads.md).

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
`forkSource`. It returns the materialized command plus the side-effect plans. The dispatcher
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
  (falling back to the T3 turn id). The child never inherits the source's resume cursor — the
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

The `T3CODE_THREAD_FORKING` server config toggle (default on) drives the `threadForking`
capability advertised by [`ServerEnvironment.ts`][env] and is enforced again inside the ws fork
branch with a typed "unsupported" rejection, so disabling it both hides the action on clients
and hard-stops forks from older or misbehaving ones.

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
