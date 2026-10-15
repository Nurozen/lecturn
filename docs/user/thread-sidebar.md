# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, Lecturn stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

On mobile, use a thread's branch action to start a task on the same branch.
Submitting a task opens its conversation immediately while
Lecturn creates the thread. If creation fails, retry from the conversation or
return to the draft to edit it; your message and attachments remain available.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

Arrangement stays within the current account section. In the project hierarchy, drag within
the same project; each project has its own Settled shelf. Dragging never changes a thread’s project.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging. The other rows slide aside to show
where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also identify empty sections and a
collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a pinned or active thread's menu and choose **Move up** or **Move down**. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the Lecturn server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered message-mode async questions without
sending an answer or restarting the agent.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, except in a Stave space, where an open pull request in any editable
repo keeps the space's threads active. An old closed or merged pull request does
not settle work you resumed after it closed. Settlement uses the actual close or merge time;
later pull request edits do not make old work eligible again. For a Stave space, every
editable repo and any linked pull request must have a terminal time before PR-based
settlement can apply.

**Settled** is an expandable group beneath each project, Stave space, or saga in the project
hierarchy. Its red-gold connectors and check marks distinguish finished conversations. The flat
sidebar keeps its shared Settled section.

Opening a settled thread keeps its conversation visible. The composer becomes an **Unsettle**
control with a red-gold border; unsettle before writing another message. Existing drafts are
preserved. The thread tooltip also labels its settled state.

Change these rules in **Settings → General**. They continue to run when your apps
are closed. Changes apply to connected environments that support shared settings;
offline environments and older servers keep their previous values. If connected
environments disagree, **Apply to all** copies your current settings to those named
in the warning. Changing a rule does not reopen already settled threads.

Answered questions and resolved approvals stay closed if a provider replays the
request or delivers its events out of order. A stale or unknown request no longer
blocks settlement or snoozing; a temporary reply failure keeps it open for retry.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

In a Stave space with one editable checkout, automatic links follow that
checkout's current branch. Spaces with several editable checkouts need an
explicit thread link; per-repository PR watches remain available.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

On mobile, the work log groups subagents and shows how many are still working.
Before a workflow reports its members, its coordinator shows its own status and
details. Once members arrive, the group counts those members and lists their results.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

A single completed call appears directly in the conversation; select it to open its details.
Calls that arrive after an assistant response stay visible below that response, followed by
its copy, fork (when available), and timestamp controls. In a forked conversation, inherited
calls and response controls remain above the fork divider.

Long groups scroll inside a bounded area without expanding the whole conversation. Faded edges
indicate more calls above or below. Short groups use only the space they need.
Collapsing and reopening a group preserves your reading position and any open call details.
Open details also survive collapsing and reopening the turn's "Worked for" section.

Recognized Lecturn tools use descriptive labels in both the running summary and individual rows.
The latest live activity stays in the present tense while the turn continues, such as
"Running vp" or "Clicking in the preview browser", even after that call has completed.
Expanded rows follow the call's own state, such as "Clicked" after success.
When a call has not reported a state yet, the label stays in the present tense.
Failed, declined, and stopped calls say what happened without implying success.
Failed calls keep their tool icon with a muted red tint, so a failed command still
looks like a command. App logos and other multicolor icons keep their artwork and
show a small muted red failure mark beside the row. Expand the call to inspect its
output. Runtime errors and warnings keep their stronger styling.
Preview browser actions use a globe icon. Other Lecturn tools keep the Lecturn mark.
Group summaries count browser actions separately, such as "Used browser 18 times" or
"Ran 4 commands and used browser 15 times". Browser-only groups also use a globe icon.

Command summaries show the program inside a shell wrapper, such as "Running vp" for
`/bin/zsh -lc 'vp test run'`. Expanded rows keep the full command.

On web and desktop, image previews from agent activity stay visible in the conversation while
the agent works and after the turn finishes. You do not need to expand the call or the
"Worked for" section to see them. Select a preview to open the image viewer.

## Stave lifecycle notices

Stave projects show archive reminders or cleanup refusals beside their project information.
Open project settings for Archive now or Keep; deleted projects with unfinished cleanup appear
in Settings → Stave. See [Stave spaces](./stave.md#automatic-cleanup) for policy and recovery.

Settled conversations retain a read-only model, reasoning/options, and access-mode strip beneath Unsettle. Context usage remains visible when available.

Stave spaces and sagas carry a staff icon in their parent heading. Nested conversation rows avoid repeating the workspace type; repository details remain available in the workspace controls and tooltips.

## Connect account sections

When multiple Connect accounts are available, each account has its own section. Projects from different accounts stay separate even when they use the same repository. Collapse a section to hide its conversations; its approval, input, and plan attention summary remains visible. Direct connections appear after the account sections.

Use the account menu’s **Label and color** action to distinguish personal and work accounts. Labels and color choices follow the account across devices. The conversation and composer use that account’s tint; the sidebar keeps your chosen base theme.
