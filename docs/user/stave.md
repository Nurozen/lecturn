# Stave spaces

[Stave](https://github.com/Nurozen/stave) is a command-line tool for agent workspaces. A
_space_ is a directory that Stave fills with checkouts of the repositories a task needs — some
editable on their own branch, some read-only for context — plus any memory stores the task
should carry. Stave is a separate install; the app talks to the `stave` command on your server
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
- **Set up** appears when no config file exists. For now it copies the command to run in a
  terminal (`stave setup`, with `--config` when you set one); running it from the app is coming
  later.

Saving any of these fields makes the server look again, so you do not need to restart after
installing Stave or editing its config.

## A space as a project

Add a space the same way you add any folder: choose the space root, the directory that holds
`.stave.yaml`. The app recognises the manifest and treats the project as a space.

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

## Coming soon

Creating a space from the app — picking registered repositories, choosing which are editable,
attaching memory, and previewing Stave's plan before anything is written — is in progress, along
with running **Set up** directly, archiving and restoring spaces, and saga members nested under
their saga in the sidebar. Until then, create and change spaces with the `stave` command; the
app picks up the result the next time it reads the manifest.

## Related

- [Customize a project icon](./project-settings.md)
- [Source control integrations](./source-control.md)
