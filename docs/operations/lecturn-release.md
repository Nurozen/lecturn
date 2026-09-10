# Lecturn releases (fork)

Lecturn is a fork of [T3 Code](https://github.com/pingdotgg/t3code). This page covers only what differs from upstream's [release runbook](./release.md); everything not mentioned here works as upstream documents it.

## Branch model

- `main` is the product line. Fork releases are cut from it.
- `t3mirror` is a pristine mirror of upstream `main`, force-updated by the nightly `t3mirror-sync.yml` workflow (09:23 UTC). It replaces the old `upstream-main` branch. Cut upstream-bound PR branches from it, never from `main`, so they cannot carry fork-only commits.
- Nothing from upstream lands on `main` automatically. A nightly launchd job runs `.github/upstream-integration/integrate-local.sh` on your machine, inside the `lecturn-upstream` Stave space: it merges `t3mirror` in, has Claude resolve conflicts and typecheck the result, and opens a PR assigned to you. CI gates it; you merge it. `upstream-integrate.yml` is the same flow in Actions, kept disabled as a travel fallback. See [upstream integration](./upstream-integration.md).
- Upstream tags are never fetched or pushed here. Pushing an upstream `v*.*.*` tag would trigger this fork's release pipeline.

## What the fork's `release.yml` removes

- Blacksmith runners → GitHub-hosted (`ubuntu-24.04`, `macos-26`, `macos-26-intel`, `windows-2025`).
- T3 Connect relay/Clerk configuration. The build simply omits those values; the app hides Connect UI and CLI commands when they are absent.
- AUR publishing, Vercel web deploy, Discord announcements, and the GitHub App used by `finalize` (it uses the workflow token instead).
- The nightly cron runs once a day (10:38 UTC, after the upstream sync) instead of every three hours. `check_changes` still skips it when `main` has not moved.

Upstream workflows that still depend on upstream infrastructure can be disabled in the repository's Actions settings rather than deleted. The fork's mobile EAS production workflow is active.

## Mobile production builds

`mobile-eas-production.yml` builds both mobile platforms on relevant pushes to `main` and publishes OTA updates only when a finished production binary matches the current platform fingerprint. An existing version, including a queued build, prevents duplicate automatic builds. Native changes without a matching binary require a manual build dispatch even if the app version is unchanged.

iOS builds automatically submit to TestFlight. Android builds and fingerprint-gated OTA remain enabled, but Google Play submission defaults off. Set the repository variable `EAS_ANDROID_AUTO_SUBMIT=true` only after completing Play Console onboarding, uploading the first app as required by Google, and configuring the Google service account for the production EAS submission profile. Manual `build` dispatches follow the same submission policy.

Enabling Android submission does not resubmit an existing build. Submit that build explicitly from CI or EAS after credentials are ready; do not create a duplicate merely to retry submission. The workflow summary distinguishes build-only Android runs from store submission.

## npm package

The workspace package keeps its upstream name `t3` so build filters and task graphs stay untouched. Only the published manifest is rewritten: `publish_cli` passes `--package-name lecturn --bin-name lecturn`, and `repository.url` follows `GITHUB_REPOSITORY`. Publishing uses npm trusted publishing (OIDC) — no token is stored; the trusted publisher on npm must point at `Nurozen/lecturn` and `release.yml`.

## Bundled Stave

Every release bundles the Stave CLI binary from the [`Nurozen/stave`](https://github.com/Nurozen/stave) GitHub releases so the app never depends on a system-installed `stave`.

- **Choosing the version.** The `stave_version` dispatch input takes a Stave release tag or `latest` (the default). Pin a tag when you need a reproducible rebuild. Tag pushes and the nightly schedule have no inputs and always resolve `latest`.
- **One pin per run.** `preflight` resolves the tag once (`Resolve Stave release tag`, via `scripts/fetch-stave.ts --resolve-only`) and exposes it as the `stave_tag` job output. Every build and publish job fetches that exact tag, so a Stave release landing mid-run cannot split the artifacts. The resolved tag is written to the run's step summary.
- **Verification.** Each download is sha256-checked against the release's `checksums.txt` before extraction. A checksum mismatch or a missing asset fails the job.
- **CLI package.** `publish_cli` fetches all six platform keys (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`) into `apps/server/dist/stave/<key>/`, and `cli.ts publish --require-stave` refuses to publish if any is missing.
- **Desktop legs.** Each of the four desktop matrix legs fetches only its own platform key. The Windows leg also fetches `linux-x64` for the WSL backend; the artifact script stages it into the WSL server payload.
- **Local builds.** `vp run dist:desktop:artifact` requires `--stave-binary <path>` (and `--stave-wsl-binary <path>` on Windows). Pass `--allow-missing-stave` only for local development; CI never does.
- **Where the tag shows up.** A `stave.version` file containing the tag sits beside each bundled binary, and the app reports the bundled version under Diagnostics.

## Code signing

Builds are unsigned until the secrets exist; nothing fails without them.

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` enable Developer ID signing and notarization. `APPLE_TEAM_ID` and `MACOS_PROVISIONING_PROFILE` are optional: they only add the T3 Connect passkey entitlements, which the fork does not ship. electron-updater refuses to update unsigned macOS apps, so mac auto-update requires these.
- Windows: the Azure Trusted Signing secrets work as upstream documents; unsigned builds install with a SmartScreen warning.

## Before the first stable release

The desktop build still carries upstream's app identity (bundle id, product name, protocol scheme, data directory). Installing it replaces a real T3 Code install. Use nightly prereleases for testing until the identity is changed.

The resolved Stave release must be v0.4.0 or newer. `fetch-stave` validates both explicit
`stave_version` pins and the tag returned for `latest` before downloading assets; older releases
lack the JSON mutation protocol used by this integration.
