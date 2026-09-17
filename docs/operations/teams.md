# Teams operations

This runbook describes configuration and verification required to enable Teams. Source support alone does not mean production configuration or deployment is complete.

## Configure the relay

Keep `TEAMS_ENABLED=false` until the database schema, payment configuration, and signed webhook endpoints are ready. Teams also requires enabled existing Connect billing, the configured Clerk backend credentials, and the correct application origin.

Configure these bindings through the relay’s normal deployment mechanism:

| Binding                               | Purpose                                           |
| ------------------------------------- | ------------------------------------------------- |
| `TEAMS_ENABLED`                       | Enable Teams routes after prerequisites are ready |
| `STRIPE_TEAM_MONTHLY_PRICE_ID`        | Recurring USD $15 per-seat monthly price          |
| `STRIPE_TEAM_ANNUAL_PRICE_ID`         | Recurring USD $150 per-seat annual price          |
| `STRIPE_TEAM_PORTAL_CONFIGURATION_ID` | Dedicated company billing portal configuration    |
| `STRIPE_TEAM_WEBHOOK_SECRET`          | Signing secret for the Teams Stripe webhook       |
| `CLERK_TEAM_WEBHOOK_SECRET`           | Signing secret for the Teams Clerk webhook        |

Use the same Stripe account and live/test mode as the relay billing configuration. The supported pilot purchase range is 5–20 seats. Configure portal capabilities consistently with application-controlled seat previews and renewal reductions; do not enable independent quantity changes that bypass the seat constraints.

Apply the relay database migrations before enabling routes. Configure Clerk Organizations and invitation delivery. Register `POST /v1/teams/webhooks/clerk` for `organizationMembership.deleted`, `organization.deleted`, and `user.deleted`. Register `POST /v1/teams/webhooks/stripe` for the relevant customer subscription and invoice lifecycle events. Preserve raw webhook bodies and signatures; do not replace signature validation with an account allowlist. Verify rejected signatures and replay behavior in the target environment.

## Rollout verification

1. Deploy schema and relay support with billing and webhook credentials configured. Check startup configuration validation and webhook delivery.
2. Ship a host build that signs `teamPolicyVersion: 1`, plus clients that preserve returned funding organization and send policy-compatible publishing flags. Older hosts must be rejected when requesting company funding.
3. Exercise a test-mode company purchase, invitation acceptance, explicit seat assignment, and enrollment. Confirm return from Checkout alone grants no entitlement.
4. Confirm a member discovers only their own environments. Test owner/admin/member permissions and verify personal subscriptions are unchanged.
5. Revoke a seat and remove a member. Verify the company gateway closes, activity ingestion stops, and personal access remains available.
6. Disable activity publishing and enroll a tunnel-only company host. Restrict a provider and verify the host rejects new work; simulate an unavailable policy endpoint and verify company operations fail closed.
7. Preview and confirm an increase, schedule a reduction, and cancel that reduction. Verify the assigned-seat floor and 20-seat pilot maximum.

Use isolated fixtures and payment test mode for validation. Do not use a maintainer’s personal environment as a shared worker or reviewer environment.

## Billing recovery

Inspect company billing state, Stripe subscription/customer/session metadata, webhook deliveries, audit records, and relay errors together. Do not grant seats or alter paid access merely because a customer returned from Checkout.

Checkout reserves a durable operation before external calls. If the external result is unknown, retry the original quantity and interval so the same idempotency key recovers it. A known open session can be expired before a changed selection; a completed session must reconcile payment. Unknown operations older than 23 hours without a recorded session require support recovery because the original Stripe idempotency window may no longer be safe. Known expired sessions are verified with Stripe and can be replaced automatically.

Do not blindly delete an unknown Checkout reservation or retry with a new key: this can create duplicate subscriptions. First establish whether Stripe created a session or subscription for the original operation and company customer. Reconcile confirmed results, or explicitly resolve/expire the original session before clearing state through a reviewed repair.

If membership deletion or payment reconciliation is delayed, inspect the signed webhook delivery and retry it. Reconciliation and gateway synchronization should converge from authoritative membership and payment state. Disabling the feature flag is not a substitute for revoking existing company entitlements; handle active subscriptions and funded links explicitly before a rollback.

Interrupted seat confirmations are replayed by reconciliation using the original idempotency key only within 23 hours and against the same subscription term. Canonically completed changes reconcile without replay. Expired, replaced, renewed, or suspended operations require review rather than charging again.

A verified user-deletion webhook persists a Teams tombstone, revokes that user’s seats, closes companies they own, and synchronizes their gateways before retrying Stripe cancellation. Do not remove tombstones to recreate an owner.
