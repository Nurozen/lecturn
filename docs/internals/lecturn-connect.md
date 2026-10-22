# Lecturn Connect

Lecturn Connect uses Clerk for cloud identity. The relay manages environment links,
credentials for reaching environments, and managed tunnel allocations. After
bootstrap, clients send application traffic through the environment's tunnel
hostname; the relay Worker does not proxy their HTTP or WebSocket sessions.
The one exception is automation webhooks: the relay forwards
`/v1/hooks/:endpointKey/:hookId/:token` to the environment's tunnel so
senders get a stable URL. It keeps bodies and tokens out of its traces and
leaves token and signature verification to the environment
([forwarder](../../infra/relay/src/hooks/HookForwarder.ts)).

By default the forwarder stores nothing. An environment can opt in to having
the relay hold requests while it is offline
(`hold_webhooks_while_offline` on its link). Only then does the relay store the
raw request, including the hook token in the path, in a Durable Object for
that environment, with SQLite storage. The object pushes held requests back
through the tunnel from its alarm, oldest first, and backs off while the
environment stays away. When the tunnel reconnects, the environment asks the
relay to deliver right away. Requests are deleted once the environment
answers, after 24 hours, or when no user has the environment linked. The relay
still never checks the token; delivery goes through the same environment route.
Every forward carries `x-lecturn-relay-delivery-id`, so a request that reached the
environment before a timeout and is delivered again later runs once
([inbox object](../../infra/relay/src/hooks/HookInboxObject.ts)).

A Durable Object, not Postgres or Queues, because held requests are write-once,
read-once bodies of up to 1 MiB that need per-environment order, caps, and
retry timing. Queues cap messages at 128 KB and cannot hold one environment's
requests back while it is away.

Clerk, deployment, and native authentication setup live in the
[Connect setup runbook](../operations/connect-setup.md).

## The relay is a trusted broker

An authenticated cloud user still needs an active environment link. The relay
asks that environment to mint a one-time bootstrap credential bound to the
client's DPoP key. The client exchanges it directly with the environment for an
[environment session](./environment-auth.md). The relay never receives that
session token, and possessing the bootstrap credential alone does not permit
redeeming it without the client's private key.

Both sides authenticate this exchange. The environment accepts only bounded,
replay-guarded relay proofs for its own identity, linked user, and requested
operation. Signed environment responses bind the result to the request nonce;
mint responses also bind the credential to the client proof key. The relay
verifies those bindings before returning a credential. This prevents a different
process behind the tunnel from impersonating the linked environment. The checks
meet in the
[environment link service](../../apps/server/src/cloud/CloudLink.ts) and
[relay connector](../../infra/relay/src/environments/EnvironmentConnector.ts).

The relay holds the signing authority for mint requests. DPoP protects an honest
exchange from credential reuse; it does not make a compromised relay signing
key harmless. Keep that trust assumption explicit when changing the protocol.

Managed tunnels expose only a validated loopback HTTP origin. Link proof checks
reject forwarded authority headers, and the relay resolves endpoints from its
own managed allocations rather than a caller-supplied URL. Health and mint
requests must not follow redirects. These restrictions keep endpoint discovery
from turning into arbitrary relay egress or exposing another service on the
environment host.

## A link outlives a connector process

CLI authorization, desired exposure, and a running connector have different
lifetimes. Linking can record intent while the server is stopped. Startup
reconciles that intent. CLI logout removes the stored cloud credential and
disables exposure without uninstalling the environment's background service.

Managed allocations belong to a user/environment pair. Provisioning checkpoints
external tunnel and DNS resources so retries can reconcile partial work. A
normal shutdown of a CLI-managed link releases its tunnel to avoid paying for
an idle resource, retaining the hostname reservation for the next startup.
It also retains the allocation record so the environment remains "offline"
rather than becoming "not authorized".

Two cases must retain the tunnel across shutdown. A link installed through a
client has no startup provisioning path and depends on its stored connector
token. An update handoff immediately starts a replacement server, and replacing
the tunnel would add routing propagation delay to every update. These exceptions
belong to [shutdown handling](../../apps/server/src/cloud/CloudLink.ts).

Release and unlink claim the allocation generation before deleting external
resources. A delayed cleanup must not delete a tunnel reused by a concurrent
restart or relink. Unlink commits authorization revocation before external
teardown, because a database failure must leave the active link usable. Failed
teardown retains enough state to retry. See the
[managed endpoint lifecycle](../../infra/relay/src/environments/ManagedEndpointProvider.ts).

## Idle tunnels are reclaimed and recovered

Cloudflare bills a tunnel whether or not a connector is attached, so a laptop
that sleeps with a linked environment leaves a paid tunnel behind. The relay's
five-minute maintenance job can reclaim those tunnels. `RELAY_TUNNEL_CLEANUP_MODE`
selects `off`, `dry-run`, or `enabled`, with `off` as the default. The mode is
read at deploy time, so changing it means a relay deploy, not a variable flip.
A candidate is a same-stage tunnel that Cloudflare reports down for at least
five minutes, or one that never connected and is at least an hour old. The
longer grace for never-connected tunnels covers a pairing still in progress.

Cleanup deletes only tunnels whose host has registered recovery. Allocations
without recovery registration belong to hosts that cannot replace a deleted
tunnel and are left alone. Allocations with no recorded tunnel ID, or a
different tunnel ID, are skipped because a provision may own them. A tunnel with
no allocation row at all is counted as `skippedOrphan` and never deleted: there
is no row to lock, so a relink that adopts it by name could race the delete.
Clear those by hand. Each sweep is bounded: at most ten list requests, 100 deletions, a
two-minute deadline, and an early stop on a Cloudflare rate limit. Each sweep
starts one budget further along the candidate list, so a block of deletes that
keep failing cannot starve the tunnels listed after them. See the
[reaper](../../infra/relay/src/environments/ManagedEndpointReaper.ts).

A host registers recovery at startup by sending its tunnel ID and loopback
origin with a short-lived signature from the environment key. Registration
touches Cloudflare only when the local host or port changed, and once per
existing allocation on the first registration after the upgrade because the
stored origin is empty. First registrations are jittered so an auto-update wave
does not hit the relay at once. The host stores a confirmed-origin marker with
the connector config, and a later boot starts the connector before registration
only when that marker matches the current config and port. If registration
cannot reach the relay for ten minutes, the host starts its stored config anyway
and keeps registering in the background until it can reconcile the origin.
If the connector exits, or `cloudflared` reports repeated tunnel
rejections, the host asks the relay for a replacement, at most once every two
minutes. The relay
provisions under the same allocation, so the hostname and DNS record survive
and clients keep their bindings. Every mutation on an allocation bumps its
`generation`, and deletion locks the row at the generation it claimed, so a
host that reconnects mid-sweep wins.

## OAuth traps

Interactive clients and the headless CLI use the same Clerk application but
different credentials. The relay accepts both session-template JWTs and CLI
OAuth tokens; requiring a JWT template for the CLI would reject valid logins.
The CLI is a public OAuth client using PKCE and stores no client secret.

Loopback CLI authorization starts on the hosted `/connect` page so sign-in
completes before entering Clerk's authorize endpoint. Sending a signed-out
browser straight to that endpoint loses the authorize parameters during the
sign-in redirect. The [shared flow](../../packages/shared/src/connectAuth.ts)
preserves PKCE and state for the loopback callback.

SSH and headless sessions use Clerk's OAuth device authorization grant because
the browser cannot ordinarily reach a listener on the remote machine. The CLI
polls Clerk's token endpoint directly while the user approves a short code on
Clerk's hosted device page; the hosted app plays no part and there is no
redirect URI or PKCE. The grant must be enabled on the CLI OAuth application
or the device endpoint returns an error before any prompt is shown.

## Boot-time origin sync

A managed tunnel forwards to the loopback origin (`http://127.0.0.1:<port>`) the relay recorded when
the link was made, but the local port is not stable: the desktop app scans upward for a free port on
every launch. The CLI startup reconcile re-links with the current origin, but it only runs for links
made by `lecturn connect link`. Links installed from the desktop, web, or mobile UI have no CLI token
and no boot-time re-provision, so after activation the server instead calls the relay's
environment-authenticated `PUT /v1/environments/:environmentId/managed-endpoint-origin` with the port
it actually bound, using the stored environment credential and the persisted relay URL. Without this,
a port change left `cloudflared` dialing a dead port and every relayed request failed with
`endpoint_request_failed` until the user unlinked and relinked. The sync retries transient failures
on the same bounded schedule as the reconcile, never blocks startup, and treats a 404 from an older
relay as "not supported" rather than an error.

The background service has an independent lifecycle. Connect setup may offer to install it, but
logout leaves it running; manage it with `lecturn service status`, `install`, `update`, and `uninstall`.

## Device relay reservation

Updated hosts reserve loopback TCP port `47391` while publishing, including activity-only links. This kernel-owned lease is shared across OS users, release channels, and Lecturn homes on the same host. A competing installation remains usable locally and reports the owning environment in **Settings → Relay**. Unlink or stop the owner, then use **Retry relay** in the blocked installation. Health reads do not acquire the reservation.

The lease releases on orderly shutdown or process exit without PID-file cleanup. Tests use ephemeral ports and owned child processes. Older builds do not participate, and isolated VM/container network namespaces have their own reservations. An abruptly killed host can leave an orphan connector process, but its backend is gone; the reservation does not terminate unrelated processes.

Account ownership changes are serialized across validation, connector changes, and credential persistence. Sidebar ownership combines relay catalog account tags with the primary host's verified publisher, revalidated after reconnect and foregrounding. Direct/SSH connections are not assigned to the active account merely because that account is selected.

## Multiple Signed-in Accounts

Web and desktop can serve several Connect accounts at once through Clerk multi-session. An account is
a Clerk user ID. Native mobile retains multiple accounts too, with account-scoped push registration
and Live Activities when the relay advertises the required capability.

- **Clerk dashboard.** Multi-session is a per-instance setting (**Sessions → Multi-session handling**).
  It is on for the production instance. A fork on a plan without it keeps working with one account:
  the loaded environment reports `authConfig.singleSessionMode`, and **Add account** is offered only
  when that reads `false`. clerk-js exposes the value on an internal field only
  (`__internal_environment`), so `readClerkSingleSessionMode` checks every step and treats anything
  unexpected as single-session.
- **Always enabled.** Multi-account support ships in web, desktop, and native mobile. There is no
  build flag. Clerk multi-session support, account limits, environment ownership, and mobile relay
  capability checks still control whether another account can be added.
- **Older browser tabs.** Hosted web shares one Clerk client across tabs. Current clients keep
  writing `lecturn:multi-account-enabled` every 20 minutes so older single-account clients ask for
  a reload rather than signing out an account the updated app added. The compatibility marker
  becomes stale after two hours without a writer.
- **Known-account list.** `apps/web/src/cloud/knownAccounts.ts` persists the accounts this client
  holds data for under `lecturn:accounts:v1`. Clerk's session list is not the source of truth: a
  session can disappear through expiry, cookie loss, or a 401 refetch without any sign-out. An
  account leaves the list, and its relay environments, drafts, and token cache are swept, only on a
  sign-out started in Lecturn. That cleanup also sweeps the view stores keyed
  by the removed environments (`environmentOwnedState.ts`). Removing an environment by hand, or a
  platform environment going away, clears drafts only, so adding it back restores its layout. A
  known account without a signed-in session **needs sign-in**: its environments stay in the catalog,
  disconnected. Signing one out has no Clerk session to end, so it is recorded as a sign-out mark
  under `no-session:<accountId>`, after any unpublish succeeded, and survives a reload. Storage is per origin, so a locally
  served web app keeps one list per port. `connectAccounts.ts` keeps each known account's email and
  image next to the list (`lecturn:account-profiles:v1`) so an account that needs sign-in still has a
  name.
- **Per-account token reads.** `readToken(accountId)` in `apps/web/src/cloud/accountTokens.ts` finds
  the account's session in `clerk.client.signedInSessions` at call time and reads the
  `lecturn-relay` template token from it. Template tokens only, since a bare `getToken()` on a
  non-active session would touch the active session's cookie. All reads share one permit, because on
  Electron each response rotates the client JWT. The token's `sub` claim must equal the requested
  account; a mismatch resolves `null` and is logged once.
- **clerk-js pin.** Reading tokens from a non-active session is undocumented behavior, so hosted web
  loads exact builds (`PINNED_CLERK_VERSIONS` in `BrowserManagedAuthShell.tsx`) and warns when another
  version loaded. `accountTokens.test.ts` runs against the pinned build and the one `@clerk/electron`
  bundles. Bump the pin together with that test.
- **Ownership.** Relay catalog targets carry an optional `accountId`. `relayAccountByEnvironmentId`
  builds the environment-to-account lookup from those tags; thread and project view models carry only
  `environmentId`. Direct, Tailscale, and SSH environments have no owner.
- **Add-account gate.** `decideAddAccountGate`
  (`packages/client-runtime/src/relay/connectAccounts.ts`) allows another account when
  Clerk reports multi-session, fewer than five accounts are known, and no relay entry is untagged.
  Entries in the registry's in-memory `unlistedRelayEnvironmentIds` are ignored, since no signed-in
  account lists them and a new account cannot be handed them.
- **Account UI.** `ConnectAccountMenu.tsx` replaces the `UserButton` popover. **Manage account** calls
  `clerk.openUserProfile` with the three custom pages from `connectProfilePages.tsx`, mounted through
  portals the way `UserButton.UserProfilePage` does. Clerk's profile belongs to the active account, so
  it opens under `withActiveAccount` for any signed-in account, and its Billing tab
  (`BillingAccount activeAccountOnly`) has no picker.
  `AccountMark.tsx` renders the owner's short mark on sidebar thread rows and Connect environment rows
  once two accounts are known.
- **Reads never depend on the active session.** Relay-backed data (billing, teams, environment lists,
  link and unlink) is fetched with the chosen account's own token: `readToken(accountId)`, or the
  clients in `apps/web/src/cloud/accountRelayClients.ts` that wrap it. `setActive`, to choose an
  account, is called in one place only: `withActiveAccount(accountId, fn)` in
  `apps/web/src/cloud/withActiveAccount.ts`. It holds one mutex, switches only when the account is not
  already active, checks `clerk.user.id` before and after `fn`, throws `ActiveAccountError` on a
  mismatch, and does not restore the previous active session. A timed-out switch retains its mutex
  until the in-flight Clerk request settles; it cannot run a late authorization callback. Expired
  queued turns do not start. Use it only where Clerk itself has to
  act as the account: the CLI authorize redirect, opening Clerk's profile, and **Make active** in the
  account menu. Do not add a second `setActive` caller. (The sign-out plan also calls `setActive` to pick the session that survives a sign-out.)
- **Account pickers.** A surface that acts for one account calls `useConnectAccountPicker(surface)`
  (`apps/web/src/components/clerk/ConnectAccountPicker.tsx`). It returns the account to act as and a
  `picker` node, which is `null` when fewer than two accounts are known; the
  account is then Clerk's active one. `resolvePickedAccount`
  (`apps/web/src/cloud/accountPicker.ts`) picks the default among signed-in accounts: the choice made
  in this picker, the surface's own account (the onboarding wizard's new account), the open thread's
  owner, the account last used on that surface (`lecturn:account-picker:v1`), then the active
  account. The thread route records its environment in `openThreadEnvironmentIdAtom`, because
  Settings replaces that route. Accounts that need sign-in are listed disabled with the reason in a
  tooltip. Surfaces: publish (`ConnectionsSettings.tsx` and `ConnectOnboardingDialog.tsx`, surface
  `publish`), Billing and Teams (`account-settings`, shared so both tabs show one account, and keyed
  by account id so a switch remounts), and `/connect` (`cli-authorize`).
- **Publishing.** `useCloudLinkController({ accountId, onSelectAccount })` links, unlinks, selects the
  team, and checks the subscription as `accountId`. The computer still links to one account.
  `describePublishAccount` (`cloudLinkAccount.ts`) decides what another account may do about an
  existing link: a known publisher is named by email and can be chosen in the picker or unlinked
  (with its token when it is signed in, without one when it needs sign-in); an unknown publisher's link
  stays blocked with guidance to sign in to its owner.
- **CLI authorize.** Clerk's OAuth authorize endpoint acts as the active account.
  `decideConnectCliAuthorizeStep` (`connectCliAuth.ts`) keeps the immediate redirect for one account
  and shows the chooser for two or more, then redirects inside `withActiveAccount`. The chosen account
  ID is kept in `sessionStorage` with the request's `state`. The callback names Clerk's actual user
  and flags a mismatch with the choice.
- **Command palette.** `useConnectAccountPaletteItems` adds "Add Lecturn Connect account", "Go to
  account", "Sign out of", and "Sign out of all accounts". The palette renders without Clerk, so the
  actions run in `ConnectAccountCommandsHost`, mounted by `ManagedRelayAuthProvider`, and reach the
  palette through `connectAccountCommandsAtom`. The atom lives in `connectAccountCommands.ts`, apart
  from the host, so the palette does not import Clerk.
- **Signed-out account behind an open thread.** Before a leaving account's environments are removed,
  `recordSignedOutAccount` (`accountGone.ts`) notes which ones it owned. The thread route resolves
  `account-gone` from that record while the environment is absent from the catalog, and renders
  `AccountGoneNotice` instead of redirecting to `/`. The record lasts for the page.

## Account presentation and native clients

`@lecturn/shared/accountTint` supplies six preset hues and contrast-preserving role overlays without a native color-library dependency. User metadata is namespaced under `unsafeMetadata.lecturn` as `label` and `preset`. Unknown presets fall back; labels are bounded display text. Web metadata writes run under `withActiveAccount` and validate the returned user ID. Cached profile presentation remains in `lecturn:account-profiles:v1`; it is never an authority for tokens.

Web subscribes to applied theme/preview updates and scopes semantic token overrides to the conversation. Mobile applies the same roles through `ScopedVariables` and a JS theme context before accessibility substitutions. Native navigation and global chrome stay untinted. The desktop activity IPC carries bounded cosmetic account labels and hex color marks without credentials.
