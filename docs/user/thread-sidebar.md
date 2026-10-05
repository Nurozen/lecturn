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

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work. Drag pinned threads
to reorder them on web and desktop, or use **Move up** and **Move down** on mobile.
The order syncs across devices.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, except in a Stave space, where an open pull request in any editable
repo keeps the space's threads active. An old closed or merged pull request does
not settle work you resumed after it closed.

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

## Link a pull request

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread**. Use **Unlink from thread** on the same link to remove it.
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
