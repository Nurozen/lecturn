# Lecturn releases

The [release runbook](./release.md) describes packaging and publishing. This page covers Lecturn-specific release configuration.

## Branch model

- `main` is the product line; releases are cut from it.
- `upstream-mirror` holds the configured upstream source for reviewed integration. See [upstream integration](./upstream-integration.md) for the current checkpoint workflow.
- Upstream tags are never fetched or pushed here, because matching release tags trigger the release pipeline.

## Release configuration

The workflow uses GitHub-hosted runners and publishes desktop artifacts and the `lecturn` CLI package. Hosted-app, relay, and Clerk configuration comes from repository variables and the production environment. Review `.github/workflows/release.yml` for required configuration before dispatching a release.

## Stable release finalization

After publishing a stable release, finalization opens or reuses a `release/version-<tag>` pull request for the package version bump. It explicitly dispatches the normal CI workflow on that branch because pushes made with `GITHUB_TOKEN` do not start push workflows. The release summary links the pull request; merge it after the required checks pass. Branch protection stays enabled, and publishing does not wait for this bookkeeping PR to merge.

Rerunning finalization succeeds without a PR when `main` already has the released versions. An existing version branch is reused only when its changes and generated file contents match; finalization never force-pushes it. If it has diverged, inspect and reconcile that branch before retrying. CI's optional `pull_request_number` dispatch input lets its native-change detector inspect the PR; without a resolvable diff, native checks run as a precaution.

## Mobile production builds

`mobile-eas-production.yml` builds both mobile platforms on relevant pushes to `main` and publishes OTA updates only when a finished production binary matches the current platform fingerprint. An existing version, including a queued build, prevents duplicate automatic builds. Native changes without a matching binary require a manual build dispatch even if the app version is unchanged.

iOS builds automatically submit to TestFlight. Android builds and fingerprint-gated OTA remain enabled, but Google Play submission defaults off. Set the repository variable `EAS_ANDROID_AUTO_SUBMIT=true` only after completing Play Console onboarding, uploading the first app as required by Google, and configuring the Google service account for the production EAS submission profile. Manual `build` dispatches follow the same submission policy.

Enabling Android submission does not resubmit an existing build. Submit that build explicitly from CI or EAS after credentials are ready; do not create a duplicate merely to retry submission. The workflow summary distinguishes build-only Android runs from store submission.

## npm package

The workspace and published package use `lecturn`, with the `lecturn` executable. `publish_cli` passes `--package-name lecturn --bin-name lecturn`, and `repository.url` follows `GITHUB_REPOSITORY`. Publishing uses npm trusted publishing (OIDC); the trusted publisher must point at `Nurozen/lecturn` and `release.yml`.

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

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` enable Developer ID signing and notarization. `APPLE_TEAM_ID` and `MACOS_PROVISIONING_PROFILE` configure associated-domain entitlements when supplied. See the release runbook for signing setup.
- Windows: Azure Trusted Signing configuration is described in the release runbook.

## Application identity

Lecturn uses its own application name and identity. Runtime data lives in `~/.lecturn/userdata`. See [Install Lecturn](../user/lecturn-installation.md) for installation and data-directory configuration.

The resolved Stave release must be v0.4.0 or newer. `fetch-stave` validates both explicit
`stave_version` pins and the tag returned for `latest` before downloading assets; older releases
lack the JSON mutation protocol used by this integration.

## Upgrading installations after the naming change

Rebuild and deploy the server, relay, web, desktop, and mobile clients together: package scopes, native module names, connection endpoints, and token identifiers now use Lecturn names. A mobile binary rebuild is required; an OTA update cannot rename native modules.

- Update deployment settings to the `LECTURN_` environment variables documented in `.env.example`, and the corresponding web and mobile build variables. Update external CI configuration before publishing.
- Rename checked-in project configuration to `lecturn.json` and use the schema at `/schema/lecturn.json`.
- Existing data in `~/.lecturn/userdata` remains in place. Historical checkpoint refs and citation links remain readable through their stored structure.
- Renamed browser and mobile storage keys do not automatically import earlier saved connections, credentials, caches, or preferences. Sign in and pair again where necessary; no existing data is deleted.
- Existing temporary worktree branches retain their names and may need a manual rename; automatic branch recognition applies to the current `lecturn/` naming convention.
- Reconcile existing cloud resources and deployment state before deploying renamed infrastructure. See the [relay deployment notes](../../infra/relay/README.md).
