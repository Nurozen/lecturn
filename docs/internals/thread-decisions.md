# Thread decisions

Decisions is an opt-in, project-scoped derived record. Existing Saved notes remain independent. The desktop/server owns ingestion, source snapshots, job leases, writer execution, notes and review history; shared runtime atoms expose these through environment-scoped RPCs. Native clients read and review the same records.

## Processing and ownership

The ingestion consumer subscribes before capturing its event-feed high-water mark, replays committed messages and atomically advances its cursor with durable jobs. Jobs capture source generation, description revision, funding generation, cancellation epoch and writer binding. Historical scan previews are signed and bounded; enabling tracking does not silently scan old conversations. Project deletion purges dependent Decisions state. Thread deletion retains saved notes and quotes, with unavailable source navigation.

The detector asks fixed Jev existence and relevance questions on bounded canonical Markdown. Positive or uncertain branches subdivide, and a positive parent remains available when child queries lose context. Evidence uses CRLF-normalized JavaScript UTF-16 offsets, hashes and generation checks. Presentation may offer exact highlighting, the containing message, or retained evidence only; it never highlights unrelated text after source edits.

The writer uses the thread's exact provider instance, model, options and configured account. The verified Codex adapter runs an isolated, ephemeral process with no tools, MCP, hooks or workspace writes. Other configurations return an explicit unsupported state. Foreground provider work preempts background writing. Changed selection/auth/configuration invalidates the captured binding; an explicit retry discards incompatible uncommitted writer output.

Writer results are locally validated typed actions: create, duplicate, propose replacement, skip, or request context. Batches and continuation are bounded. Mechanical evidence validation precedes note creation. Notes and job checkpoints commit together behind ownership/funding/source fences. Review state is independent of lifecycle: unreviewed, confirmed and dismissed describe human review, while current and superseded describe replacement history. Approving and undoing replacements preserve edits and comments.

## Cloud boundary

The host sends bounded text to the Decisions relay only after explicit environment funding and project opt-in. The relay authenticates the environment credential, resolves its approved payer, checks settled personal paid access or a Decisions-specific grant, reserves quota and then calls pinned Jev. The writer uses the user's provider subscription separately. The TypeSafe secret is relay-only.

A durable PostgreSQL ledger serializes admission, request fingerprints, account/environment concurrency and operator exposure. Request replay does not repeat upstream calls. Unknown dispatched work retains bounded operator exposure after releasing the user's expired hold; late results cannot debit twice. Payer revocation, unlink and key changes fence work. Local revocation is persisted before its remote call and is retried without re-enabling inference.

See [user behavior](../user/decisions.md) and [configuration and rollout](../operations/decisions.md).
