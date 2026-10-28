import { appReferenceLabelsFromRecords } from "@lecturn/shared/appReferences";

import type { ThreadFeedEntry } from "../../lib/threadActivity";

/**
 * The names the user's chips carried when their messages were sent, by reference, so a chip in
 * any message of the thread reads as the app named it. A later message's name wins.
 */
export function appReferenceLabelsFromFeed(
  feed: ReadonlyArray<ThreadFeedEntry>,
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const entry of feed) {
    if (entry.type !== "message" || entry.message.context === undefined) continue;
    for (const { ref, label } of appReferenceLabelsFromRecords(entry.message.context.records)) {
      labels.set(ref, label);
    }
  }
  return labels;
}

export function sameAppReferenceLabels(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [ref, label] of left) if (right.get(ref) !== label) return false;
  return true;
}
