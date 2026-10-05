import type { ScopedThreadRef, ThreadNoteListItem } from "@lecturn/contracts";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  BookmarkIcon,
  BotIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  QuoteIcon,
  SearchIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useComposerHandleContext } from "../composerHandleContext";
import { assistantCitationNavigation } from "../lib/assistantCitationNavigation";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { useRightPanelStore } from "../rightPanelStore";
import { useServerConfigs, useThreadShell, useThreadDetail } from "../state/entities";
import {
  setActiveThreadNote,
  threadNoteScopeKey,
  threadNoteToCitation,
  useThreadNotes,
  useThreadNoteUI,
} from "../state/threadNotes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { AssistantCitationCommentEditor } from "./chat/AssistantCitationCommentEditor";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";
import {
  groupThreadNotes,
  nextNoteIndex,
  noteCanNavigate,
  noteUnavailableReason,
} from "./NotesPanel.logic";

import { DecisionsPanel } from "./DecisionsPanel";

export function NotesPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const shell = useThreadShell(threadRef);
  const available =
    useServerConfigs().get(threadRef.environmentId)?.environment.capabilities.threadDecisions ===
    true;
  const [tab, setTab] = useState<"saved" | "decisions">("saved");
  const [scope, setScope] = useState<"project" | "thread">("project");
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Notes">
      <div className="space-y-2 border-b border-border/50 p-3">
        {available ? (
          <div role="tablist" aria-label="Note type" className="flex gap-1">
            {(["saved", "decisions"] as const).map((value) => (
              <Button
                key={value}
                id={`notes-tab-${value}`}
                role="tab"
                aria-selected={tab === value}
                aria-controls={`notes-panel-${value}`}
                size="sm"
                variant={tab === value ? "glass" : "ghost"}
                onClick={() => setTab(value)}
              >
                {value === "saved" ? "Saved" : "Decisions"}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="flex gap-1" aria-label="Notes scope">
          {(["project", "thread"] as const).map((value) => (
            <Button
              key={value}
              size="xs"
              variant={scope === value ? "glass" : "ghost"}
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {value === "project" ? "Project" : "This thread"}
            </Button>
          ))}
        </div>
      </div>
      <div
        id="notes-panel-saved"
        role={available ? "tabpanel" : undefined}
        aria-labelledby={available ? "notes-tab-saved" : undefined}
        hidden={available && tab !== "saved"}
        className={available && tab !== "saved" ? "hidden" : "flex min-h-0 flex-1 flex-col"}
      >
        <SavedNotesPanel threadRef={threadRef} scope={scope} />
      </div>
      {available && shell ? (
        <div
          id="notes-panel-decisions"
          role="tabpanel"
          aria-labelledby="notes-tab-decisions"
          hidden={tab !== "decisions"}
          className={tab !== "decisions" ? "hidden" : "flex min-h-0 flex-1 flex-col"}
        >
          <DecisionsPanel
            environmentId={threadRef.environmentId}
            projectId={shell.projectId}
            {...(scope === "thread" ? { threadId: threadRef.threadId } : {})}
          />
        </div>
      ) : null}
    </section>
  );
}
function SavedNotesPanel({
  threadRef,
  scope,
}: {
  threadRef: ScopedThreadRef;
  scope: "project" | "thread";
}) {
  const data = useThreadNotes(threadRef);
  const detail = useThreadDetail(threadRef);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const [saving, setSaving] = useState(false);
  const active = useThreadNoteUI((s) => s.active);
  const highlights = useThreadNoteUI((s) => s.highlights);
  const container = useRef<HTMLDivElement>(null);
  const composer = useComposerHandleContext();
  const navigate = useNavigate();
  const messageOrder = useMemo(
    () => new Map((detail?.messages ?? []).map((message, index) => [message.id, index])),
    [detail?.messages],
  );
  const groups = useMemo(
    () => groupThreadNotes(data.notes, threadRef.threadId, scope, filter, messageOrder),
    [data.notes, threadRef.threadId, scope, filter, messageOrder],
  );
  const rows = groups.flatMap((group) => group.notes);
  const activeId = active?.key === threadNoteScopeKey(threadRef) ? active.id : undefined;
  useEffect(() => {
    if (activeId)
      container.current
        ?.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(activeId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  function jump(note: ThreadNoteListItem) {
    if (!noteCanNavigate(note)) return;
    const dest = scopeThreadRef(threadRef.environmentId, note.threadId);
    setActiveThreadNote(dest, note.id);
    if (window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches) {
      useRightPanelStore.getState().close(threadRef);
      useRightPanelStore.getState().close(dest);
    } else useRightPanelStore.getState().open(dest, "notes");
    void navigate(assistantCitationNavigation(threadNoteToCitation(note, threadRef.environmentId)));
  }
  const action = (label: string, icon: React.ReactNode, onClick: () => void, disabled = false) => (
    <Tooltip key={label}>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
  if (!data.available)
    return (
      <div className="p-5 text-sm text-muted-foreground">
        Notes are unavailable on this environment.
      </div>
    );
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Thread notes">
      <div className="flex flex-col gap-3 border-b border-border/50 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <BookmarkIcon className="size-4 text-primary" />
            Notes <span className="text-xs text-muted-foreground">{data.notes.length}</span>
          </div>
          <div className="flex items-center gap-1">
            {action(
              highlights ? "Hide highlights" : "Show highlights",
              highlights ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />,
              () => useThreadNoteUI.setState({ highlights: !highlights }),
            )}
            <Button size="xs" variant="ghost" onClick={data.refresh}>
              Refresh
            </Button>
          </div>
        </div>
        <label className="lecturn-panel-tile flex items-center gap-2 px-3 py-2">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <input
            aria-label="Filter notes"
            placeholder="Find a quote or comment…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setFocused(0);
            }}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
      </div>
      <div
        ref={container}
        className="min-h-0 flex-1 overflow-y-auto p-3"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setActiveThreadNote(threadRef, null);
            setEditing(null);
          }
        }}
      >
        {data.error ? (
          <div role="alert" className="lecturn-panel-tile mb-3 p-3 text-sm">
            {data.error}
            <Button size="xs" variant="ghost" onClick={data.refresh}>
              Try again
            </Button>
          </div>
        ) : null}
        {data.isPending && !data.notes.length ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading notes…
          </p>
        ) : null}
        {!data.isPending && !rows.length ? (
          <div className="lecturn-panel-tile flex flex-col items-center gap-3 px-5 py-10 text-center">
            <BookmarkIcon className="size-7 text-primary/70" />
            <p className="text-sm">{filter ? "No matching notes" : "Keep the parts that matter"}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {filter
                ? "Try another quote or comment."
                : "Select text in a message, then choose Save note."}
            </p>
          </div>
        ) : null}
        {groups.map((group) => (
          <div key={group.threadId} className="mb-4">
            <h3 className="truncate px-2 pb-2 pt-1 text-xs font-medium text-muted-foreground">
              {group.title}
              {group.threadId === threadRef.threadId ? " · Current thread" : ""}
            </h3>
            <div className="flex flex-col gap-2" role="list" aria-label={`Notes in ${group.title}`}>
              {group.notes.map((note) => {
                const index = rows.indexOf(note),
                  pending =
                    data.pending.get(JSON.stringify([threadRef.environmentId, note.id]))?.busy ===
                    true;
                const reason = noteUnavailableReason(note);
                return (
                  <article
                    key={note.id}
                    role="listitem"
                    data-note-id={note.id}
                    data-active={note.id === activeId || undefined}
                    className={`lecturn-panel-tile lecturn-panel-note group p-3 ${!noteCanNavigate(note) ? "opacity-65" : ""}`}
                  >
                    <button
                      type="button"
                      tabIndex={index === Math.min(focused, rows.length - 1) ? 0 : -1}
                      className="block w-full rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-current={note.id === activeId ? "true" : undefined}
                      onFocus={() => setFocused(index)}
                      onClick={() => jump(note)}
                      onKeyDown={(e) => {
                        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                          e.preventDefault();
                          const next = nextNoteIndex(index, e.key, rows.length);
                          setFocused(next);
                          container.current
                            ?.querySelectorAll<HTMLButtonElement>("[data-note-id] > button")
                            [next]?.focus();
                        } else if (e.key === "e" && !pending) {
                          e.preventDefault();
                          setEditing(note.id);
                        } else if (e.key === "Backspace" && !pending) {
                          e.preventDefault();
                          void data.deleteNote(note);
                        }
                      }}
                    >
                      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                        {note.messageRole === "user" ? (
                          <UserIcon className="size-3" />
                        ) : (
                          <BotIcon className="size-3" />
                        )}
                        <span>{note.messageRole === "user" ? "You" : "Assistant"}</span>
                        <span className="ml-auto">
                          {pending ? "Saving…" : formatRelativeTimeLabel(note.createdAt)}
                        </span>
                      </div>
                      <blockquote className="line-clamp-2 border-l-2 border-primary/40 pl-2.5 text-sm leading-relaxed">
                        {note.text}
                      </blockquote>
                      {note.comment && editing !== note.id ? (
                        <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                          {note.comment}
                        </p>
                      ) : null}
                      {reason ? (
                        <p className="mt-2 text-xs text-muted-foreground">{reason}</p>
                      ) : null}
                    </button>
                    {editing === note.id ? (
                      <div className="mt-3" inert={saving}>
                        <AssistantCitationCommentEditor
                          citation={{ comment: note.comment }}
                          inputRef={(node) => node?.focus()}
                          onCancel={() => setEditing(null)}
                          onSubmit={(comment) => {
                            setSaving(true);
                            void data.updateNote(note, comment).then((ok) => {
                              setSaving(false);
                              if (ok) setEditing(null);
                            });
                            return true;
                          }}
                        />
                      </div>
                    ) : null}
                    <div className="mt-2 flex justify-end gap-1 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      {action(
                        "Edit comment",
                        <PencilIcon className="size-3.5" />,
                        () => setEditing(note.id),
                        pending,
                      )}
                      {action(
                        note.messageRole === "user"
                          ? "Only assistant notes can be inserted into chat"
                          : "Insert into chat",
                        <QuoteIcon className="size-3.5" />,
                        () => {
                          if (
                            !composer?.current?.insertCitation(
                              threadNoteToCitation(note, threadRef.environmentId),
                            )
                          )
                            toastManager.add({
                              type: "warning",
                              title: "The composer is not ready",
                              description: "Try again once the current operation finishes.",
                            });
                        },
                        pending || note.messageRole === "user",
                      )}
                      {action("Copy note", <CopyIcon className="size-3.5" />, () => {
                        void navigator.clipboard
                          .writeText([note.text, note.comment].filter(Boolean).join("\n\n"))
                          .catch(() =>
                            toastManager.add({ type: "error", title: "Could not copy note" }),
                          );
                      })}
                      {action(
                        "Delete note",
                        <Trash2Icon className="size-3.5" />,
                        () => {
                          void data.deleteNote(note);
                        },
                        pending,
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ))}
        {data.data?.truncated ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Showing the newest 500 notes in this project.
          </p>
        ) : null}
      </div>
    </section>
  );
}
