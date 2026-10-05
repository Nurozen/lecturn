# Glossary

Terms whose meaning matters across Lecturn. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.   |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| Lecturn home   | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime Lecturn controls, such as Codex or Claude Code.                                            |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into Lecturn operations and events.                    |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

## Lecturn-specific terms

### Stave

#### Stave space

A project whose workspace root carries a `.stave.yaml` manifest (fork only). The root is a directory of repo checkouts rather than a repository, threads always run in the root, and git surfaces target the first `mode: edit` repo. The server derives `project.stave` from the manifest at read time in [ProjectionSnapshotQuery.ts][10]. See [stave-integration.md][28].

#### Saga

A Stave space that coordinates member spaces (`kind: saga` in its manifest). Its derived `memberOf` relationships and live status drive an environment-scoped project tree in the clients. See [stave-integration.md][28].

#### Den

A ContextMarmot memory store attached to a Stave space through its manifest's `memories` list. Listed on the project today; integration is planned. See [stave-integration.md][28].

#### Stave operation

One long Stave mutation (create a space, register a repo, remove a partial space, set up) run by the application-lifetime `StaveOperations` service under a client-chosen `operationId` and streamed as sequence-numbered progress events. A client starts or reattaches with the same id, so an operation outlives the socket that started it (fork only). See [stave-integration.md][28].

### Forks and imports

#### Fork

A new thread that continues an existing thread from a completed point. In [the contracts][1], the server-materialized `thread.fork` command produces `thread.created` plus `thread.forked` on the child aggregate, with lineage stored as `forkedFrom`. History assembly lives in [threadFork.ts][27].

#### Fork point

The turn boundary a fork continues from: through turn _N_, inclusive. It is anchored by the command's `throughTurnId` and, on the provider side, by the native turn reference recorded per completed turn. See [the contracts][1] and [threadFork.ts][27].

#### Inherited history

The messages, activities, proposed plans, and turns copied into a fork through the fork point, keeping their original timestamps. The `ThreadForkHistory` payload in [the contracts][1] is projected into real rows for the child by [projector.ts][4].

#### Imported thread

A thread created from an [external session](#external-session) by the server-materialized `thread.import` command, which emits `thread.created` plus `thread.imported`. It runs on a native fork of that session cut at import time, so the original is never touched; the copied history belongs to no turn and cannot be reverted or diffed. Origin is stored as `importedFrom` in [the contracts][1], and a fork of an imported thread inherits it so its copy of that history stays protected; the flow is in [thread forking][30].

#### External session

A provider session created outside Lecturn, by a provider CLI or desktop app writing to the same provider home. The read-only `externalSessions.list` RPC lists them per provider instance and hides the sessions Lecturn started itself, including the forks of imports that have not been sent to yet. Shape is in [the external session contracts][29]; per-provider behavior is in the [provider architecture][16] external sessions section.

### Notifications

#### User present

The strict presence signal that silences notification rings: some client lease is active, visible, focused, and recently interacted with (`isUserPresentLease` in `apps/server/src/background/BackgroundPolicy.ts`). It is stricter than a foreground lease, which only schedules background work. The server sends it to the relay as `userPresent` on each activity publish. The desktop notch applies the same rule locally. See [pull-request-watches.md][31].

#### Notified-event record

The per-device list of events the relay already rang, stored in `relay_mobile_devices.notified_push_events_json`. Identity is environment + thread + phase + status. Entries marked `deferred` are Live Activity rings still owed because the user was present or a shared card observed another environment’s transition before its own publish. See [pull-request-watches.md][31].

### Thread notes

A **thread note** is a project-scoped quote and optional comment saved independently of the chat draft. Its **note anchor** records the message identity, role, normalized rendered-text offsets, quote, and nearby context. Anchors share citation matching and navigation; they never index raw stored message text. See [Thread notes](./thread-notes.md).

### Decision

An opt-in, project-scoped note derived from conversation evidence. Review state (unreviewed, confirmed, dismissed) is independent of lifecycle (current, superseded). An environment’s funding account pays for bounded detection; the selected thread provider writes the note. See [Thread decisions](thread-decisions.md).

### Extensions and Contextual

**Extensions** is the optional private implementation boundary for desktop capture and fixed-policy evaluation; public contracts, consent, accounting and clients stay in Lecturn. **Contextual** selects relevant source evidence for a thread at submission. A **preparation** is its durable pending assessment, a **packet** is the bounded selected evidence, and a **delivery receipt** records the provider's proven or unknown acceptance. The **supply ledger** prevents repeatedly attaching unchanged guidance. A **context epoch** changes only with proven continuity loss such as native compaction or an explicit refresh. See [Extensions architecture](extensions.md).

## Teams terminology

- **Company / organization**: a Clerk organization with a relay Teams account for centralized Connect purchasing and policy. It is not a shared environment.
- **Purchased seat**: one unit of company subscription capacity. Purchasing a seat does not assign it to a member.
- **Assigned seat**: an explicit allocation to one current member; paid entitlement and live membership are also required for company access.
- **Funding organization**: the company bound to an environment link. It remains fixed until explicit unlink/relink and never replaces the environment's user owner.
- **Company policy**: allowed providers and activity-publishing rules enforced by company-funded hosts and the relay.

See [Teams architecture](teams.md) for enforcement boundaries.

## Connect account terminology

- **Connect account**: a Clerk user ID signed in to Lecturn Connect. Web and desktop can hold up to five at once.
- **Active account**: the account of Clerk's active session. Publish, billing, teams, and CLI authorize act on it.
- **Known account**: an account this client holds data for, from its first sign-in until a sign-out started in Lecturn. The list is kept per origin.
- **Needs sign-in**: a known account without a signed-in session. Its environments stay in the catalog, disconnected, and its data is kept.
- **Owning account**: the account a relay environment is tagged with (`accountId` on its catalog target). Direct, Tailscale, and SSH environments have none.
- **Account mark**: the short text, taken from the owner's email, shown on rows once two accounts are known.
- **Segment**: one account's part of the thread sidebar, shown once two accounts are known: a sticky account bar, then the usual composition over that account's environments. Environments without an owning account form one last segment without a bar. Collapsing a segment hides its rows and changes nothing about the connection. See [sidebarSegments.logic.ts](../../apps/web/src/components/sidebar/sidebarSegments.logic.ts).
- **Account-scoped key**: a project group key with its owning account appended. Project groups are built once per account so a repository under two accounts stays two groups, and the scope keeps their keys apart. `parseAccountScopedKey` reads the account back, and only from a well-formed scope at the end of the key. The project page uses it to act on that account's members alone.
- **Unlisted environment**: a relay environment no signed-in account lists. It is disconnected and kept, and the user can remove it.
- **Account admission**: the checks for Clerk multi-session support, account limits, environment ownership, and mobile relay capability before adding an account.
- **Stand-down marker**: the shared-storage timestamp a multi-account build writes so a single-account tab on the same origin asks for a reload instead of signing out the extra account.

See [Lecturn Connect](lecturn-connect.md#multiple-signed-in-accounts) for the mechanics.

[1]: ../../packages/contracts/src/orchestration.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[16]: ./providers.md
[27]: ../../apps/server/src/orchestration/threadFork.ts
[28]: ./stave-integration.md
[29]: ../../packages/contracts/src/externalSessions.ts
[30]: ./thread-forking.md#importing-external-sessions
[31]: ./pull-request-watches.md#notification-rings
