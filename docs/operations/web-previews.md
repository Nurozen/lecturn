# Authenticated web previews

The `preview:web` label builds a same-repository pull request and assigns
`https://pr-<number>.preview.lecturn.cloudgatherer.net` to that deployment. The
build embeds this exact hosted origin. Production and nightly aliases are not
changed. Open the custom URL in the PR comment, not the generated `vercel.app`
deployment URL.

These previews share production Clerk accounts and relay data. Clerk requires
the same root domain when a preview uses production accounts. The Vercel Preview
environment supplies public Clerk and relay configuration; it does not need a
Clerk secret key or a Frontend API proxy. Keep Vercel deployment protection
enabled and limit preview builds to reviewed, same-repository changes.

Infrastructure prerequisites:

- DNS for `*.preview.lecturn.cloudgatherer.net` points to the Vercel project.
- The workflow token can create project domains and assign deployment aliases.
- Each project domain is pinned to its PR branch, so a production deployment
  cannot automatically take over the preview alias.

Authentication does not grant preview origins permission to use Billing or make
Teams changes. To enable a reviewed preview, add its exact HTTPS origin to the
relay's comma-separated `BILLING_ADDITIONAL_APP_ORIGINS` setting and redeploy the
relay. The production GitHub environment variable with the same name supplies
this setting to the relay deployment workflow. The default list is empty;
wildcards, paths, and non-HTTPS origins are rejected.

The allowlist permits browser requests from only those exact origins. Account
authentication, organization membership, and admin role checks still apply.
Stripe Checkout and portal return URLs continue to use the canonical production
app origin. This setting does not change native clients or grant access to
another account's environments.

When a preview is retired, remove its origin from the relay allowlist and
redeploy, then remove its PR-specific alias and project domain.
Never remove the production or nightly domains as part of preview cleanup.
