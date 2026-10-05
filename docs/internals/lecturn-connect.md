# Lecturn Connect

Lecturn Connect uses Clerk for cloud identity. The relay manages environment links,
credentials for reaching environments, and managed tunnel allocations. After
bootstrap, clients send application traffic through the environment's tunnel
hostname; the relay Worker does not proxy their HTTP or WebSocket sessions.

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
[environment cloud handlers](../../apps/server/src/cloud/http.ts) and
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
belong to [shutdown handling](../../apps/server/src/cloud/http.ts).

Release and unlink claim the allocation generation before deleting external
resources. A delayed cleanup must not delete a tunnel reused by a concurrent
restart or relink. Unlink commits authorization revocation before external
teardown, because a database failure must leave the active link usable. Failed
teardown retains enough state to retry. See the
[managed endpoint lifecycle](../../infra/relay/src/environments/ManagedEndpointProvider.ts).

## OAuth traps

Interactive clients and the headless CLI use the same Clerk application but
different credentials. The relay accepts both session-template JWTs and CLI
OAuth tokens; requiring a JWT template for the CLI would reject valid logins.
The CLI is a public OAuth client using PKCE and stores no client secret.

CLI authorization starts on the hosted `/connect` page so sign-in completes
before entering Clerk's authorize endpoint. Sending a signed-out browser
straight to that endpoint loses the authorize parameters during the sign-in
redirect. The [shared flow](../../packages/shared/src/connectAuth.ts) preserves
PKCE and state for both loopback and pasted-code callbacks. SSH and headless
sessions use the pasted-code flow because the browser cannot ordinarily reach a
listener on the remote machine.

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
