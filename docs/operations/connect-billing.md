# Connect billing sandbox integration

Lecturn uses Clerk user IDs for billing ownership and Stripe Billing for Connect subscriptions. The current implementation supports a disabled mode and an observation-only sandbox mode. It cannot enable live charging. A separate sandbox-only opt-in tests managed admission and notification checks; it does not terminate existing tunnels.

## Current behavior

The authenticated hosted account page is `/account/billing`. It works without a connected environment. Desktop account settings open that page in a browser; the browser may require a separate sign-in. Mobile displays subscription status without purchase links. Local, direct, SSH and Tailscale connections are unchanged.

The relay exposes:

| Endpoint                              | Purpose                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `GET /v1/billing/status`              | Read the authenticated user's billing projection                       |
| `POST /v1/billing/checkout`           | Create or recover sandbox Checkout for a monthly/yearly subscription   |
| `POST /v1/billing/portal`             | Open that user's Stripe billing portal                                 |
| `POST /v1/billing/checkout/reconcile` | Reconcile an owned Checkout return                                     |
| `POST /v1/billing/webhooks/stripe`    | Verify raw Stripe event bodies and persist routing references          |
| `POST /v1/billing/webhooks/clerk`     | Verify dedicated Clerk lifecycle events and tombstone deleted accounts |

Account requests use the existing Clerk bearer verification, including CLI OAuth. Checkout additionally requires a verified email on a nonlocked, nonbanned Clerk account. Browser mutations require the configured account origin; native bearer clients may omit Origin. A client cannot choose a Stripe customer, price, amount, or redirect URL.

## Isolated stage configuration

Never point a billing sandbox stage at the production database. The production deployment explicitly sets `BILLING_MODE=disabled` and `BILLING_CHECKOUT_ENABLED=false`, with `BILLING_SANDBOX_MANAGED_ACCESS_ENABLED=false`. The Worker rejects observation mode on the `prod` stage. Apply the additive billing migration to an isolated database branch before enabling observation.

| Binding                                  | Value                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `BILLING_MODE`                           | `disabled` by default; `observe` for an isolated sandbox stage                           |
| `BILLING_CHECKOUT_ENABLED`               | `false` by default; explicitly `true` for sandbox Checkout                               |
| `BILLING_SANDBOX_MANAGED_ACCESS_ENABLED` | `false` by default; test admission/quota/notification checks only in an isolated sandbox |
| `BILLING_APP_ORIGIN`                     | Exact HTTPS origin of the hosted account page                                            |
| `BILLING_RENEWAL_GRACE_SECONDS`          | `0` until a renewal-grace policy is approved                                             |
| `STRIPE_SECRET_KEY`                      | Sandbox secret, kept server-side                                                         |
| `STRIPE_WEBHOOK_SECRET`                  | Signing secret for this stage's Stripe endpoint                                          |
| `CLERK_BILLING_WEBHOOK_SECRET`           | Dedicated lifecycle endpoint secret, distinct from auth-email delivery                   |
| `STRIPE_MONTHLY_PRICE_ID`                | Recurring USD monthly price                                                              |
| `STRIPE_ANNUAL_PRICE_ID`                 | Recurring USD annual price                                                               |
| `STRIPE_PORTAL_CONFIGURATION_ID`         | Portal with payment updates, invoice history, cancellation and resume                    |

The Stripe API version is pinned to `2026-08-26.dahlia`; configure webhook events to the same version. Use the sandbox product and IDs from the private operator configuration, never keys in client builds or source control. Endpoint registration and its signing secret must be created for the deployed stage; a local CLI forwarding secret is not interchangeable.

## Persistence and recovery

A database lease serializes per-user billing changes. Durable operation IDs supply Stripe idempotency keys across retries. A timed-out call does not authorize a new purchase. Ambiguous operations older than the provider's idempotency retention window require operator investigation before another checkout.

The durable inbox is also the reconciliation work log. A minute cron revisits pending receipts and stale accounts; there is no database-to-queue handoff in this initial slice. Receipts are acknowledged only after persistence. Canonical Stripe data, rather than event ordering or a browser success redirect, determines the projection. Unknown customers remain untrusted. Deleted identities retain minimal mappings so retries can cancel continuing subscriptions and expire pending Checkout sessions.

By default billing is observed and `hasAccess` is a projected subscription eligibility result. With the explicit sandbox managed-access flag, the relay checks local entitlement before provisioning, feature enablement and managed health/mint requests, and again before returning connector credentials. Missing/expired access is a distinct subscription-required error; unavailable or stale billing storage remains a temporary error. Direct/local/SSH/Tailscale paths and account inventory/cleanup remain available.

Sandbox provisioning reserves capacity atomically under an account row lock before contacting Cloudflare. Pending and offline enabled environments count toward three slots; restarting does not free one. Each attempt advances its reservation generation. Completion checks both reservation and billing-account generations, withholding credentials if either changed. Explicit disable/unlink releases a captured reservation only after matching allocation cleanup; shutdown-only tunnel release retains the slot. Existing allocations count conservatively until adopted. Concurrent external provider operations are not held inside SQL transactions.

Notification checks apply per recipient at enqueue and immediately before APNs dispatch. Ineligible jobs are acknowledged without delivery; storage failures retry. Live Activity end cleanup remains allowed and becomes silent when access is missing or cannot be checked. Companion pushes are checked independently. Preferences and shared publishing credentials remain intact.

These admission checks do not revoke existing connector tokens or stop established HTTP/WebSocket streams. Provisioning failures or superseded completions retain reservations for recovery; they do not claim successful provider cleanup. Before production enforcement, complete durable per-resource suspension/recovery operations, actual token invalidation and connector disconnect experiments, and migration grants/over-quota keep-sets. Do not enable the sandbox flag against existing production users. Switching the flag off bypasses admission and notification checks without canceling subscriptions or deleting reservation history.

## Provider details established by sandbox tests

- The portal can set `cancel_at` while leaving `cancel_at_period_end=false`; both fields matter.
- The pinned API stores billing period boundaries on subscription items.
- A card-required trial can still fail its first payment; redirect success is not settled access.
- An annual subscription's entitlement must come from its settled invoice term, not an assumed month.

## Remaining launch gates

Production billing is intentionally not available in this version. Bind queued jobs to their originating entitlement window before production rollout: definite denial is recorded to stop duplicate replay, but a first delivery delayed across an expiry and renewal gap still needs that window fence. Complete refund/dispute handling, full deletion compensation and missed-event recovery validation, bounded reconciliation operational monitoring, and provider cutoff experiments before enabling a paid cohort. Approve taxes/markets, refunds, payment grace, transition grants and mobile distribution policies. Obtain fresh hosted CI and isolated provider end-to-end evidence before deployment or live activation.
