# 0001. Thread notes use a typed side table

- Status: Accepted
- Date: 2026-09-19

## Context

Thread notes are user annotations anchored to a text range in a chat message, stored per project. They need server persistence so they survive reload and reach other clients on the same environment. A cross-project view and programmatic analysis of note text are planned.

Two storage patterns exist on the server:

- The event-sourced orchestration core: command, decider, event, projector, `projection_*` tables (`apps/server/src/orchestration/`).
- Side tables with their own service and unary RPCs, outside event sourcing. Saga workbench (migration 051) and pull request watches (migration 052) both store one `state_json` blob per row beside a few lookup columns.

## Decision

Thread notes live in a `thread_notes` side table with its own service and RPCs, outside the orchestration core.

The table uses typed columns for every field a query or an index will need: project, thread, message, message role, quote text, comment, and timestamps. Only the range offsets and their prefix and suffix context are stored as JSON.

Rows have no foreign keys. The list query joins the thread and message projections and reports whether each note's anchor still exists, so notes on deleted threads or reverted messages are kept and shown as unresolvable.

## Alternatives

- **New orchestration aggregate.** Notes have no agent semantics, no ordering relationship with thread events, and nothing replays them. The decider and projector changes buy live push to other clients and nothing else. Rejected as too much ceremony for a user annotation.
- **`state_json` blob, matching 051 and 052.** Consistent with the existing side tables, but quote text and comments would only be reachable through JSON extraction, which rules out a plain FTS5 index and makes analysis queries awkward. Rejected because analysis is a stated goal.
- **Client localStorage.** No schema work, but notes would not be shared across windows, clients, or mobile, and the cross-project view would be impossible. Rejected.
- **Foreign keys with cascade delete.** Thread and project deletes are soft (`deletedAt`), so a cascade would never fire. Rejected as misleading.

## Consequences

- Other windows and clients see note changes on their next refetch. There is no push. Adding one later means a streamed RPC, which does not change the table.
- Adding a note field that needs querying is a migration, where a blob would have absorbed it.
- Side tables now follow two conventions. Use a blob for opaque workflow state that only the owning service reads. Use typed columns when the content itself will be searched or analyzed.
- Range offsets index the rendered text of a message, which can differ from the stored message text. Analysis must read the stored quote text and must not slice messages by offset.
