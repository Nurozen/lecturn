# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Process and account isolation

Lecturn-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
Lecturn's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
Lecturn auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).

## Codex conversation rollback

Legacy Codex history uses `thread/rollback`. Paginated history is read with `thread/turns/list`
and reverted by forking through the last retained turn; removing every turn starts a fresh native
thread. The Lecturn thread ID stays unchanged. The runtime adopts the replacement resume cursor
only after the request succeeds and ignores later notifications from the retired native thread.
`ProviderService` persists the updated session binding before reporting rollback success, so
reconnects and later forks use the retained history.
Stored-thread resume and fork requests use `excludeTurns: true`; the runtime reads history
separately instead of asking Codex to hydrate paginated turns in the open response.

## Copilot health check

The `githubCopilot` probe also never opens an ACP session. It runs `copilot --version`, then parses
the model list from `copilot help config`. That list is the installed CLI version's built-in
catalog, not filtered per account or plan; org policy can still reject a listed model at turn time.
The snapshot always leads with `auto` (default, Copilot picks per request). Auth state comes from the CLI itself: a short-lived
`copilot --acp` process answers `initialize` and `authenticate` (`copilot-login`), then is closed.
Success is "authenticated" (labelled with the last user in `~/.copilot/config.json` when present),
ACP's `auth_required` error (-32000) is "unauthenticated" with a `copilot login` hint, and any other
failure or timeout is "unknown". Token env vars are not trusted because Copilot falls back to its
keychain login; Copilot reads `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` itself. The CLI
is driven over ACP (`copilot --acp --no-ask-user`, since ask-user questions have no ACP answer
path): threads resume with `session/load`, every model selection, `auto` included, goes out as
`session/set_model` unless it equals the model last set in that session, and permission modes map
onto the session's `mode` and `allow_all` config options. Cancel waits for Copilot to resolve the
prompt as `cancelled` (`cancelBehavior: "wait-for-prompt"`), and the adapter drains queued updates
before `turn.completed`. In `#plan` mode Copilot writes its plan with `apply_patch` to
`${COPILOT_HOME:-~/.copilot}/session-state/<acpSessionId>/plan.md`; the adapter hides edits inside
that directory and, at the end of a plan turn, emits `turn.proposed.completed` with `plan.md` when
the turn changed it, else with the final assistant message. Updates go through npm for npm, bun,
pnpm, and Vite+ installs (including the Windows `%APPDATA%\npm` shim) and through `copilot update`
otherwise. Title and commit generation uses `gpt-5-mini` in a one-shot `--no-ask-user
--disable-builtin-mcps` session, which stays in Copilot's own session history because the CLI
cannot delete sessions.

## Adapter capabilities

Each adapter declares a static `ProviderAdapterCapabilities` record, defined in
[`ProviderAdapter.ts`][adapter] and exposed on the adapter shape as `capabilities`. Server code
and clients gate per-provider features on it instead of switching on driver kinds:

- `sessionModelSwitch` — whether the model of an existing session can change in place
  (`in-session`) or not (`unsupported`).
- `conversationFork` — whether the driver can natively fork a conversation at a turn boundary
  when a session starts with a `fork` input (`native`), or must reject that start
  (`unsupported`).

| Driver kind     | `sessionModelSwitch` | `conversationFork` |
| --------------- | -------------------- | ------------------ |
| `codex`         | `in-session`         | `native`           |
| `claudeAgent`   | `in-session`         | `native`           |
| `cursor`        | `in-session`         | `unsupported`      |
| `grok`          | `in-session`         | `unsupported`      |
| `githubCopilot` | `in-session`         | `unsupported`      |
| `opencode`      | `in-session`         | `native`           |
| `antigravity`   | `in-session`         | `unsupported`      |

The values live at the top of each adapter (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on in
`apps/server/src/provider/Layers/`). A driver with `conversationFork: "unsupported"` fails a
session start that carries a `fork` input with a `ProviderAdapterValidationError` rather than
silently starting a session that never saw the forked transcript. See
[thread-forking.md](./thread-forking.md) for how the fork input is produced.

## External sessions

An external session is a provider session created outside Lecturn: Claude Code CLI or Claude
Desktop sessions under the Claude home, and Codex CLI, Codex Desktop, or ChatGPT app threads under
the Codex home. The read-only RPC `externalSessions.list` ([contract][external-contract], scope
`orchestration:read`) lists them for one provider instance, optionally narrowed by `cwd` and
`searchTerm`.

The seam is an optional `listExternalSessions` on `ProviderInstance` in
[`ProviderDriver.ts`][driver], paired with the `externalSessions` snapshot field
(`supported` or `unsupported`). Absent means unsupported, on both sides. It sits on the instance,
not the adapter, because it reads the instance's own session store.
[`externalSessions.ts`][external-sessions] resolves the instance, passes the lister every resume
cursor Lecturn has persisted (provider bindings plus the forks of imported threads that have not
been sent to yet, for all instances, since instances can share a home; a lister skips cursors its
own schema cannot parse), and shapes the rows. Failures are `provider-unsupported`,
`provider-unavailable` (unknown or disabled instance), or `unreadable`.

A second optional seam, `importExternalSession`, backs `thread.import`: it natively forks one
listed session (a local operation, no auth and no model call) and returns the fork's resume
cursor, the session's title and cwd, and a summary-level transcript that never carries tool inputs
or outputs. A driver that sets it must also set `listExternalSessions`. The original session is
never resumed or written. Callers validate before invoking it, since the fork stays on disk even
if the import is later rejected. Flow, history rules, and per-provider notes are in
[thread-forking.md](./thread-forking.md#importing-external-sessions).

- **Claude** ([`ClaudeExternalSessions.ts`][claude-external]) calls the SDK's `listSessions` with
  `includeProgrammatic: false`, which drops the sessions Lecturn creates, then removes any session
  named by a known resume cursor. `origin` comes from the `entrypoint` field in the first 16 KiB of
  the transcript, read only for the returned page; transcripts are never read in full. The SDK
  lister reads `process.env`, so an instance with a custom Claude home reports `unsupported`.
- **Codex** ([`CodexExternalSessions.ts`][codex-external]) opens a short-lived app-server, pages
  `thread/list` newest first in fixed pages of 100 until the limit is filled or 1000 threads are
  scanned, and closes it after each call, one call at a time per instance. Lecturn's threads are
  hidden by `originator` and known resume cursors, not by `source`: desktop apps and Lecturn both
  report `vscode`. Ephemeral and subagent threads are dropped too. The state-database-only list
  mode is not used because it returns stale rows.

Results are newest first and bounded: at most 100 rows per request, `title` and `firstPrompt`
capped at 200 characters, search applied before the limit. `searchTerm` semantics differ per
provider: Codex matches natively on the thread title, Claude matches title, first prompt, cwd and
branch. `truncated` is true when more matching sessions exist than were returned, including when
a lister stopped at its own scan cap.

| Driver kind     | `externalSessions` | Source                                      | Importer                                               |
| --------------- | ------------------ | ------------------------------------------- | ------------------------------------------------------ |
| `codex`         | `supported`        | app-server `thread/list` on the Codex home  | app-server `thread/fork`, turns read from the fork     |
| `claudeAgent`   | `supported`        | SDK `listSessions` on the default home only | SDK `forkSession` beside the source, default home only |
| `cursor`        | `unsupported`      | none                                        | none                                                   |
| `grok`          | `unsupported`      | none                                        | none                                                   |
| `githubCopilot` | `unsupported`      | none                                        | none                                                   |
| `opencode`      | `unsupported`      | none                                        | none                                                   |
| `antigravity`   | `unsupported`      | none                                        | none                                                   |

[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[driver]: ../../apps/server/src/provider/ProviderDriver.ts
[external-contract]: ../../packages/contracts/src/externalSessions.ts
[external-sessions]: ../../apps/server/src/provider/externalSessions.ts
[claude-external]: ../../apps/server/src/provider/Drivers/ClaudeExternalSessions.ts
[codex-external]: ../../apps/server/src/provider/Drivers/CodexExternalSessions.ts
