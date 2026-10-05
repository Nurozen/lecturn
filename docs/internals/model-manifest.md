# Model manifest

The [bundled manifest](../../apps/server/src/provider/model-manifest.json) allows
offline startup; fetching it from `main` lets model metadata change between
releases. Failed fetches or invalid data preserve the last usable manifest.
Remote data must pass both catalog-reference validation and the owning provider's
adapter validation before replacing the cache.

A newer bundle outranks the cached remote manifest by `updatedAt`, so a release can
correct model data before the next successful fetch. Bump `updatedAt` whenever the
file changes. Fetch time cannot establish which copy contains the newer edit.

Generic catalog data describes presentation and capabilities. Each provider owns
its adapter schema and dispatch mappings.

Claude Code discovers models through the Agent SDK initialization response, using the configured
CLI and account without submitting a prompt. Runtime model IDs, aliases, and reported capabilities
take precedence over matching manifest metadata. New runtime models appear without a catalog patch.
The manifest supplements capabilities the runtime does not report and preserves older model IDs;
it also supplies a fallback when model discovery is unavailable or an older CLI omits the list.

Discovery is cached per provider instance and installed CLI version. Explicit model refresh clears
the probe cache. A failed or empty probe preserves that instance's last successful model list for
the same CLI version; changing versions discards it. Snapshots, chat dispatch, and text generation
use the same merged catalog, while custom model identifiers remain opaque.

For supplemental Claude metadata, add an object to `providers.claudeAgent.models` using an existing
profile where possible. Add or change a profile only when the required capability combination does
not already exist.

`currentModels.claudeAgent` is frozen for releases that predate catalog discovery.
Do not extend it when adding Claude models. All `currentModels` lists are compatibility
metadata for older clients; new clients do not interpret absence from a list as legacy.

Runtime-discovered models remain visible by default. Only a matching entry in
`providers.<driver>.models` with `status: "legacy"` moves a model into Legacy. A `current`
entry or an unknown model clears stale legacy flags; custom models remain untouched.
Claude, Codex, and Antigravity discover availability from their runtimes, so new models do not need
a manifest update to appear. Older clients retain their previous classification behavior
until updated.

Model data is schema-validated configuration. Tests should cover resolver, cache,
and adapter semantics with synthetic model names, so adding a model never requires
tests that repeat the configuration.
