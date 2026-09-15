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

## Pull request activity

Watch a pull request from **Pull Requests**, or from a project's Git overview on mobile. Its activity shows CI and required-check status, whether Lecturn is watching, the managing agent’s state, and the latest observed checks. A watch continues when its conversation becomes idle or closes. The hosting computer must remain running and connected.

Tap a PR activity to open its authenticated controls. You can pause or resume watching, send merge instructions, open the managing conversation, and send a quick steer. A queued steer is awaiting delivery; it does not mean the agent has acted on it. If a desktop or web send has an uncertain outcome, retry the original text first; changing the draft will not silently resend older instructions. Notification delivery alone does not grant permission to control an environment.

**Merge when ready** sends an instruction to the managing conversation: watch CI and reviews, address failures, report blockers, and merge once required checks and repository rules pass. The agent performs the work through its normal tools and permissions. Sending the instruction does not itself merge the PR or submit an approving review.

The control shows the receiving conversation. If no manager is assigned and exactly one eligible conversation is associated with the PR, that conversation becomes the manager and receives it. Otherwise, choose a manager first. A queued instruction confirms delivery into the conversation, not completion of the work. Steer the same conversation to change or cancel the request.

An automatic merge authorization created by an earlier version remains visible. Revoke it before handing the PR to an agent so both paths cannot act at once. Stopping a watch revokes that older authorization; it does not cancel instructions already sent to an agent.

CI facts can be stale while the host is offline or the Git provider is unavailable. Open the CI disclosure for individual jobs and the information control for observation details.

Settling a conversation removes its thread activity from Live Activities and the Mac panel. An ordinary completed turn still reports that the agent finished. Watched PRs remain available independently of whether their managing conversation is settled.

## Mac activity panel

The desktop app has its own compact activity panel, independent of iPhone mirroring. It retains your three most recently interacted unsettled conversations, including idle or stopped work, alongside other active conversations and watched PRs. Expand a PR’s CI indicator to see individual jobs. Status icons and gold borders give a quick overview; information and message controls reveal context and steering.

Use **Show activity notch** or **Hide activity notch** in Pull Requests or the **Lecturn activity** menu-bar menu to enable or hide it. On an internal display with a recognizable notch area, the panel joins the top edge around the camera housing, with compact controls beside the camera and expanded content extending downward. On other displays, or when that area cannot be identified, use **Show activity** from the menu bar. The celestial background and illuminated-book logo match Lecturn. The panel follows the app’s Light, Dark, or System appearance setting, including the compact header and changes while it is open. Light surfaces use deeper gold and state colors so thread borders, hierarchy lines, and CI indicators remain visible. Peek and expanded views open with a short resize and content reveal; reduced motion keeps these transitions immediate. A moving gold border marks active work; it stops when hidden or when reduced motion is enabled. Approval, input and error states keep explicit labels.

The notch starts collapsed. Restoring conversations and PR checks during startup does not open a preview; subsequent live changes can still alert.

Hover over the compact notch to peek at up to three items, ranked with requests for attention and failing checks before ongoing work and quiet recent threads. Each row shows its project icon, conversation or PR, a short task update, and compact CI progress when available. Rows stay in place while hovered or focused as their facts refresh. Click a row to expand its details and CI jobs. Manual expansion stays open as you move through the panel; click outside, press Escape, or click its chevron to close it. Leaving a hover peek dismisses only the peek. The conversation already open in the foreground Lecturn window is omitted from hover peeks and automatic previews; its updates remain visible in the expanded panel. PR checks still appear independently. In an expanded conversation card, click its title, empty space, or the small corner arrow to open the chat and close the notch; steering inputs and other controls keep their own actions.

This local desktop panel does not require a Connect subscription. Managed iPhone notifications, Live Activities, and their supported Apple mirroring surfaces retain the Connect access requirements above.

Activity cards show the current plan step and latest response when available, with a last-update timestamp. Silence alone is not labeled as a stuck agent. Associated conversations identify where a PR came from. The merge control shows which eligible conversation will receive the instruction.

Stopping a watch removes it from active watched lists and the Mac panel. You can resume it from **Watch history** or the PR's **Watch** button. Mobile activity removal follows the host's next publication cycle, normally within 30 seconds plus push delivery time. Automatic discovery respects watches you stopped.

Activity states share the same visual cues across the Mac panel, web, and phone: moving gold for active work, pulsing amber for attention, red for failure, green for completion, and grey for idle or offline work. Labels remain available in tooltips and accessibility descriptions. Motion pauses off screen and respects reduced motion. Passing checks alone do not mark a PR complete.

Opening a conversation from the notch closes the panel. The Lecturn logo brings the main app forward without switching conversations or expanding the panel. Expanded cards keep their steering field visible.

A meaningful activity or CI state change briefly bounces and colors the count, then shows a single-item preview when the panel is closed. The preview closes after five seconds unless you interact; leaving it or sending steering dismisses it. Text streaming alone does not trigger alerts, and new alerts do not replace a card you are already using. Reduced motion keeps the color cue without the bounce. Failed steering delivery restores your draft and surfaces an error.

Submitting a prompt, steering, settling, or stopping work does not pop the notch open to report your own action. Later agent results, attention requests and CI changes remain eligible for alerts.
