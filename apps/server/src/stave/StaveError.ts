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
import {
  STAVE_CLI_ERROR_CODES,
  STAVE_HOST_ERROR_CODES,
  STAVE_OPERATION_ERROR_CODES,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The code lists live in contracts (`STAVE_OPERATION_ERROR_CODES`) because the
// same values travel in `StaveOperationError`; the server only re-exports them.
// Host codes, raised here without a Stave envelope behind them:
//   binary_missing       no usable `stave` binary (resolution failed or ENOENT)
//   not_setup            Stave is installed but `stave setup` has not run
//   disabled             the integration is switched off in server settings
//   non_json_output      Stave exited without a JSON payload or envelope
//   spawn_failed         the process could not be started or read
//   timeout              the verb's timeout elapsed (reads 60s, mutations 15m)
//   nested_project       a project root sits inside another Stave space
//   archived_project     the operation targets an archived space
//   incarnation_mismatch the manifest stamp differs from the expected one
//   membership_unknown   saga membership could not be determined
//   unreadable           JSON that does not fit the verb's contract
//   operation_expired    a pending operation handle is no longer valid
export { STAVE_CLI_ERROR_CODES, STAVE_HOST_ERROR_CODES };
export const STAVE_ERROR_CODES = STAVE_OPERATION_ERROR_CODES;

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
