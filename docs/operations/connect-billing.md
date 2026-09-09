# Connect billing operations

Lecturn uses Clerk user IDs for ownership and Stripe Billing for Connect subscriptions. The plan is $10/month or $100/year, with a card-required 14-day trial and three enabled managed environments. Managed push notifications and Live Activities are included. Pending provisioning and offline enabled environments consume capacity; disabling or unlinking releases it. Local, direct, SSH and Tailscale access does not require the subscription.

## Account and payment flow

The hosted `/account/billing` route works without a connected environment and presents account settings in a dialog. Desktop reads access using its own signed-in Clerk identity and opens billing management in the external browser, which may have a separate signed-in account. Mobile displays account access, quota and expiry without directing users to external payment. Stripe hosts card entry, invoice history and payment-method management.

### iOS companion distribution

The iOS app consumes existing account entitlements. Do not add Stripe checkout, subscription prices, upgrade calls to action or external purchase links to its native screens. There is no StoreKit purchase or restore-purchases flow in this model; signing into the same Clerk account restores access from the relay.

Explain the companion model accurately in App Review notes and provide a working review account with Connect access and a reachable test environment. Do not hide different purchase behavior from reviewers. Apple's [App Review guideline 3.1.3(f)](https://developer.apple.com/app-store/review/guidelines/#other-purchase-methods) describes free companions to paid web tools; Apple determines whether the app qualifies. Beta approval of an older build does not approve a new billing experience.

Client source changes require a desktop build and an iOS build or compatible Expo update before installed clients receive them. Backend deployment alone does not update bundled UI. Keep paid enforcement disabled until those clients have been exercised against the deployed account service.

| Endpoint                              | Purpose                                                          |
| ------------------------------------- | ---------------------------------------------------------------- |
| `GET /v1/billing/status`              | Read the authenticated account's projection                      |
| `POST /v1/billing/checkout`           | Create or recover owned monthly/yearly Checkout                  |
| `POST /v1/billing/portal`             | Open the account's Stripe portal                                 |
| `POST /v1/billing/checkout/reconcile` | Reconcile an owned Checkout return                               |
| `POST /v1/billing/webhooks/stripe`    | Verify raw Stripe events and persist routing references          |
| `POST /v1/billing/webhooks/clerk`     | Verify dedicated Clerk deletion events and tombstone the account |

Requests use Clerk bearer verification. Checkout requires a verified email on a nonlocked, nonbanned account. Browser mutations require the configured account origin. Prices, customer IDs and redirects come from server configuration. A Checkout redirect alone never grants access.

## Deployment controls

Keep sandbox credentials, database branch, Clerk instance and webhook endpoints isolated from production. Stripe API and webhook version are pinned to `2026-08-26.dahlia`. A deployed endpoint's signing secret differs from a local forwarding secret. Never put provider secrets in client builds or source control.

| Binding                                             | Meaning                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `BILLING_MODE`                                      | `disabled`, `observe` or `enforce`; disabled is the default                                                        |
| `BILLING_CHECKOUT_ENABLED`                          | Separate explicit Checkout switch                                                                                  |
| `BILLING_CHECKOUT_USERS`                            | Separate reviewed Clerk user ID cohort for purchases; live Checkout requires it; `*` explicitly opens public sales |
| `STRIPE_LIVEMODE`                                   | Select test versus live credentials                                                                                |
| `STRIPE_ACCOUNT_ID`                                 | Required pinned account for live configuration                                                                     |
| `BILLING_PRODUCTION_READY`                          | Explicit live charging/enforcement gate after release validation                                                   |
| `BILLING_ENFORCEMENT_USERS`                         | Reviewed comma-separated Clerk user IDs; required for enforcement                                                  |
| `MANAGED_GATEWAY_ENABLED`                           | Default false; requires managed access, a reviewed cohort and both gateway proofs                                  |
| `MANAGED_GATEWAY_ORIGIN_GUARD_VERIFIED`             | Default false; set only after direct-origin and spoofed-caller bypass tests pass                                   |
| `MANAGED_GATEWAY_ROUTE_VERIFIED`                    | Default false; set only after all enrolled public hosts route through the gateway                                  |
| `BILLING_SUSPENSION_ENABLED`                        | Separate external tunnel retirement gate                                                                           |
| `BILLING_SANDBOX_MANAGED_ACCESS_ENABLED`            | Isolated test-mode admission/notification testing                                                                  |
| `BILLING_APP_ORIGIN`                                | Exact HTTPS origin of the hosted account entry                                                                     |
| `BILLING_IDENTITY_RECONCILIATION_ENABLED`           | Opt-in missed-deletion scan using the matching Clerk instance; default false                                       |
| `BILLING_RENEWAL_GRACE_SECONDS`                     | Launch default `259200` (three days) for previously settled renewal service                                        |
| `BILLING_ALLOWED_COUNTRIES`                         | Reviewed ISO country codes for the sales policy                                                                    |
| `BILLING_COUNTRY_POLICY`                            | `notice` displays the sales policy; `enforced` also requires verified blocking                                     |
| `BILLING_COUNTRY_RESTRICTION_VERIFIED`              | Evidence-backed gate for `enforced`; do not set for a notice-only policy                                           |
| `BILLING_AUTOMATIC_TAX`                             | Required for live Checkout; does not create tax registrations                                                      |
| `STRIPE_SECRET_KEY`                                 | Server-only key whose mode matches the configuration                                                               |
| `STRIPE_WEBHOOK_SECRET`                             | This deployment's Stripe signing secret                                                                            |
| `CLERK_BILLING_WEBHOOK_SECRET`                      | Dedicated lifecycle secret, separate from authentication email                                                     |
| `STRIPE_MONTHLY_PRICE_ID`, `STRIPE_ANNUAL_PRICE_ID` | Recurring USD prices                                                                                               |
| `STRIPE_PORTAL_CONFIGURATION_ID`                    | Account portal configuration                                                                                       |

Configuration eligibility is not proof that a release passed its deployment gates. Live products can be prepared while Checkout and enforcement remain off. Changing a flag must not silently migrate every existing user into paid enforcement. Inventory an intended cohort and resolve its subscriptions and environment count before enrolling it; users outside the cohort retain their previous managed behavior.

For a controlled live purchase test, resolve the tester's verified production Clerk account ID and set `BILLING_CHECKOUT_USERS` to that ID, with live observation mode, Checkout enabled and production readiness approved. Status hides purchase controls from everyone else and the server rejects their Checkout requests. Keep `BILLING_ENFORCEMENT_USERS`, gateway enrollment and suspension unchanged until the managed-service cohort is separately reviewed. Purchase enrollment does not grant access or remove complimentary grants, and leaving the purchase cohort does not block an existing subscriber's portal or Checkout return reconciliation. Sandbox Checkout keeps its unrestricted default unless a purchase cohort is explicitly configured. Only set `BILLING_CHECKOUT_USERS=*` for an intentional public sales rollout.

## Lifecycle and access

Canonical provider data determines access. Settlement must cover the actual invoice service interval; a paid status without a verified settlement does not suffice. Trial access requires confirmed card setup. Cancellation preserves already-granted service through the effective cancellation boundary. The portal may set `cancel_at` without `cancel_at_period_end`.

Partial refunds preserve service. A complete refund of the current service term revokes that term and schedules subscription cancellation. Current-term unresolved or lost disputes suspend access; canonical resolution is reconciled before restoring it. These mechanisms react to provider facts; the application does not automatically approve refunds or create tax registrations. The launch renewal grace is three days for previously settled service, never an unpaid trial. Publish customer refund terms and supported markets before live Checkout.

Account deletion persists a tombstone before cancellation attempts. Retained mappings allow retries to cancel renewing subscriptions and expire owned open Checkout sessions, including operations that raced deletion. A new identity with the same email does not inherit the old account. A post-deletion charge requires operator review and resolution; deletion alone does not reverse historical charges.

`BillingOperations.reconcileIdentities` compensates for missed deletion webhooks using the matching Clerk instance's authenticated user endpoint. Only a Clerk-shaped `404 resource_not_found` establishes absence. Authentication failures, rate limits, timeouts, malformed responses and server errors leave the identity intact and retry later. The bounded scan keeps durable per-account due times: successful checks wait six hours; uncertain checks retry after fifteen minutes. Tombstoning writes the existing durable deletion receipt so the normal cancellation processor handles it. Verify the Clerk key belongs to the same instance as the retained users before enabling the scan.

## Managed connections and notifications

Admission checks run before managed provisioning, feature enablement, status/credential minting and credential return. Missing or expired access differs from unavailable/stale billing storage. Account inventory and cleanup remain reachable. A reservation transaction serializes three-slot allocation without holding a database lock across Cloudflare requests; completion checks billing and reservation generations.

Tunnel retirement persists work for the exact tunnel ID. It rotates the old token, disconnects connectors, deletes the tunnel and only then clears the matching allocation. Each external stage is checkpointed for retries. A renewal cannot reuse an allocation being retired. Hostname history remains available for a fresh provision. Stale billing data is uncertainty and cannot authorize destructive retirement. Suspension requires both its deployment gate and database enforcement control; the control epoch fences in-flight workers at subsequent external boundaries.

The gateway owns proxied HTTP streams and WebSockets and closes them at the authoritative finite access deadline. Snapshots are serialized per user and carry monotonically increasing generations; the Durable Object rejects older deliveries. A public request cannot supply or modify its own entitlement snapshot. Gateway origin routing must reject direct and forged-caller access. The gateway flags are independent proof gates: `MANAGED_GATEWAY_ENABLED=true` requires `MANAGED_GATEWAY_ORIGIN_GUARD_VERIFIED=true`, `MANAGED_GATEWAY_ROUTE_VERIFIED=true`, managed-access checks and the reviewed `BILLING_ENFORCEMENT_USERS` cohort. Production `BILLING_MODE=enforce` additionally requires the verified gateway. The isolated sandbox uses test billing and its explicit managed-access test flag.

Enrollment creates new `<digest>-g-<stage>.<base-domain>` public hosts and `gw-origin-<stage>-<digest>.<base-domain>` origins. Public Worker routes use `*-g-<stage>.<base-domain>/*`: Cloudflare permits the hostname wildcard at the beginning, not in the middle of the hostname. These remain single-label subdomains for certificate coverage. Existing direct-tunnel hostnames are never enrolled automatically. For each legacy environment, stop its old connector, explicitly unlink it, then relink to provision a new gateway hostname; verify the old process is stopped before enrolling that user. A deletion tombstone retains origin DNS and generation through provider cleanup and blocks relinking until cleanup is complete. Failed cleanup retries against that same generation.

Notifications check each recipient at enqueue and immediately before APNs dispatch. Signed job creation time must belong to the current uninterrupted entitlement window: a delayed first delivery from before an expiry/renewal gap is discarded, while uninterrupted renewal retains it. Definite denial records a terminal receipt so duplicates cannot replay after renewal. Storage uncertainty retries. Live Activity end cleanup remains permitted and suppresses alert copy when the old access window is no longer valid. Preferences and shared environment publishing credentials remain intact.

Turning enforcement off bypasses paid admission and notification gates. Disabling the gateway denies existing gateway connections when their authoritative snapshots synchronize; the gateway synchronization job must continue even when billing is disabled. This does not silently restore direct-tunnel routing. Turn suspension off before rollback; already-completed external deletion cannot be undone and a host may need to provision a fresh tunnel. Rollback does not cancel subscriptions or erase billing history.

## Monitoring and operator actions

The health projection exposes counts and ages, never provider secrets: pending inbox events and oldest age, unknown-account quarantine, stale accounts, deleted accounts with unresolved renewals, pending suspensions and oldest age, overdue identity checks and identity lookup failures. Alert immediately on deleted renewals; investigate an increasing quarantine backlog or identity failure count. Alert when pending work or suspension age exceeds the validated cutoff objective, and whenever account projections approach their fifteen-minute freshness limit. Connect health output to the deployment's monitoring destination and verify a test alert before enrolling users; availability of a metric alone is not an installed alert.

Use the explicit database branch URL and a read-only database role for status:

```sh
node infra/relay/scripts/billing-operations.ts status
node infra/relay/scripts/billing-operations.ts inventory
node infra/relay/scripts/billing-operations.ts payment-reviews
```

The command reads `BILLING_OPERATIONS_DATABASE_URL`; there is no fallback database. Supply credentials through the private operator environment, not a literal command committed to the repository. Applied billing and operations migrations are required.

A write-capable role and an explicit audit reason are required for recovery actions:

```sh
node infra/relay/scripts/billing-operations.ts replay evt_EXAMPLE --reason 'Provider issue resolved; replay approved'
node infra/relay/scripts/billing-operations.ts prune --reason 'Approved nonfinancial receipt maintenance'
```

The suspension database control is separately audited and increments its epoch even for repeated updates, invalidating earlier worker control snapshots:

```sh
node infra/relay/scripts/billing-operations.ts suspension-control off --reason 'Emergency enforcement rollback'
```

Enabling the database control (`on`) does not override disabled deployment gates. The transition default is 30 days. Inventory existing enabled environments first; use at least their current count as the grant limit so transition does not silently shrink an existing user's capacity. The grant operation rechecks capacity under the account lock.

```sh
node infra/relay/scripts/billing-operations.ts grant user_EXAMPLE --id transition-EXAMPLE --operator Justin --reason 'Reviewed existing-user transition' --start UNIX_SECONDS --days 30 --limit 3
node infra/relay/scripts/billing-operations.ts revoke-grant user_EXAMPLE --grant-id transition-EXAMPLE --id revoke-EXAMPLE --operator Justin --reason 'Reviewed grant revocation'
```

Replace placeholders with the reviewed identity and an explicit Unix-second start. Preserve the operation ID and timestamps on retries. Grant/revoke writes are audited and fence account generation; they do not create Stripe charges. Inventory reads at most 100 accounts; pass `--after LAST_USER_ID` for the next page. Changing cohort configuration remains a reviewed deployment operation.

Positive invoices settled after account deletion enter a durable payment-review queue and contribute to `pending_payment_reviews` health counts. Review the payment in Stripe, take the approved provider action separately, then record its outcome:

```sh
node infra/relay/scripts/billing-operations.ts resolve-review --invoice in_EXAMPLE --operator Justin --reason 'Provider refund confirmed; support record linked'
```

Resolving a review records an operator statement; it does not issue a refund or move money. Repeating an identical resolution is idempotent; a conflicting resolution fails.

Replay resets only the selected durable event for canonical reconciliation. It does not invent payment or erase the original receipt. Retention is disabled by default. Explicit pruning removes at most 100 processed receipts older than 90 days that contain neither customer nor user references; it preserves unprocessed events, deletion evidence and financial identity mappings. Every write appends an operator audit record. No automatic financial-history hard deletion is implemented.

## Release validation

The direct-tunnel provider experiment failed established-stream cutoff: rotating credentials, deleting connector connections and deleting the tunnel stopped new connections but existing HTTP and WebSocket traffic continued while the old connector ran. Those cleanup APIs alone cannot enforce a paid-service deadline. Code tests and configuration checks do not prove external traffic cutoff. Before paid enforcement, run an isolated real cloudflared connector with active HTTP/WebSocket traffic. Record the cutoff objective and observed result, then verify old-token retry, host restart and concurrent resubscription. Confirm old credentials cannot reopen the retired resource. Validate provider failure/retry and rollback during retirement.

A disposable per-user Durable Object prototype did close established HTTP and WebSocket traffic at its persisted deadline while the connector remained running. New public requests were denied, and both direct-origin access and a forged `CF-Worker` header were rejected. The working route used an authenticated Worker origin hop: a raw Durable Object origin fetch lacked the zone context required by the origin WAF guard. The prototype established the transport design; it was not application integration evidence.

The isolated `stripe-sandbox` application subsequently passed the integrated test through its real environment-link API, persisted entitlement/mapping store, Durable Object binding, public Worker route and guarded origin hop. The test verified DPoP at the origin, a 155,648-byte streamed POST, live HTTP and WebSocket traffic, and direct-origin/forged-header/unauthenticated-hop rejection. At the finite test grant deadline, HTTP closed after 223 ms and WebSockets after 175 ms while the connector remained running; a fresh public request returned 402. These are observed sandbox measurements, not a universal latency guarantee or proof of production configuration.

The integrated test also exposed response-header mutation errors at the platform adapters and repeated provisioning failures under the ordinary nine-second API deadline. Platform responses now receive mutable header wrappers without buffering their streams or losing WebSocket upgrades. Environment link, unlink and tunnel release requests have a thirty-second server deadline; shared web/mobile link and unlink clients allow thirty-five seconds. Ordinary API/client deadlines remain nine/ten seconds. The scoped deadline change has behavioral test coverage and still requires verification in the target deployment. Keep production enrollment disabled until its own route, origin guard, policy publication and rollout checks pass.

Before live charging, obtain passing CI on the deployed commit, hosted sign-in/Checkout/portal and webhook evidence, settlement/refund/dispute/deletion recovery evidence, a delivered monitoring test alert, reviewed cohort enrollment and approved public subscription terms. Confirm live account activation, prices, portal, webhook delivery, tax registrations and market choices. Do not infer approval or deployment completion from this runbook; the release record should identify the actual commit, provider environment, evidence and any remaining gates.
