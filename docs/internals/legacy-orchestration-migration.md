# Legacy orchestration migration

Orchestration v2 snapshots `state.sqlite` into `statev2.sqlite` before opening writable persistence
on its first launch. Only the copy receives v2 migrations; the original remains available to v1.
Subsequent launches reuse the copy without refreshing it from v1. It creates v2 thread shell events first and imports
the complete user and assistant transcript lazily when a client reads or continues the thread. The
v1 projection tables remain the import source and provide a read-only recovery source if an import
needs investigation.

## Imported data

The shell import preserves the project and thread identifiers, title, provider and model selection,
runtime and interaction modes, branch, worktree path, creation and update times, archive and delete
times, settlement override and timestamps, snooze timestamps, pin timestamp and order, and linked
pull request. The metadata repair path fills snooze, pin order, `unsettledAt`, and linked pull request
fields for threads imported before those fields were covered.

Transcript import reads user and assistant rows from `projection_thread_messages`. It preserves
message identifiers, text, supported attachments, timestamps, role, and ordering. A message that was
still streaming becomes an interrupted turn item.

The importer does not translate provider session identity, native provider runs, checkpoints and
diffs, activities and tool calls, approvals, or proposed plans. V2 therefore must not present those
records as migrated history.

## First continuation

A migrated thread has no active provider thread. Its first continuation creates a fresh provider
session and sends a legacy handoff built only from user and assistant messages. The handoff selects
the newest transcript suffix within a 32,000-character budget, including section labels and the
import notice. This budget is separate from portable provider handoffs.

## Client and server cutover

Clients and servers must agree on `ORCHESTRATION_PROTOCOL_VERSION` (currently 2). The client
runtime appends `orchestrationProtocol=2` to the socket URL, and the `/ws` route rejects a missing
or mismatched version with HTTP 426 (`orchestration_protocol_incompatible`) before any RPC or auth
work runs. The client checks the environment descriptor the same way: a missing version means the
host predates protocol 2, and a different version means both sides need updating. Either direction
blocks the connection as `unsupported` with a message naming the machine to update rather than
running half-upgraded. See `packages/client-runtime/src/connection/compatibility.ts` and
`apps/server/src/ws.ts`.

## Divergent migration ids

`effect_sql_migrations` records `migration_id` and `name`, but the migrator compares ids only:
rows at or below the recorded maximum are skipped without checking names. A database that ran a
local or fork migration under an id this build later assigns to a different migration therefore
never receives this build's migration at that id. After repairing supported V2 preview ledgers,
[`runMigrations`](../../apps/server/src/persistence/Migrations.ts) rejects history that would skip a
requested V2 migration (Lecturn id 70 and later) without its expected name. Earlier name clashes
remain warnings for compatibility with site-local migrations. Upstream's guidance is that a fork
has no safe id range in this ledger, because any id at or below a future upstream id masks that
upstream migration forever. Lecturn instead keeps its own ids and renumbers upstream migrations
above them, as described next.

## Lecturn ledger and fork data

Lecturn's ledger already uses ids 1-69, so upstream migrations are remapped above the fork maximum:
upstream `055_OrchestrationV2` runs as id 70 and `056_RemoveRedundantProjectionIndexes` as id 71
(the files keep their upstream names). Later upstream migrations keep being remapped the same way.
Ids 48-54 were published by both products under different names. Whichever side's migrations a
database ran there, the additive compatibility migrations 64-69 replay both sides' changes, so it
ends with both schemas. The divergence warning stays on, and a known-divergence
map in `Migrations.ts` accepts those upstream names at 48-54 as expected history. `reconcileV2PreviewMigration` only acts on V2 preview ledgers at 53/54, which
no Lecturn database has, so it is inert on Lecturn ledgers.

The `statev2.sqlite` copy is a whole-database snapshot, so fork-owned tables (`thread_notes`,
`decision_*`, `contextual_*`, `stave_*`, `saga_workbench*`, `pull_request_watch*`) travel with it and
remain fork-owned there. Fork readers must use v2 projections and events rather than v1 projection
tables, which v2 stops writing after cutover.

The shell import also carries fork lineage and import origin. `forked_from_json` becomes v2 lineage
(parent thread, `fork` relationship, root thread) and `forkOrigin`; `imported_from_json` becomes
`importedFrom`. The v1 resume cursors (`fork_source_json`, `import_source_json`) and
`projection_turns.provider_turn_ref` are not carried, because migrated threads continue through the
legacy handoff. Message identifiers are preserved, so thread note anchors survive the import.

## Recovery

There is no supported whole-thread export API. Recovery uses an untouched copy of the environment's
`userdata` directory and opens that copy with SQLite's read-only mode. The user guide documents the
queries against `projection_threads` and `projection_thread_messages`. Never start a server against
the recovery copy because startup can run migrations and write new state.
