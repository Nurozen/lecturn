import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId, TurnId } from "@lecturn/contracts";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { AssistantCitationRequest, AssistantCitationTarget } from "./AssistantCitationSource";
import { toastManager } from "../ui/toast";

export interface CitationHistoryPage {
  readonly loading: boolean;
  readonly cursor?: string | null;
  readonly onLoadEarlier: () => void;
}

/** Rendering the expanded user body must commit before navigation can measure it. */
export function citationSourceReadiness(input: {
  role: string;
  userExpanded: boolean;
  rowPresent: boolean;
  listReady: boolean;
}): "unsupported" | "expand-user" | "expand-turn" | "wait" | "ready" {
  if (input.role !== "assistant" && input.role !== "user") return "unsupported";
  if (input.role === "user" && !input.userExpanded) return "expand-user";
  if (!input.rowPresent) return "expand-turn";
  return input.listReady ? "ready" : "wait";
}

/** Fetch, unfold, and mount the source before its measured quote owns scrolling. */
export function useAssistantCitationTarget({
  request,
  entries,
  rows,
  listRef,
  viewport,
  historyLoading,
  loadEarlier,
  onExpandTurn,
  expandedUserMessages,
  onExpandUserMessage,
  onManualNavigation,
}: {
  request: AssistantCitationRequest | null;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  viewport: HTMLElement | null;
  historyLoading: boolean;
  loadEarlier: CitationHistoryPage | null;
  onExpandTurn: (turnId: TurnId) => void;
  expandedUserMessages: ReadonlySet<MessageId>;
  onExpandUserMessage: (messageId: MessageId) => void;
  onManualNavigation: () => void;
}) {
  const [ready, setReady] = useState<AssistantCitationTarget | null>(null);
  const [finishedKey, setFinishedKey] = useState<string | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const onListLoad = useCallback(() => setListLoaded(true), []);
  const navigationRef = useRef<{
    target: AssistantCitationTarget;
    requestedPages: Set<string>;
    done: boolean;
  } | null>(null);

  useEffect(() => {
    if (navigationRef.current && navigationRef.current.target.key !== request?.key) {
      navigationRef.current.target.activationRef.current.dismissed = true;
      navigationRef.current.target.activationRef.current.cancelScroll?.();
    }
    if (!request) {
      navigationRef.current = null;
      setReady(null);
      setFinishedKey(null);
      return;
    }
    if (navigationRef.current?.target.key !== request.key) {
      const target: AssistantCitationTarget = {
        ...request,
        activationRef: { current: { scrolled: false, dismissed: false } },
        onComplete: () => {
          if (navigationRef.current?.target !== target) return;
          navigationRef.current.done = true;
          // ChatView's thread-open effect can run after our initial opt-out.
          onManualNavigation();
          setFinishedKey(target.key);
        },
      };
      navigationRef.current = {
        target,
        requestedPages: new Set(),
        done: false,
      };
      setReady(null);
      onManualNavigation();
    }
    if (!viewport || historyLoading) return;
    const navigation = navigationRef.current;
    if (navigation.done || navigation.target.activationRef.current.dismissed) return;
    const fail = (title: string, description: string) => {
      navigation.done = true;
      setFinishedKey(navigation.target.key);
      toastManager.add({ type: "warning", title, description });
    };
    const source = entries.find(
      (entry) =>
        entry.kind === "message" && entry.message.id === navigation.target.citation.messageId,
    );
    if (!source) {
      if (loadEarlier) {
        if (loadEarlier.loading) return;
        const cursor = loadEarlier.cursor ?? entries[0]?.id ?? "first";
        if (navigation.requestedPages.has(cursor) || navigation.requestedPages.size >= 20) {
          fail(
            "Could not load the selected message",
            "Load earlier turns, then click the citation to try again. Your saved quote is unchanged.",
          );
          return;
        }
        navigation.requestedPages.add(cursor);
        loadEarlier.onLoadEarlier();
        return;
      }
      fail(
        "The selected message is unavailable",
        "It may have been removed. The selected text is still saved in your citation.",
      );
      return;
    }
    if (source.kind !== "message") return;
    const readiness = citationSourceReadiness({
      role: source.message.role,
      userExpanded: expandedUserMessages.has(source.message.id),
      rowPresent: rows.some(
        (row) => row.kind === "message" && row.message.id === source.message.id,
      ),
      listReady: listLoaded && listRef.current !== null,
    });
    switch (readiness) {
      case "unsupported":
        fail(
          "The saved selection does not refer to a chat message",
          "The selected text is still saved in your citation.",
        );
        return;
      case "expand-user":
        onExpandUserMessage(source.message.id);
        return;
      case "expand-turn":
        if (source.message.turnId) onExpandTurn(source.message.turnId);
        return;
      case "wait":
        return;
      case "ready":
        setReady(navigation.target);
    }
  }, [
    entries,
    historyLoading,
    listLoaded,
    listRef,
    loadEarlier,
    onExpandTurn,
    expandedUserMessages,
    onExpandUserMessage,
    onManualNavigation,
    request,
    rows,
    viewport,
  ]);

  useEffect(() => {
    if (!request) return;
    const dismiss = (onlyPending: boolean) => {
      const navigation = navigationRef.current;
      if (!navigation || navigation.target.key !== request.key) return;
      const activation = navigation.target.activationRef.current;
      if (activation.dismissed || (onlyPending && (activation.scrolled || navigation.done))) return;
      activation.dismissed = true;
      activation.cancelScroll?.();
      if (!activation.scrolled && !navigation.done) onManualNavigation();
      navigation.done = true;
      setReady(null);
      setFinishedKey(request.key);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss(false);
      } else if (
        viewport?.contains(event.target as Node) &&
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      ) {
        dismiss(true);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) dismiss(true);
    };
    const onNavigation = () => dismiss(true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onNavigation, true);
    viewport?.addEventListener("wheel", onWheel, { passive: true });
    viewport?.addEventListener("touchmove", onNavigation, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onNavigation, true);
      viewport?.removeEventListener("wheel", onWheel);
      viewport?.removeEventListener("touchmove", onNavigation);
    };
  }, [onManualNavigation, request, viewport]);

  const target = ready?.key === request?.key ? ready : null;
  const positioning = request !== null && finishedKey !== request.key;
  const sourceRow =
    target && positioning
      ? rows.find((row) => row.kind === "message" && row.message.id === target.citation.messageId)
      : undefined;
  return {
    target,
    positioning,
    onListLoad,
    alwaysRender: sourceRow ? { keys: [sourceRow.id] } : undefined,
  };
}
