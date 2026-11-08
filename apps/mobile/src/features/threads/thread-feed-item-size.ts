import { THREAD_WORK_ROW_MIN_HEIGHT } from "../../lib/layout";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

// Content-driven rows must be measured by LegendList: returning a fixed size
// makes the list skip native measurement entirely.
const TURN_FOLD_HEIGHT = 42;
const WORK_GROUP_TOGGLE_HEIGHT = THREAD_WORK_ROW_MIN_HEIGHT;
// Lecturn import divider: text-xs line box (17) + py-1 (7) + mb-3 (10.5), with
// the mobile 14px rem. One divider exists per thread, so LegendList never forms
// a running average for its item type and would otherwise carry the list
// estimate for it.
const IMPORT_DIVIDER_HEIGHT = 34.5;

export function resolveThreadFeedFixedItemSize(
  entryType: ThreadFeedEntry["type"],
): number | undefined {
  switch (entryType) {
    case "run-fold":
      return TURN_FOLD_HEIGHT;
    case "work-toggle":
      return WORK_GROUP_TOGGLE_HEIGHT;
    case "import-divider":
      return IMPORT_DIVIDER_HEIGHT;
    case "activity-group":
    case "message":
      return undefined;
  }
}
