# Decisions

Decisions collects choices made during a conversation into project notes with saved quotations. Open **Notes → Decisions** in a thread, or open **Decisions** from the project's menu. **Saved** continues to hold notes you capture yourself.

On desktop or web, link an eligible personal Lecturn membership as the environment's funding account, then enable tracking for the project. This account funds decision detection; the thread's connected agent writes the note using its configured account, model, and options. Linking for Decisions does not require turning on a remote tunnel or notifications.

Funding approval covers the host. People with permission to operate that host can enable tracking for its projects using the approved allowance. Changing the funding account requires host administration and approval from the new payer. Revoking funding stops new detection across the host.

The default filter tracks agreed architecture, product behavior, scope, and constraints while ignoring exploratory suggestions and routine implementation steps. Optionally describe what matters, such as “architecture and database choices” or “product scope and release decisions.” Tracking starts with new completed messages. Use **Scan existing conversation…** to preview and explicitly start a scan of older messages. Progress and incomplete work stay visible, and scans can be canceled or retried. Pausing a thread leaves the rest of the project running.

Processing details show messages that remain unscanned. Messages received while tracking is paused, or while the live queue is full, require an explicit scan of existing conversation.

Generated notes start **unreviewed**. Confirm, unconfirm, dismiss, or restore them independently of whether they are current or superseded. You can edit the title, note, rationale, and personal comment on desktop/web. A proposed replacement does not supersede its predecessor until you approve the relationship; you can undo that approval.

Each note retains its source quotations. Open a quotation to read a bounded transcript with the exact passage highlighted when it still matches. If the message changed or was removed, the saved quotation remains visible with an explanation. Deleting a thread does not delete its decisions. Deleting the project or purging its Decisions removes the project's decision data.

Search and export include the selected filters. Include dismissed and superseded notes when you want the full record. Export uses one consistent project version; if notes change during export, refresh and try again.

Native mobile supports reading, searching, source viewing, confirm/unconfirm, dismiss/restore, copying, and sharing Markdown or JSON. Configure tracking, scan history, edit notes, approve replacements, or purge data on desktop/web.

If detection is paused by allowance, account access, provider availability, or host power settings, saved decisions remain available. New detection requires funded access and a supported isolated writer. The initial verified writer is Codex CLI 0.155.1 or 0.156.1; other versions/providers show an unsupported explanation. No provider or account is substituted automatically.

## Data and usage

Enabling tracking sends bounded conversation excerpts and your tracking description through Lecturn’s proxy to TypeSafe for detection. Relevant context is also sent to the thread’s configured provider to write the note. Notes, evidence and review history are stored on the hosting environment. Turning tracking off stops new analysis and preserves saved notes; purge removes the project’s Decisions data. Detection and your provider’s subscription usage are separate allowances.
