# Release Checklist

> For maintainers. Using Lecturn? See [docs/user](../user/).

This document covers the unified release workflow for stable and nightly desktop releases.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - manual `workflow_dispatch` with `channel=stable`, the normal way to ship stable. Stable
    and nightly dispatches must select `main`.
  - push tag matching `v*.*.*` for a stable release of an explicit commit
  - scheduled nightly check once daily at 10:38 UTC
  - manual `workflow_dispatch` with `channel=nightly`
- A manual stable release builds the commit of the latest published nightly, not `main` HEAD.
  Nightly is the release candidate: verify the nightly, then promote it. Merges to `main` keep
  landing while you verify and never leak into the stable build.
  - The version defaults to the one the nightly previewed (`0.0.39-nightly.*` ships as `0.0.39`).
    Pass the `version` input to override it, for example for a minor bump.
  - Every quality check, desktop build, CLI archive, CLI package, and GitHub Release uses the
    resolved commit. Finalization alone checks out current `main` for the version bookkeeping PR.
  - The stable tag is created on the nightly's commit when the GitHub Release is published.
  - Without a published nightly, manual stable releases fail even when `version` is supplied.
    Nightlies are selected from this repository, so Lecturn versions remain independent of upstream.
  - Pushing a `vX.Y.Z` tag by hand still works and builds exactly the tagged commit. Use it when
    the commit to ship is not the latest nightly, such as a cherry-picked fix on a release branch.
- Runs lint, typecheck, and tests alongside artifact builds. Publishing waits for every check.
- Reads the shared production Lecturn Connect relay URL and Clerk client configuration before packaging clients.
- Builds the Linux x64 CLI archive first in its own job (`build_linux_cli`); the Windows desktop build embeds it as the WSL runtime.
- Builds four desktop artifacts in parallel for both channels:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Builds a self-contained CLI archive (`lecturn-<version>-<platform>-<arch>.tar.gz`, `.zip` on Windows) for three targets, macOS arm64, Linux x64, and Windows x64, and attaches them to the GitHub Release with a `SHA256SUMS` file. Linux comes from `build_linux_cli`; macOS arm64 and Windows x64 are built in the same job as that target's desktop artifact. There is no macOS x64 archive: Node single-executables are unsupported on x64 macOS. The x64 desktop app is Electron and unaffected.
  - The archive holds the server as a Node single-executable (`scripts/build-cli-archive.ts`) plus the web client, resource monitor, native externals, and the platform's Stave binary at `stave/<platform>-<arch>/`, so unpacking it needs neither Node, npm, nor a compiler. The install scripts (`scripts/install.sh`, `scripts/install.ps1`) and desktop SSH environments on macOS arm64 and Linux x64 remotes download this archive and verify it against `SHA256SUMS`; other SSH remotes run `npx lecturn@<version>`, and the install scripts point other platforms at `npx lecturn`. The desktop WSL backend embeds the Linux archive. The boot service and `lecturn update` also install from these archives but stay disabled until `RuntimeReleaseArchivesPublished` (`apps/server/src/cloud/pinnedRuntime.ts`) is enabled for published Lecturn archives; until then they fail with an explicit unavailable error.
  - The executable is built with a Node that supports `--build-sea` (`VP_NODE_VERSION=26.8.2`, kept in step with `SEA_NODE_VERSION` in `apps/server/vite.config.ts`), while the repo stays on `engines.node`.
  - macOS archives are signed with the Developer ID certificate (`CSC_LINK`) and notarized when the Apple API secrets are present, and signed ad hoc otherwise. Windows executables use the installer's Azure Trusted Signing setup when its secrets are present and stay unsigned otherwise.
  - Each archive is extracted and executed on its build runner (`scripts/smoke-cli-archive.ts`) before it is uploaded.
- Publishes the CLI package (`apps/server`, npm package `lecturn`) with OIDC trusted publishing from the same workflow file:
  - stable releases publish npm dist-tag `latest`
  - nightly releases publish npm dist-tag `nightly`
  - Upstream's npm layout, a launcher over per-platform executable packages (`scripts/build-npm-platform-packages.ts`, which would publish `@lecturn/lecturn-<platform>-<arch>`), is not wired into the workflow: those packages and their trusted publishers do not exist yet.
- Signing is optional and auto-detected per platform from secrets.

## Required release credentials

CLI publishing uses npm OIDC trusted publishing. GitHub Release publication and stable
finalization use the repository-scoped `GITHUB_TOKEN`; no Release App credentials are required
for this workflow. Stable finalization opens or reuses a version bump pull request and explicitly
dispatches CI. Merge that pull request after its required checks pass; see
[Lecturn release finalization](./lecturn-release.md#stable-release-finalization).

## Lecturn Connect relay deployment

The relay is a shared control plane versioned separately from client releases. Stable and nightly
client builds must point at the same relay so users see the same linked environments when switching
release channels.

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. The
release workflow reads the relay URL and Clerk client configuration from the existing `production`
GitHub Actions environment before building desktop and CLI artifacts. Client packaging uses
`RELAY_DOMAIN` explicitly; configure it even when the relay deployment derives its domain from
`RELAY_API_ZONE_NAME`. The release does not read or redeploy Alchemy state.

Required repository variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `PLANETSCALE_ORGANIZATION`
- `AXIOM_ORG_ID`

Required repository secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `PLANETSCALE_API_TOKEN_ID`
- `PLANETSCALE_API_TOKEN`
- `AXIOM_TOKEN`

Required `production` environment variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

Optional `production` environment variables:

- `RELAY_DOMAIN` when overriding the derived `relay.<RELAY_API_ZONE_NAME>` domain
- `RELAY_TUNNEL_CLEANUP_MODE` with `off`, `dry-run`, or `enabled`. Missing and blank values use
  `off`.
- `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` with the same values, for tunnels whose host never registered
  recovery. Missing and blank values use `off`.

Required `production` environment secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

After changing a variable or secret, run the **Deploy Lecturn Connect relay** workflow manually from
`main` with **force** unchecked. Alchemy compares the values the Worker reads and redeploys it when
one changed. Check **force** only to redeploy resources with no detected change: a forced run also
replaces the Postgres runtime role and its password
([alchemy-run/alchemy#1832](https://github.com/alchemy-run/alchemy/issues/1832)).

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The `prod` stage owns the retained PlanetScale
database. Local personal stages provision isolated branches from it and are never deployed by CI.
Production adopts the configured relay API and tunnel DNS zones as retained Cloudflare resources.
Personal stages reference the production-owned zones.

Developers deploy personal stages locally rather than through pull-request automation:

```sh
vp run --filter lecturn-relay deploy -- --stage "$USER" --env-file .env.local
```

### Managed tunnel cleanup rollout

Keep `RELAY_TUNNEL_CLEANUP_MODE=off` for the first production deploy. That deploy applies the
nullable allocation migration and adds the recovery endpoints. Web and mobile clients need no
coordinated release. CLI and desktop server builds must reach users before cleanup is enabled,
because those builds register recovery and replace a deleted tunnel after wake.

1. Deploy the relay and migration with cleanup `off`.
2. Release the server build and confirm current hosts register recovery. Older hosts stay marked
   legacy and are only candidates under the legacy switch below.
3. Set `dry-run`, run a relay deploy, and read the sweep counters (`scanned`, `wouldDelete`,
   `skippedLegacy`, `skippedOrphan`, `failed`, `truncated`) across several sweeps. Each sweep records
   them, and the active `mode`, as `relay.managed_endpoint_reaper.*` attributes on its
   `relay.managed_endpoint_reaper.sweep` span in Axiom.
4. Run the disposable-host canary below.
5. Set `enabled` only after the canary recovers without a server restart.

The job runs every five minutes with a five-minute grace period for tunnels that lost their
connector, so a candidate is usually removed five to ten minutes after it goes down. Tunnels that
never connected wait an hour. One sweep attempts at most 100 deletions, so a backlog takes longer.
Changing `RELAY_TUNNEL_CLEANUP_MODE`, including turning cleanup off during an incident, needs a relay
deploy without force. Confirm the new `mode` on the next sweep span.

To roll back, set cleanup to `off` and run a relay deploy before downgrading any host. Keep the
recovery endpoints deployed while current server builds are in use. The nullable columns can stay.

### Legacy tunnel cleanup

A legacy tunnel belongs to a host that never registered recovery, usually one that went offline
before the recovery build shipped. `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` deletes these once Cloudflare
reports them down, or never connected, for more than 7 days. It is independent of
`RELAY_TUNNEL_CLEANUP_MODE`, and every other check still applies.

A deleted legacy tunnel keeps its allocation, so its hostname is kept. When the host comes back:

- On a build with recovery, the connector is rejected and the host requests a replacement tunnel at
  the same hostname.
- On an older build with a CLI link, startup provisions a new tunnel.
- On an older build linked from web or mobile, the host stays offline until Lecturn on that computer
  is updated.

Ship the web and mobile builds that show the offline reason before enabling legacy cleanup, so a
user whose host is affected sees what to do. The relay adds the `tunnel_released_at` allocation
column in its first deploy with this change; the legacy switch stays `off` until you set it.

1. Run `vp run --filter lecturn-relay tunnels:census` with a read-only Cloudflare token. It counts
   tunnels in every relay stage. The reaper only sees its own stage's tunnels, so clean up the rest
   by hand.
2. Set the legacy mode to `dry-run`, deploy, and read `wouldDeleteLegacy`, `legacyOver30Days`,
   `totalDown`, and `totalInactive` on the sweep spans for a day. `wouldDeleteLegacy` counts only the
   tunnels a sweep inspected, at most 500 per status. `totalDown` and `totalInactive` are Cloudflare's
   counts of this stage's tunnels down for over five minutes and never connected for over an hour.
   They include ones the reaper skips, so they are an upper bound on the backlog. The share of `wouldDeleteLegacy` in each sweep's `scanned` estimates how
   much of that total is eligible.
3. Run the legacy steps of the disposable-host canary below.
4. Before enabling, confirm the web and mobile builds that show the "update Lecturn on that computer"
   message are live. Without them, a user whose older host lost its tunnel only sees it as offline.
5. Set the legacy mode to `enabled`. One sweep deletes at most 100 tunnels, four at a time, and
   stops starting new deletions after 90 seconds. A backlog of 20,000 takes about 17 hours if each
   sweep finishes its 100. Watch `deletedLegacy`, `attempted`, `failed`, and `truncated`. An
   `attempted` well under 100 with `truncated` set means the sweep stopped early: either the time
   budget ran out or Cloudflare rate-limited a deletion. The counters don't say which; the relay
   logs a warning with the Cloudflare error for each failed deletion.

In Axiom, filter the relay traces dataset on `name == "relay.managed_endpoint_reaper.sweep"` and
chart the `attributes.custom.relay.managed_endpoint_reaper.*` fields over time.

Set the legacy mode back to `off` and deploy if any of these happen:

- `failed` stays above a few per sweep. Read the warning log for the Cloudflare error.
- Users report an environment that is offline with the update message after they have updated
  Lecturn on that computer and restarted it.
- Relay request errors rise while sweeps run. Deletions share the Postgres connection pool with
  request handlers.

Turning the legacy mode off stops new legacy deletions; `RELAY_TUNNEL_CLEANUP_MODE` keeps deleting
tunnels of hosts with recovery while it is `enabled`. Deleted tunnels stay deleted; their hosts
recover as described above.

### Disposable-host canary

This test has not been run against a real Cloudflare account. Run it against a disposable relay
stage, test Cloudflare account, disposable host, and disposable Lecturn home. Keep production cleanup at
`off` or `dry-run` until it passes. Do not stop a daily-use Lecturn server.

1. Deploy the disposable stage with cleanup `dry-run`. Link a first disposable environment through
   web or mobile settings and confirm its tunnel is healthy and recovery is registered.
2. Stop that host and restart the same Lecturn home on a different local port. Confirm the public
   hostname reaches the new port and sends nothing to the old one.
3. Link a second disposable environment with a server build that predates recovery registration.
   Capture its managed `cloudflared` child PID, confirm it belongs to that host, and pause only that
   child with `kill -STOP <legacy-pid>`. Wait until Cloudflare reports it down for over five minutes.
4. Capture the first environment's `cloudflared` child PID from its server logs, confirm ownership,
   and pause it with `kill -STOP <first-pid>`. Wait until Cloudflare reports it down for over five
   minutes.
5. Confirm dry-run counts the first tunnel in `wouldDelete` and the second in `skippedLegacy`.
6. Set cleanup `enabled` on the disposable stage and deploy. Confirm in the test Cloudflare account
   that the first tunnel is deleted and the legacy tunnel still exists.
7. Resume the first child with `kill -CONT <first-pid>`. Confirm the running server detects the
   repeated rejection, requests recovery, and becomes reachable at the same hostname without a
   restart.
8. Resume the legacy child with `kill -CONT <legacy-pid>` and confirm its tunnel reconnects.
9. Repeat with a physical sleep and wake cycle on a disposable laptop before broad rollout.

Legacy cleanup, on the same disposable stage:

10. Set `RELAY_LEGACY_TUNNEL_GRACE_MINUTES=10` and the legacy mode to `dry-run`, then deploy. The
    override shortens the 7-day grace period and is ignored on `prod`. Pause the legacy child again
    and wait until Cloudflare reports it down for over ten minutes.
11. Confirm the sweep counts it in `wouldDeleteLegacy`, then set the legacy mode to `enabled` and
    deploy. Confirm the legacy tunnel is deleted and its allocation row remains.
12. With the legacy host still on its old build, resume the child. A CLI-linked host provisions a
    new tunnel on its next restart; a web- or mobile-linked host stays offline.
13. Update that host to the current build and start it. Confirm it requests recovery and is
    reachable at the same hostname.
14. Remove `RELAY_LEGACY_TUNNEL_GRACE_MINUTES` from the disposable stage.

## Hosted web deployment

Hosted web deployment is independent of `.github/workflows/release.yml`. The release workflow
publishes desktop artifacts and the CLI package; it does not deploy Vercel, the relay, or mobile.
When deploying a hosted client, verify that its exact `lecturn@<version>` is available on npm first.
See [Lecturn release configuration](./lecturn-release.md#release-configuration) for the fork's
release boundaries.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - scheduled check once daily at 10:38 UTC
  - manual `workflow_dispatch` with `channel=nightly`
- Automatic nightlies require new commits and at least six hours since the last nightly was published, including manual nightlies.
- Manual nightlies bypass the time and change checks. Nightly runs remain serialized. Scheduled runs wait for an active nightly to finish, then check the publication gap before building.
- Runs the same desktop quality gates and artifact matrix as the tagged release flow.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...` is accepted only as a legacy previous-nightly tag
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the CLI package (`apps/server`, npm package `lecturn`) to the `nightly` npm dist-tag using the same nightly version.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Every released
desktop or hosted client version must therefore have a matching `lecturn@<version>` package available on
npm before users can receive that client.

The workflow enforces this ordering:

1. `publish_cli` publishes the exact stable or nightly version to npm.
2. `release` depends on `publish_cli` before exposing desktop artifacts in GitHub Releases.

Hosted web deployment must separately verify npm availability before exposing a new client version.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view lecturn@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. When the release adds database migrations, verify that the
remote update applies them and reconnects. A failed trial must restore the database snapshot and
restart the previous server. If the installed launcher does not support the target protocol,
verify that the update stops before restart and run `npx lecturn@<version> service update` once on the
server machine. Also test the manual or desktop-managed guidance when those environments are
available.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `LECTURN_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, `.deb`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship
`resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar: the Linux CLI archive
(`lecturn-<version>-linux-x64.tar.gz`) built by `build_linux_cli` and handed to
the Windows desktop build as `--wsl-runtime`, copied in verbatim so WSL runs the
exact bytes a Linux user downloads. WSL verifies and extracts that archive into
`~/.lecturn/wsl-runtime/sha256-<archive-digest>` inside the selected distro,
then reuses it for later launches of the same update.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build given `--wsl-runtime` omits the WSL archive or SHA-256
  sidecar, or the sidecar digest does not match the emitted archive.
- The emitted WSL archive is not a Linux CLI release archive: it must unpack to
  a single `lecturn-<version>-linux-<arch>` directory holding `lecturn`,
  `client/`, `node_modules/` with the Linux node-pty binary, and (for a
  Stave-equipped build) an executable `stave/linux-<arch>/stave`, and must not
  carry a loose server bundle (`bin.mjs`).
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow invokes `node apps/server/scripts/cli.ts publish` after aligning package versions. That
script temporarily prepares the `lecturn` package, then runs `vp pm publish --filter lecturn ...` from the
repository root so workspace publish configuration is applied correctly.

Checklist:

1. Confirm npm org/user owns package `lecturn` (or rename package first if needed).
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - align the release package versions to `X.Y.Z`
   - build web + server
   - invoke the CLI publish script with npm dist-tag `latest`
5. Nightly runs invoke the same publish script with npm dist-tag `nightly`.

## 1) Release validation and unsigned builds

There is no dry-run tag path. Pushing any accepted non-nightly tag, including
`v0.0.0-test.1`, classifies the run as the stable channel. It publishes `lecturn` with npm dist-tag
`latest`, creates a real GitHub Release, and can open a version bump pull request in the finalize job.
Do not push a test tag to validate the workflow.

The workflow has no non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. To exercise the complete release graph at lower stable
risk, manually dispatch `channel=nightly`; this still publishes a real nightly npm package, GitHub
prerelease, and desktop updater release. It does not open a version bump pull request. Only run it
when a real nightly release is acceptable.

Manual `channel=stable` is also a real stable-channel release. Omitting signing secrets only makes
platform artifacts unsigned; it does not prevent publication.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE` (base64-encoded provisioning profile with Associated Domains)

Required repository variables:

- `APPLE_TEAM_ID`

Optional repository variables:

- `CLERK_PASSKEY_RP_DOMAINS`: comma-separated RP-domain override. By default, the build derives the
  domain from the production Clerk publishable key.

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create an explicit App ID for `com.cloudgatherer.lecturn` and enable Associated Domains.
3. Create a `Developer ID Application` certificate and a compatible provisioning profile for that
   App ID with Associated Domains enabled.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. Base64-encode the provisioning profile and store it as `MACOS_PROVISIONING_PROFILE`.
7. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
8. In App Store Connect, create an API key (Team key).
9. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
10. Complete the Clerk Native API and AASA setup in [Lecturn Connect setup](./connect-setup.md#desktop-passkeys).
11. Re-run a tag release and confirm macOS artifacts are signed/notarized and contain the expected
    `com.apple.developer.associated-domains` entitlement.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- The workflow decodes `MACOS_PROVISIONING_PROFILE`, validates it with `security cms`, and passes it
  to the desktop packager.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Pick the latest nightly and verify it: run the smoke test above against its artifacts and
   check the nightly channel for regressions.
2. Dispatch the Release workflow with `channel=stable`. Leave `version` empty unless the version
   should differ from the one the nightly previewed.
3. Confirm the `Resolve release commit` notice names the nightly tag and commit you verified. If a
   newer nightly published in between, the run builds that one instead. The `version` input only
   changes the version; it does not select the source commit. Stable rebuilds the selected source
   with current signing/configuration and the resolved Stave tag; pin `stave_version` when needed.
4. Verify workflow steps:
   - preflight passes
   - release quality checks pass
   - `build_linux_cli` and all matrix builds pass
   - `publish_cli` publishes the exact release version before the release job
   - release job uploads expected files
5. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets plus `APPLE_TEAM_ID` are populated and non-empty.
  - Confirm the provisioning profile belongs to `APPLE_TEAM_ID.com.cloudgatherer.lecturn` and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
