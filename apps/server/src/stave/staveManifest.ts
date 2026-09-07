/**
 * On-disk shape of a Stave space manifest (`<space root>/.stave.yaml`).
 *
 * Decoding is deliberately permissive so every space Stave itself can load
 * lights up here too: `version` 0/absent through the current ceiling, unknown
 * keys (present and future) ignored, and scalar fields tolerated when YAML
 * hands them back as numbers or dates. Source of truth:
 * references/stave/internal/space/manifest.go.
 *
 * @module staveManifest
 */
import * as Schema from "effect/Schema";

/** Manifest file name relative to the space root. Never searched for upward. */
export const STAVE_MANIFEST_FILE_NAME = ".stave.yaml";

/** Manifest `kind` Stave writes for spaces that coordinate member spaces. */
export const STAVE_MANIFEST_KIND_SAGA = "saga";

// YAML scalars: Stave writes strings, but a hand-edited or future manifest may
// hold numbers/booleans/dates where a string is expected. Accept them and let
// the reader stringify.
const ManifestScalar = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.instanceOf(Date),
]);
export type ManifestScalar = typeof ManifestScalar.Type;

const OptionalScalar = Schema.optionalKey(Schema.NullOr(ManifestScalar));

export const StaveManifestRepo = Schema.Struct({
  name: OptionalScalar,
  mode: OptionalScalar,
  path: OptionalScalar,
  base: OptionalScalar,
  ref: OptionalScalar,
  branch: OptionalScalar,
  bareRepoPath: OptionalScalar,
});
export type StaveManifestRepo = typeof StaveManifestRepo.Type;

export const StaveManifestMemory = Schema.Struct({
  name: OptionalScalar,
  provider: OptionalScalar,
  id: OptionalScalar,
  owned: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.Boolean, Schema.String]))),
});
export type StaveManifestMemory = typeof StaveManifestMemory.Type;

// The saga block's members are not projected yet (Phase 5); only its presence
// matters, so the payload stays unknown.
export const StaveManifest = Schema.Struct({
  version: OptionalScalar,
  id: OptionalScalar,
  kind: OptionalScalar,
  createdAt: OptionalScalar,
  repos: Schema.optionalKey(Schema.NullOr(Schema.Array(StaveManifestRepo))),
  memories: Schema.optionalKey(Schema.NullOr(Schema.Array(StaveManifestMemory))),
  saga: Schema.optionalKey(Schema.Unknown),
});
export type StaveManifest = typeof StaveManifest.Type;

export const decodeStaveManifest = Schema.decodeUnknownEffect(StaveManifest);
