# Thread notes

> For maintainers. Using Lecturn? See [Thread notes](../user/thread-notes.md).

Notes are project-scoped annotations on rendered user or assistant text. They use a typed SQLite side table outside the orchestration event stream. [ADR 0001](../adr/0001-thread-notes-typed-side-table.md) records the storage decision.

The server derives project ownership from the thread, preserves orphaned notes, and computes anchor availability from thread, project, and message projections. Read authorization permits listing; operate authorization is required for mutations. Client-minted IDs make identical create retries idempotent and conflicting retries fail explicitly. List responses are bounded to 500 rows and report truncation.

The optional `threadNotes` capability gates client queries and entry points. Shared runtime atoms canonicalize environment/project query keys and invalidate reads after mutations. Web pending rows and held ranges bridge the mutation/refetch interval. Changes reach other clients on refresh or focus; there is no note push stream.

Anchors reuse citation offsets, selected text, and prefix/suffix matching. Offsets index normalized rendered text, not the stored message string. Notes preserve the existing citation URL format. Assistant notes become ordinary citation chips when inserted; user notes remain notes only.

Persistent highlights have a shared viewport observer to detect both source mutations and virtualized ancestor moves. Resolution batches all selectors for a source into one text walk per frame. Existing ranges are repaired in place. Separate highlight names and priorities keep note, active-note, comment-editor, and navigation-pulse painting independent. Persistent notes never pin virtualized rows. Unsupported browsers still have the Notes panel and citation navigation fallback.

Highlight hit testing skips interactive controls and non-collapsed text selections, prefers native highlight hit testing, then uses caret fallbacks. Shorter overlapping anchors win. A highlight opens Notes; a note navigates with existing citation paging and folding support. User-message bodies expand before navigation completes.

Native mobile note UI is deferred. The contracts and query atoms are platform-neutral. Local SQLite migration 054 is automatic; no relay schema or service changes are needed.
