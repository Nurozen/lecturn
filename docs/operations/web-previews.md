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

Authentication does not grant preview origins permission to make Teams changes.
The relay's existing origin checks still apply; do not weaken those checks to
make a preview pass. Any production-data mutation needs its normal authorization.

When a preview is retired, remove its PR-specific alias and project domain.
Never remove the production or nightly domains as part of preview cleanup.
