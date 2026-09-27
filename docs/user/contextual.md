# Contextual

Contextual brings relevant saved Decisions and selected Slack desktop messages into a thread when you send a new task. Enable it in the composer controls. The setting belongs to that thread; a project's default applies only to newly created threads. Existing threads keep their own setting.

Open **Settings → Connections → Contextual** to select sources on the hosting computer, link membership funding, pause collection, inspect the archive, export it, or forget captured content. Remote clients control that host's sources; they do not read Slack on the phone or browser. Source and archive administration requires the host's administrative permission. Read-only connections can inspect attached evidence.

Slack must be installed on the hosting Mac with a supported desktop cache. Contextual can capture messages present in that cache; it cannot promise complete channel history or recover messages Slack has already evicted. Select the workspaces and conversations you want to capture. Unselected conversations are excluded before storage. Collection status explains unsupported cache versions, missing access, and unavailable helpers.

## Membership and control

Decisions and Contextual use one monthly membership token allowance, with usage shown separately by feature. Each feature requires its own approval for the named host. The account shown on the browser approval page pays for the allowance. Canceling a new approval leaves an existing link intact; revoking a feature stops its new paid evaluations. Exhausting the allowance pauses evaluation while eligible local collection and saved data remain available.

If collection cannot start, its status explains whether approval, membership, or a connection check is needed. When funding cannot be confirmed, previously reported token amounts are marked as unconfirmed. You can still pause running collection during a connection problem.

Turning Contextual off stops new automatic attachment in that thread. Pausing collection stops reading new Slack cache changes. Forget removes the selected archived content and its retained derived copies; forgetting a source also deselects it. Turning a feature off or forgetting content cannot retract text already delivered to an agent or an external model.

## When context appears

Contextual considers a bounded candidate set for a new user task. It normally attaches one coherent group of evidence, or at most two related groups. It does not dump the archive into the conversation or keep running during an agent's work. Remaining candidates may be reconsidered when a later user message changes the task; routine acknowledgments do not drain the remaining archive. Longer cached Slack exchanges can be narrowed to relevant original excerpts while preserving needed context. If evaluation stops before it can assess an exchange safely, Contextual reports that it is unavailable for that turn. It does not label an unexamined exchange irrelevant.

Unchanged guidance is normally supplied once per thread. Explicit **Refresh context** permits another bounded assessment. A verified provider compaction can allow relevant guidance to be restored on the next user turn, once for that context epoch. Reconnecting alone does not reset this history. Some providers cannot prove receipt or compaction; their status explains the limitation. Claude currently runs without automatic Contextual attachment.

Restoration can continue over later substantive requests, with each useful item restored at most once in that context. An acknowledgment or a task with no relevant context does not use up that opportunity. Previously supplied guidance can still be checked for conflicts with newly selected evidence without being attached again.

Contextual appears as its own message beside your task. For longer accepted context, it adds a short explanation using the text-generation model configured in Settings. This optional summary arrives after delivery and never delays the agent. The agent receives the full selected original excerpts and their source information; the display summary does not replace them. A compact source preview remains visible while the summary is unavailable or the selected model cannot generate it safely.

Expand the message to inspect the exact evidence, authors, times, attribution, and incomplete-coverage explanations, or exclude an item from the thread. Unknown delivery is labeled explicitly. Forgetting or expiring retained evidence also removes its generated display summary; an older disclosure may then retain only metadata.

Contextual appears as its own card beside the message. Longer accepted context can receive a short display summary using your configured text-generation model; expand the card to inspect the original sources. The agent receives the selected original context, and generating the display summary does not delay its turn. If context could not be added, the card shows the recorded reason and a way to review settings. Routine turns with no relevant new context do not add an empty card.

Saved Decisions include their summary separately from the original supporting quotes. A material change to the saved commitment can be supplied as a correction after evaluation. Cosmetic edits and review changes do not repeat the same guidance.

## Conflicting decisions

A material unresolved contradiction can hold your pending task for review. Choose the applicable claim, keep the scopes separate with clarification, mark a claim obsolete, send without new context, or cancel. Resolution applies to that task; it does not silently rewrite your project Decisions. Later messages in the same thread wait behind the held task, while other threads can continue.

Decision attribution describes who made the choice: user, agent, or user-accepted agent proposal. Review state is separate. Matching occurrences retain their own evidence and review history when consolidated, and consolidation can be undone. Automatic semantic consolidation remains unavailable until its accuracy is qualified.

## Data handling

The local archive and retained evidence live on the hosting environment. Bounded excerpts selected for evaluation are sent to Lecturn’s evaluation service. Accepted context is sent to the thread's configured provider. When a display summary is generated, the same selected evidence is also sent through the configured text-generation model and account. Source text is treated as evidence, not as permission to run commands or change access. The optional Extensions component supplies desktop capture; core Lecturn continues to work without it.
