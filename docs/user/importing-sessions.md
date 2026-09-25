# Importing sessions

Importing lets you continue a Claude Code or Codex session that you started outside Lecturn, from
the command line or from the Claude and Codex desktop apps. The session opens as a new Lecturn
thread with its conversation already in place, and the agent picks up with everything the session
knew.

The original session is never changed. Lecturn continues on its own copy, so you can keep using
the original wherever you started it, and deleting the imported thread leaves it untouched.

## Where to import

On web and desktop, click **Continue a Claude Code or Codex session** below the prompt on a new
thread's start screen, or open the command palette and choose **Import session…**. On mobile,
start a new task, choose the project, then tap **Import** below the prompt. Either way the list
shows the sessions that ran in that project's folder, and **Show sessions from all folders** widens
it to every session on that machine. Pick a session from the list to import it. The link names only
the tools you can import from, so it reads **Continue a Codex session** when Codex is the only one.

### Starting from a folder you haven't added yet

To bring over a folder you have been working in with Claude Code or Codex, add a new project and
choose **From Claude Code or Codex** as its source. Lecturn lists every folder with sessions on
that machine, most recently active first, with how many sessions each tool has there. Folders you
already added are marked **Already a project**. Each folder a session ran in is listed on its own,
so a git worktree appears separately from its main checkout.

Pick a folder and Lecturn adds it as a project, then lists its sessions with checkboxes. Sessions
from the last 14 days start selected, except ones you already imported, which show **Imported**.
Use **Select all** or **Select none** to change the selection, then choose **Import**. Sessions
import one at a time while Lecturn shows its progress. If any session cannot be imported, the rest
still import and Lecturn lists the ones that failed at the end. You land on the most recently
active imported thread.

A session imports only into a project whose folder matches the folder the session ran in. A
session that ran in one of the project's worktrees imports when a thread in that project already
uses that worktree, and the imported thread works there too. Sessions from any other folder are
listed with their folder but cannot be imported until you add that folder as a project.

An imported thread starts in the same [permission mode](./permission-modes.md) and **Plan** or
**Build** mode a new thread would. On web and desktop those come from the thread you have open; on
mobile they come from the new task's controls. Either way, importing while you work in a restricted
mode never gives you a **Full access** thread.

Importing works over remote connections too. Sessions are read on the machine running Lecturn, so
the list shows the sessions on that machine, not the ones on the device in your hand.

## What you see

The imported conversation appears above an "Imported from …" divider; everything you do in Lecturn
goes below it. A chip in the header names where the thread came from, and its tooltip shows the
session's folder and the date you imported it.

Tool activity from the original session appears as short summaries, without the inputs and outputs
of each call.

Only the most recent 200 messages are shown. When a session is longer, a note at the top of the
thread says that earlier messages aren't shown. The model still has the full session, including
the part you cannot see.

## What to know

- **Same provider.** An imported thread continues on the provider it came from, so the provider
  picker is locked to it. Until you send your first message you can still choose a different
  model from that provider.
- **The first message costs more.** Your first message has the agent re-read the whole session.
  Large sessions use more of your plan on that message than a normal reply does.
- **Revert starts at your first new message.** The imported conversation has no checkpoints, so
  you cannot revert into it. Once you send messages in Lecturn, reverting to any of them works as
  usual.
- **Same folder.** The thread works in the session's folder, never a different one. It does not
  offer to create a new worktree on the first message.
- **Keep the original Codex session.** Deleting the original Codex session later breaks the
  imported thread.
- **Forking works.** After your first reply you can [fork](./forking-threads.md) an imported
  thread like any other.

## Availability

You can import Claude Code and Codex sessions. Claude instances that use a custom home folder are
not supported yet, and neither are OpenCode, Cursor, Grok, or Antigravity sessions.
