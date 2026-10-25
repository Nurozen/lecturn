import * as Schema from "effect/Schema";

/**
 * `apps/server/scripts/cli.ts pack --out-dir` writes this file beside the
 * tarballs. An embedding host installs from it instead of copying settings out
 * of Lecturn's pnpm-workspace.yaml, and scripts/smoke-pack-install.ts installs
 * from it the same way, so the smoke proves the kit rather than the workspace.
 */
export const LECTURN_PACK_DESCRIPTOR_FILE = "lecturn-pack.json";

const PackedPackage = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  tarball: Schema.String,
});

export const LecturnPackDescriptor = Schema.Struct({
  version: Schema.Literal(1),
  packages: Schema.Struct({
    lecturn: Schema.Struct({
      ...PackedPackage.fields,
      bin: Schema.Record(Schema.String, Schema.String),
    }),
    embed: PackedPackage,
  }),
  pnpm: Schema.Struct({
    nodeLinker: Schema.Literal("hoisted"),
    publicHoistPattern: Schema.Array(Schema.String),
    allowBuilds: Schema.Record(Schema.String, Schema.Boolean),
    // Values are paths relative to the descriptor, inside its patches/ directory.
    patchedDependencies: Schema.Record(Schema.String, Schema.String),
  }),
  notes: Schema.Array(Schema.String),
  build: Schema.Struct({
    repoEnvFile: Schema.Boolean,
    lecturnConnect: Schema.Boolean,
    telemetry: Schema.Boolean,
    icons: Schema.Literals(["development", "nightly", "production"]),
  }),
});
export type LecturnPackDescriptor = typeof LecturnPackDescriptor.Type;
