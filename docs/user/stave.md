# Stave spaces

[Stave](https://github.com/Nurozen/stave) is a command-line tool for agent workspaces. A
_space_ is a directory that Stave fills with checkouts of the repositories a task needs — some
editable on their own branch, some read-only for context — plus any memory stores the task
should carry. The app includes Stave and can also use your own installation. It runs the `stave` command on your server
and never edits a space behind its back. This page covers what the integration does today.

## Enable Stave

Open **Settings** and select **General**, then find the **Stave** section. If the section is
missing, your server was started with the integration switched off (`T3CODE_STAVE=false`).

- **Enable** turns the integration on for this server. Leave it off and existing spaces still
  open as projects; only the Stave-specific status and actions stay hidden.
- The status line tells you what the server found. It takes one of these shapes:
  - `stave <version> (<path>)` — a runnable binary was found; the path shows which one.
  - `Stave binary not found` — nothing runnable in your settings path, the bundled copy, or
    `PATH`. Install Stave or fill in **Binary path**.
  - `Not set up` — the binary runs but there is no config file yet. Use **Set up**.
- **Binary path** points the server at a specific `stave` executable. Leave it empty to use the
  copy bundled with the server, or `stave` on `PATH`. When you set it, that file is used and
  nothing else: a wrong path shows as an error rather than silently falling back.
- **Config path** passes `--config` to every Stave command. Leave it empty to use Stave's own
  default location (`~/.config/stave/config.yaml`).
- **Set up** appears when no config file exists. Enable Stave, then select **Set up** to create
  its directories and config on this server. Progress appears beneath the status row.

Saving any of these fields makes the server look again, so you do not need to restart after
installing Stave or editing its config.

## A space as a project

Add an existing space the same way you add any folder: choose the space root, the directory
that holds `.stave.yaml`. The app recognises the manifest and treats the project as a space. To
make a new space from the app, see [Create a space](#create-a-space).

- **Threads run in the space root.** Every thread works in the root directory, where all the
  space's checkouts sit side by side. The per-thread worktree options you see on ordinary
  projects are not offered, and the project's default environment mode is fixed to local.
  The composer and chat list show **Stave space** with its editable repo count. Open the
  composer's space control to see the working directory and all editable and reference repos.
- **Space Git shows every repo.** Open **Space Git** to see branches, working changes,
  ahead/behind status, conflicts, and pull requests across the space. Select an editable repo
  to review its diff, choose files for a commit, push, or change branches. Each action applies
  to that repo; choosing a Git target keeps the thread in the space root. Reference repos
  offer inspection without write actions.
- **Pull requests span editable repos.** The PR manager lists each editable repository under
  its space, including repositories on different hosts. A thread can show a PR for each repo's
  branch in Space Git. Automatic PR-based settlement waits for all editable repos' PRs to
  finish; a single merged PR cannot settle work while another repo's PR remains open or unknown.
- **Checkpoints are unavailable.** A space spans several repositories, so per-thread checkpoints
  (and the diff and revert built on them) are off in spaces. Use Git in the editable repo
  instead.
- **Archived spaces** show as archived in the project's Stave section. Choose **Unarchive**
  there to review and restore the selected archive before resuming work.

## The Stave section in project settings

Open **Settings**, select **Projects**, and pick the space. The **Stave space** section is
where you can inspect the manifest, edit repos and memory attachments, and review lifecycle
actions. Stave applies each change after you confirm its plan.

- **Space id**, **Kind** (`space` or `saga`), and **State** (live or archived) come from the
  manifest.
- **Repos** lists each checkout with its mode, branch, base, and ref. With Stave enabled and
  runnable, the row also shows the live state Stave reports: how many commits the branch is
  ahead of or behind its base, whether the checkout has uncommitted changes, and a warning when a
  read-only reference checkout has been edited. Live figures refresh every 15 seconds while the
  panel is open.
- **Memories** lists the memory stores the space owns or has attached, with the provider and,
  when Stave can reach it, a short freshness note such as unpushed changes or stale.

## Diagnostics

Open **Settings** and select **Diagnostics** to see the Stave block. It shows the binary the
server would run and where it came from (your settings, an environment override, the bundled
copy, or `PATH`), the config file and whether it exists, the root, bare-repos, and agent-work
directories from that config, whether the memory provider is reachable and its version, and the
last Stave command that failed with its error code. Check here first when a space's live status
is missing or stale.

## Create a space

Open the Command Palette, choose **Add Project**, and pick **New Stave space**. The entry is
listed only when Stave is enabled and the server found a runnable binary; if it is missing,
check the status line under **Settings → General → Stave**. The wizard walks through the steps
below. Nothing is written to disk until you choose **Create** on the Review step, with one
exception: registering a repo is a real Stave change on its own (see [Repos](#repos)).

### Identity

- **Space id** names the directory Stave creates under its agent-work directory. Use letters,
  digits, `.`, `_`, or `-`, starting with a letter or digit. The wizard checks the id as you
  type: an id a live space already uses is refused. An archived space that shares the id only
  produces a warning, because Stave timestamps archive entries and an id can be reused after
  archiving; restoring one of those archives later may need you to say which one.
- **Title** is the project title shown in the sidebar. Leave it empty to use the id.
- **Kind** is a chip: `ticket`, `spike`, `audit`, or `custom` with a word of your own (same
  characters as ids; `review` and `saga` are reserved by Stave).
- **Spec** is optional: paste text, or give an absolute path on the server to a spec file or
  directory. One or the other, not both. Pasted text goes to Stave through a temporary file that
  is removed once the create finishes.

### Repos

The table lists every repository registered with Stave. For each row choose a mode, or leave it
unset to skip the repo:

- **Edit** gives the space its own branch and working checkout of the repo. **Base** is the git
  ref to branch from; leave it empty for the repo's default branch, or pick `space:<id>` from the
  picker to stack on the branch another live space is editing in the same repo.
- **Reference** gives the space a read-only checkout for context. **Ref** pins it; empty means
  the default branch.

Pick at least one repo, or turn on **Empty space** to create a space with no checkouts at all.
Two toggles apply to the whole space: **Include commonly paired references** (Stave's `-c`) adds
reference checkouts of the repositories Stave has learned are usually paired with the ones you
edit, and **Include weak tethers** widens that to weaker pairings.

**Register a repo** adds a repository Stave does not know yet: a name (same characters as ids)
and a clone URL or local path. Registering runs `stave repos add` immediately and shows its
progress, because it clones into Stave's bare-repo cache and Stave's preview of the create
refuses repos it has not registered. A registered repo stays registered even if you cancel the
wizard afterwards.

### Memory

This step appears only when Stave reports a memory provider as available. Add one spec per
store to attach: `.` creates a fresh task store owned by the space, and `provider:id` attaches an
existing den. The suggestions list `.` plus every den attached to a space Stave knows about, so
related work can share memory; you can also type a spec by hand.

### Saga

Optional. Pick a saga to enrol the new space in, then choose the members the new space lands
**after**; Stave uses that order to infer stacking bases, and the Review step shows what it
inferred. Choosing members without a saga is refused. When you start the wizard from inside a
saga, that saga is preselected.

### Review

The exact `stave space create …` line the server will run is shown, followed by Stave's own
dry-run plan, one step per line. The plan comes from Stave with your real registry, so what you
read is what will happen. Pasted spec text appears as `--spec <pasted spec>`. Check the plan,
then choose **Create**.

### Progress

Creation is a streamed list of phases with Stave's notes under each one:

1. **pre-flight** — checks made before Stave runs: Stave is set up, nothing already sits at the
   space's path, and no existing project uses that directory (even through a symlink). Leftover
   `stave/<id>/…` branches from an earlier space with the same id, or several archived spaces
   that match it, are reported as notes and do not stop the create.
2. **space create** — the command from the Review step, including your memory and saga choices.
3. **verify** — Stave reads the new space back and the server confirms the manifest on disk is
   the one this create wrote.
4. **project.create** — the project is created on the server, then opens on your client: its
   latest thread, or a new one.

The operation runs on the server, not in your browser tab, so losing the connection does not
stop it. If the stream drops, the Progress step shows **Disconnected** with a **Reattach**
button; reattaching resumes from the last event you received, and an operation that finished
while you were away can still be read for 24 hours after it ended.

**When a create fails, nothing is undone for you.** If the failure came after Stave wrote the
space (the verify or project step failed), the space stays on disk so you can inspect it, and
the wizard offers **Remove partial space**. Review its dry-run plan and confirm removal of
exactly the space this attempt created. A replacement space with the same id is refused. Dirty
or dependent-space refusals offer a separate Force confirmation; saga membership needs its own
explicit combined removal confirmation. Any task store the create made is destroyed with it; dens you attached from
elsewhere are kept. If the server cannot establish which space this attempt created—for example,
creation timed out after writing files—it reports the uncertain outcome and leaves removal
disabled. Inspect the reported directory before importing it or retrying creation.

## Edit a space

Open the project's settings and find **Stave space**. Enable Stave on that environment to use
its actions. Each action shows Stave's dry-run plan before you confirm it.

- **Add repo** chooses a registered repo, editable or reference mode, and an optional base or
  ref. Use `space:<id>` to stack on another live space. You can choose a branch for an editable
  repo and use cached refs without fetching.
- **Remove** targets the row's exact mode, so an editable and reference checkout with the same
  repo name stay distinct. Committed branches survive removal.
- **Retarget** changes an editable repo's base. **Sync** refreshes the space, optionally limiting
  the work to references.
- **Attach memory** accepts `.` for a fresh store or an existing `provider:store`. Detach can
  keep the store; an owned store also offers an explicit destroy choice. Detach stops the space's provider sessions first so they release their memory connections.

**Archive space** stops the space's sessions, removes its worktrees, and moves it into the
archive. The project follows the archived directory. Its manifest, spec, notes, and committed
branches survive. **Unarchive** restores that exact archive and allows new threads again.

**Destroy space** stops sessions and permanently removes the space directory and project.
Specs and notes are lost; committed branches survive in Stave's repository cache. The dialog
lets you keep memory, contribute and keep it, or destroy owned stores. Read the plan before
confirming. When a space belongs to a saga, the explicit combined action names the saga and
counts the dependent ordering edges it will remove. Partial failure reports what needs repair.

Dirty worktrees and dependent spaces can refuse an operation. Only after such a refusal does
**Review forced operation** appear. It shows a new plan and requires a second confirmation;
Force may discard uncommitted changes. It never bypasses memory-in-use, identity, or nested
project guards. Changes are bound to the space's creation timestamp, so a stale request cannot
act on a replacement space with the same id. Legacy manifests without that timestamp need
repair through Stave before they can be changed here.

The app refuses cleanup when another project uses a directory inside the space or aliases its
root through a symlink. Resolve the overlapping project entry before retrying. If the server
restarts during archive or restore, it reconciles the project with the matching live or archived
space; ambiguous or unreadable results require repair instead of guessing.

PR checkout into a thread is unavailable for Stave-managed repositories. Use the repository
controls in project settings to manage a space's checkout.

## Work with sagas

Choose **New Stave saga** in the command palette to create a coordinator with an id, title,
spec, reference repositories, and optional memory. Review the plan, then create it. The project
opens after the server has created it, including when you reattach after a connection loss.

In the saga's project settings, **Add member** can create a new space or adopt an existing
space. Choose predecessors with **after** to express dependency order. Editing that selection
updates the existing member; clearing it removes its ordering edges. Removing a member leaves
its space on disk and drops the edges that depended on that membership.

The **Sagas** sidebar section and legacy sidebar nest member projects in Stave's dependency
order. Badges show live, archived, missing, or corrupt members, dirty worktrees, and merged
bases. Use the saga row's menu for **Add member** or **Archive saga**. A member without a
visible saga project remains in the ordinary project list. Matching names on different servers
never combine saga membership. Nesting can be disabled in client settings.

**Sync saga** refreshes its members. **Archive saga** and **Destroy saga** show the ordered
teardown plan, memory fate, and losses before confirmation. They stop sessions across all
members. A failure may leave some members already archived or destroyed; Lecturn rereads every
member so their projects follow what actually happened. Force remains a separate explicit
choice after a refusal. Archived survivors can be restored from their own project settings.

Saga archive and destroy confirmations list every affected space. Destroy also names imported
member projects and counts the conversations it removes, including archived threads. This
applies when deleting the saga's project from the sidebar or project settings as well. If the
roster or affected projects change after review, cleanup stops for another confirmation. If the
scope cannot be read, deleting the coordinator project leaves saga cleanup pending review in
Stave settings.

When **settle on saga merge** is enabled, a live member becomes an automatic settlement
candidate only when every editable repository reports a merged base. A partially merged member
or a member with no editable repositories does not qualify. Running work and explicit thread
settlement overrides keep their existing protections.

Mobile shows space/saga identity and status in project headers and the new-task picker. The
tablet sidebar adds saga project navigation beside its default flat thread list; the optional
legacy list nests project headers. **Project Grouping → Nest saga members** is a device-local
preference. Nesting requires a verified member path and creation identity. Spaces with the same
name in another installation, older archives, or incomplete identity information stay at the top
level. Create and edit sagas on web or desktop.

## Automatic cleanup

Stave lifecycle settings belong to the connected environment. Their defaults are:

| Trigger                                         | Default behavior                                         | Other choices                                          |
| ----------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| Delete a project                                | Destroy its live Stave space after the deletion is saved | Archive or keep files                                  |
| All threads are settled or no longer active     | Archive after a seven-day grace period                   | Archive immediately, suggest an archive, or do nothing |
| Destroy memory                                  | Keep stores                                              | Contribute and keep, or destroy owned stores           |
| Every editable repo in a saga member has merged | Leave thread settlement unchanged                        | Enable settlement on saga merge                        |

A project with no thread history is never archived automatically. In grace-period mode, settling
an old project or enabling cleanup for the first time starts a fresh countdown. Ordinary checks do not move the
deadline. Starting or un-settling work cancels the schedule; **Keep** suppresses that settlement
episode until new thread activity starts another one; routine provider shutdown does not reset it. **Archive now** lets you review and run the archive
without waiting. Suggestion mode offers the action without automatically archiving.

Deleting a project records cleanup before it disappears from the app. A server restart does not
lose that intent. When Stave refuses, **Settings → Stave → Pending cleanups** shows the problem.
Retry reviews the exact archive/destroy choice that will run. Dirty/dependent refusals can offer
an explicit **Force** review; a saga member needs confirmation to remove its roster entry and
dependent edges before destruction. Force never bypasses incarnation or memory-in-use guards.
**Dismiss** stops retrying and leaves the files in place. Keep and Dismiss remain usable when a
manifest needs repair. Deleting an already archived project leaves its archive in place.

Project settings show archive reminders and refusals, and sidebar badges keep them visible.
Mobile shows read-only reminders; manage cleanup from web or desktop. Disabling Stave stops
its automatic sweep and does not delete existing spaces. Re-enabling archive-after-grace policy starts a
fresh grace window rather than immediately cleaning up old settled work.

Automatic saga archiving also waits for each registered member’s archive grace period and honors
its Keep choice. A coordinator stays pending while a member has active work or is not yet eligible.

## Memory in provider sessions

When a live space has Marmot memory attached, new provider sessions can use the memory
configuration generated by Stave. Other MCP servers remain available. In Codex, the space’s
memory takes precedence over an existing Marmot connection for that session. Restart a provider
session after attaching or changing memory so it picks up the current configuration.

Codex checks its MCP configuration before starting a session with space memory. If that check
fails, startup reports a diagnostic; check the configured Codex executable, launch arguments and
home. The CLI must support `mcp list --json`.

| Provider        | Memory support                                                                     |
| --------------- | ---------------------------------------------------------------------------------- |
| Claude Code     | Reads the space's project configuration                                            |
| Codex           | Receives memory configuration for the session                                      |
| Cursor and Grok | Receive memory configuration when starting or resuming a session                   |
| OpenCode        | Supported with a local server managed by the app; external servers are unsupported |

Settings → Stave and Diagnostics show provider support. The project Stave section also shows
whether its memory configuration can be loaded. **Supported** describes the adapter;
configuration being ready does not confirm that the provider connected to memory. Missing or
invalid configuration is reported there so you can inspect it with Stave.

A custom Stave binary may support fewer actions than the bundled one. Unsupported actions are
disabled with compatibility details in Settings and Diagnostics. Select a compatible binary to
restore them; Keep and Dismiss remain available for cleanup records. On Windows, select the
native executable; command-script wrappers are unsupported. Stave's platform-specific notes
remain visible in operation progress.

## Related

- [Customize a project icon](./project-settings.md)
- [Source control integrations](./source-control.md)

## Saga workbench

Projects organizes a saga, its own conversations, and its member spaces in one hierarchy.
Expand a space to reach its threads. Standalone spaces and ordinary projects remain available.
On desktop and web, select a saga to open its workbench; use its settings action for the existing
project settings. Mobile uses the same Projects hierarchy; the custom workbench page is currently
available on desktop and web.

The **+** beside a saga or space opens a new conversation there. Send the first message to
start the thread; clicking **+** again while its empty draft is open focuses the composer.
The folder label beneath a conversation identifies its workspace: **Stave saga** means the
saga coordinator directory, while **Stave space** identifies a member or standalone space.
This label is conversation metadata, not another folder or project in the hierarchy.

The workbench presents the same spaces in Board, List, and Dependencies views. Dependency waves
show prerequisite ordering, not a promise that agents will run concurrently. Selection follows
you between views. Each space exposes its conversations, repository evidence, activity, and
project settings. Saga settings do not silently override the settings of member spaces.

| Stage  | Purpose                                                 |
| ------ | ------------------------------------------------------- |
| Spec   | Establish scope and acceptance criteria                 |
| Plan   | Decide the implementation and dependencies              |
| Build  | Implement and test                                      |
| Review | Resolve review findings                                 |
| Accept | Await explicit acceptance, clean required CI, and merge |

By default, each new prompt in a saga or member-space conversation requests one combined summary
and phase update. It uses the last three completed exchanges before that prompt, so the newly
submitted question is included on a later submission after its response has finished. The first
prompt has no completed exchange to summarize. Each exchange includes only the question and the
agent's text, including commentary; tool calls, tool results, attachments and other activity are
excluded. One prior summary provides continuity. Very long exchanges are shortened while keeping
the beginning and end.

Select a space and turn off **Automatically infer stage** to move it yourself by dragging its handle
to another board column. Keyboard dragging is available from the same handle. Automatic summaries
continue when automatic phase movement is off. Pin a space's phase to prevent both automatic and
manual movement; its summaries still update. Unpin it to allow movement again.

Stages can move in either direction or skip. A phase change does not start an agent, approve work,
merge a PR, settle a thread, or archive a space. Completed is a separate outcome; completed work
remains visible and must be explicitly reopened before its phase can change.

Acceptance records approval of specific repository revisions. A human or an authorized automation
session can approve those revisions. Completion then requires fresh evidence that all required
PRs have clean required checks and were merged from the accepted revisions. A repository with no
changes to deliver must have a clean checkout and a verified comparison against its base. Missing
PRs, unavailable provider evidence, changed revisions, and unknown CI remain visible blockers.
An empty check list is not proof that CI passed. Reopening clears current acceptance and completion.

GitHub completion verification currently supports readable branch protection and status-check rules.
If policy cannot be read, or requires workflows, merge queues, deployments, or code-scanning evidence
that this view cannot verify, completion remains blocked. Other Git hosts currently report unknown
acceptance evidence. Their existing Git and pull-request controls remain available.

Summary and phase inference uses the same provider account as the conversation. Codex prefers
GPT-5.6 Luna, Claude prefers Sonnet 5, and Cursor prefers Composer 2.5 or Composer 2 when advertised
by that account. If a preferred model is unavailable, the conversation's selected model is used.
Grok and OpenCode keep the conversation's model selection. The environment's general text-generation
model does not override these account choices.

Each generation returns a summary, an inferred phase and a confidence value together. Confidence
expresses the model's certainty, not proof of approval, clean CI or merge. The saved summary and
phase update together when movement is enabled and unpinned. You can also refresh the summary
explicitly. A failed or malformed response leaves the previous result intact; repository evidence
and conversation activity remain separate factual views.

A card with a running conversation has an animated gold border. Reduced-motion preferences keep
the highlight static. Gold connector lines show the Projects hierarchy on desktop, web and mobile.
