# Lecturn artwork

`lecturn/mark.svg` is the canonical illuminated-book and lectern emblem. The midnight navy, parchment and brass palette follows the Stave reference artwork. Production, development and nightly icons use separate background tones.

Run `vp run icons:export` to rasterize all platform icons and refresh Icon Composer projects, favicons, Android assets and the marketing icon. Run `vp run icons:check` to verify byte-for-byte reproducibility. `scripts/export-lecturn-icons.ts` renders the source vector with pinned Sharp; it never edits an existing raster image. Keep generated files in sync rather than changing them directly.

The macOS icon renders the canonical vector directly onto a transparent 1024-pixel canvas with an 824-pixel rounded body inset by 100 pixels. iOS uses the matching Icon Composer project or full-bleed PNG. Android foreground and notification marks are transparent. Historical filenames remain stable so existing build integrations consume the new artwork.
