# Lecturn Connect Relay

> [!NOTE]
> Sign in to Lecturn Connect from the app under Settings > Connections.

The relay is the hosted control plane for Lecturn Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal Lecturn traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [Lecturn Connect architecture overview](../../docs/internals/lecturn-connect-auth-flow.html) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking Lecturn environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/internals/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts) defines persisted relay state. Keep
  schema and migration changes together.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Before considering a change complete, run the repository-wide checks from the root:

```sh
vp check
vp run typecheck
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Deployment

Production retains the `T3CodeRelay` Alchemy stack, `t3coderelay` PlanetScale database,
and original `t3-code-*` Axiom resource names. These are persisted infrastructure
identifiers, not product branding. `src/physicalIdentity.ts` centralizes them; all
stages share the stack identity so references to production remain valid. Renaming
these resources requires a separate state migration and must not accompany a
normal application deployment. Inspect the production dry run: existing keys,
database, queues, and Worker must be retained rather than recreated.

The relay deploys through Alchemy:

```sh
vp run --filter lecturn-relay deploy
```

The stack provisions the Cloudflare Worker and queues, managed endpoint resources, database
connectivity, and relay tracing resources. Copy [`infra/relay/.env.example`](./.env.example) to
`infra/relay/.env` and fill in the deployment-specific values before deploying. Alchemy loads that
file from the relay directory. Runtime secrets include Clerk and APNs credentials. Production adopts
the configured API and tunnel DNS zones as retained Cloudflare resources. Personal stages reference
the production-owned zones.

The `prod` Alchemy stage owns the retained PlanetScale database and is the shared hosted relay for
stable and nightly clients. Every other stage references that database and provisions an isolated
PlanetScale branch and runtime role for local development, so deploy `prod` before creating
developer stages:

```sh
vp run --filter lecturn-relay deploy -- --stage prod
vp run --filter lecturn-relay deploy -- --env-file .env.local
```

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`relay-dev-julius.<RELAY_API_ZONE_NAME>`. Managed environment endpoints are provisioned below
`RELAY_TUNNEL_ZONE_NAME`, which may be a different Cloudflare zone. Production tunnel hostnames use
`prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>`; personal stages use
`<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>`. `RELAY_DOMAIN` remains available as an explicit API
domain override.

After a successful deploy, the wrapper updates the repository-root `.env` file with the derived relay
URL. That makes subsequent source builds point at the relay that was just deployed without copying
the URL manually.

### Deployment CI

The relay is versioned separately from client releases. `.github/workflows/deploy-relay.yml` deploys
the shared Alchemy `prod` stage on every push to `main`. Stable and nightly release builds both
resolve their static public config from the same
`production` GitHub environment. Pull requests do not deploy relay stages. Developers can
deploy personal non-production stages locally with any stage name other than `prod`.

The repository must define these Actions variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `PLANETSCALE_ORGANIZATION`
- `AXIOM_ORG_ID`

The repository must define these Actions secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `PLANETSCALE_API_TOKEN_ID`
- `PLANETSCALE_API_TOKEN`
- `AXIOM_TOKEN`

The `production` GitHub environment must define these Actions variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `RELAY_DOMAIN` if overriding the derived production relay domain
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

The `production` GitHub environment must define these Actions secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The release workflow reads the production relay's
derived public URL and Clerk publishable key from the same environment for downstream desktop, CLI,
and hosted web builds.

See:

- [Lecturn Connect Clerk Setup](../../docs/internals/lecturn-connect.md) for Clerk keys, JWT templates, and sign-up restrictions
  setup.
- [Relay Observability](../../docs/operations/relay-observability.md) for deployment tracing and diagnostics.
- [Lecturn Connect Architecture Overview](../../docs/internals/lecturn-connect-auth-flow.html) for the full link,
  connect, endpoint, and notification flows.

## Multi-account push rollout

Ship the relay migrations and worker before enabling iOS multi-account registration. The protected
resource metadata endpoint advertises `capabilities.multiAccountPush`. Older requests omit
`deviceAccountIds` and still claim tokens exclusively. New requests retain at most five existing
same-device account registrations; a list never creates a registration for another account.
Token kinds have separate owner rows, locked by an upsert in the registration transaction.
When a device token displaces an account, its separate Live Activity update token is retired too;
the membership list alone cannot retire unrelated devices or accounts.

Run the focused registration, APNs, and environment-relink tests and `vp run --filter lecturn-relay
typecheck` from the root. The optional PostgreSQL integration test uses
`RELAY_PUSH_TEST_DATABASE_URL` and removes its uniquely named fixture rows. It verifies real row
locks, but is not a substitute for the deployed Hyperdrive probe.

1. Deploy an isolated development stage with development Clerk keys and a separate database:
   `vp run --filter lecturn-relay deploy -- --stage <development-stage>`.
2. Confirm that stage's Hyperdrive binding points to its development database and that
   `/.well-known/oauth-protected-resource` advertises `multiAccountPush: true`.
3. Prepare a local, permission-restricted JSON file (do not commit it) containing `stage`,
   `relayUrl`, and exactly two `accounts`, each with `userId` and a fresh development Clerk
   `clerkToken`. Use dedicated test users. Set `RELAY_PUSH_TEST_DATABASE_URL` to that same
   development database's connection string, then run
   `node infra/relay/scripts/verify-multi-account-push.ts /absolute/path/to/probe-input.json`.
   It uses authenticated DPoP HTTP requests through the deployed worker/Hyperdrive and reads
   the resulting rows to verify concurrent first claims, device displacement, account retention,
   and legacy exclusive registration for notifications and Live Activities. It uses fake token
   values and disabled delivery preferences, removes only its generated fixtures, prints no
   credentials, and bounds each HTTP call. A skipped database test is not a passed probe.
4. Check signed old APNs jobs still decode, then check on a real iPhone that both accounts receive
   notifications and maintain separate cards, including foreground re-registration, sign-out,
   relaunch, and taps. Build the native widget extension containing its optional account attribute.
5. After those gates pass, deploy production with
   `vp run --filter lecturn-relay deploy -- --stage prod`, verify metadata again, and only then
   release the iOS build. Do not roll back to a worker with global exclusive token claims while
   multi-account clients are enabled.

Host-signed relinks serialize on `relay_environment_link_owners`. The link transaction captures the
old endpoint generation and team organization, revokes displaced links and credentials, and writes
cleanup intents in `relay_environment_link_cleanup`. Cleanup retries after commit and on the existing
maintenance cron. Relinking back first drains prior intents before preparing new team funding or
endpoints. Cleanup releases only the captured endpoint generation and matching prior team funding.
The lock has a five-second wait limit and the transaction has a 25-second overall limit. Endpoint
provision/cleanup runs while this row lock is held to serialize funding and relink-back; this bounded
transaction is a deliberate tradeoff until there is a durable link-operation coordinator. Failed
requests use a fresh host proof on retry. External cleanup is idempotent and pending rows survive
failure; inspect logs for `Relink cleanup remains pending`.

The migration seeds a one-off cleanup of pre-existing duplicate active links. The worker chooses the
newest link by `updated_at`, then `created_at`, then user ID under the same lock, and preserves the
winner's host credential. After deployment, inspect for duplicates created by old workers during
rollout and enqueue any remaining ones using:

```sql
INSERT INTO relay_environment_link_owners(environment_id, legacy_cleanup_pending)
SELECT environment_id, true FROM relay_environment_links WHERE revoked_at IS NULL
GROUP BY environment_id HAVING count(*) > 1
ON CONFLICT(environment_id) DO UPDATE SET legacy_cleanup_pending=true;

SELECT environment_id, count(*) FROM relay_environment_links
WHERE revoked_at IS NULL GROUP BY environment_id HAVING count(*) > 1;
SELECT user_id, environment_id FROM relay_environment_link_cleanup;
SELECT environment_id FROM relay_environment_link_owners WHERE legacy_cleanup_pending=true;
```

Wait for maintenance to drain both queues and verify old managed allocations and team funding are
released. Do not manually delete pending rows to hide a failed cleanup.
