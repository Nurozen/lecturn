/**
 * StaveError - the one error every `stave` invocation fails with.
 *
 * `code` is the stable machine-readable code Stave emits in its `--json`
 * failure envelope (`{"error": {code, message, details?}}` on stdout, exit 1)
 * plus the codes Lecturn synthesises around the spawn itself (missing binary,
 * timeout, prose output, ...). Unknown codes from a newer Stave decode as
 * `"unknown"` so a host build never fails on a code it has not learned yet.
 *
 * Source of truth for the Stave codes: references/stave/internal/space/errcode.go
 * and errcode_repos.go; README "Machine-readable output".
 *
 * @module StaveError
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Codes Stave itself emits (errcode.go + errcode_repos.go, v0.4). */
export const STAVE_CLI_ERROR_CODES = [
  "dirty_worktrees",
  "dependent_spaces",
  "memory_in_use",
  "space_exists",
  "space_not_found",
  "repo_not_found",
  "repo_not_in_space",
  "repo_already_in_space",
  "repo_mode_ambiguous",
  "saga_space",
  "saga_member",
  "invalid_name",
  "branch_missing",
  "ambiguous_archive",
  "archive_not_found",
  "invalid_arguments",
  "unknown",
  "repo_exists",
  "clone_failed",
  "cache_exists",
  "config_exists",
] as const;

/** Codes Lecturn synthesises without a Stave envelope behind them. */
export const STAVE_HOST_ERROR_CODES = [
  /** No usable `stave` binary (resolution failed or spawn hit ENOENT). */
  "binary_missing",
  /** Stave is installed but `stave setup` has not been run for this config. */
  "not_setup",
  /** The Stave integration is switched off in server settings. */
  "disabled",
  /** Stave exited without a JSON payload or envelope on stdout. */
  "non_json_output",
  /** The process could not be started or its pipes could not be read. */
  "spawn_failed",
  /** The verb's timeout elapsed (reads 60s, mutations 15m). */
  "timeout",
  /** A project root sits inside another Stave space. */
  "nested_project",
  /** The operation targets a space that is archived. */
  "archived_project",
  /** A saga member's manifest stamp differs from the roster's record. */
  "incarnation_mismatch",
  /** Saga membership could not be determined. */
  "membership_unknown",
  /** Stave answered with JSON that does not fit the verb's contract. */
  "unreadable",
  /** A pending operation handle is no longer valid. */
  "operation_expired",
] as const;

export const STAVE_ERROR_CODES = [...STAVE_CLI_ERROR_CODES, ...STAVE_HOST_ERROR_CODES] as const;

export const StaveErrorCode = Schema.Literals(STAVE_ERROR_CODES);
export type StaveErrorCode = typeof StaveErrorCode.Type;

const KNOWN_CODES: ReadonlySet<string> = new Set(STAVE_ERROR_CODES);

export function isStaveErrorCode(value: string): value is StaveErrorCode {
  return KNOWN_CODES.has(value);
}

/** Forward-compatible: any code this build does not know reads as `unknown`. */
export function normalizeStaveErrorCode(raw: string): StaveErrorCode {
  return isStaveErrorCode(raw) ? raw : "unknown";
}

export const StaveErrorDetails = Schema.Record(Schema.String, Schema.Unknown);
export type StaveErrorDetails = typeof StaveErrorDetails.Type;

export class StaveError extends Schema.TaggedErrorClass<StaveError>()("StaveError", {
  code: StaveErrorCode,
  message: Schema.String,
  /** Stave's structured `details` (repo lists, candidates, saga teardown progress) or null. */
  details: Schema.NullOr(StaveErrorDetails),
  /** Process exit status; null when the process never ran to completion. */
  exitCode: Schema.NullOr(Schema.Number),
  /** Last part of stderr, for diagnostics when no envelope was available. */
  stderrTail: Schema.NullOr(Schema.String),
  /** The verb that failed, e.g. `space create`. */
  verb: Schema.String,
}) {}

/** Stave's `--json` failure shape, exactly as jsonrun.go writes it. */
const StaveErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    details: Schema.optionalKey(Schema.NullOr(StaveErrorDetails)),
  }),
});

const decodeEnvelope = Schema.decodeUnknownOption(StaveErrorEnvelope);

export interface StaveErrorEnvelope {
  readonly code: StaveErrorCode;
  /** The raw code as Stave wrote it, kept for logs when it normalised to `unknown`. */
  readonly rawCode: string;
  readonly message: string;
  readonly details: StaveErrorDetails | null;
}

/**
 * Reads the `{"error": {code, message, details?}}` envelope off a verb's
 * stdout. Returns none when stdout is not exactly one such object, so prose
 * or a success payload is never mistaken for a failure.
 */
export function parseStaveErrorEnvelope(stdout: string): Option.Option<StaveErrorEnvelope> {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) {
    return Option.none();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return Option.none();
  }
  return Option.map(decodeEnvelope(parsed), ({ error }) => ({
    code: normalizeStaveErrorCode(error.code),
    rawCode: error.code,
    message: error.message,
    details: error.details ?? null,
  }));
}
