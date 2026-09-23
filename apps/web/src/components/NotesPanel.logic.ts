import type { ThreadId, ThreadNoteListItem } from "@lecturn/contracts";
export function noteCanNavigate(note: ThreadNoteListItem) {
  return note.anchorState === "ok" || note.anchorState === "thread-archived";
}
export function noteUnavailableReason(note: ThreadNoteListItem) {
  switch (note.anchorState) {
    case "message-missing":
      return "This message was removed. Your note is preserved.";
    case "thread-deleted":
      return "This thread was deleted. Your note is preserved.";
    case "thread-archived":
      return "Archived thread";
    case "ok":
      return null;
    default:
      return "The source is unavailable.";
  }
}
export function groupThreadNotes(
  notes: readonly ThreadNoteListItem[],
  currentThreadId: ThreadId,
  scope: "project" | "thread",
  filter: string,
  messageOrder: ReadonlyMap<string, number> = new Map(),
) {
  const query = filter.trim().toLocaleLowerCase();
  const groups = new Map<ThreadId, ThreadNoteListItem[]>();
  for (const note of notes) {
    if (scope === "thread" && note.threadId !== currentThreadId) continue;
    if (query && !`${note.text}\n${note.comment ?? ""}`.toLocaleLowerCase().includes(query))
      continue;
    const group = groups.get(note.threadId) ?? [];
    group.push(note);
    groups.set(note.threadId, group);
  }
  return [...groups]
    .sort(([a, an], [b, bn]) =>
      a === currentThreadId
        ? -1
        : b === currentThreadId
          ? 1
          : Math.max(...bn.map((n) => Date.parse(n.createdAt))) -
            Math.max(...an.map((n) => Date.parse(n.createdAt))),
    )
    .map(([threadId, items]) => ({
      threadId,
      title: items[0]?.threadTitle ?? "Untitled thread",
      notes: items.sort((a, b) => {
        const ai = messageOrder.get(a.messageId),
          bi = messageOrder.get(b.messageId);
        return ai !== undefined && bi !== undefined
          ? ai - bi || a.start - b.start
          : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      }),
    }));
}
export function nextNoteIndex(index: number, key: string, count: number) {
  if (!count) return 0;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return Math.max(
    0,
    Math.min(count - 1, index + (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0)),
  );
}
