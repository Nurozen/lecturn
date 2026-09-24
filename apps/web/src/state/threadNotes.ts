import { createThreadNoteEnvironmentAtoms } from "@lecturn/client-runtime/state/threadNotes";
import { executeAtomQuery, runAtomCommand } from "@lecturn/client-runtime/state/runtime";
import {
  ThreadNoteId,
  type AssistantCitation,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadNoteListItem,
  type ThreadNoteCreateInput,
} from "@lecturn/contracts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs, useThreadShell } from "./entities";
import { useEnvironmentQuery } from "./query";
import { randomUUID } from "../lib/utils";
import { toastManager } from "../components/ui/toast";

export const threadNoteEnvironment = createThreadNoteEnvironmentAtoms(connectionAtomRuntime);
const EMPTY_NOTES: readonly ThreadNoteListItem[] = [];
export type PendingNote = {
  environmentId: EnvironmentId;
  note: ThreadNoteListItem;
  kind: "create" | "update" | "delete";
  busy: boolean;
  release?: (() => void) | undefined;
};
export const useThreadNoteUI = create<{
  pending: ReadonlyMap<string, PendingNote>;
  active: { key: string; id: string } | null;
  highlights: boolean;
}>(() => ({ pending: new Map(), active: null, highlights: true }));
const noteKey = (environmentId: EnvironmentId, id: string) => JSON.stringify([environmentId, id]);
export const threadNoteScopeKey = (ref: ScopedThreadRef) =>
  JSON.stringify([ref.environmentId, ref.threadId]);
export function setActiveThreadNote(ref: ScopedThreadRef, id: string | null) {
  useThreadNoteUI.setState({ active: id ? { key: threadNoteScopeKey(ref), id } : null });
}
export function overlayThreadNotes(
  saved: readonly ThreadNoteListItem[],
  pending: ReadonlyMap<string, PendingNote>,
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): readonly ThreadNoteListItem[] {
  const overlays = [...pending.values()].filter(
    (item) => item.environmentId === environmentId && item.note.projectId === projectId,
  );
  if (!overlays.length) return saved;
  const byId = new Map(saved.map((note) => [note.id, note]));
  for (const item of overlays) {
    if (item.kind === "delete") {
      if (!item.busy) byId.delete(item.note.id);
    } else byId.set(item.note.id, item.note);
  }
  return [...byId.values()];
}

/** A confirmed write stays visible until a successful list observes it. */
export function acknowledgedThreadNoteWrites(
  pending: ReadonlyMap<string, PendingNote>,
  saved: readonly ThreadNoteListItem[],
  environmentId: EnvironmentId,
  projectId: ProjectId,
) {
  const byId = new Map(saved.map((note) => [note.id, note]));
  return [...pending].filter(([, item]) => {
    if (item.busy || item.environmentId !== environmentId || item.note.projectId !== projectId)
      return false;
    const savedNote = byId.get(item.note.id);
    if (item.kind === "delete") return !savedNote;
    // A later edit from another device is also an acknowledgment of this write.
    return (
      savedNote !== undefined &&
      (savedNote.updatedAt > item.note.updatedAt ||
        (savedNote.updatedAt === item.note.updatedAt && savedNote.comment === item.note.comment))
    );
  });
}
function replacePending(key: string, value: PendingNote | undefined) {
  useThreadNoteUI.setState((state) => {
    const pending = new Map(state.pending);
    if (value) pending.set(key, value);
    else pending.delete(key);
    return { pending };
  });
}
function beginMutation(
  environmentId: EnvironmentId,
  note: ThreadNoteListItem,
  kind: PendingNote["kind"],
  release?: () => void,
) {
  const key = noteKey(environmentId, note.id);
  const previous = useThreadNoteUI.getState().pending.get(key);
  if (previous?.busy) {
    release?.();
    return null;
  }
  const item: PendingNote = {
    environmentId,
    note,
    kind,
    busy: true,
    release: release ?? previous?.release,
  };
  replacePending(key, item);
  return {
    fail: () => {
      replacePending(key, previous);
      release?.();
    },
    confirm: (confirmedNote: ThreadNoteListItem) => {
      if (release && previous?.release && previous.release !== release) previous.release();
      if (kind === "delete") item.release?.();
      replacePending(key, {
        ...item,
        note: confirmedNote,
        busy: false,
        release: kind === "delete" ? undefined : item.release,
      });
    },
  };
}
export function threadNoteToCitation(
  note: Pick<
    ThreadNoteListItem,
    "threadId" | "messageId" | "text" | "start" | "end" | "prefix" | "suffix" | "comment"
  >,
  environmentId: EnvironmentId,
): AssistantCitation {
  return {
    version: 1,
    environmentId,
    threadId: note.threadId,
    messageId: note.messageId,
    text: note.text,
    start: note.start,
    end: note.end,
    prefix: note.prefix,
    suffix: note.suffix,
    ...(note.comment ? { comment: note.comment } : {}),
  };
}
export function threadNoteCreateInput(note: ThreadNoteListItem): ThreadNoteCreateInput {
  return {
    id: note.id,
    threadId: note.threadId,
    messageId: note.messageId,
    messageRole: note.messageRole,
    text: note.text,
    comment: note.comment,
    start: note.start,
    end: note.end,
    prefix: note.prefix,
    suffix: note.suffix,
  };
}
export function useThreadNotes(ref: ScopedThreadRef | null) {
  const shell = useThreadShell(ref);
  const configs = useServerConfigs();
  const available =
    !!ref &&
    !!shell &&
    configs.get(ref.environmentId)?.environment.capabilities.threadNotes === true;
  const environmentId = available ? ref.environmentId : null;
  const projectId = available ? shell.projectId : null;
  const atom =
    environmentId && projectId
      ? threadNoteEnvironment.list({ environmentId, input: { projectId } })
      : null;
  const query = useEnvironmentQuery(atom);
  const pending = useThreadNoteUI((state) => state.pending);
  const saved = query.data?.notes ?? EMPTY_NOTES;
  const notes = useMemo(
    () => overlayThreadNotes(saved, pending, environmentId, projectId),
    [saved, pending, environmentId, projectId],
  );
  useEffect(() => {
    if (!environmentId || !projectId || query.error || query.isPending || !query.data) return;
    const acknowledged = acknowledgedThreadNoteWrites(pending, saved, environmentId, projectId);
    if (!acknowledged.length) return;
    // This runs after the persisted selectors have committed. The following
    // render retains those same selectors, so releasing the hold cannot blink.
    for (const [key, item] of acknowledged) {
      if (useThreadNoteUI.getState().pending.get(key) !== item) continue;
      replacePending(key, undefined);
      item.release?.();
    }
  }, [pending, saved, environmentId, projectId, query.error, query.isPending, query.data]);
  useEffect(() => {
    if (!atom) return;
    let lastRefresh = 0;
    const refresh = () => {
      if (Date.now() - lastRefresh < 30_000) return;
      lastRefresh = Date.now();
      appAtomRegistry.refresh(atom);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [atom]);
  async function refreshAfterMutation() {
    if (!atom) return;
    const result = await executeAtomQuery(appAtomRegistry, atom, {
      refresh: true,
      reportFailure: false,
    });
    if (result._tag === "Failure")
      toastManager.add({
        type: "warning",
        title: "Change saved; list could not refresh",
        description:
          "Your change is saved on the environment. Refresh Notes when the connection returns.",
      });
  }
  async function createNote(input: ThreadNoteCreateInput, release?: () => void) {
    if (!environmentId || !projectId) {
      release?.();
      return false;
    }
    const now = new Date().toISOString();
    const note: ThreadNoteListItem = {
      ...input,
      projectId,
      createdAt: now,
      updatedAt: now,
      threadTitle: shell?.title ?? null,
      anchorState: "ok",
    };
    const mutation = beginMutation(environmentId, note, "create", release);
    if (!mutation) return false;
    {
      const result = await runAtomCommand(appAtomRegistry, threadNoteEnvironment.create, {
        environmentId,
        input,
      });
      if (result._tag === "Failure") {
        mutation.fail();
        toastManager.add({
          type: "error",
          title: "Could not save note",
          description: "Your selection was not saved. Please try again.",
        });
        return false;
      }
      mutation.confirm({ ...note, ...result.value });
      await refreshAfterMutation();
      return true;
    }
  }
  async function deleteNote(note: ThreadNoteListItem) {
    if (!environmentId) return;
    const mutation = beginMutation(environmentId, note, "delete");
    if (!mutation) return;
    {
      const result = await runAtomCommand(appAtomRegistry, threadNoteEnvironment.delete, {
        environmentId,
        input: { id: note.id },
      });
      if (result._tag === "Failure") {
        mutation.fail();
        toastManager.add({ type: "error", title: "Could not delete note" });
        return;
      }
      mutation.confirm(note);
      const active = useThreadNoteUI.getState().active;
      if (ref && active?.key === threadNoteScopeKey(ref) && active.id === note.id)
        setActiveThreadNote(ref, null);
      await refreshAfterMutation();
      toastManager.add({
        type: "success",
        title: "Note deleted",
        actionProps: {
          children: "Undo",
          onClick: () => {
            void createNote(threadNoteCreateInput(note));
          },
        },
      });
    }
  }
  async function updateNote(note: ThreadNoteListItem, comment: string) {
    if (!environmentId) return false;
    const mutation = beginMutation(environmentId, note, "update");
    if (!mutation) return false;
    const result = await runAtomCommand(appAtomRegistry, threadNoteEnvironment.update, {
      environmentId,
      input: { id: note.id, comment: comment.trim() || null },
    });
    if (result._tag === "Failure") {
      mutation.fail();
      toastManager.add({ type: "error", title: "Could not update note" });
      return false;
    }
    mutation.confirm({ ...note, ...result.value });
    await refreshAfterMutation();
    return true;
  }
  return {
    ...query,
    available,
    notes,
    pending,
    createNote,
    deleteNote,
    updateNote,
    newId: () => ThreadNoteId.make(randomUUID()),
  };
}
