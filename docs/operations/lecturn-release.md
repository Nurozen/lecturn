# Lecturn releases (fork)

Lecturn is a fork of [T3 Code](https://github.com/pingdotgg/t3code). This page covers only what differs from upstream's [release runbook](./release.md); everything not mentioned here works as upstream documents it.

## Branch model

- `main` is the product line. Fork releases are cut from it.
- `upstream-main` is a pristine mirror of upstream `main`, force-updated by the nightly `upstream-sync.yml` workflow (09:23 UTC). Clean merges land on `main` automatically; conflicts open a PR from `upstream-main` listing the files to resolve.
- Upstream tags are never fetched or pushed here. Pushing an upstream `v*.*.*` tag would trigger this fork's release pipeline.

## What the fork's `release.yml` removes

- Blacksmith runners → GitHub-hosted (`ubuntu-24.04`, `macos-26`, `macos-26-intel`, `windows-2025`).
- T3 Connect relay/Clerk configuration. The build simply omits those values; the app hides Connect UI and CLI commands when they are absent.
- AUR publishing, Vercel web deploy, Discord announcements, and the GitHub App used by `finalize` (it uses the workflow token instead).
- The nightly cron runs once a day (10:38 UTC, after the upstream sync) instead of every three hours. `check_changes` still skips it when `main` has not moved.

Other upstream workflows that depend on upstream infrastructure (relay deploy, mobile EAS, previews, PR bots) are disabled in the repository's Actions settings rather than deleted, so they never conflict with nightly merges.

## npm package

The workspace package keeps its upstream name `t3` so build filters and task graphs stay untouched. Only the published manifest is rewritten: `publish_cli` passes `--package-name lecturn --bin-name lecturn`, and `repository.url` follows `GITHUB_REPOSITORY`. Publishing uses npm trusted publishing (OIDC) — no token is stored; the trusted publisher on npm must point at `Nurozen/lecturn` and `release.yml`.

## Code signing

Builds are unsigned until the secrets exist; nothing fails without them.

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` enable Developer ID signing and notarization. `APPLE_TEAM_ID` and `MACOS_PROVISIONING_PROFILE` are optional: they only add the T3 Connect passkey entitlements, which the fork does not ship. electron-updater refuses to update unsigned macOS apps, so mac auto-update requires these.
- Windows: the Azure Trusted Signing secrets work as upstream documents; unsigned builds install with a SmartScreen warning.

## Before the first stable release

The desktop build still carries upstream's app identity (bundle id, product name, protocol scheme, data directory). Installing it replaces a real T3 Code install. Use nightly prereleases for testing until the identity is changed.
