import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@lecturn/contracts";
import { NotebookPenIcon, QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { Button } from "../ui/button";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";

export interface ThreadNoteSelection {
  citation: AssistantCitation;
  sourceAnchor: AssistantCitationSourceAnchor;
  role: "user" | "assistant";
}

export function selectionSourceRole(source: HTMLElement): "user" | "assistant" {
  return source.dataset.citationSourceRole === "user" ? "user" : "assistant";
}

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
  onSaveNote,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite?:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
  onSaveNote?: ((selection: ThreadNoteSelection) => void) | undefined;
}) {
  const [selection, setSelection] = useState<
    (ThreadNoteSelection & { position: SelectionActionPoint }) | null
  >(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const captured = captureAssistantTextSelection(viewport, window.getSelection());
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
        clear();
        return;
      }
      const role = selectionSourceRole(captured.source);
      if (!onSaveNote && (role === "user" || !onCite)) {
        clear();
        return;
      }
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom || rect.width === 0) {
        clear();
        return;
      }
      const rects = captured.range.getClientRects();
      setSelection({
        role,
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.item(rects.length - 1) ?? rect,
          pointer,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      )
        return;
      const button = toolbar.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      button.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [threadRef, viewport, onCite, onSaveNote]);

  if (!selection) return null;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  return createPortal(
    <div
      ref={toolbarRef}
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] gap-1 rounded-full border border-border p-1 shadow-lg surface-glass"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      {selection.role === "assistant" && onCite ? (
        <Button
          type="button"
          size="xs"
          variant="glass"
          disabled={tooLong}
          aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
          className="rounded-full px-2.5"
          onClick={() => {
            if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return;
            window.getSelection()?.removeAllRanges();
            dismiss();
          }}
        >
          <QuoteIcon aria-hidden="true" className="size-3.5" />
          {tooLong ? "Shorten selection" : "Cite"}
        </Button>
      ) : null}
      {onSaveNote ? (
        <Button
          type="button"
          size="xs"
          variant="glass"
          disabled={tooLong}
          aria-label={tooLong ? "Selection is too long to save" : "Save selection as a note"}
          className="rounded-full px-2.5"
          onClick={() => {
            if (tooLong) return;
            onSaveNote({
              ...selection,
              sourceAnchor: {
                ...selection.sourceAnchor,
                range: selection.sourceAnchor.range.cloneRange(),
              },
            });
            window.getSelection()?.removeAllRanges();
            dismiss();
          }}
        >
          <NotebookPenIcon aria-hidden="true" className="size-3.5" />
          {tooLong ? "Shorten selection" : "Save note"}
        </Button>
      ) : null}
    </div>,
    document.body,
  );
}

/** Owned by the timeline, so dismissing the selection toolbar does not close the editor. */
export function ThreadNoteSelectionEditor({
  selection,
  onSave,
  onCancel,
}: {
  selection: ThreadNoteSelection;
  onSave: (comment: string) => void;
  onCancel: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const rects = selection.sourceAnchor.range.getClientRects();
    const rect =
      rects.item(rects.length - 1) ?? selection.sourceAnchor.range.getBoundingClientRect();
    const bounds = editor.getBoundingClientRect();
    editor.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8))}px`;
    editor.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - bounds.height - 8))}px`;
    inputRef.current?.focus({ preventScroll: true });
  }, [selection]);
  useEffect(
    () =>
      observeAssistantCitationCommentSource({
        anchor: selection.sourceAnchor,
        citation: selection.citation,
        onUnavailable: onCancel,
      }),
    [selection, onCancel],
  );
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!editorRef.current?.contains(event.target as Node)) onCancel();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [onCancel]);
  return createPortal(
    <div
      ref={editorRef}
      role="dialog"
      data-slot="popover-popup"
      aria-label="Save thread note"
      className="fixed z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-border p-3 shadow-xl surface-glass"
    >
      <p className="mb-2 text-sm font-medium">Save note</p>
      <AssistantCitationCommentEditor
        citation={{}}
        inputRef={inputRef}
        onSubmit={(comment) => {
          onSave(comment);
          return true;
        }}
        onCancel={onCancel}
      />
    </div>,
    document.body,
  );
}
