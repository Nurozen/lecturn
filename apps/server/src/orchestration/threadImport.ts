import type {
  DispatchableClientOrchestrationCommand,
  IsoDateTime,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ThreadForkHistory,
} from "@lecturn/contracts";
import { EventId, MessageId } from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";

import type { ImportedTranscriptEntry } from "../provider/ProviderDriver.ts";

/**
 * Server-materialized thread.import command minus the commandId the
 * dispatcher mints when it wraps this assembly into a dispatch.
 */
export type MaterializedThreadImportCommand = Omit<
  Extract<DispatchableClientOrchestrationCommand, { type: "thread.import" }>,
  "commandId"
>;

/** An import shows the tail of the session: only its last messages are copied. */
export const IMPORT_HISTORY_MAX_MESSAGES = 200;
/** Activities are summary rows, but a long agentic session holds thousands. */
export const IMPORT_HISTORY_MAX_ACTIVITIES = 1_000;
export const IMPORT_MESSAGE_TEXT_MAX_LENGTH = 20_000;
export const IMPORT_MESSAGE_TRUNCATION_SUFFIX = "\n\n[… truncated on import]";
const IMPORT_ACTIVITY_DETAIL_MAX_LENGTH = 500;

export interface BuildImportedThreadHistoryInput {
  /** Chronological, as reported by the provider's importer. */
  readonly transcript: ReadonlyArray<ImportedTranscriptEntry>;
  /** The importing thread's creation time, which is also `importedAt`. */
  readonly createdAt: IsoDateTime;
  /** Fresh-id source for minted message/activity ids; injectable for tests. */
  readonly mintUuid: () => string;
}

export interface ImportedThreadHistory {
  readonly history: ThreadForkHistory;
  /** Messages or activities were dropped, or a message's text was capped. */
  readonly historyTruncated: boolean;
}

function capText(value: string, maxLength: number, suffix: string): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - suffix.length)}${suffix}` : value;
}

/**
 * Pure import history builder: turns a provider-neutral transcript into the
 * `ThreadForkHistory` a materialized thread.import carries. Rows belong to no
 * Lecturn turn (null turn ids, no turn rows), so nothing here can be reverted
 * or diffed. No IO.
 *
 * Timestamps are rewritten to be strictly increasing and no later than
 * `createdAt`: projections order rows by timestamp then by (random) id, so
 * ties would shuffle the transcript, and `isImportedHistoryRow` treats every
 * turnless row at or before `importedFrom.importedAt` as imported history.
 * The dispatcher stamps `importedAt` with this same `createdAt`.
 */
export function buildImportedThreadHistory(
  input: BuildImportedThreadHistoryInput,
): ImportedThreadHistory {
  const { transcript } = input;

  const messageIndexes = transcript.flatMap((entry, index) =>
    entry.kind === "message" ? [index] : [],
  );
  const droppedMessageCount = Math.max(0, messageIndexes.length - IMPORT_HISTORY_MAX_MESSAGES);
  // The window opens at the first kept message, so activities that belong to
  // dropped messages go with them.
  const windowStart = droppedMessageCount === 0 ? 0 : (messageIndexes[droppedMessageCount] ?? 0);
  const windowed = transcript.slice(windowStart);

  const activityCount = windowed.length - (messageIndexes.length - droppedMessageCount);
  // The oldest activities go first, like the oldest messages.
  let activitiesToDrop = Math.max(0, activityCount - IMPORT_HISTORY_MAX_ACTIVITIES);
  const droppedActivities = activitiesToDrop > 0;
  const kept = windowed.filter((entry) => {
    if (entry.kind === "activity" && activitiesToDrop > 0) {
      activitiesToDrop -= 1;
      return false;
    }
    return true;
  });

  const createdAtMs = Date.parse(input.createdAt);
  // Walked newest to oldest so each row only ever moves earlier, and only
  // when it collides with its successor or the import time.
  const timestamps = kept.map((entry) => entry.createdAt);
  let ceilingMs = createdAtMs;
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const parsedMs = Date.parse(kept[index]!.createdAt);
    const clampedMs = Number.isNaN(parsedMs) ? ceilingMs : Math.min(parsedMs, ceilingMs);
    timestamps[index] = DateTime.formatIso(DateTime.makeUnsafe(clampedMs));
    ceilingMs = clampedMs - 1;
  }

  let cappedText = false;
  const messages: Array<OrchestrationMessage> = [];
  const activities: Array<OrchestrationThreadActivity> = [];
  kept.forEach((entry, index) => {
    const createdAt = timestamps[index]!;
    if (entry.kind === "message") {
      const text = capText(
        entry.text,
        IMPORT_MESSAGE_TEXT_MAX_LENGTH,
        IMPORT_MESSAGE_TRUNCATION_SUFFIX,
      );
      cappedText ||= text !== entry.text;
      messages.push({
        id:
          entry.role === "assistant"
            ? MessageId.make(`assistant:${input.mintUuid()}`)
            : MessageId.make(input.mintUuid()),
        role: entry.role,
        text,
        // Explicit []: the message projection COALESCEs attachments on upsert.
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      return;
    }
    const summary = entry.summary.trim();
    const activityKind = entry.activityKind.trim();
    if (summary.length === 0 || activityKind.length === 0) {
      return;
    }
    const detail = entry.detail?.trim();
    activities.push({
      id: EventId.make(input.mintUuid()),
      tone: entry.tone,
      kind: activityKind,
      summary,
      payload: {
        ...(entry.itemType !== undefined ? { itemType: entry.itemType } : {}),
        title: summary,
        ...(detail ? { detail: capText(detail, IMPORT_ACTIVITY_DETAIL_MAX_LENGTH, "…") } : {}),
      },
      turnId: null,
      createdAt,
    });
  });

  return {
    history: { messages, activities, proposedPlans: [], turns: [] },
    historyTruncated: droppedMessageCount > 0 || droppedActivities || cappedText,
  };
}
