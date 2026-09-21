import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ImportedTranscriptEntry } from "../provider/ProviderDriver.ts";
import {
  buildImportedThreadHistory,
  IMPORT_HISTORY_MAX_ACTIVITIES,
  IMPORT_HISTORY_MAX_MESSAGES,
  IMPORT_MESSAGE_TEXT_MAX_LENGTH,
  IMPORT_MESSAGE_TRUNCATION_SUFFIX,
} from "./threadImport.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const importedAt = "2026-05-02T00:00:00.000Z";
const t = (minute: number, second = 0) =>
  `2026-05-01T00:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

const makeMintUuid = () => {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
};

const message = (
  role: "user" | "assistant",
  text: string,
  createdAt: string,
): ImportedTranscriptEntry => ({ kind: "message", role, text, createdAt });

const activity = (summary: string, createdAt: string): ImportedTranscriptEntry => ({
  kind: "activity",
  tone: "tool",
  activityKind: "tool.completed",
  summary,
  itemType: "command_execution",
  detail: "bun test",
  createdAt,
});

const build = (transcript: ReadonlyArray<ImportedTranscriptEntry>, createdAt = importedAt) =>
  buildImportedThreadHistory({ transcript, createdAt, mintUuid: makeMintUuid() });

describe("buildImportedThreadHistory", () => {
  it("mints turn-less rows with fork-style ids and summary-level activity payloads", () => {
    const { history, historyTruncated } = build([
      message("user", "fix the bug", t(1)),
      activity("Ran command", t(2)),
      message("assistant", "fixed", t(3)),
    ]);

    expect(historyTruncated).toBe(false);
    expect(history.turns).toEqual([]);
    expect(history.proposedPlans).toEqual([]);

    const [user, assistant] = history.messages;
    expect(history.messages).toHaveLength(2);
    expect(user?.id).toMatch(UUID_PATTERN);
    expect(assistant?.id.startsWith("assistant:")).toBe(true);
    expect(assistant?.id.slice("assistant:".length)).toMatch(UUID_PATTERN);
    expect(user).toMatchObject({
      role: "user",
      text: "fix the bug",
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: t(1),
      updatedAt: t(1),
    });

    expect(history.activities).toHaveLength(1);
    expect(history.activities[0]?.id).toMatch(UUID_PATTERN);
    expect(history.activities[0]).toMatchObject({
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { itemType: "command_execution", title: "Ran command", detail: "bun test" },
      turnId: null,
      createdAt: t(2),
    });
    expect(history.activities[0]).not.toHaveProperty("sequence");

    const ids = [...history.messages.map((row) => row.id), ...history.activities.map((r) => r.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the last messages and only the activities inside their window", () => {
    const transcript: ImportedTranscriptEntry[] = [];
    const total = IMPORT_HISTORY_MAX_MESSAGES + 3;
    for (let index = 0; index < total; index += 1) {
      const at = DateTime.formatIso(DateTime.makeUnsafe(Date.parse(t(0)) + index * 60_000));
      transcript.push(message(index % 2 === 0 ? "user" : "assistant", `message ${index}`, at));
      transcript.push(activity(`work ${index}`, at));
    }

    const { history, historyTruncated } = build(transcript);

    expect(historyTruncated).toBe(true);
    expect(history.messages).toHaveLength(IMPORT_HISTORY_MAX_MESSAGES);
    expect(history.messages[0]?.text).toBe("message 3");
    expect(history.messages.at(-1)?.text).toBe(`message ${total - 1}`);
    // Activities of the three dropped messages go with them.
    expect(history.activities).toHaveLength(IMPORT_HISTORY_MAX_MESSAGES);
    expect(history.activities[0]?.summary).toBe("work 3");
  });

  it("caps the activity count to the latest rows", () => {
    const transcript: ImportedTranscriptEntry[] = [message("user", "go", t(0))];
    for (let index = 0; index < IMPORT_HISTORY_MAX_ACTIVITIES + 2; index += 1) {
      transcript.push(activity(`work ${index}`, t(1)));
    }

    const { history, historyTruncated } = build(transcript);

    expect(historyTruncated).toBe(true);
    expect(history.messages).toHaveLength(1);
    expect(history.activities).toHaveLength(IMPORT_HISTORY_MAX_ACTIVITIES);
    expect(history.activities[0]?.summary).toBe("work 2");
  });

  it("caps long message text with a visible suffix", () => {
    const { history, historyTruncated } = build([
      message("user", "x".repeat(IMPORT_MESSAGE_TEXT_MAX_LENGTH + 50), t(1)),
      message("assistant", "short", t(2)),
    ]);

    expect(historyTruncated).toBe(true);
    const capped = history.messages[0]?.text ?? "";
    expect(capped).toHaveLength(IMPORT_MESSAGE_TEXT_MAX_LENGTH);
    expect(capped.endsWith(IMPORT_MESSAGE_TRUNCATION_SUFFIX)).toBe(true);
    expect(history.messages[1]?.text).toBe("short");
  });

  it("clamps timestamps to the import time and keeps transcript order under ties", () => {
    const createdAt = t(10);
    const { history } = build(
      [
        message("user", "first", t(5)),
        // Same instant as the next two rows: a (createdAt, random id) sort
        // would shuffle them.
        activity("tied work", t(6)),
        message("assistant", "tied answer", t(6)),
        message("user", "tied follow-up", t(6)),
        // Later than the import itself (clock skew between provider and server).
        message("assistant", "from the future", t(30)),
      ],
      createdAt,
    );

    const rows = [
      ...history.messages.map((row) => ({ label: row.text, createdAt: row.createdAt })),
      ...history.activities.map((row) => ({ label: row.summary, createdAt: row.createdAt })),
    ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

    expect(rows.map((row) => row.label)).toEqual([
      "first",
      "tied work",
      "tied answer",
      "tied follow-up",
      "from the future",
    ]);
    expect(new Set(rows.map((row) => row.createdAt)).size).toBe(rows.length);
    expect(rows.every((row) => row.createdAt <= createdAt)).toBe(true);
    expect(rows.at(-1)?.createdAt).toBe(createdAt);
    expect(rows[0]?.createdAt).toBe(t(5));
  });

  it("drops activities that cannot form a valid row", () => {
    const { history } = build([
      message("user", "go", t(1)),
      {
        kind: "activity",
        tone: "info",
        activityKind: "tool.completed",
        summary: "  ",
        createdAt: t(2),
      },
    ]);
    expect(history.activities).toEqual([]);
  });
});
