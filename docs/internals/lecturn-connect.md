# Lecturn Connect

> For maintainers. Using Lecturn? See [docs/user](../user/).

Lecturn Connect uses one Clerk application for web, desktop, and mobile authentication. The relay verifies
two kinds of bearer credential: template JWTs generated from the `lecturn-relay` template with the shared
`lecturn-relay` audience, and Clerk OAuth tokens issued to the CLI. `verifyRelayClientBearerToken` in
`infra/relay/src/http/Api.ts` tries the template/session path first and falls back to OAuth
verification (`acceptsToken: "oauth_token"`), so the CLI's OAuth credential works without a JWT
template.

For the wider system diagram, see
[lecturn-connect-auth-flow.html](./lecturn-connect-auth-flow.html).

## Application Keys

Lecturn Connect is disabled in a fresh clone. To enable it for source builds against the production
deployment, copy the repository-root example file:

```sh
cp .env.example .env
```

`.env.example` carries the production public identifiers (the same values baked into official
release builds). To target a different Clerk application or relay, set the values yourself in a
repository-root `.env` or `.env.local` file:

```dotenv
LECTURN_CLERK_PUBLISHABLE_KEY=<publishable key>
LECTURN_CLERK_JWT_TEMPLATE=<JWT template name>
LECTURN_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
LECTURN_RELAY_URL=https://relay.example.com
```

The shared client loader projects these canonical values into framework-specific `VITE_*` and
`EXPO_PUBLIC_*` aliases. Existing aliases remain accepted as overrides for compatibility, but new
client configuration should use the canonical names.

Configuration precedence is:

1. Process or CI environment variables.
2. Repository-root `.env.local`.
3. Repository-root `.env`.

The Clerk publishable key, JWT template name, CLI OAuth client ID, and relay URL are public
identifiers, not secrets.
Web, desktop, mobile, and bundled server builds statically inject the values they consume during
their build step. A built artifact does not need an environment file at runtime. CI release builds
should set `LECTURN_CLERK_PUBLISHABLE_KEY`, `LECTURN_CLERK_JWT_TEMPLATE`,
`LECTURN_CLERK_CLI_OAUTH_CLIENT_ID`, and `LECTURN_RELAY_URL` before building. EAS preview and
production builds only need the Clerk publishable key, JWT template name, and relay URL in their EAS
environment.

When any client-facing public value is absent, cloud UI is omitted. The `lecturn connect` command group is
always registered: when the CLI public values are absent, `makeCli` in `apps/server/src/bin.ts`
registers a hidden fallback `connect` command that reports the missing configuration instead of
silently vanishing from help. The bundled server still accepts runtime overrides for self-hosted or
operator-managed deployments.

For a hosted relay deployment, copy `infra/relay/.env.example` to `infra/relay/.env`. The relay
deployment reads `RELAY_DOMAIN`, `RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`,
`CLERK_PUBLISHABLE_KEY`, and `CLERK_JWT_AUDIENCE` through Effect `Config`. There are no checked-in
deployment defaults.
`vp run --filter lecturn-relay deploy` invokes Alchemy from the relay directory, so Alchemy loads
`infra/relay/.env`. After a successful deployment, the wrapper updates the repository-root `.env`
with the deployed HTTPS relay URL. The relay still requires
`CLERK_SECRET_KEY` as an Alchemy secret. Never put `CLERK_SECRET_KEY` in a client application
environment or commit it to the repository.

The `prod` Alchemy stage owns the retained PlanetScale database. Non-production stages reference
that database and provision isolated PlanetScale branches, so deploy `prod` before creating a
personal developer stage.

## Headless CLI OAuth Application

The `lecturn connect` commands authorize a headless environment with a separate Clerk OAuth application.
This uses an OAuth public client with PKCE, so the CLI stores no client secret.

In **Clerk Dashboard > OAuth applications**:

1. Create an OAuth application for the Lecturn CLI.
2. Enable the **Public** option so authorization-code exchange uses PKCE.
3. Add **both** allowed redirect URIs:
   - `http://127.0.0.1:34338/callback` for the loopback listener;
   - `https://lecturn.cloudgatherer.net/connect/callback` for the hosted out-of-band flow. This is
     `connectCallbackUrl(DEFAULT_HOSTED_APP_URL)` from `packages/shared/src/connectAuth.ts`, so a
     custom `LECTURN_HOSTED_APP_URL` means `$LECTURN_HOSTED_APP_URL/connect/callback` instead.
     Omitting it breaks headless and SSH authorization.
4. Enable the `openid`, `profile`, and `email` scopes.
5. Set `LECTURN_CLERK_CLI_OAUTH_CLIENT_ID` in the repository-root `.env` file and release build
   environment to the generated public client ID.

Both CLI flows start at the hosted `/connect` page (`buildConnectAuthorizeRequestUrl` in
`packages/shared/src/connectAuth.ts`), which waits for a Clerk session and then forwards the request
to Clerk's `/oauth/authorize`. The CLI never opens `/oauth/authorize` directly: a signed-out browser
sent there goes through Clerk's sign-in redirect, which drops the authorize query parameters and
fails the flow with `unsupported_response_type` or an empty `state` (#5051). The loopback flow marks
the request with a `port` fragment parameter so the hosted page asks Clerk to redirect the
authorization code straight to `http://127.0.0.1:<port>/callback`; the out-of-band flow omits it and
uses the hosted `/connect/callback` page instead. The CLI derives Clerk's frontend API URL from the
publishable key and calls only the `/oauth/token` endpoint directly. The relay is not involved in
the OAuth handshake; it only validates the issued Clerk bearer token when the CLI manages an
environment link.

The connect command group is:

```sh
lecturn connect            # default: onboarding
lecturn connect login
lecturn connect link       # --publish-only
lecturn connect status     # --json
lecturn connect publish    # --disable
lecturn connect unlink
lecturn connect logout
```

`lecturn serve` is a separate top-level command, not a connect subcommand.

`lecturn connect login` opens the Clerk authorization flow and stores the CLI credential without enabling
cloud exposure. `lecturn connect link` installs the pinned managed `cloudflared` binary when needed,
authorizes when needed, and records durable intent to expose the environment. It works without a
running Lecturn server. The next `lecturn serve` or `lecturn start` reconciles the relay link and launches the
managed tunnel. `lecturn connect unlink` records disabled intent immediately, stops a reachable running
connector, and attempts to revoke the relay-side environment record. It retains the stored CLI
authorization so `lecturn connect link` can re-enable exposure without another browser flow. `lecturn connect
logout` performs the same cleanup and removes the stored CLI authorization.

### Boot-time origin sync

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

### Headless and SSH authorization

The loopback OAuth callback listener binds to port `34338`. That path only works when a browser on
the same machine can reach it, so `authorizeCli` in `apps/server/src/cli/connect.ts` automatically
selects the out-of-band flow when `--headless` is passed or when it detects SSH through
`SSH_CONNECTION` or `SSH_TTY`. The out-of-band flow prints the hosted `/connect` authorization URL
and accepts a pasted authorization code, so no port is involved.

Port forwarding is therefore optional, not required. Forward the port only if you specifically want
the loopback flow over SSH:

```sh
ssh -L 34338:127.0.0.1:34338 <host>
```

## JWT Template

In **Clerk Dashboard > JWT templates**, create a template with:

| Setting | Value                        |
| ------- | ---------------------------- |
| Name    | `lecturn-relay`              |
| Claims  | `{ "aud": "lecturn-relay" }` |

Set `LECTURN_CLERK_JWT_TEMPLATE=lecturn-relay` in the repository-root `.env`, and set
`CLERK_JWT_AUDIENCE=lecturn-relay` in `infra/relay/.env`. Define `CLERK_JWT_TEMPLATE` and
`CLERK_JWT_AUDIENCE` in the production relay deployment environment as well. The stable `aud` value
is shared by production and non-production relay stages. The client-facing `LECTURN_RELAY_URL` still
selects the concrete relay deployment, but changing that URL does not require a JWT template change.

## Desktop OAuth Redirect Allowlist

The desktop app opens OAuth in the system browser and returns to the app with a custom URL scheme.
In **Clerk Dashboard > Native applications**, enable the Native API and add these entries under the
mobile SSO redirect allowlist:

```text
lecturn-dev://app/
lecturn://app/
```

Local desktop development uses `lecturn-dev://app`, while packaged builds use `lecturn://app`. Add the
matching origin to each Clerk instance's Backend API `allowed_origins` array as well. The development
Clerk instance should only need `lecturn-dev://app`; the production Clerk instance should only need
`lecturn://app`. `@clerk/electron` owns the native request adapter, encrypted Clerk token persistence,
external-browser OAuth transport, and callback delivery for initial sign-in and linked-account flows.

There is currently no Dashboard UI for `allowed_origins`. Preserve any existing entries and update
the instance through the Backend API:

```sh
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -d '{"allowed_origins":["lecturn://app"]}'
```

Never put `CLERK_SECRET_KEY` in the desktop app, a client-facing environment file, or a build
artifact.

## Desktop Passkeys

The production macOS bundle ID is `com.cloudgatherer.lecturn`. To enable native passkeys:

1. Create an explicit macOS App ID for `com.cloudgatherer.lecturn` in the Apple Developer portal and enable
   **Associated Domains**.
2. Create a compatible macOS provisioning profile for that App ID and the certificate used to sign
   the distributed app.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID. This is
   also the configuration point for Electron/macOS passkeys.
4. Confirm Clerk serves `https://<frontend-api>/.well-known/apple-app-site-association` and that
   `webcredentials.apps` contains `<TEAM_ID>.com.cloudgatherer.lecturn`.
5. Set the local or CI signing configuration described below.

For a local signed build, add these values to `.env.local` or export them before invoking the
desktop artifact command:

```dotenv
LECTURN_APPLE_TEAM_ID=ABC1234567
LECTURN_MACOS_PROVISIONING_PROFILE=/absolute/path/to/lecturn.provisionprofile
# Optional: comma-separated override when Clerk's RP ID differs from the Frontend API hostname.
LECTURN_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

When `LECTURN_CLERK_PASSKEY_RP_DOMAINS` is absent, the build derives the RP domain from
`LECTURN_CLERK_PUBLISHABLE_KEY`. Signed macOS builds fail early if the Team ID, provisioning profile,
or RP-domain configuration is missing. The generated main-app entitlements include every configured
`webcredentials:<domain>` entry; helper apps keep Electron's minimal default entitlements.

The normal `dev:desktop` launcher is unsigned and cannot complete macOS passkey ceremonies. For
renderer HMR, build and install a signed app first, run the renderer dev server, then launch the
installed app executable with `VITE_DEV_SERVER_URL` and `LECTURN_PORT` set. Rebuild the signed app
after native dependency, main-process, preload, entitlement, provisioning, or signing changes;
renderer-only changes can reuse the installed app.

For the default development ports, run `pnpm dev:web` in one terminal and launch the installed
binary from another:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
LECTURN_PORT=13773 \
  "/Applications/Lecturn (Alpha).app/Contents/MacOS/Lecturn (Alpha)"
```

After changing Associated Domains, bump the build version before rebuilding; macOS may otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/Lecturn (Alpha).app"
codesign -d --entitlements :- "/Applications/Lecturn (Alpha).app"
```

The current mobile UI uses Clerk's native authentication view. If a future mobile browser OAuth
flow uses a custom redirect URI, add that exact URI to the same allowlist.

## Sign-in Surfaces

Signed-in users manage Lecturn Connect under **Connections**. The settings sidebar also has dedicated
controls, rendered by `SettingsSidebarNav.tsx`: `LecturnConnectSidebarSignIn` in the footer shows a
**Sign in to Lecturn Connect** button while signed out, and `LecturnConnectSidebarAvatar` shows a Clerk
`UserButton` account control while signed in, or the Connect account menu in a multi-account build
(see [Multiple Signed-in Accounts](#multiple-signed-in-accounts)). Both are gated on cloud public configuration.
Desktop renders the same web bundle, so it has them too. The waitlist enrollment flow from the
private beta was removed when Connect went GA; sign-up is open unless a Clerk restriction below is
enabled.

## Multiple Signed-in Accounts

Web and desktop can serve several Connect accounts at once through Clerk multi-session. An account is
a Clerk user ID. Mobile stays on one account.

- **Clerk dashboard.** Multi-session is a per-instance setting (**Sessions → Multi-session handling**).
  It is on for the production instance. A fork on a plan without it keeps working with one account:
  the loaded environment reports `authConfig.singleSessionMode`, and **Add account** is offered only
  when that reads `false`. clerk-js exposes the value on an internal field only
  (`__internal_environment`), so `readClerkSingleSessionMode` checks every step and treats anything
  unexpected as single-session.
- **Build constant.** `connectMultiAccount` in `apps/web/src/cloud/publicConfig.ts` switches the
  feature. There is no remote flag, so changing it means a new build. While it is `false` the footer
  renders Clerk's `UserButton` exactly as before and none of the account UI mounts.
- **Single-account guard.** While the constant is off, `decideSingleAccountGuard`
  (`packages/client-runtime/src/relay/singleAccountGuard.ts`) runs in front of all account-transition
  handling in `ManagedRelayAuthProvider`. An extra Clerk session, from another tab or Clerk's own UI,
  is signed out through the non-current path and never reaches cleanup. Hosted web shares one Clerk
  client across tabs, so a build with the constant on writes the **stand-down marker**
  (`lecturn:multi-account-enabled`, a timestamp rewritten every 20 minutes and stale after two
  hours). A guard that sees a fresh marker asks for a reload instead of signing out an account a
  newer tab added.
- **Known-account list.** `apps/web/src/cloud/knownAccounts.ts` persists the accounts this client
  holds data for under `lecturn:accounts:v1`. Clerk's session list is not the source of truth: a
  session can disappear through expiry, cookie loss, or a 401 refetch without any sign-out. An
  account leaves the list, and its relay environments, drafts, and token cache are swept, only on a
  sign-out started in Lecturn. With the constant on, that cleanup also sweeps the view stores keyed
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
  (`packages/client-runtime/src/relay/connectAccounts.ts`) allows another account when the constant is
  on, Clerk reports multi-session, fewer than five accounts are known, and no relay entry is untagged.
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
  account menu. Do not add a second `setActive` caller. (The sign-out plan and the single-account
  guard also call `setActive`, to pick the session that survives a sign-out, not to choose an account.)
- **Account pickers.** A surface that acts for one account calls `useConnectAccountPicker(surface)`
  (`apps/web/src/components/clerk/ConnectAccountPicker.tsx`). It returns the account to act as and a
  `picker` node, which is `null` while the constant is off or fewer than two accounts are known; the
  account is then Clerk's active one, as before. `resolvePickedAccount`
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
  (with its token when it is signed in, without one when it needs sign-in); a stranger's link, and
  every mismatch in a single-account build, stays blocked with the old advice.
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

## Restricting Sign-ups: Known-User Allowlist

For a closed deployment where all permitted users are known in advance, restrict sign-up to
permitted email addresses or domains:

1. In **Clerk Dashboard > Restrictions > Allowlist**, add each permitted email address or email
   domain.
2. Enable the allowlist and save.
3. Alternatively, enable **Restricted mode** when all new users must be explicitly invited or
   manually created.

Do not enable an empty allowlist: it blocks all new sign-ups.

Clerk allowlists control who can sign up. They do not revoke an existing user's active cloud
access. To remove an already-created user's access, ban that user in Clerk so their active
sessions are ended and future sign-ins are rejected.

### Account presentation and native clients

`@lecturn/shared/accountTint` supplies six preset hues and contrast-preserving role overlays without a native color-library dependency. User metadata is namespaced under `unsafeMetadata.lecturn` as `label` and `preset`. Unknown presets fall back; labels are bounded display text. Web metadata writes run under `withActiveAccount` and validate the returned user ID. Cached profile presentation remains in `lecturn:account-profiles:v1`; it is never an authority for tokens.

Web subscribes to applied theme/preview updates and scopes semantic token overrides to the conversation. Mobile applies the same roles through `ScopedVariables` and a JS theme context before accessibility substitutions. Native navigation and global chrome stay untinted. The desktop activity IPC carries bounded cosmetic account labels and hex color marks without credentials.
