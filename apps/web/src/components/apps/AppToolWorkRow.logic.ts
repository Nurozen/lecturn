import {
  workEntryIndicatesToolSuccess,
  type WorkLogPresentationEntry,
} from "@lecturn/client-runtime/work-log/presentation";
import { isAppToolSource } from "@lecturn/shared/appToolPresentation";

export type AppToolRowOutcome = "succeeded" | "failed" | "pending";

/**
 * Undefined for every row that is not a connected app's tool, so those keep the standard row.
 * `failed` is the timeline's own reading of the row, so the outcome mark never disagrees with the
 * failure styling the row already shows.
 */
export function appToolRowOutcome(
  entry: WorkLogPresentationEntry,
  failed: boolean,
): AppToolRowOutcome | undefined {
  if (!isAppToolSource(entry.toolSource)) return undefined;
  if (failed) return "failed";
  return workEntryIndicatesToolSuccess(entry) ? "succeeded" : "pending";
}
