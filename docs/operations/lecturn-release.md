# Lecturn releases

The [release runbook](./release.md) describes packaging and publishing. This page covers Lecturn-specific release configuration.

## Branch model

- `main` is the product line; releases are cut from it.
- `upstream-mirror` holds the configured upstream source for reviewed integration. See [upstream integration](./upstream-integration.md) for the current checkpoint workflow.
- Upstream tags are never fetched or pushed here, because matching release tags trigger the release pipeline.

## Release configuration

The workflow uses GitHub-hosted runners and publishes desktop artifacts and the `lecturn` CLI package. Hosted-app, relay, and Clerk configuration comes from repository variables and the production environment. Review `.github/workflows/release.yml` for required configuration before dispatching a release.

## Mobile production builds

`mobile-eas-production.yml` builds both mobile platforms on relevant pushes to `main` and publishes OTA updates only when a finished production binary matches the current platform fingerprint. An existing version, including a queued build, prevents duplicate automatic builds. Native changes without a matching binary require a manual build dispatch even if the app version is unchanged.

iOS builds automatically submit to TestFlight. Android builds and fingerprint-gated OTA remain enabled, but Google Play submission defaults off. Set the repository variable `EAS_ANDROID_AUTO_SUBMIT=true` only after completing Play Console onboarding, uploading the first app as required by Google, and configuring the Google service account for the production EAS submission profile. Manual `build` dispatches follow the same submission policy.

Enabling Android submission does not resubmit an existing build. Submit that build explicitly from CI or EAS after credentials are ready; do not create a duplicate merely to retry submission. The workflow summary distinguishes build-only Android runs from store submission.

## npm package

The workspace and published package use `lecturn`, with the `lecturn` executable. `publish_cli` passes `--package-name lecturn --bin-name lecturn`, and `repository.url` follows `GITHUB_REPOSITORY`. Publishing uses npm trusted publishing (OIDC); the trusted publisher must point at `Nurozen/lecturn` and `release.yml`.

## Code signing

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` enable Developer ID signing and notarization. `APPLE_TEAM_ID` and `MACOS_PROVISIONING_PROFILE` configure associated-domain entitlements when supplied. See the release runbook for signing setup.
- Windows: Azure Trusted Signing configuration is described in the release runbook.

## Application identity

Lecturn uses its own application name and identity. Runtime data lives in `~/.lecturn/userdata`. See [Install Lecturn](../user/lecturn-installation.md) for installation and data-directory configuration.

## Upgrading installations after the naming change

Rebuild and deploy the server, relay, web, desktop, and mobile clients together: package scopes, native module names, connection endpoints, and token identifiers now use Lecturn names. A mobile binary rebuild is required; an OTA update cannot rename native modules.

- Update deployment settings to the `LECTURN_` environment variables documented in `.env.example`, and the corresponding web and mobile build variables. Update external CI configuration before publishing.
- Rename checked-in project configuration to `lecturn.json` and use the schema at `/schema/lecturn.json`.
- Existing data in `~/.lecturn/userdata` remains in place. Historical checkpoint refs and citation links remain readable through their stored structure.
- Renamed browser and mobile storage keys do not automatically import earlier saved connections, credentials, caches, or preferences. Sign in and pair again where necessary; no existing data is deleted.
- Existing temporary worktree branches retain their names and may need a manual rename; automatic branch recognition applies to the current `lecturn/` naming convention.
- Reconcile existing cloud resources and deployment state before deploying renamed infrastructure. See the [relay deployment notes](../../infra/relay/README.md).
