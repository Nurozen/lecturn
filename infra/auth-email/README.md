# Authentication email delivery

This Worker delivers Clerk's rendered authentication emails through the verified
`cloudgatherer.net` Resend domain. Clerk still generates and verifies every code;
only email transport changes. The sender is `Lecturn <notifications@cloudgatherer.net>`.

## Configuration

- Webhook: `https://lecturn-auth-email.accounts-657.workers.dev/clerk-email`
- Subscribe the Clerk production endpoint to **`email.created`**.
- Worker secrets: `CLERK_WEBHOOK_SIGNING_SECRET` (endpoint signing secret) and
  `RESEND_API_KEY` (sending-only key restricted to `cloudgatherer.net`).
- GitHub repository secret names (available to the production job): `CLERK_EMAIL_WEBHOOK_SIGNING_SECRET`,
  `RESEND_API_KEY`, and existing `CLOUDFLARE_API_TOKEN`; account ID uses the existing
  `CLOUDFLARE_ACCOUNT_ID` variable.

Deploy the Worker and set both secrets before disabling **Delivered by Clerk**
for any email template. Keep authentication verification enabled. Start with the
new-device challenge and sign-in verification templates; change additional
transport settings only when this handler is ready to deliver those messages.

The handler uses Clerk's official signature verifier, including timestamp checks,
then accepts only email events with `delivered_by_clerk: false`. It forwards the
rendered HTML and plain text without logging codes, content, or recipients.
Provider failures return HTTP 502 so Svix retries. Each email uses its Clerk email
ID as a Resend idempotency key; Resend retains keys for 24 hours, so this is not
an unlimited deduplication guarantee.

## Deploy and verify

The `Deploy authentication email` workflow runs on relevant `main` changes or
manual dispatch. For local deployment, use Wrangler 4.82.2 from this directory:

```sh
wrangler deploy
wrangler secret bulk /secure/path/to/auth-email-secrets.json
```

The secrets JSON uses the two Worker secret names above. Keep that file outside
the repository with mode 600. The workflow supplies secrets without storing them
in the repository.

Run `vp test run infra/auth-email/src/index.test.ts` and the package typecheck.
`GET /health` checks availability; unsigned POSTs to `/clerk-email` must return 400. Then request a real verification email and check Svix delivery status,
Resend delivery status, and mailbox receipt. Health alone does not prove delivery.

To revert transport, re-enable **Delivered by Clerk** for the affected templates
only after Clerk's native delivery works. Events marked as delivered by Clerk
are ignored by this Worker, preventing a second send.

Sources:

- https://clerk.com/docs/guides/customizing-clerk/email-sms-templates
- https://clerk.com/docs/reference/backend/verify-webhook
- https://resend.com/docs/dashboard/emails/idempotency-keys
