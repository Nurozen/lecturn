/**
 * Server-local decoders for every `stave --json` payload `StaveCli` consumes.
 *
 * The shapes mirror the Go structs in references/stave/internal/cli
 * (jsonrun.go, jsonrun_verbs.go, memory_json.go, space_list.go, saga.go,
 * config_cmd.go, root.go) and internal/space (manifest.go, saga_status.go,
 * saga_teardown.go, saga_sync_report.go). Decoding is forward-compatible:
 * unknown keys are ignored, closed string sets decode unknown members as
 * `"unknown"`, and Go slices that may be nil or `omitempty` read as `[]`.
 *
 * Only `saga status` is snake_case (Stave's frozen contract); it is renamed
 * to camelCase here so every read model looks alike to the rest of Lecturn.
 *
 * @module staveJson
 */
import { parseStaveVersionOutput, type StaveVersionInfo } from "@lecturn/shared/stave";
import { formatSchemaError } from "@lecturn/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

// ── Building blocks ────────────────────────────────────────────

/** A closed string set that reads any member this build does not know as `fallback`. */
const ForwardCompatibleLiteral = <
  const Literals extends ReadonlyArray<string>,
  const Fallback extends string,
>(
  literals: Literals,
  fallback: Fallback,
) => {
  const known: ReadonlySet<string> = new Set(literals);
  const target = Schema.Union([Schema.Literals(literals), Schema.Literal(fallback)]);
  type Target = Literals[number] | Fallback;
  return Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transform<Target, string>({
        decode: (raw) => (known.has(raw) ? (raw as Literals[number]) : fallback),
        encode: (value) => value,
      }),
    ),
  );
};

/** Go `[]T`: a nil slice encodes as `null` and `omitempty` drops it; both read as `[]`. */
const ArrayOrEmpty = <Item extends Schema.Top>(item: Item) => {
  const target = Schema.Array(item);
  type Target = (typeof target)["Encoded"];
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transform<Target, unknown>({
        decode: (raw) => (raw === null || raw === undefined ? ([] as Target) : (raw as Target)),
        encode: (value) => value,
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(null)),
  );
};

/** Go `map[string]T`: nil encodes as `null`; reads as `{}`. */
const RecordOrEmpty = <Value extends Schema.Top>(value: Value) => {
  const target = Schema.Record(Schema.String, value);
  type Target = (typeof target)["Encoded"];
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transform<Target, unknown>({
        decode: (raw) => (raw === null || raw === undefined ? ({} as Target) : (raw as Target)),
        encode: (record) => record,
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(null)),
  );
};

const OptionalString = Schema.optionalKey(Schema.String);
const OptionalNumber = Schema.optionalKey(Schema.Number);
const OptionalBoolean = Schema.optionalKey(Schema.Boolean);
/** Go `bool` with `omitempty`: absent means false. */
const BooleanDefaultFalse = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)));
/** Go `int` with `omitempty`: absent means 0. */
const NumberDefaultZero = Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0)));
/** Go `*string` written without `omitempty`: null when unset. */
const NullableString = Schema.NullOr(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);

const Notes = ArrayOrEmpty(Schema.String);

export const StaveRepoModeJson = ForwardCompatibleLiteral(["edit", "reference"], "unknown");
export type StaveRepoModeJson = typeof StaveRepoModeJson.Type;

export const StaveMemoryFateJson = ForwardCompatibleLiteral(
  ["keep", "contribute", "destroy"],
  "unknown",
);
export type StaveMemoryFateJson = typeof StaveMemoryFateJson.Type;

export const StaveSagaMemberStateJson = ForwardCompatibleLiteral(
  ["live", "archived", "missing", "corrupt"],
  "unknown",
);
export type StaveSagaMemberStateJson = typeof StaveSagaMemberStateJson.Type;

// ── Manifest (space.Manifest, keys as in .stave.yaml) ─────────

export const StaveManifestRepoJson = Schema.Struct({
  name: Schema.String,
  mode: StaveRepoModeJson,
  path: Schema.String,
  base: OptionalString,
  ref: OptionalString,
  branch: OptionalString,
  bareRepoPath: Schema.String,
});
export type StaveManifestRepoJson = typeof StaveManifestRepoJson.Type;

export const StaveManifestMemoryJson = Schema.Struct({
  name: Schema.String,
  provider: Schema.String,
  id: Schema.String,
  owned: Schema.Boolean,
});
export type StaveManifestMemoryJson = typeof StaveManifestMemoryJson.Type;

export const StaveSagaPrJson = Schema.Struct({
  repo: Schema.String,
  number: Schema.Number,
});
export type StaveSagaPrJson = typeof StaveSagaPrJson.Type;

export const StaveSagaMemberJson = Schema.Struct({
  id: Schema.String,
  after: ArrayOrEmpty(Schema.String),
  /** RFC3339Nano stamp of the member manifest when it was enrolled; absent when zero. */
  createdAt: OptionalString,
  prs: ArrayOrEmpty(StaveSagaPrJson),
});
export type StaveSagaMemberJson = typeof StaveSagaMemberJson.Type;

export const StaveSagaManifestJson = Schema.Struct({
  members: ArrayOrEmpty(StaveSagaMemberJson),
});
export type StaveSagaManifestJson = typeof StaveSagaManifestJson.Type;

export const StaveManifestJson = Schema.Struct({
  /** Schema marker; absent on pre-version manifests. */
  version: OptionalNumber,
  id: Schema.String,
  kind: OptionalString,
  /** RFC3339Nano (UTC). */
  createdAt: Schema.String,
  specPath: OptionalString,
  repos: ArrayOrEmpty(StaveManifestRepoJson),
  memories: ArrayOrEmpty(StaveManifestMemoryJson),
  /** Only saga spaces carry a roster. */
  saga: Schema.optionalKey(Schema.NullOr(StaveSagaManifestJson)),
});
export type StaveManifestJson = typeof StaveManifestJson.Type;

// ── Mutation results (jsonrun.go, jsonrun_verbs.go) ───────────

export const StaveDryRunPlan = Schema.Struct({
  dryRun: Schema.Literal(true),
  plan: ArrayOrEmpty(Schema.String),
});
export type StaveDryRunPlan = typeof StaveDryRunPlan.Type;

export function isStaveDryRunPlan(value: unknown): value is StaveDryRunPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    "dryRun" in value &&
    (value as { dryRun: unknown }).dryRun === true
  );
}

/** A mutating verb's `--dry-run --json` answer or its real result. */
const WithDryRun = <Payload extends Schema.Top>(payload: Payload) =>
  Schema.Union([StaveDryRunPlan, payload]);

/** `space init|create|add|remove|restore|retarget`. */
export const StaveSpaceMutationResult = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifestJson,
  notes: Notes,
});
export type StaveSpaceMutationResult = typeof StaveSpaceMutationResult.Type;

export const StaveSpaceArchiveResult = Schema.Struct({
  spaceId: Schema.String,
  archivedPath: Schema.String,
  memory: StaveMemoryFateJson,
  notes: Notes,
});
export type StaveSpaceArchiveResult = typeof StaveSpaceArchiveResult.Type;

export const StaveSpaceDestroyResult = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  destroyed: Schema.Boolean,
  memory: StaveMemoryFateJson,
  notes: Notes,
});
export type StaveSpaceDestroyResult = typeof StaveSpaceDestroyResult.Type;

export const StaveSyncActionJson = ForwardCompatibleLiteral(
  ["fetched", "updated", "skipped", "drift-reported"],
  "unknown",
);
export type StaveSyncActionJson = typeof StaveSyncActionJson.Type;

/** One per-repo row of `space sync` / `saga sync` (space.SyncRepoResult). */
export const StaveSyncRepoRow = Schema.Struct({
  name: Schema.String,
  mode: StaveRepoModeJson,
  action: StaveSyncActionJson,
  ahead: Schema.Number,
  behind: Schema.Number,
  note: OptionalString,
});
export type StaveSyncRepoRow = typeof StaveSyncRepoRow.Type;

export const StaveSpaceSyncResult = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifestJson,
  repos: ArrayOrEmpty(StaveSyncRepoRow),
  notes: Notes,
});
export type StaveSpaceSyncResult = typeof StaveSpaceSyncResult.Type;

export const StaveReposAddResult = Schema.Struct({
  name: Schema.String,
  /** Redacted by Stave when it looks like a secret; never feed back into argv. */
  url: Schema.String,
  bareRepoPath: Schema.String,
  defaultBranch: OptionalString,
  adopted: Schema.Boolean,
  notes: Notes,
});
export type StaveReposAddResult = typeof StaveReposAddResult.Type;

export const StaveSetupResult = Schema.Struct({
  configPath: Schema.String,
  root: Schema.String,
  bareReposDir: Schema.String,
  agentWorkDir: Schema.String,
  created: ArrayOrEmpty(Schema.String),
  existed: ArrayOrEmpty(Schema.String),
});
export type StaveSetupResult = typeof StaveSetupResult.Type;

// ── Reads ─────────────────────────────────────────────────────

export const StaveConfigRepoJson = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  bareRepoPath: Schema.String,
  defaultBranch: OptionalString,
  description: OptionalString,
  marmotVault: OptionalString,
});
export type StaveConfigRepoJson = typeof StaveConfigRepoJson.Type;

/** `config show --json`: the resolved config exactly as every verb loads it. */
export const StaveConfigShow = Schema.Struct({
  configPath: Schema.String,
  exists: Schema.Boolean,
  root: Schema.String,
  bareReposDir: Schema.String,
  agentWorkDir: Schema.String,
  defaultBase: Schema.String,
  repos: RecordOrEmpty(StaveConfigRepoJson),
  memory: Schema.Struct({
    provider: OptionalString,
    binary: OptionalString,
    default: Schema.Boolean,
  }),
  tethers: Schema.Struct({
    enabled: Schema.Boolean,
    strongThreshold: Schema.Number,
  }),
  summon: Schema.Struct({
    default: Schema.String,
    commands: RecordOrEmpty(Schema.String),
  }),
});
export type StaveConfigShow = typeof StaveConfigShow.Type;

export const StaveReposListRow = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  bareRepoPath: Schema.String,
  defaultBranch: OptionalString,
  description: OptionalString,
  tetherCount: Schema.Number,
});
export type StaveReposListRow = typeof StaveReposListRow.Type;

export const StaveReposList = ArrayOrEmpty(StaveReposListRow);
export type StaveReposList = typeof StaveReposList.Type;

export const StaveSpaceRepoStatusRow = Schema.Struct({
  name: Schema.String,
  mode: StaveRepoModeJson,
  /** Absolute worktree path. */
  path: Schema.String,
  branch: OptionalString,
  base: OptionalString,
  ref: OptionalString,
  exists: Schema.Boolean,
  dirty: Schema.Boolean,
  dirtyOutput: OptionalString,
  ahead: Schema.Number,
  behind: Schema.Number,
  driftError: OptionalString,
  referenceWarn: OptionalString,
});
export type StaveSpaceRepoStatusRow = typeof StaveSpaceRepoStatusRow.Type;

export const StaveSpaceMemoryStatusRow = Schema.Struct({
  name: Schema.String,
  provider: Schema.String,
  id: Schema.String,
  owned: Schema.Boolean,
  /** Compact freshness text ("2 unpushed", "stale"); absent when the probe failed. */
  state: OptionalString,
});
export type StaveSpaceMemoryStatusRow = typeof StaveSpaceMemoryStatusRow.Type;

/** `space status <id> --json` (spaceStatusJSON in root.go). */
export const StaveSpaceStatus = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifestJson,
  repos: ArrayOrEmpty(StaveSpaceRepoStatusRow),
  memories: ArrayOrEmpty(StaveSpaceMemoryStatusRow),
});
export type StaveSpaceStatus = typeof StaveSpaceStatus.Type;

/**
 * One `space list [--archived] --json` row. `id` is the DIRECTORY name (the
 * `.archive/` basename for archived rows); hosts reconcile on
 * `(logicalId, manifestCreatedAt)`.
 */
export const StaveSpaceListRow = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  kind: OptionalString,
  /** Whole-second RFC3339; kept for compatibility. */
  createdAt: OptionalString,
  isSaga: Schema.Boolean,
  memberOf: OptionalString,
  repos: ArrayOrEmpty(Schema.Struct({ name: Schema.String, mode: StaveRepoModeJson })),
  archived: BooleanDefaultFalse,
  /** Manifest read error; such rows carry no manifest-derived fields. */
  error: OptionalString,
  logicalId: NullableString,
  archiveBasename: OptionalString,
  /** RFC3339Nano (UTC), equal to the stamp in `.stave.yaml`. */
  manifestCreatedAt: OptionalString,
  manifestVersion: NumberDefaultZero,
  memories: ArrayOrEmpty(StaveManifestMemoryJson),
});
export type StaveSpaceListRow = typeof StaveSpaceListRow.Type;

export const StaveSpaceList = ArrayOrEmpty(StaveSpaceListRow);
export type StaveSpaceList = typeof StaveSpaceList.Type;

export const StaveSagaListRow = Schema.Struct({
  id: Schema.String,
  kind: OptionalString,
  isSaga: Schema.Boolean,
  members: ArrayOrEmpty(Schema.String),
  memberOf: OptionalString,
  error: OptionalString,
  path: Schema.String,
  logicalId: NullableString,
});
export type StaveSagaListRow = typeof StaveSagaListRow.Type;

export const StaveSagaList = ArrayOrEmpty(StaveSagaListRow);
export type StaveSagaList = typeof StaveSagaList.Type;

// ── saga status (frozen snake_case contract → camelCase) ─────

export const StaveSagaBaseHealthJson = ForwardCompatibleLiteral(
  ["ok", "merged", "missing", "owner_archived"],
  "unknown",
);
export type StaveSagaBaseHealthJson = typeof StaveSagaBaseHealthJson.Type;

export const StaveSagaMergedViaJson = ForwardCompatibleLiteral(["ancestry", "pr"], "unknown");
export type StaveSagaMergedViaJson = typeof StaveSagaMergedViaJson.Type;

export const StaveSagaRepoStatus = Schema.Struct({
  name: Schema.String,
  branch: Schema.String,
  base: Schema.String,
  ahead: Schema.Number,
  behind: Schema.Number,
  baseHealth: StaveSagaBaseHealthJson,
  /** Set only when `baseHealth` is `merged`. */
  mergedVia: Schema.optionalKey(StaveSagaMergedViaJson),
  note: OptionalString,
}).pipe(Schema.encodeKeys({ baseHealth: "base_health", mergedVia: "merged_via" }));
export type StaveSagaRepoStatus = typeof StaveSagaRepoStatus.Type;

export const StaveSagaPrStatus = Schema.Struct({
  repo: Schema.String,
  number: Schema.Number,
  state: OptionalString,
  mergedAt: OptionalString,
  baseRefName: OptionalString,
}).pipe(Schema.encodeKeys({ mergedAt: "merged_at", baseRefName: "base_ref_name" }));
export type StaveSagaPrStatus = typeof StaveSagaPrStatus.Type;

export const StaveSagaMemberStatus = Schema.Struct({
  id: Schema.String,
  after: ArrayOrEmpty(Schema.String),
  state: StaveSagaMemberStateJson,
  /** Read error (corrupt), archive path (archived) or reused-id explanation (missing). */
  error: OptionalString,
  dirty: Schema.Boolean,
  repos: ArrayOrEmpty(StaveSagaRepoStatus),
  prs: ArrayOrEmpty(StaveSagaPrStatus),
});
export type StaveSagaMemberStatus = typeof StaveSagaMemberStatus.Type;

export const StaveSagaNoteKindJson = ForwardCompatibleLiteral(
  ["degraded", "suggestion"],
  "unknown",
);
export type StaveSagaNoteKindJson = typeof StaveSagaNoteKindJson.Type;

export const StaveSagaNote = Schema.Struct({
  kind: StaveSagaNoteKindJson,
  member: OptionalString,
  text: Schema.String,
});
export type StaveSagaNote = typeof StaveSagaNote.Type;

/** `saga status <id> --json` (space.SagaStatus): members in topological order. */
export const StaveSagaStatus = Schema.Struct({
  sagaId: Schema.String,
  members: ArrayOrEmpty(StaveSagaMemberStatus),
  notes: ArrayOrEmpty(StaveSagaNote),
}).pipe(Schema.encodeKeys({ sagaId: "saga_id" }));
export type StaveSagaStatus = typeof StaveSagaStatus.Type;

// ── Saga lifecycle (saga.go, jsonrun.go, saga_teardown.go) ────

/** `saga create|add|remove`. */
export const StaveSagaMutationResult = Schema.Struct({
  sagaId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifestJson,
  notes: Notes,
});
export type StaveSagaMutationResult = typeof StaveSagaMutationResult.Type;

export const StaveSagaTeardownActionJson = ForwardCompatibleLiteral(
  ["archived", "destroyed"],
  "unknown",
);
export type StaveSagaTeardownActionJson = typeof StaveSagaTeardownActionJson.Type;

export const StaveSagaMemberOutcomeJson = ForwardCompatibleLiteral(
  ["archived", "destroyed", "skipped"],
  "unknown",
);
export type StaveSagaMemberOutcomeJson = typeof StaveSagaMemberOutcomeJson.Type;

/** One member's outcome of `saga archive|destroy`, in teardown order. */
export const StaveSagaMemberTeardownRow = Schema.Struct({
  id: Schema.String,
  action: StaveSagaMemberOutcomeJson,
  note: OptionalString,
  /** The member's live root before teardown. */
  path: Schema.String,
  /** Archive destination (archive), or the existing archive of a skipped member. */
  archivedPath: OptionalString,
});
export type StaveSagaMemberTeardownRow = typeof StaveSagaMemberTeardownRow.Type;

export const StaveSagaTeardownResult = Schema.Struct({
  sagaId: Schema.String,
  action: StaveSagaTeardownActionJson,
  memory: StaveMemoryFateJson,
  members: ArrayOrEmpty(StaveSagaMemberTeardownRow),
  notes: Notes,
  /** The saga space's own live root before teardown. */
  sagaPath: Schema.String,
  /** The saga space's `.archive/` destination (archive only). */
  sagaArchivedPath: OptionalString,
});
export type StaveSagaTeardownResult = typeof StaveSagaTeardownResult.Type;

/** A completed step of a saga teardown walk (space.SagaTeardownStep). */
export const StaveSagaTeardownStep = Schema.Struct({
  id: Schema.String,
  action: StaveSagaTeardownActionJson,
  path: Schema.String,
  archivedPath: OptionalString,
});
export type StaveSagaTeardownStep = typeof StaveSagaTeardownStep.Type;

export const StaveSagaTeardownFailedAtJson = ForwardCompatibleLiteral(
  ["member", "saga", "den"],
  "unknown",
);
export type StaveSagaTeardownFailedAtJson = typeof StaveSagaTeardownFailedAtJson.Type;

/**
 * What a mid-walk `saga archive|destroy` failure got done, carried in the
 * error envelope's `details` beside the cause's own details.
 */
export const StaveSagaTeardownErrorDetails = Schema.Struct({
  completed: ArrayOrEmpty(StaveSagaTeardownStep),
  failedAt: Schema.optionalKey(StaveSagaTeardownFailedAtJson),
  failedMember: OptionalString,
});
export type StaveSagaTeardownErrorDetails = typeof StaveSagaTeardownErrorDetails.Type;

const decodeSagaTeardownErrorDetailsOption = Schema.decodeUnknownOption(
  StaveSagaTeardownErrorDetails,
);

/** Reads the teardown progress out of a `StaveError.details`; none when the failure was not mid-walk. */
export function parseStaveSagaTeardownErrorDetails(
  details: Readonly<Record<string, unknown>> | null,
): Option.Option<StaveSagaTeardownErrorDetails> {
  if (details === null || !("completed" in details)) {
    return Option.none();
  }
  return decodeSagaTeardownErrorDetailsOption(details);
}

export const StaveSagaSyncMemberRow = Schema.Struct({
  id: Schema.String,
  state: StaveSagaMemberStateJson,
  repos: ArrayOrEmpty(StaveSyncRepoRow),
  /** Why a non-live member was skipped. */
  note: OptionalString,
});
export type StaveSagaSyncMemberRow = typeof StaveSagaSyncMemberRow.Type;

export const StaveSagaSyncResult = Schema.Struct({
  sagaId: Schema.String,
  spacePath: Schema.String,
  members: ArrayOrEmpty(StaveSagaSyncMemberRow),
  /** The saga space's own reference rows. */
  repos: ArrayOrEmpty(StaveSyncRepoRow),
  notes: Notes,
});
export type StaveSagaSyncResult = typeof StaveSagaSyncResult.Type;

// ── Memory (memory_json.go) ───────────────────────────────────

export const StaveMemoryAttachmentRow = Schema.Struct({
  name: Schema.String,
  provider: Schema.String,
  id: Schema.String,
  owned: Schema.Boolean,
});
export type StaveMemoryAttachmentRow = typeof StaveMemoryAttachmentRow.Type;

export const StaveMemoryLinkedRow = Schema.Struct({
  reference: Schema.String,
  target: OptionalString,
  kind: Schema.String,
  resolvedVia: OptionalString,
});
export type StaveMemoryLinkedRow = typeof StaveMemoryLinkedRow.Type;

export const StaveMemoryAttachedRow = Schema.Struct({
  ...StaveMemoryAttachmentRow.fields,
  linked: ArrayOrEmpty(StaveMemoryLinkedRow),
});
export type StaveMemoryAttachedRow = typeof StaveMemoryAttachedRow.Type;

export const StaveMemoryAttachResult = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifestJson,
  attachments: ArrayOrEmpty(StaveMemoryAttachedRow),
  notes: Notes,
});
export type StaveMemoryAttachResult = typeof StaveMemoryAttachResult.Type;

export const StaveMemoryDetachedRow = Schema.Struct({
  ...StaveMemoryAttachmentRow.fields,
  /** The fate that applied (an unowned store is always kept). */
  fate: StaveMemoryFateJson,
});
export type StaveMemoryDetachedRow = typeof StaveMemoryDetachedRow.Type;

export const StaveMemoryDetachResult = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  manifest: StaveManifestJson,
  detached: ArrayOrEmpty(StaveMemoryDetachedRow),
  notes: Notes,
});
export type StaveMemoryDetachResult = typeof StaveMemoryDetachResult.Type;

export const StaveMemoryListRow = Schema.Struct({
  spaceId: Schema.String,
  spacePath: Schema.String,
  attachments: ArrayOrEmpty(StaveMemoryAttachmentRow),
});
export type StaveMemoryListRow = typeof StaveMemoryListRow.Type;

export const StaveMemoryList = ArrayOrEmpty(StaveMemoryListRow);
export type StaveMemoryList = typeof StaveMemoryList.Type;

export const StaveMemoryLinkStatusRow = Schema.Struct({
  alias: Schema.String,
  kind: Schema.String,
  ahead: OptionalNumber,
  behind: OptionalNumber,
  pending: OptionalNumber,
  stale: OptionalBoolean,
  reachable: OptionalBoolean,
  state: OptionalString,
});
export type StaveMemoryLinkStatusRow = typeof StaveMemoryLinkStatusRow.Type;

export const StaveMemoryAttachmentStatusRow = Schema.Struct({
  ...StaveMemoryAttachmentRow.fields,
  state: OptionalString,
  lifetime: OptionalString,
  links: ArrayOrEmpty(StaveMemoryLinkStatusRow),
  error: OptionalString,
});
export type StaveMemoryAttachmentStatusRow = typeof StaveMemoryAttachmentStatusRow.Type;

export const StaveMemoryStatus = Schema.Struct({
  spaceId: Schema.String,
  attachments: ArrayOrEmpty(StaveMemoryAttachmentStatusRow),
});
export type StaveMemoryStatus = typeof StaveMemoryStatus.Type;

export const StaveMemoryFlowOutcomeJson = ForwardCompatibleLiteral(
  ["synced", "up-to-date", "failed", "proposed"],
  "unknown",
);
export type StaveMemoryFlowOutcomeJson = typeof StaveMemoryFlowOutcomeJson.Type;

export const StaveMemoryFlowResultRow = Schema.Struct({
  alias: Schema.String,
  warren: OptionalString,
  outcome: StaveMemoryFlowOutcomeJson,
  detail: OptionalString,
  branch: OptionalString,
  commit: OptionalString,
  /** Stave never pushes; this is the operator's handoff. */
  pushCommand: OptionalString,
  contributed: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});
export type StaveMemoryFlowResultRow = typeof StaveMemoryFlowResultRow.Type;

/** `memory sync` and `memory propose` share this shape. */
export const StaveMemoryFlowResult = Schema.Struct({
  spaceId: Schema.String,
  results: ArrayOrEmpty(StaveMemoryFlowResultRow),
  notes: Notes,
});
export type StaveMemoryFlowResult = typeof StaveMemoryFlowResult.Type;

export const StaveMemoryProviderRow = Schema.Struct({
  name: Schema.String,
  binary: OptionalString,
  default: Schema.Boolean,
  available: Schema.Boolean,
  version: OptionalString,
  capabilities: ArrayOrEmpty(Schema.String),
  error: OptionalString,
});
export type StaveMemoryProviderRow = typeof StaveMemoryProviderRow.Type;

export const StaveMemoryProviders = ArrayOrEmpty(StaveMemoryProviderRow);
export type StaveMemoryProviders = typeof StaveMemoryProviders.Type;

// ── Decoders ──────────────────────────────────────────────────

export type StaveDecodeFailure =
  /** stdout was not JSON at all (prose, empty, or a legacy binary without `--json`). */
  | { readonly reason: "not_json"; readonly detail: string }
  /** stdout was JSON that does not fit the verb's contract. */
  | { readonly reason: "schema"; readonly detail: string };

export type StaveDecoder<A> = (stdout: string) => Result.Result<A, StaveDecodeFailure>;

const jsonDecoder = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
): StaveDecoder<S["Type"]> => {
  const decode = Schema.decodeUnknownExit(schema);
  return (stdout) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      return Result.fail({
        reason: "not_json",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const exit = decode(parsed);
    if (Exit.isFailure(exit)) {
      return Result.fail({ reason: "schema", detail: formatSchemaError(exit.cause) });
    }
    return Result.succeed(exit.value);
  };
};

/** `stave version` is prose (`stave v0.4.0` / `commit:` / `date:`). */
export const decodeStaveVersion: StaveDecoder<StaveVersionInfo> = (stdout) => {
  const parsed = parseStaveVersionOutput(stdout);
  return parsed === null
    ? Result.fail({ reason: "not_json", detail: "not a `stave <version>` header" })
    : Result.succeed(parsed);
};

// Reads
export const decodeStaveConfigShow = jsonDecoder(StaveConfigShow);
export const decodeStaveReposList = jsonDecoder(StaveReposList);
export const decodeStaveSpaceList = jsonDecoder(StaveSpaceList);
export const decodeStaveSpaceStatus = jsonDecoder(StaveSpaceStatus);
export const decodeStaveSagaList = jsonDecoder(StaveSagaList);
export const decodeStaveSagaStatus = jsonDecoder(StaveSagaStatus);
export const decodeStaveMemoryProviders = jsonDecoder(StaveMemoryProviders);
export const decodeStaveMemoryList = jsonDecoder(StaveMemoryList);
export const decodeStaveMemoryStatus = jsonDecoder(StaveMemoryStatus);

// Mutations (each may answer with a dry-run plan)
export const decodeStaveSetupResult = jsonDecoder(StaveSetupResult);
export const decodeStaveReposAddResult = jsonDecoder(WithDryRun(StaveReposAddResult));
export const decodeStaveSpaceMutationResult = jsonDecoder(WithDryRun(StaveSpaceMutationResult));
export const decodeStaveSpaceSyncResult = jsonDecoder(StaveSpaceSyncResult);
export const decodeStaveSpaceArchiveResult = jsonDecoder(WithDryRun(StaveSpaceArchiveResult));
export const decodeStaveSpaceDestroyResult = jsonDecoder(WithDryRun(StaveSpaceDestroyResult));
export const decodeStaveSagaMutationResult = jsonDecoder(WithDryRun(StaveSagaMutationResult));
export const decodeStaveSagaSyncResult = jsonDecoder(WithDryRun(StaveSagaSyncResult));
export const decodeStaveSagaTeardownResult = jsonDecoder(WithDryRun(StaveSagaTeardownResult));
export const decodeStaveMemoryAttachResult = jsonDecoder(WithDryRun(StaveMemoryAttachResult));
export const decodeStaveMemoryDetachResult = jsonDecoder(WithDryRun(StaveMemoryDetachResult));
export const decodeStaveMemoryFlowResult = jsonDecoder(WithDryRun(StaveMemoryFlowResult));
export const decodeStaveDryRunPlan = jsonDecoder(StaveDryRunPlan);
