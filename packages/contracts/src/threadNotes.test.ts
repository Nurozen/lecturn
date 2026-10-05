import { describe, it, expect } from "@effect/vitest";
import { Schema } from "effect";
import { ThreadNoteCreateInput, ThreadNoteListItem } from "./threadNotes.ts";
const decodeListItem = Schema.decodeUnknownSync(ThreadNoteListItem);
const note = {
  id: "note",
  threadId: "thread",
  messageId: "message",
  messageRole: "user",
  text: "quote",
  comment: null,
  start: 1,
  end: 6,
  prefix: "",
  suffix: "",
};
describe("thread note contracts", () => {
  it("accepts bounded user and assistant anchors but rejects invalid ranges and oversized data", () => {
    const valid = Schema.is(ThreadNoteCreateInput);
    expect(valid(note)).toBe(true);
    expect(valid({ ...note, messageRole: "assistant" })).toBe(true);
    for (const overrides of [
      { end: 1 },
      { start: -1 },
      { start: 1.5 },
      { text: " " },
      { text: "a".repeat(8001) },
      { comment: "a".repeat(8001) },
      { prefix: "a".repeat(33) },
      { messageRole: "system" },
    ])
      expect(valid({ ...note, ...overrides })).toBe(false);
  });
  it("retains the note when a newer server reports an unknown anchor state", () => {
    const decoded = decodeListItem({
      ...note,
      projectId: "project",
      createdAt: "now",
      updatedAt: "now",
      threadTitle: null,
      anchorState: "future-state",
    });
    expect(decoded.anchorState).toBe(null);
    expect(decoded.text).toBe("quote");
  });
});
