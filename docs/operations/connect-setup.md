# Lecturn Connect setup

Deployment and client configuration for Lecturn Connect. The [architecture note](../internals/lecturn-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## Public application configuration

Lecturn Connect is disabled in a fresh clone. To build against the production deployment, copy the
repository-root example:

```sh
cp .env.example .env
```

For another deployment, set these values in the repository-root `.env` or `.env.local`:

```dotenv
LECTURN_CLERK_PUBLISHABLE_KEY=<publishable key>
LECTURN_CLERK_JWT_TEMPLATE=<JWT template name>
LECTURN_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
LECTURN_RELAY_URL=https://relay.example.com
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases. These values are public identifiers.
`CLERK_SECRET_KEY` belongs only in the relay's secrets, never in client configuration.

Client and bundled-server builds embed the public values, so set them before building.
EAS preview and production environments need the publishable key, JWT template name, and relay URL.
Bundled servers also accept runtime overrides for operator-managed deployments.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
Deploy `prod` before personal stages because it owns the retained database that their branches
depend on. The deploy wrapper writes the resulting relay URL back to the root `.env`.

## CLI OAuth application

In Clerk's OAuth applications settings:

1. Create a public OAuth application for the Lecturn CLI, using authorization-code exchange with PKCE.
2. Allow both redirect URIs: `http://127.0.0.1:34338/callback` and
   `https://lecturn.cloudgatherer.net/connect/callback`. A custom `LECTURN_HOSTED_APP_URL` needs its own
   `/connect/callback` URL. Headless and SSH authorization depend on the hosted redirect.
3. Enable the `openid`, `profile`, and `email` scopes.
4. Set `LECTURN_CLERK_CLI_OAUTH_CLIENT_ID` to the generated public client ID in local and release
   build environments.

## JWT template

Create a Clerk JWT template named `lecturn-relay` with claims:

```json
{ "aud": "lecturn-relay" }
```

Set `LECTURN_CLERK_JWT_TEMPLATE=lecturn-relay` for clients and
`CLERK_JWT_AUDIENCE=lecturn-relay` for the relay. The production relay deployment environment
also defines `CLERK_JWT_TEMPLATE`. The audience stays the same across relay stages; the relay
URL selects the deployment.

## Desktop OAuth redirects

Enable Clerk's Native API and add the desktop redirects to its SSO redirect allowlist:

```text
lecturn-dev://app/
lecturn://app/
```

Add the corresponding origin to the Clerk instance's Backend API `allowed_origins` array.
Development uses `lecturn-dev://app`; production uses `lecturn://app`. Update the array with
`PATCH https://api.clerk.com/v1/instance` using the Clerk secret key, preserving existing entries.
The Clerk Electron integration handles token
persistence and system-browser callback delivery.

## Desktop passkeys

For a production macOS app with bundle ID `com.cloudgatherer.lecturn`:

1. Create an explicit macOS App ID in the Apple Developer portal with **Associated Domains**.
2. Create a provisioning profile for that App ID and the distribution signing certificate.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID.
   This setting also configures Electron/macOS passkeys.
4. Check `https://<frontend-api>/.well-known/apple-app-site-association`. Its
   `webcredentials.apps` must include `<TEAM_ID>.com.cloudgatherer.lecturn`.
5. Configure signing as described in the [release runbook](./release.md#2-apple-signing--notarization-setup-macos).

Local signed builds additionally use:

```dotenv
LECTURN_APPLE_TEAM_ID=ABC1234567
LECTURN_MACOS_PROVISIONING_PROFILE=/absolute/path/to/lecturn.provisionprofile
# Override only when the RP domain differs from the Clerk Frontend API hostname.
LECTURN_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

Without the override, the build derives the RP domain from the Clerk publishable key.
After changing Associated Domains, bump the build version before rebuilding. macOS can otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

The ordinary `dev:desktop` launcher is unsigned and cannot exercise macOS passkeys. For renderer
HMR, install a signed build, start `vp run dev:web`, and launch the installed executable with the
actual web and server ports. For example, with the default ports:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
LECTURN_PORT=13773 \
  "/Applications/Lecturn (Alpha).app/Contents/MacOS/Lecturn (Alpha)"
```

Rebuild the signed app after native dependency, main-process, preload, entitlement, provisioning,
or signing changes. Renderer edits can reuse it. Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/Lecturn (Alpha).app"
codesign -d --entitlements :- "/Applications/Lecturn (Alpha).app"
```

## Restricting sign-ups

Use Clerk's allowlist for permitted email addresses or domains, or Restricted mode for invitation-only
sign-up. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active sessions and future sign-ins must be disabled.
