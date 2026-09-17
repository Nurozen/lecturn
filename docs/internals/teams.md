# Teams architecture

Teams adds a funding and policy boundary around managed Connect. It does not change environment ownership or create shared access to computers.

## Identity and funding

Clerk remains the source of user identity and organization membership. The relay stores company ownership, billing state, explicit seat assignments, policies, environment funding, and audit events. Company authorization checks live membership; joining an organization is insufficient without an assigned seat and paid entitlement.

Clients retain personal Clerk tokens. Their per-user company selector is local funding context, not a server-global active organization or an authorization claim. New environment link requests include an optional `organizationId`. An omitted value means personal funding. Existing link updates read the host’s persisted organization and preserve that funding even if the picker changes.

The relay verifies the signed link proof, membership, seat, and subscription before binding funding. The proof must contain `teamPolicyVersion: 1` for a company link. This prevents older hosts without policy enforcement from enrolling company environments. The returned organization is persisted alongside the environment credential; unlink clears it. Funding cannot silently transfer between companies or from personal access.

Discovery and tunnels remain scoped to the actual user and environment. A seat, admin role, or company inventory entry never grants a token for somebody else’s environment.

## Billing consistency

`infra/relay/src/teams/TeamBillingService.ts` owns serialized billing operations and reconciliation. Persisted operation IDs become Stripe idempotency keys; database leases and generation checks protect concurrent updates. Checkout grants no access from a browser return parameter. Signed Stripe events and reconciliation re-read the subscription and confirmed payment window.

Seats are explicitly assigned independently of purchased quantity. Increases require preview and confirmation; decreases are scheduled for renewal. A scheduled decrease can be canceled with a preview of the current quantity. Clerk deletion webhooks revoke membership-derived access; gateway synchronization closes affected company connections.

## Policy enforcement

`apps/server/src/cloud/TeamPolicy.ts` reads the persisted funding organization and authenticates to `/v1/teams/environment-policy` with the environment credential. The response must match the configured organization and grant current access. Company policy errors fail closed. Personal hosts avoid this request.

`ProviderService` checks allowed providers before starting, recovering, or continuing provider work. `AgentAwarenessRelay` checks activity policy before reading or sending activity snapshots. The relay independently checks entitlement and policy at ingestion. Disabling activity does not disable a managed tunnel: clients sign and submit both publishing flags as false while retaining managed mode.

These are application-level controls on company-funded environments, not an MDM boundary against a machine owner modifying their own installation. Already-running provider processes are not retroactively terminated by a policy change.

## Client surfaces

The shared relay client lives in `packages/client-runtime/src/relay/teams.ts`; core domain schemas are in `packages/contracts/src/relayTeams.ts`. Hosted web renders `TeamsAccount` management. Desktop and locally hosted web render a browser handoff because mutation origins are restricted to the hosted app; `TeamSelector` remains available for funding on every surface. Mobile uses a native selector without purchase controls. Async UI responses are guarded against account/context changes. The account billing route supports `?tab=teams` for Stripe returns.

See the [user guide](../user/teams.md), [operations runbook](../operations/teams.md), and [environment authentication](environment-auth.md).
