import type {
  StaveOperationOutputLine,
  StaveOperationPhaseState,
  StaveOperationState,
} from "@t3tools/client-runtime/state/stave-operation";
import type { StaveOperationError, StaveRemovePartialSpaceOperation } from "@t3tools/contracts";

import { buildRemovePartialSpaceOperation, partialSpaceFromError } from "./staveSpaceWizard.logic";

/**
 * Pure rules behind `StaveOperationProgress`: what each phase's marker says,
 * how durations and failures read, and whether the "Remove partial space"
 * recovery can run. The component renders these verbatim.
 */

/**
 * `interrupted` is an open phase in a `disconnected` operation: the server may
 * still be running it, but this client stopped hearing about it. A phase with
 * `finishedAt` is `done` unless it is the last one of a `failed` operation
 * (the server emits `phase_finished` for the failing phase too).
 */
export type StavePhaseStatus = "running" | "done" | "failed" | "interrupted";

export function phaseStatus(
  phase: StaveOperationPhaseState,
  index: number,
  state: StaveOperationState,
): StavePhaseStatus {
  const isLast = index === state.phases.length - 1;
  if (phase.finishedAt !== undefined) {
    return isLast && state.status === "failed" ? "failed" : "done";
  }
  switch (state.status) {
    case "failed":
      return "failed";
    case "disconnected":
      return "interrupted";
    case "finished":
      // Attached mid-phase and saw the terminal event before the phase's end.
      return "done";
    case "idle":
    case "running":
      return "running";
  }
}

/** "0.4s" under ten seconds, "12s" under a minute, then "1m 05s". */
export function formatPhaseDuration(durationMs: number): string {
  const safeMs = Math.max(0, durationMs);
  if (safeMs < 10_000) {
    return `${(safeMs / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.round(safeMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export interface StaveOperationErrorDescription {
  /** The error code, with the Stave verb that failed when the server knew it. */
  readonly title: string;
  readonly detail: string;
}

export function describeOperationError(error: StaveOperationError): StaveOperationErrorDescription {
  const title = error.verb === undefined ? error.code : `${error.code} (${error.verb})`;
  return { title, detail: error.message };
}

export type StaveRemovePartialSpaceAvailability =
  | { readonly kind: "available"; readonly operation: StaveRemovePartialSpaceOperation }
  | { readonly kind: "unavailable"; readonly hint: string };

export const NO_PARTIAL_SPACE_HINT = "Stave did not report a partial space; nothing was created.";

/**
 * Whether a failed `createSpace` left something the wizard can remove: only
 * when the server reported the partial space with its manifest stamp, so the
 * destroy stays bound to what this operation created.
 */
export function removePartialSpaceAvailability(
  state: StaveOperationState,
  spaceId: string,
): StaveRemovePartialSpaceAvailability {
  const partial = partialSpaceFromError(state.error, spaceId);
  if (partial === null) {
    return { kind: "unavailable", hint: NO_PARTIAL_SPACE_HINT };
  }
  const operation = buildRemovePartialSpaceOperation(partial);
  if (operation === null) {
    return {
      kind: "unavailable",
      hint: `Stave reported a partial space at ${partial.spacePath} but its manifest stamp is unknown; remove it with \`stave space destroy ${partial.spaceId}\` after checking it is yours.`,
    };
  }
  return { kind: "available", operation };
}

export function overallStatusLabel(state: StaveOperationState): string {
  switch (state.status) {
    case "idle":
      return "Not started";
    case "running":
      return "Running…";
    case "finished":
      return "Finished";
    case "failed":
      return "Failed";
    case "disconnected":
      return "Disconnected";
  }
}

/** Text of one output line as shown: Stave's notes are prefixed so they read apart from raw stdout. */
export function outputLineText(line: StaveOperationOutputLine): string {
  return line.stream === "notes" ? `note: ${line.text}` : line.text;
}

export interface StaveOutputRun {
  readonly stream: StaveOperationOutputLine["stream"];
  /** 1-based number of the run's first line within the phase; keys the run in the view. */
  readonly startLine: number;
  /** The run's lines as shown, newline-joined. */
  readonly text: string;
}

/** Consecutive lines of one stream collapse into a single styled block. */
export function outputRuns(
  lines: ReadonlyArray<StaveOperationOutputLine>,
): ReadonlyArray<StaveOutputRun> {
  const runs: Array<StaveOutputRun> = [];
  lines.forEach((line, index) => {
    const last = runs[runs.length - 1];
    const text = outputLineText(line);
    if (last !== undefined && last.stream === line.stream) {
      runs[runs.length - 1] = { ...last, text: `${last.text}\n${text}` };
    } else {
      runs.push({ stream: line.stream, startLine: index + 1, text });
    }
  });
  return runs;
}

export function truncatedNotice(state: StaveOperationState): string | null {
  if (!state.truncated) return null;
  return state.earliestSequence === undefined
    ? "Earlier output was evicted."
    : `Earlier output was evicted; showing from sequence ${state.earliestSequence}.`;
}
