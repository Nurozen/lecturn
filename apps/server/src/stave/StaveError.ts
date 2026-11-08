/**
 * `code` is Stave's `--json` failure-envelope code (stdout, exit 1) or a host code Lecturn raises
 * around the spawn. Unknown codes from a newer Stave decode as `"unknown"` so a host never fails on
 * a code it has not learned. Source: references/stave/internal/space/errcode.go, errcode_repos.go.
 */
import {
  STAVE_CLI_ERROR_CODES,
  STAVE_HOST_ERROR_CODES,
  STAVE_OPERATION_ERROR_CODES,
} from "@lecturn/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The code lists live in contracts (`STAVE_OPERATION_ERROR_CODES`) because the
// same values travel in `StaveOperationError`; the server only re-exports them.
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

export class StaveError extends Schema.TaggedError<StaveError>()("StaveError", {
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
