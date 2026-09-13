# Lecturn Claude emblem

A crescent moon with fourteen uneven radial strokes, drawn for Lecturn under the repository MIT license. It identifies Claude within Lecturn; it is not official Anthropic artwork or an endorsement. The artwork uses orange `#D97757` on every theme.

Canonical paths live in `packages/shared/src/providerEmblems.ts`. Regenerate the standalone SVG, marketing asset, and web file-icon sprite with `node scripts/export-provider-emblems.ts`. Other providers retain their existing icons.

Account initials remain separate functional UI for distinguishing configured accounts. Mobile account-badge behavior is adapted from upstream `pingdotgg/t3code` commit `2c8e95a4b`; the existing web badge background already includes `a9cd94eb9`.
