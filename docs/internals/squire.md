# Squires

> For maintainers. Using Lecturn? See [Squires](../user/squires.md).

A Squire is an agent that watches threads the user opted it into and acts only through its own MCP
tools. Like `StaveLifecycleService`, it runs beside the v2 orchestrator and reacts to committed
events. Nothing Squire-specific goes into the upstream-synced [Orchestrator.ts][orchestrator]
decisions; orchestration deltas are additive fields marked `Lecturn:`. Server code is in
[`apps/server/src/squire/`][squire].

## Kill switch

Squires are opt-in and off by default. [SquireSwitch.ts][switch] owns the switch: the saved
`squire.enabled` setting, applied live, unless `LECTURN_SQUIRE` is set, which pins it for the
process and withholds the `squireLiveSwitch` capability. Desktop users cannot set environment
variables, so the Settings switch is their only way in.

Because the switch can flip under a running server, every Squire service is built whatever it
says, and nothing may capture it at construction: gates read it per call, and background work
(reactor, clock, delivery re-dispatch, Jev resume, CI excerpts, the read model's event followers)
runs only inside an on period that startup opens and closes on each change. Off means no `squire`
capability, `squire.*` RPCs fail `disabled_by_server`, webhooks and the action-log export answer
404, the MCP gate lists nothing, delivery starts no new turn (running ones finish), and nothing
ticks. A flip re-sends the server config snapshot, the only way the descriptor reaches clients.
The settings stream applies a write asynchronously, so the RPC gate re-reads the saved setting
before it refuses: a client may call `squire.lead.open` right after its own write. The guard rails
for marked threads stay on in both states: the deny runtime, the narrowed MCP credential and its
gate, provider-side MCP isolation, and the command allowlist.

## Threads first

A Squire's conversation is an ordinary thread, its **home thread**. Squire tables hold only what a
thread cannot, and the action log stores keys and outcomes, never copies of thread text.

**Hidden-thread contract.** Home threads and probes carry a server-set `squire` marker that clients
cannot set and forks drop. Every server site that lists, mines, settles, summarizes, or notifies
about user threads must skip [`isSquireThread`][squire-thread]. A site that forgets is a leak: a
Squire batch would ring "agent finished", feed Decisions, or settle the thread so its queue never
drains.

**Command allowlist.** [SquireCommandHook.ts][command-hook] refuses every command that names a
marked thread unless it runs inside `SquireDispatchOrigin`. The `server:squire:` command-id prefix
names receipts, not authority, since clients choose their own ids. The rule table is typed over the
full command union, so an upstream command fails typecheck at t3-sync until it is classified.

**Deny runtime.** Home threads and probes run read-only, and the reactor declines any approval
raised on them so an unseen prompt cannot stall the queue. A home thread works in a scratch Git
repo under `<userdata>/squires/<id>/workspace`, because checkpoint capture walks up to the
enclosing repository. That repo is not a read boundary; read restriction is per provider.

**Stave.** Stave admission treats a home thread as outside its project's space, and Stave settle
queries skip marked threads, because a Squire thread never settles and would hold a space open. A
home turn waits for the space like any turn, and is refused only when a Stave operation outlasts
that wait. Delivery keeps the batch, queues for the space in shared mode until the operation ends,
then lets go and resends the same command once.

**Rooms are not threads.** Events, routed tasks, and direct messages are `message.dispatch` into
the recipient's home thread. Rooms keep their own log (`squire_room_post`), because every
`message.dispatch` opens a provider run.

**Controls allowlist.** The Squire view mounts `ChatView` (mobile: `ThreadRouteScreen`) with a
`controls` allowlist, so a control added to the thread view later stays hidden there until listed.

## Providers

Per-driver decisions and reasons are in `DRIVER_SUPPORT` in [SquireService.ts][service] and
[Squire support](./providers.md#squire-support). Enabling a driver requires provider-side MCP
isolation on start, resume, and fork.

- Grok runs only on versions in `GROK_SQUIRE_VERIFIED_VERSIONS`, checked at readiness and on every
  launch, so a Grok upgrade disables its Squires until the new version is checked live.
- A Codex Squire home links only the login and the thread store. The user's `config.toml` stays
  behind, so a model provider or profile set there does not apply to Squires.
- An instance's launch args reach a Squire only through an allowlist: Claude's
  `CLAUDE_SQUIRE_LAUNCH_FLAGS`, and Codex `-c` keys for the model provider and sign-in. Both CLIs
  stack tool, permission, MCP, and settings flags on top of Lecturn's, and Claude pre-approves
  before the permission callback runs.
- Codex summaries run in the Squire `CODEX_HOME`, because ordinary Codex text generation injects the
  user's global `AGENTS.md`. They also need a version in `CodexInferenceIsolation`'s verified list.

## Events

Settled and archived threads are outside every Squire's scope, thread grants included:
`SquireScope` reads the shell fresh on each decision, so a settle untracks at once and an unsettle
brings the grants back. When a thread settles or archives the reactor drops its waiting events and
outdates its cards and holds, and a held steer re-checks at execution, since the settle may not have
reached the reactor yet.

[SquireReactor.ts][reactor] classifies each transition from its stored payload, never the current
projection, and dedupes on (Squire, kind, thread, state key). PR keys are absolute states, because
the sync reactor republishes unchanged snapshots, so the daily prune keeps PR keys while their
thread lives; other finished rows go after 30 days because their keys never recur. A PR's revision is its
`headSha`, or `updated-<updatedAt digits>` for a provider that reports none (Azure DevOps), so
`isHeadShaRevision` must gate anything that treats the revision as a commit. A snapshot with
neither yields no event. Compaction would delete the PR
events the reactor has not read; [SquireCompactionFloor.ts][floor] keeps them, `lecturn doctor`
included. Turning the switch on fast-forwards the cursor before anything else in the on period
runs, so the off period is never delivered; the skipped project and thread deletes still cascade,
from current state, when the reactor starts. Turning it off records the cursor as off only after the
reactor has stopped, since the reactor rewrites the flag it read when it started.
User stops are silent and are classified from `createdBy` on `run.interrupt` and `thread.stop`,
because thread `actor_kind` never records a client.

## Actions

A tool call's **invocation key** (Squire run, tool, canonical args) is Squire-owned because MCP
command ids are random; its `tool.called` row commits with the call's effects, so a retry returns
the stored result. Held and accepted actions follow the durable protocol in
[SquireActions.ts][actions]: the receipt decides the outcome, and because the orchestrator replays a
rejected receipt forever, a deliberate retry needs a new attempt number.

**Approvals.** An approval is an open steer or proposal. It renders and counts only in the raiser's
chat, so a badge never needs correcting for what another chat shows. One a background turn raised
waits [`SQUIRE_APPROVAL_TTL`][repository], refreshed when a re-raise replaces it in place, then the
clock moves it to `outdated`/`expired` writing no Lead event and no push: a stale ask leaves quietly,
and its rule offer stays savable. An approval the user or a voice note started never expires.

Deny is dismiss on an open approval. The slot (thread and kind, or project and title for a proposal
with no thread) is refused until the user next writes in that Squire's chat. That message closes the
Squire's open approvals and ends its denials, bounded by the run's `requestedAt`, because a run's
updates repeat and its own new cards are newer. A denial is in force while its card's `expires_at`
is null; ending it stamps that column, so the history row keeps reading Denied.

**Holds are not items.** A held Auto action is a `squire_card` in `held` status, outside the
one-open-card index, so it never replaces an open card for the same thread and kind. The read model
pairs them (`heldOverCardId`) so every surface shows the hold under the card it would supersede.
Undo supersedes the older card, then opens the hold in its place, so the newer intent wins. Pausing
does not: `openHeldCards` opens each hold, newest first, only where no open card holds that slot,
and marks the rest `outdated` (`superseded`). An open card therefore survives a pause and the
holds under it are dropped. A hold never expires and a chat message does not cancel it, since the
Undo window is the user's say; one that reopens as an approval gets its TTL then.

**Origins.** Text a Squire wrote never drives an Auto action or a rule match, directly or laundered
through the Lead. Voice, webhook, test, sweep, and unknown origins are recommend-only and ignore
rules, and so is any turn whose input carries a Squire's words: its messages, its room posts shown
as context or read mid-turn with `squire_read_room` (the run then stays recommend-only), and the
Lead's `item-raised` and `room-proposed` events. The Lead's own messages and posts keep the
recipient's Auto and rules only when a user started the Lead turn that wrote them (its plain
message, or a user room post); a Lead turn woken by a Squire, an item, or a sweep counts as a
Squire's. The sending turn's origin is recorded on its `tool.called` row, keyed by the message key,
and a tool call binds to its home thread's run; with no readable run it is `unknown`, never `user`.
The server returns rule offers with the accept or undo result, so every surface offers the same rule.

**The `DispatchModeLimit` exception.** Held and Auto actions run server-side as the granting user,
outside MCP `writesThreads` and `DispatchModeLimit`. In their place: re-validation under the owner,
target, and policy locks, never raising the target's modes, `createdBy: "agent"`, and a re-check in
the target's command lock that refuses the dispatch if the user wrote there after the intent.

## Lead

The Lead proposes Squires and approves room proposals but never creates a Squire; its proposals are
capped at Recommend and do not push. It has no `squire_get_detail`, and its permission on a thread
is the lower of its own and the owning Squire's. `SQUIRE_LEAD_COMPANION` is reserved:
`squireDistinctCompanion` treats it as taken, and the crest comes from the role, not storage.

## Rooms and routing

[squireRoomRouting.ts][room-routing] routes posts by deterministic rules, falling back to the Lead.
On the funded tier a fallback post goes to Jev first ([SquireJevRouter.ts][jev]) with the Lead's
row deferred 5 s; an answer before the deadline retargets with a compare-and-set on `pending`, and
anything else falls back at once. The relay gives `squires` its own per-environment concurrency
slot, but account concurrency and the per-minute limit stay shared ([Extensions](./extensions.md)).
Until the relay route and evaluator policy are deployed, the feature reads unfunded.

## Showcase

The showcase is the only MCP App card. [SquireMcpAppRoute.ts][app-route] serves it from Lecturn,
not the provider session, so its buttons work on every provider and in copied threads. The tool
fills a versioned template with data only, and the page reads nothing after publishing. Inline it
shows counts and Expand, which asks the host for full screen.

## Pages

Every Squire gets `html_render` and `html_preview` as role tools ([SquireHtmlTools.ts][html-tools]),
always locked down. The home thread's credential picks the mode, never an argument, and the
ordinary handlers lock a Squire credential too. A Squire reads untrusted text, so its page is
treated as an attacker's: it must not read local files or reach the network on any client,
including clients older than the mode.

- Local paths and `file:` URLs a page names are refused by name, never inlined.
- A CSP alone does not close the network. CSP has no working `navigate-to`, so a script or
  `<meta http-equiv=refresh>` can send the page to any URL carrying data, and CSP does not govern
  WebRTC at all: STUN packets left Chromium and WebKit under a strict policy. So no page script
  runs, and the server publishes the page as data in a wrapper document
  ([htmlRender.ts][html-render], "Locked pages"). The wrapper's `frame-src 'none'` blocks every
  navigation of the sandboxed `srcdoc` frame holding the page, the frame inherits that policy, and
  only Lecturn's bootstrap runs, by hash. The wrapper relays height, keys, and inline images up and
  theme and shortcuts down, so links do not open.
- The host's headless browser previews and measures the page offline: every request but the page
  fails, its proxy refuses every connection, and no host name resolves.
- `HtmlRenderFrame.locked.browser.test.tsx` tries each exit against an ordinary-page control. A new
  exit belongs there.

## Notifications

Transport follows notification intents, not decision counts; Notify Off writes none.
`squire_notify` is the alert: an FYI card and a `notification.pushed` row, with the reply as the body.
The phone counts open FYIs, so a visit to the home thread or a user message there closes them, or
attention would never clear; the inactivity check stays open until answered.
[SquireMobileAttention.ts][mobile-attention] publishes one relay row per Squire with a count, never
item text, and `userPresent: false`, because the relay's own suppression counts mobile clients.
[SquirePresence.ts][presence] owns hold-back: only a focused web or desktop client with input in
the last 2 minutes counts. The notch panel is a `data:` document, not a secure context, so it has
no `crypto.randomUUID`.

Traps: on Android, a returning Squire row does not ring while another agent's row is on the card,
until a relay deploy. The relay drops waiting rows after 24 hours, so a ring can happen while the
intent is recorded as coalesced.

[orchestrator]: ../../apps/server/src/orchestration-v2/Orchestrator.ts
[squire]: ../../apps/server/src/squire/
[switch]: ../../apps/server/src/squire/SquireSwitch.ts
[squire-thread]: ../../apps/server/src/squire/squireThread.ts
[command-hook]: ../../apps/server/src/squire/SquireCommandHook.ts
[service]: ../../apps/server/src/squire/SquireService.ts
[reactor]: ../../apps/server/src/squire/SquireReactor.ts
[floor]: ../../apps/server/src/squire/SquireCompactionFloor.ts
[actions]: ../../apps/server/src/squire/SquireActions.ts
[repository]: ../../apps/server/src/squire/SquireRepository.ts
[room-routing]: ../../apps/server/src/squire/squireRoomRouting.ts
[jev]: ../../apps/server/src/squire/SquireJevRouter.ts
[app-route]: ../../apps/server/src/squire/SquireMcpAppRoute.ts
[html-tools]: ../../apps/server/src/squire/SquireHtmlTools.ts
[html-render]: ../../packages/shared/src/htmlRender.ts
[mobile-attention]: ../../apps/server/src/squire/SquireMobileAttention.ts
[presence]: ../../apps/server/src/squire/SquirePresence.ts
