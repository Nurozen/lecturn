# App trust boundary

A connected app is a third-party program on the server's machine. It gets agent threads in its own
projects, offers its tools to those threads, and shows Lecturn's own web UI inside its window (the
embed). Users approve it once ([Connected apps](../user/connected-apps.md)). The boundary spans
auth, MCP, orchestration and the clients, so its constraints live here rather than in any one of
them. Product terms are in the [glossary](./glossary.md#workspace-and-conversation).

## Two subjects and a scope nobody else holds

An app acts as one of two session subjects, and [subjects.ts][subjects] is the only code that
parses them:

- `app:<appId>`: the app's own credential. It is a long-lived bearer, since no refresh grant
  exists, re-minted on every connect and stored by the app. It carries `apps:host`, the scope of
  every app method. That scope is outside the standard client scopes and the grantable scopes, so no pairing link,
  Connections grant or MCP sign-in can delegate it.
- `embed:<appId>:<projectId>`: a token of at most 15 minutes for one embedded view of one project,
  minted by `apps.mintEmbedToken`. It can read and operate threads of that project only.

Both are left out of the Connections session lists and out of "revoke other clients", including
the SQL in [AuthSessions.ts][auth-sessions]. Otherwise a user cleaning up devices would silently
disconnect every app.

## Default deny, in four places

The scope check runs first. For `app:` and `embed:` sessions, an allowlist then decides what they
may touch, and the project must be bound to the subject's app (for an embed, the token's
project). Anything not listed is refused, so a method or route added upstream is closed to apps
until someone writes a rule for it:

- WebSocket RPCs: `APP_RPC_RULES` in [appAuthorization.ts][app-authz].
- HTTP routes: [appHttpAuthorization.ts][app-http-authz]. `EnvironmentAuth` refuses unlisted paths
  before any handler runs, including the WebSocket ticket path.
- Shell streams: [appStreamFilter.ts][stream-filter] filters snapshots and updates for app and embed
  sessions only. Every other session receives the same values it did before, so their payloads
  are byte-identical.
- MCP: an agent on an app thread holds a `/mcp` credential that reaches only that app's project
  ([threadAccess.ts][thread-access]). Without this, a prompt-injected app tool result could steer
  the agent into the user's other projects.

An embed never creates a thread directly. `apps.createEmbedThread` creates it on the server, which
sets `appData` on behalf of the owning app; Lecturn's own clients never write `appData`.

## Embed tokens and the cookie-precedence trap

The embed is Lecturn's web app, served from the server's own origin. A browser therefore attaches
the user's session cookie to the embed's requests, and HTTP credential selection prefers the
cookie over a bearer. Left alone, the embed would act as the user. Two rules prevent that:

- On the server, a bearer that verifies to an embed session wins over a cookie. Any other bearer
  keeps the cookie-first order (`embedBearerBesideCookie` in [EnvironmentAuth.ts][env-auth]).
- In the client, embed HTTP uses `credentials: "omit"`, and the socket always opens with a ticket.
  An unticketed socket would authenticate by the cookie. The token arrives as `#embedToken=` (not
  `#token=`, which pairing consumes) and lives in memory only.

Electron hosts also give the embed its own session partition. Authenticated requests annotate
their span with the subject and whether a cookie was present, which is how the cookie-isolation
check is proven end to end.

## Loopback does not mean local

Only a program on the server's machine may ask to pair. Tailscale Serve, Lecturn Connect and
reverse proxies all reach the server from a loopback socket, so the remote address alone proves
nothing. [pairingGuard.ts][pairing-guard] refuses any `Origin` header (a web page posting through
the user's browser), any forwarding or `Tailscale-*` header, a non-loopback `Host` (DNS rebinding),
and a non-loopback remote address. The app then polls for the decision with a secret only it
holds.

## Sockets close when the session expires

The server closes a WebSocket when its session expires. An embed socket therefore dies with its
token. The embed asks its host for a new token ahead of expiry (`lecturn/token.refresh`) and opens a
new session for each token. Do not keep an embed socket alive past its token instead: the token's
lifetime is the boundary.

## The embed guest never has a desktopBridge

The web app takes its desktop code paths, including IPC to the Electron main process, whenever
`window.desktopBridge` exists. The embed guest's preload ([electron-preload.ts][embed-preload])
exposes only the embed host bridge. `mountEmbedView` owns every web preference that decides what
the guest can reach: preload, partition, sandbox, context isolation and node integration. A host
cannot override them.

## Framing

`frame-ancestors` is set only by the static HTML handler ([frameAncestors.ts][frame-ancestors]):
`'self'` on every page, plus the granted apps' `embedOrigins` on `/embed`. It is never set on asset
or attachment routes, because Lecturn's own clients frame MCP App cards and documents from them.
Origins must name their port, since a port-less source matches only the default port; a port
wildcard is accepted for loopback. Electron hosts load `/embed` as a top-level page, where
`frame-ancestors` does not apply, so they declare no origin. In dev, HTML comes from Vite and gets
no policy, so framing tests use a static build. If the registry cannot be read, `/embed` falls back
to `'self'`.

## Re-approval when what the user approved changes

A grant is bound to a fingerprint of the headless command (command, args, `listArgs`, env, cwd) and
the embed origins (`appGrantFingerprintSource` in [apps.ts][contracts-apps]). These are what the
user actually approved: the program Lecturn runs as the user and who may frame Lecturn. A
registration with a different fingerprint pauses the grant until the user decides, and the new
registration waits on its pairing request meanwhile. Name, icon, instructions and gated tools are
the app's own presentation and policy, so changing them does not ask again.

Headless processes inherit the server's environment minus `ELECTRON_RUN_AS_NODE`, then the
registration's `env`. The server itself may run as Electron-as-node, and leaking that flag would
change what an app's Electron binary does.

## App tools go through an interceptor

The shared `/mcp` server has one flat tool registry: visibility cannot see the session, and
`list_changed` never reaches providers because the transport has no GET stream. So app tools are
not registered there. [AppToolInterceptor.ts][interceptor] wraps the transport through one line in
`McpHttpServer`. For a credential whose thread belongs to a granted app, it adds that app's tools
to `tools/list` and routes a `tools/call` the built-in toolkits do not know. Built-in tools win a
name clash.

Definitions pass through an allowlist: title, description, input schema, annotations,
`_meta.ui.resourceUri` and `_meta.ui.visibility`. Other `_meta` keys could change how a provider
treats a tool (Claude's `anthropic/requiresUserInteraction` is one), so they are dropped. Any
`lecturn/*` key or card reference an app returns is stripped, so an app cannot spoof Lecturn's
approvals or cards. The one exception is `lecturn/summary`, the row's secondary text, kept only as
one line of plain text of at most 120 characters. Clients read it, like the tool title the server
stamps on the turn item, only on rows whose source is an app.

Adapters store a result's `lecturn/*` `_meta` keys with the tool item, and drop its other `_meta`
keys. Claude and Codex always get them. ACP gets them when the agent puts the MCP result in
`rawOutput`, and Pi's bridge passes them in `details`, which the model never sees. Cursor's SDK
reports no result `_meta` and OpenCode reports results as text, so their app rows show the title
with no summary.

Headless definitions are cached. The registration's `listArgs`, the preferred path, runs a command
that prints the definitions and exits. It must not take an app-side lock. A throwaway lister could
take the project lock from a session the app started itself, as RocketWright's would. Without
`listArgs`, an app thread's `tools/list` on an empty cache starts the long-lived call-path process
that calls use, never a throwaway lister. Codex gives MCP startup only 10 seconds, which is why
`listArgs` stays preferred. That process is shared per app project and closed by an idle reaper
armed from `onRunTerminal`: the reaper closes its stdin and lets the app drain. Lecturn
force-kills it only on revoke or shutdown.

## Gating and the approval encoding

[AppToolGate.ts][gate] is the only gate. The effective access is the thread's resolved runtime
mode, after any downgrade, capped by the app's runtime ceiling. Plan mode gates like the runtime
mode under it, and an unknown interaction mode counts as Read-only.

- Auto and Full access forward every call with `lecturn/approval: { approved: true }`. These modes
  already run tools without asking, and the app is told so that it does not ask on its own.
- Supervised and auto-accept-edits ask the user before a call to a gated tool, and when the app
  answers a call with `lecturn/approval-required`.
- Read-only refuses those calls and forwards the rest. Read-only exists only as a per-app ceiling
  in the registry. The credential's `rtc` claim holds only a `RuntimeMode`, and mapping Read-only
  to the lowest mode would turn refusals into prompts.

An approval is an ordinary `permission` runtime request with a `live` capability on the calling
session, marked with `connectedAppTool` ([AppToolApprovalService.ts][approval-service]). Every
shipped client, including old mobile builds, already renders and answers that shape.
`RuntimeRequestService` sees the marker, or a registry claim, and answers the waiting MCP call
instead of the provider, which never raised the request. The respond effect is still enqueued;
only the adapter call is skipped, so tests assert "no adapter respond call". An unanswered request
expires after 10 minutes through the internal `runtime-request.app-expire` command, and
interrupting or stopping the run cancels it.

## Shared state lives below the runtime

An approval waits in the MCP branch of the layer graph, but the user's answer is executed by
`RuntimeRequestService` inside the orchestration runtime. The apps orchestration hooks also
register inside the runtime, where `AppsLayer` services are invisible. So
`AppToolApprovalRegistry` and `AppRuntimeState` (host context, the headless process table, the
instruction and tool lookups) are provided once in [runtimeLayer.ts][runtime-layer], and the
`AppsLayer` services wrap those same refs. `AppsLayer` itself is provided once, on the outer pipe
in `server.ts`. A second build would split lease and process state, so a latch in
`AppRuntimeState` makes it fail. [AppsLayer.ts][apps-layer] records the dependency tiers.

## The live switch, and why hosts key by workspace root

`@lecturn/embed` starts on the app's own sidecar when the user's server is absent or has not
granted the app. It switches to the user's server live, without a host restart. While on the
sidecar it watches `server-runtime.json` under the user's Lecturn home. It never opens the
ownership lock, because probing the lock can make a starting server exit. On grant it:

1. re-creates every known workspace;
2. copies the sidecar's threads;
3. maps thread ids through `copiedFrom.sourceThreadId` and marks the originals `continuedIn`;
4. publishes the live lease on the new server;
5. retargets mounted views and emits a `mode` event.

The sidecar and its lease stay up until no turn runs on it. Losing the user server runs the same
sequence in reverse.

A thread is copied again only when its `historyRevision` has passed the revision its copy was
taken at. The revision moves on messages, turn items and terminal provider-turn events, never on
metadata such as `appData`, subtitles or `continuedIn`. Otherwise the helper's own writes would
trigger re-copies.

A copy keeps its source's runtime mode, interaction mode and model, so it is never more permissive
than its source. If the source's provider is missing on the destination, the copy takes the
destination's default model and ends with a notice that says so. Replacing a copy can make its
modes stricter, never looser. A bundle from before these fields existed gets the destination's
defaults.

Project and thread ids differ per server. Hosts key mounts, caches and rail state by workspace
root, and follow `mode` events (`projectIdsByWorkspaceRoot`, `threadIdMap`); a mount built from a
connection retargets itself.

## The sidecar never outlives its host

The sidecar is a private Lecturn server in the app's own base directory. It runs in web mode with
an `AppSidecarBootstrap` envelope on fd 3. Desktop mode would change cookie naming, the default
port, the self-update owner and the startup URL. The helper never logs sidecar stdout, which
carries an admin token. Exit code 78, or a live owner of the base dir, means attach instead of
spawn, and an attached sidecar is left running.

A sidecar left behind by a crashed host would keep the app's state locked. The helper passes a pipe
as `parentPipeFd` (fd 4) and never writes to it. The server exits at its end-of-file, which only
the host's death causes ([sidecarBootstrap.ts][sidecar-bootstrap]). A parent-pid poll covers hosts
that pass no pipe, and Windows. `connect()` takes the host's `AbortSignal` and returns a promise
with `close()`, so a host that quits while the sidecar is still starting stops it and waits for
it to exit.

## Per-adapter decisions

Each adapter makes three decisions. It delivers the app's `instructions`. It keeps the provider's
own approval prompt off app tools, which Lecturn already gates. And it reports whether the
provider thread got Lecturn's MCP server, through `McpProviderSessions.reportActivation`. On a
missing or failed activation, the apps hook writes one "tools unavailable" notice per thread and
provider thread.

| Adapter                                          | Instructions                                  | Native prompt for app tools                                                                                                           | Notes                                                                                                |
| ------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Claude                                           | `systemPrompt.append` (part of the query key) | None: `mcp__lecturn__*` is pre-approved                                                                                               | Init failure reports activation failed                                                               |
| Codex                                            | `developer_instructions`                      | Off per tool (`approval_mode = "approve"`) for the app's tools on app threads; a server-wide default would also change built-in tools | MCP startup failure reports activation failed                                                        |
| ACP: registry agents, Grok, Copilot, Antigravity | Prompt block, re-sent when its digest changes | `clientPolicy` allows calls naming Lecturn's server and an app tool; never commands, file mutations or calls with locations           |                                                                                                      |
| Cursor                                           | Appended per turn                             | None                                                                                                                                  | The SDK takes no MCP tool timeout, so its 60 s default applies; users are told to answer within 60 s |
| OpenCode                                         | v2 session instructions, v1 system prompt     | None                                                                                                                                  | 65 min tool timeout. An external server never installs the MCP config, so it reports not activated   |
| Pi, Muse                                         | Not delivered                                 | None                                                                                                                                  | Activation only                                                                                      |

[subjects]: ../../apps/server/src/apps/subjects.ts
[auth-sessions]: ../../apps/server/src/persistence/AuthSessions.ts
[app-authz]: ../../apps/server/src/apps/appAuthorization.ts
[app-http-authz]: ../../apps/server/src/apps/appHttpAuthorization.ts
[stream-filter]: ../../apps/server/src/apps/appStreamFilter.ts
[thread-access]: ../../apps/server/src/mcp/threadAccess.ts
[env-auth]: ../../apps/server/src/auth/EnvironmentAuth.ts
[pairing-guard]: ../../apps/server/src/apps/pairingGuard.ts
[embed-preload]: ../../packages/embed/src/electron-preload.ts
[frame-ancestors]: ../../apps/server/src/apps/frameAncestors.ts
[contracts-apps]: ../../packages/contracts/src/apps.ts
[interceptor]: ../../apps/server/src/mcp/toolkits/app/AppToolInterceptor.ts
[gate]: ../../apps/server/src/apps/AppToolGate.ts
[approval-service]: ../../apps/server/src/apps/AppToolApprovalService.ts
[runtime-layer]: ../../apps/server/src/orchestration-v2/runtimeLayer.ts
[apps-layer]: ../../apps/server/src/apps/AppsLayer.ts
[sidecar-bootstrap]: ../../apps/server/src/apps/sidecarBootstrap.ts
