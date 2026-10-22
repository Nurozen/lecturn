# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/orchestration-v2/ProviderAdapter.ts). Normalize there
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
See the [adapter](../../apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts).

Pi runs the user's own `pi` install in RPC mode and owns native extension, package, and project
trust discovery. Lecturn injects only its namespaced MCP bridge, so a Pi session behaves as it does in
the Pi TUI. Pi session files back native resume, rollback, and same-instance thread forks.
Forks use Pi's CLI in the destination directory because RPC session switching retains the source
session's cwd. Provider switches still use portable handoff summaries.
See the [adapter](../../apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
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

Managed ChatGPT sign-in for a remote environment can finish on a local primary. The
[primary handoff](../../apps/server/src/provider/CodexChatGptHandoff.ts) uses an ephemeral
credential store and the destination's environment ID. It exchanges and verifies the code before
transferring the issued client registration and tokens. Only the destination persists and refreshes
that session; retaining a primary refresh session would race refresh-token rotation. Without a local
primary, the client uses the remote callback completion flow.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Cursor and Grok are the exception: their only updater is the CLI itself, which detects its
own installer, so any resolved executable runs `<binary> update`. Anything unproven stays
manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

GitHub Copilot is the one provider whose other installs update themselves: a path that is not a
Node package install runs `copilot update`, and a Node package install updates only through a
proven package manager.

Ownership is cached per instance. It is re-read after provider detection, because the login-shell
`PATH` can change which executable resolves, and immediately before an update runs. The re-read
after detection runs in the background, before snapshot enrichment, so a slow `brew` never delays
the detected snapshot. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. The
[adapter](../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts) persists them as
`user_input_request` turn items and runtime requests with `responseCapability: { type: "message" }`.
Their execution nodes do not block the run. Web, desktop, and mobile use their normal question
panels, and requests remain pending after a turn finishes, a provider exits, or the server restarts.

`runtime-request.respond` reads the persisted request and question item, validates required
answers, and commits the resolution and a user message in one transaction. Repeating the same
command returns its receipt without posting the answer twice. The normal message path starts or
resumes a run, queues behind active work, or steers when the adapter supports it. Blocking questions
retain the provider's live response path. Do not infer that a request has disappeared merely because
it is outside the recent history window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace. The
[attachment boundary](../../apps/server/src/orchestration-v2/AttachmentClaims.ts) validates and claims
uploads for a thread; adapters choose native input formats for those environment-local files.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

## Provider diagnostics

Native event logs retain lifecycle events, responses, and failures. Token deltas and duplicate raw
frames are filtered before adapters copy or redact payloads. The filter accepts both legacy native
events and v2 protocol envelopes; decode failures remain visible through diagnostic frames.

Log payloads have a 64 KiB encoded budget. Large or deeply nested payloads become structural
summaries that retain routing identifiers, methods, status, and error fields. Traversal is bounded
before redaction and serialization, so logging a large response does not require several full
copies. These limits apply to diagnostics; provider event handling is unchanged.

Codex resumes with metadata-only reads when it needs a thread's identity and update time. Its
initialization capabilities opt out of `turn/diff/updated`: Lecturn derives diffs from checkpoints.
The logger filters those notifications before traversal when an older provider still sends them.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).

## Codex conversation rollback

Codex 0.156 removed `thread/rollback`, so every rollback replaces the native thread at a turn
boundary. Paginated history is read with `thread/turns/list` (legacy history with `thread/read`)
and reverted by forking through the last retained turn; removing every turn starts a fresh native
thread. If Codex refuses to fork legacy history, that error is surfaced unchanged. The Lecturn thread ID stays unchanged. The runtime adopts the replacement resume cursor
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
- `conversationFork` — whether the driver forks a conversation natively (`native`) or not
  (`unsupported`). It is presentation only and mirrors the V2 adapter capability
  `threads.canForkThread`; it never gates the fork action. Every provider can fork.

| Driver kind     | `sessionModelSwitch` | `conversationFork` |
| --------------- | -------------------- | ------------------ |
| `codex`         | `in-session`         | `native`           |
| `claudeAgent`   | `in-session`         | `native`           |
| `cursor`        | `in-session`         | `unsupported`      |
| `grok`          | `in-session`         | `unsupported`      |
| `githubCopilot` | `in-session`         | `unsupported`      |
| `opencode`      | `in-session`         | `native`           |
| `antigravity`   | `in-session`         | `unsupported`      |

The presentation values live in each provider snapshot (`CodexProvider.ts`, `ClaudeProvider.ts`,
and so on in `apps/server/src/provider/Layers/`); the fork capability itself lives in each V2
adapter (`apps/server/src/orchestration-v2/Adapters/*AdapterV2.ts`). A fork onto a provider
without a native fork (or one that cannot fork from the chosen turn) still succeeds: the
orchestrator hands the source transcript to a fresh provider session through a portable context
handoff instead of a native fork. Clients show the fork action from the environment's
`threadForking` capability and a completed source run, not from this flag. See
[thread-forking.md](./thread-forking.md) and [context-handoffs.md](./context-handoffs.md).

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
