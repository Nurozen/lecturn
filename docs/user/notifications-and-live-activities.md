# Notifications and Live Activities

Step away without losing track of your agents. Notifications bring activity updates to your phone; Live Activities keep a compact view of working, waiting, and recently completed work on the iPhone Lock Screen and supported Dynamic Island devices.

## Access and setup

Managed notifications and Live Activities are part of paid [Lecturn Connect](./connect-subscription.md), including active trial and complimentary access. Signing in alone does not activate managed access. Local connections, direct pairing, SSH, and Tailscale remain free.

1. Sign in to the same Lecturn Connect account on the hosting computer and iPhone. Link the computer and select it in the phone app. Keep the hosting app running and the computer online.
2. On the hosting computer, open **Settings → Connections** and enable **Publish agent activity**.
3. In Lecturn on iPhone, open **Settings → Device Notifications** and allow the iOS permission prompt. If permission was previously denied, enable notifications for Lecturn in iOS Settings.
4. Enable **Live Activity Updates** in Lecturn Settings. This setting requires successful device registration with Connect. If iOS has disabled Live Activities for Lecturn, allow them in the app's system settings too.
5. Start a task on the connected computer. Check activity updates on your phone, then tap the activity to verify that Lecturn opens the linked conversation.

Notification permission and Live Activity registration are separate. An enabled **Device Notifications** switch means iOS permission is allowed; a message that push delivery setup is pending means registration still needs to finish.

## Read the activity

| Status   | Meaning                                                          |
| -------- | ---------------------------------------------------------------- |
| Working  | An agent is working on the task.                                 |
| Approval | The agent needs permission before continuing.                    |
| Input    | The agent needs your response.                                   |
| Done     | The task has completed.                                          |
| Failed   | The task ended with an error; open the conversation for details. |

The banner prioritizes work that needs attention and displays up to five activity rows. Compact layouts show less detail. Tapping a linked activity opens its attention-first conversation, or the first displayed conversation when none needs attention. Approvals and replies happen in the app, not directly in the banner.

Lecturn's Live Activities use navy, warm text, gold accents, and distinct status colors. They can also appear through supported Apple mirroring surfaces. Apple controls availability, surrounding system chrome, and transitions; ordinary notification banners retain the system appearance. The gold accent is static.

## If updates do not appear

- Confirm the account has active Connect access and the host is online with **Publish agent activity** enabled.
- Check both **Device Notifications** and **Live Activity Updates**. Allowing notification permission does not by itself finish Connect registration.
- If delivery setup is pending, restore connectivity and reopen Lecturn Settings to retry registration.
- Check iOS notification, Focus, and Live Activity settings when an expected alert or activity is hidden.
- Start a new task to check current delivery. A completed activity is not evidence that the host is still connected.

Push delivery and the interactive connection use different paths. Notifications may arrive while the app is reconnecting to the computer. If that happens, check the environment connection in the app and the host's network; receiving a notification does not establish that chat is connected.

Activity titles and project names can appear on the Lock Screen. Choose suitable device notification visibility settings, and disable activity publishing for environments whose activity you do not want delivered.
