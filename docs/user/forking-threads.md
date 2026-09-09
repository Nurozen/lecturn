# Forking threads

Forking lets you continue from any completed point of a conversation in a new thread. The fork
carries everything up to that point: the conversation, the files context (branch and worktree),
the model and permission mode, and the linked pull request. The agent in the fork knows exactly
what the thread shows — it picks up mid-conversation with the same context, so you can try a
different direction without disturbing the original.

The original thread is never changed by a fork. Delete a fork like any other thread; deleting the
original does not delete its forks.

## Where to fork

On web and desktop, hover over a completed reply to reveal the **Fork from here** icon below it,
next to Copy. Plain conversations can be forked even when no Git checkpoint exists. Forking from an agent
reply continues from that reply. Forking from one of your own messages continues from the reply
before it and pre-fills the composer with your message, so you can edit and resend it.

Hover over a conversation card in the sidebar to reveal the fork icon in its bottom-left corner.
It forks at the latest completed reply and is also available when navigating by keyboard.

You can also fork a whole thread at its latest completed reply from the chat header's thread
menu, the sidebar context menu, the command palette, or the `/fork` composer command. The
`chat.fork` command has no default keyboard shortcut — assign one in **Settings** → **Keybindings**.

On mobile, fork from the thread menus: the thread list row menu or the open thread's menu.

A fork opens as a new thread with the inherited conversation already in place, a "Forked here"
divider at the fork point, and a chip in the header linking back to the original.

## Shared files

A fork works in the same folder as the original thread. That keeps the code the conversation was
about, but it means the agents in both threads edit the same files. If the original thread's
agent is still working when you fork, Lecturn warns you — sending work in both threads at once
can have the two agents stepping on each other. Wait for the original to finish, or keep one of
the two threads idle.

## Availability

Forking works on Codex, Claude, and OpenCode threads. Cursor and Grok threads do not offer the
fork action in Lecturn yet.

Grok's current Lecturn integration cannot preserve its native conversation context at a selected
reply in a separate session. The missing option is an integration limitation, unrelated to
Connect or your subscription. Starting a new Grok thread does not inherit the original chat's
context.

On Claude threads, replies recorded before your server gained forking cannot serve as a fork
point — the hover action on those messages is disabled with "Fork point unavailable for turns
recorded before forking was added". Forking the thread at its end still works.

**Revert** is unavailable in a fork until you send its first message. To continue from an earlier
point instead, fork at that message.

## Titles

A fork starts titled "_original title_ (fork)" and is automatically renamed from its own
conversation after its first reply, the same way a new thread is titled. You can rename it or
regenerate the title from the thread menu at any time.
