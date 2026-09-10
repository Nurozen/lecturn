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
- **The first editable repo drives git.** A space root is not a repository itself, so branch
  status, the pull request lookup, and the Git actions in the toolbar target the first `edit`
  repo in the manifest on its manifest branch. Reference checkouts are listed but never
  targeted.
- **Checkpoints are unavailable.** A space spans several repositories, so per-thread checkpoints
  (and the diff and revert built on them) are off in spaces. Use Git in the editable repo
  instead.
- **Archived spaces** show as archived in the project's Stave section. Restoring them from the
  app is coming later; for now use `stave space restore`.

## The Stave section in project settings

Open **Settings**, select **Projects**, and pick the space. The **Stave space** section is
read-only; Stave owns everything in it.

- **Space id**, **Kind** (`space` or `saga`), and **State** (live or archived) come from the
  manifest.
- **Repos** lists each checkout with its mode, branch, base, and ref. With Stave enabled and
  runnable, the row also shows the live state Stave reports: how many commits the branch is
  ahead of or behind its base, whether the checkout has uncommitted changes, and a warning when a
  read-only reference checkout has been edited. Live figures refresh every few seconds while the
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
elsewhere are kept. If Stave itself refused the create, there is no space to remove and the
button is not offered.

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
  keep the store; an owned store also offers an explicit destroy choice.

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

## Coming soon

Creating sagas from the wizard, saga nesting, and automatic lifecycle cleanup are still being
integrated. Until then, manage saga structure with the Stave command.

## Related

- [Customize a project icon](./project-settings.md)
- [Source control integrations](./source-control.md)
