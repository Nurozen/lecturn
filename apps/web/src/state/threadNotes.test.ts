import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ThreadNoteId,
  MessageId,
  type ThreadNoteListItem,
} from "@lecturn/contracts";
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@lecturn/client-runtime/state/threadNotes", () => ({
  createThreadNoteEnvironmentAtoms: () => ({}),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./entities", () => ({ useServerConfigs: () => new Map(), useThreadShell: () => null }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
import { acknowledgedThreadNoteWrites, overlayThreadNotes, type PendingNote } from "./threadNotes";
const environmentId = EnvironmentId.make("one");
const projectId = ProjectId.make("project");
const note: ThreadNoteListItem = {
  id: ThreadNoteId.make("note"),
  projectId,
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  messageRole: "assistant",
  text: "saved quote",
  comment: "new comment",
  start: 0,
  end: 11,
  prefix: "",
  suffix: "",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:01.000Z",
  threadTitle: "Thread",
  anchorState: "ok",
};
function pending(kind: PendingNote["kind"], busy = false) {
  return new Map<string, PendingNote>([["key", { environmentId, note, kind, busy }]]);
}
describe("confirmed note write reconciliation", () => {
  it("keeps a successful create visible across a failed or stale list until it is observed", () => {
    const writes = pending("create");
    expect(overlayThreadNotes([], writes, environmentId, projectId)).toEqual([note]);
    expect(acknowledgedThreadNoteWrites(writes, [], environmentId, projectId)).toEqual([]);
    expect(acknowledgedThreadNoteWrites(writes, [note], environmentId, projectId)).toEqual([
      ...writes,
    ]);
    expect(
      acknowledgedThreadNoteWrites(pending("create", true), [note], environmentId, projectId),
    ).toEqual([]);
  });
  it("retains the confirmed comment while a refresh still contains the earlier version", () => {
    const oldNote = { ...note, comment: "old comment", updatedAt: note.createdAt };
    const writes = pending("update");
    expect(overlayThreadNotes([oldNote], writes, environmentId, projectId)).toEqual([note]);
    expect(acknowledgedThreadNoteWrites(writes, [oldNote], environmentId, projectId)).toEqual([]);
    expect(
      acknowledgedThreadNoteWrites(
        writes,
        [{ ...oldNote, updatedAt: note.updatedAt }],
        environmentId,
        projectId,
      ),
    ).toEqual([]);
    expect(acknowledgedThreadNoteWrites(writes, [note], environmentId, projectId)).toEqual([
      ...writes,
    ]);
    expect(
      acknowledgedThreadNoteWrites(
        writes,
        [{ ...note, comment: "another device", updatedAt: "2026-09-22T00:00:02.000Z" }],
        environmentId,
        projectId,
      ),
    ).toEqual([...writes]);
  });
  it("keeps deletion pending until write success, then hides it through a stale refresh", () => {
    expect(overlayThreadNotes([note], pending("delete", true), environmentId, projectId)).toEqual([
      note,
    ]);
    const writes = pending("delete");
    expect(overlayThreadNotes([note], writes, environmentId, projectId)).toEqual([]);
    expect(acknowledgedThreadNoteWrites(writes, [note], environmentId, projectId)).toEqual([]);
    expect(acknowledgedThreadNoteWrites(writes, [], environmentId, projectId)).toEqual([...writes]);
  });
  it("never paints or acknowledges another environment or project with colliding note ids", () => {
    const writes = pending("create");
    expect(overlayThreadNotes([], writes, EnvironmentId.make("other"), projectId)).toEqual([]);
    expect(overlayThreadNotes([], writes, environmentId, ProjectId.make("other"))).toEqual([]);
    expect(
      acknowledgedThreadNoteWrites(writes, [note], EnvironmentId.make("other"), projectId),
    ).toEqual([]);
    expect(
      acknowledgedThreadNoteWrites(writes, [note], environmentId, ProjectId.make("other")),
    ).toEqual([]);
  });
});
