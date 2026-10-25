# Connected apps

A connected app is a program on your computer that shows Lecturn's chat in its own window and
gives agents its own tools. Its chats are ordinary Lecturn threads, kept in projects that belong
to the app. You approve each app once, and you can open, continue and revoke everything it does
from Lecturn.

## Approve an app

When an app first connects, every Lecturn client you are signed in to asks whether to connect it.
You can also answer under **Settings → Connected apps**, or in the Apps tab on mobile. The request
shows what you are approving:

- the command Lecturn runs for the app's background tools;
- the addresses allowed to show Lecturn inside the app;
- the tools that need your approval before they run.

Only a program on the computer that runs Lecturn can ask to connect.

If the app later changes that command, its environment or those addresses, its access pauses until
you approve the change.

An app can also run a private copy of Lecturn for itself, for example before you approve it or
when Lecturn is not running. Once you approve, the chats it held there are copied into your
Lecturn, and the app shows each original as **Continued in Lecturn**.

## Apps mode

The switch under the sidebar search moves between **Projects** and **Apps**. You can also press
`mod+alt+p`, or choose **Open app…** in the command palette. Apps mode lists each app with its
workspaces and threads; the scope row shows **All apps** or one app. Projects mode leaves app
threads out, but its search still finds them. On mobile, app threads are in the Apps tab.

## Continue a chat

Open an app thread in Apps mode and keep working. It uses the same providers, models and
[permission modes](./permission-modes.md) as any other thread, and its agent can use the app's
tools only on that app's threads.

Some app tools run inside the app itself and work only while it is open. When it is closed, the
thread says so, and **Open in** the app opens it at that thread; that button is offered on the
computer that runs Lecturn. If the thread's provider cannot reach the app's tools at all, the
thread says so too; switching to another provider is the way around it.

## Approving app tools

Tools the app marked as needing approval, and single calls the app asks about with a reason,
follow the thread's permission mode:

| Mode                  | App tools that need approval |
| --------------------- | ---------------------------- |
| **Supervised**        | Ask you first                |
| **Auto-accept edits** | Ask you first                |
| **Auto**              | Run without asking           |
| **Full access**       | Run without asking           |

A request you do not answer expires after 10 minutes, and the tool call fails.

The permission mode picker has no Read-only mode, so Read-only is set per app: **Settings →
Connected apps**, the app's **Runtime ceiling**. With Read-only, tools that need approval are
refused and the app's other tools still run. A ceiling also caps the thread's mode: with
**Supervised**, the app's tools ask even in a **Full access** thread.

Cursor waits at most 60 seconds for a tool call, so on Cursor threads answer an app tool's
approval within 60 seconds or the call fails.

## Revoke or remove an app

**Revoke access** on the app in **Settings → Connected apps** stops the app's tools and rejects
its credential, including the chat it shows in its own window. Its threads stay in Apps mode and
say that access was revoked. To restore access, open the app so it asks again, then approve the
request (**Re-pair**). On mobile, open the app in the Apps tab to revoke or pair it again.

The app's menu in Settings also has **Remove app**, which keeps its threads on this machine, and
**Remove app and its threads**, which deletes them.
