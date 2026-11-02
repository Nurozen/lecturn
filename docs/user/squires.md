# Squires

A Squire is an agent that keeps an eye on the threads you give it. When a watched thread finishes a
turn, stops, waits on you, or its pull request changes, the Squire reads a short summary. It then
stays quiet, asks you to decide something, or does what you allowed it to do. You can run several
Squires, each with its own brief, scope, and permissions. They all report to one **Lead**, which
keeps the combined queue, flags threads that touch the same files, sends a daily digest, and can
route your requests to the right Squire.

## Turn on Squires

Squires are off by default. To try them, start the Lecturn server with `LECTURN_SQUIRE=1`. Once
the environment has a project, a Lead appears in the sidebar's **Squires** group. Open it and it
proposes two or three Squires based on your recent work. Accept the ones you want, edit them first,
or create your own with **New Squire**.

Each Squire watches the projects, Stave spaces, sagas, or single threads you pick. New threads in a
watched project are picked up automatically. To add or remove a thread later, use **Track with**
or **Stop tracking** from the thread's menu or the command palette.

A Squire runs on a provider you choose: Claude, Codex, or Grok (version 1.0.70). Cursor,
OpenCode, GitHub Copilot, and Antigravity can't run Squires yet; the provider picker says why.

## Items

When a Squire needs you, it raises an item: a steer to send, a thread to create, a question a
thread is waiting on, or, from the Lead, two threads changing the same files. Items show in the
Squire's view, in the Lead's combined queue, in the desktop notch, and on mobile in the Squires
section of the home list. Acting on an item anywhere resolves it everywhere. **Ask about this**
answers a question from a temporary read-only copy of the thread, so it uses tokens only when you
ask.

You can also give the Lead a task in its conversation. It forwards the task to the Squire watching
that thread, proposes a new thread, or answers from what its Squires already know. Ask the Lead for
a showcase to get a snapshot of your threads, the files they share, and what is waiting on you;
use **Expand** to open it full size.

## Permissions and rules

Steering a thread and creating threads can each be **Off**, **Recommend** (the default, which asks
you first), or **Auto**. An Auto action waits out a short undo window before it runs, and the server
keeps that timer even if you close the app. If an older recommendation for the same thread is still
open, the held action shows under it; **Undo** turns the held action into a recommendation instead.
Only one Squire can steer a given thread on Auto. Budgets cap how much a Squire does in a day. Once
a budget runs out, it goes back to recommending.

After you accept a recommendation, in Lecturn or the notch, the Squire can offer **Always allow
this**. That saves a rule that lets it act on its own next time, for that thread or its project.
After you undo an action, it offers **Always ask first for this**. Rules are listed in the Squire's
settings with how often they matched, and you can remove them there. A rule never widens what a
Squire can see.

## Rooms

A room is a group conversation among Squires, the Lead, and you. Start one with **New room**. Your
post goes to the Squire it mentions (`@Name`) or replies to, or else to the only Squire watching
what it refers to, or else to the Lead. Other members see it next time they work. An idle room
closes after the timeout in **Settings → Squires**, and you can reopen it.

With **Room routing with Jev** funded in **Settings → Squires**, a post that matches none of those
goes to the member Jev picks instead of the Lead. Without funding, rooms use the rules above.

## Phone alerts

Phone alerts need [Lecturn Connect](./notifications-and-live-activities.md) with agent activity
publishing on. Your phone is alerted when a Squire first needs a decision from you, not for every
item. Later items arrive quietly until you have dealt with the open ones.

If you are active at a desktop or web client, the alert waits. If you have not opened the item
after 3 minutes, your phone is alerted anyway. To change that wait, go to **Settings → Squires →
Phone alerts while I'm at my desktop**. To stop a Squire's alerts entirely, turn off **Notify me**
in its settings. Its items still show in Lecturn.

## Advanced: triggers and webhooks

Besides watching threads, a Squire can wake on a schedule or when another service calls it. Add
triggers in the Squire's settings. A scheduled run acts under the Squire's normal permissions. A
webhook run only recommends, because its content comes from outside.

For a custom webhook, open **Advanced: custom webhook** on the trigger. The secret is shown once,
when you create the trigger. Send it as `Authorization: Bearer <secret>` or as an
`X-Hub-Signature-256` signature, as GitHub does. **Rotate** replaces the secret, and **Revoke**
retires the URL for good. The URL works wherever this environment can be reached, such as over
Tailscale or your own proxy. For a public URL, link the environment to Lecturn Connect. A paused
Squire or trigger ignores calls.

If you do not use Squires for a while, the Lead asks whether to keep triggers running and pauses
them if you do not answer.
