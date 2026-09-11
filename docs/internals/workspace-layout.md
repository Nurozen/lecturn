# Workspace layout

> For maintainers. Using Lecturn? See [docs/user](../user/).

A pnpm workspace driven by [vite-plus](https://vite.plus) (`vp`). See [scripts.md](./scripts.md) for
the task commands.

## apps

- `apps/server` (`lecturn`): the execution runtime and the published CLI. Owns orchestration, provider
  drivers, checkpointing, VCS, terminals, filesystem access, auth, and the HTTP + WebSocket surface.
  Also serves the built web app.
- `apps/web` (`@lecturn/web`): React + Vite UI. Consumes the shared client runtime and adds routing,
  components, and web-specific platform layers.
- `apps/desktop` (`@lecturn/desktop`): Electron shell. Supervises a desktop-scoped `lecturn` backend,
  loads the web bundle over the `lecturn://` protocol, and owns SSH-managed remote environments.
- `apps/mobile` (`@lecturn/mobile`): Expo/React Native client. Same client runtime composition as
  web, different platform layer and UI.
- `apps/marketing` (`@lecturn/marketing`): Astro marketing site.

### Desktop data directories

An explicit `LECTURN_HOME` selects both the backend state directory
(`<home>/userdata`) and the Electron profile (`<home>/userdata/electron`). The profile contains
renderer storage, including IndexedDB, and is selected before Clerk and renderer startup. Use
distinct homes when running an installed build alongside another Lecturn build. Without an
override, Electron retains its existing platform application-data profile, including legacy
profile detection. A blank override is treated as unset.

The Clerk SDK acquires Electron's profile-scoped single-instance lock on Windows and Linux;
it does not acquire that lock on macOS. Separate application bundles on macOS must therefore
use distinct homes to avoid opening the same renderer database concurrently.

## packages

- `packages/contracts` (`@lecturn/contracts`): shared Effect Schema definitions. RPC group,
  orchestration commands/events/read model, auth scopes, environment descriptors, settings.
- `packages/shared` (`@lecturn/shared`): framework-agnostic utilities used by server and clients
  (`DrainableWorker`, git and source-control helpers, relay auth and signing, DPoP, semver, logging,
  observability, and more).
- `packages/client-runtime` (`@lecturn/client-runtime`): connection lifecycle, authorization, RPC
  session, environment registry, and Atom-based domain state shared by web and mobile. See its
  [README](../../packages/client-runtime/README.md).
- `packages/ssh` (`@lecturn/ssh`): SSH config parsing, auth prompts, command execution, and the
  tunnel/environment manager behind desktop-managed SSH environments.
- `packages/tailscale` (`@lecturn/tailscale`): Tailscale CLI wrapper, including the
  `ensureTailscaleServe` / `disableTailscaleServe` serve lifecycle the server drives.
- `packages/effect-acp` (`effect-acp`): Effect client and agent implementation of the Agent Client
  Protocol, used by ACP-speaking provider drivers.
- `packages/effect-codex-app-server` (`effect-codex-app-server`): Effect client for the
  `codex app-server` JSON-RPC protocol.

## infra

- `infra/relay` (`lecturn-relay`): the hosted Lecturn Connect relay, deployed with Alchemy. Handles
  environment discovery, cloud-side records, and mobile notifications. It is not in the hot path;
  after connect, client traffic goes directly to the environment. See
  [lecturn-connect.md](./lecturn-connect.md).

## Other top-level directories

- `scripts/`: workspace tooling run through `vp run`. Dev runner, desktop artifact builds, release
  helpers, mobile static checks and showcase capture, update-manifest merging.
- `assets/`: brand and app icon sources per channel (`dev`, `nightly`, `prod`).
- `patches/`: pnpm patches for pinned upstream dependencies.
- `oxlint-plugin-lecturn/`: repo-specific lint rules.
- `experiments/`: throwaway prototypes. Not part of the shipped build.
- `docs/`: this documentation tree.

## Import conventions

`@lecturn/shared` and `@lecturn/client-runtime` use explicit subpath exports with no barrel index and
no root export. Import the narrow path (`@lecturn/shared/DrainableWorker`,
`@lecturn/client-runtime/state/threads`) rather than the package root. Files that are not exported
are implementation details. `@lecturn/contracts` does export a root alongside `./settings` and
`./relay`.
