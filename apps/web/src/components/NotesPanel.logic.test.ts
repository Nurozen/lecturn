import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  ProjectId,
  ThreadId,
  ThreadNoteId,
  type ThreadNoteListItem,
} from "@lecturn/contracts";
import {
  groupThreadNotes,
  nextNoteIndex,
  noteCanNavigate,
  noteUnavailableReason,
} from "./NotesPanel.logic";
const a = ThreadId.make("a"),
  b = ThreadId.make("b");
const note = (
  id: string,
  threadId = a,
  overrides: Partial<ThreadNoteListItem> = {},
): ThreadNoteListItem => ({
  id: ThreadNoteId.make(id),
  projectId: ProjectId.make("project"),
  threadId,
  messageId: MessageId.make(id),
  messageRole: "assistant",
  text: "A saved quote",
  comment: null,
  start: 0,
  end: 13,
  prefix: "",
  suffix: "",
  createdAt: "2026-09-22T00:00:00Z",
  updatedAt: "2026-09-22T00:00:00Z",
  threadTitle: threadId,
  anchorState: "ok",
  ...overrides,
});
describe("notes panel behavior", () => {
  it("keeps current thread first, orders loaded messages by transcript, and filters comments", () => {
    const notes = [
      note("later", a, { comment: "Find me" }),
      note("other", b, { createdAt: "2026-09-23T00:00:00Z" }),
      note("earlier"),
    ];
    const groups = groupThreadNotes(
      notes,
      a,
      "project",
      "",
      new Map([
        ["earlier", 0],
        ["later", 1],
      ]),
    );
    expect(groups.map((g) => g.threadId)).toEqual([a, b]);
    expect(groups[0]?.notes.map((n) => n.id)).toEqual(["earlier", "later"]);
    expect(
      groupThreadNotes(notes, a, "thread", " find ME ").flatMap((g) => g.notes.map((n) => n.id)),
    ).toEqual(["later"]);
  });
  it("preserves unavailable quotes but refuses their navigation", () => {
    for (const state of ["thread-deleted", "message-missing", null] as const) {
      const item = note("x", a, { anchorState: state });
      expect(noteCanNavigate(item)).toBe(false);
      expect(noteUnavailableReason(item)).toBeTruthy();
    }
    expect(noteCanNavigate(note("x", a, { anchorState: "thread-archived" }))).toBe(true);
  });
  it("bounds keyboard navigation and supports first and last", () => {
    expect(nextNoteIndex(0, "ArrowUp", 5)).toBe(0);
    expect(nextNoteIndex(4, "ArrowDown", 5)).toBe(4);
    expect(nextNoteIndex(2, "Home", 5)).toBe(0);
    expect(nextNoteIndex(2, "End", 5)).toBe(4);
  });
});
