import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { SquireQueueChip, SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SquireCardId,
  SquireId,
  SquireThreadMarker,
} from "@lecturn/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, SendIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { observeResize } from "../../lib/observeResize";
import { cn, randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import {
  squireCapableAtom,
  squireEnvironment,
  useSquireEnvironmentState,
} from "../../state/squires";
import { useAtomCommand } from "../../state/use-atom-command";
import { squireComposerPlaceholder } from "../../composerPlaceholder";
import { useComposerDraftStore } from "../../composerDraftStore";
import { dispatchSnapShotComposerFocus } from "../../lib/desktopSnapShot";
import ChatView from "../ChatView";
import { useQuickSteer } from "../pullRequest/useQuickSteer";
import { SQUIRE_THREAD_CONTROLS } from "../chat/chatViewControls";
import { ComposerSendButton } from "../chat/ComposerPrimaryActions";
import { AppReferencesProvider } from "../embed/AppReferencesProvider";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SquireCompanionPanel } from "./companion/SquireCompanionPanel";
import { SquireLeadOnboarding } from "./lead/SquireLeadOnboarding";
import { useSquireLeadOpen } from "./lead/useSquireLeadOpen";
import { SquireQueue } from "./queue/SquireQueue";
import { openSquireSetup } from "./setup/squireSetupStore";
import { SquireBanners } from "./SquireBanners";
import { SquireHeader, SquireTopbar, useSquireHomeShell, useSquireIndicator } from "./SquireHeader";
import {
  nextSquireViewSearch,
  SQUIRE_CONVERSATION_COLLAPSED_DEFAULT,
  SQUIRE_HEADER_PORTRAIT_PX,
  squireConversationCollapsedKey,
  squireConversationHint,
  squireConversationLayout,
  squireExpandedQueueMaxHeight,
  squireConversationPane,
  squireMiniComposerDraft,
  type SquireConversationLayout,
  type SquireConversationPane,
  squirePageState,
  squireViewBreakpoint,
  squireViewLayout,
} from "./squirePage.logic";
import { squireViewForThread, type SquireViewSearch } from "./squireView.logic";

export function SquirePage(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly search: SquireViewSearch;
}) {
  const { environmentId, squireId } = props;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const state = useSquireEnvironmentState(environmentId);
  const page = squirePageState(
    config == null ? null : config.environment.capabilities.squire === true,
    state,
    squireId,
  );
  useMarkViewOpened(environmentId, page.status === "ready");

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      {page.status === "ready" ? (
        <SquireView
          environmentId={environmentId}
          entry={page.entry}
          isLead={page.isLead}
          team={page.team}
          search={props.search}
        />
      ) : page.status === "unavailable" ? (
        <>
          <WorkspacePageHeader electron={isElectron} />
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Squire not available</EmptyTitle>
              <EmptyDescription>
                This Squire was removed, or its environment does not run Squires.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </>
      ) : (
        <WorkspacePageHeader electron={isElectron} />
      )}
    </SidebarInset>
  );
}

/** Opening the view counts as activity even with no item opened. */
function useMarkViewOpened(environmentId: EnvironmentId, ready: boolean) {
  const allowed = useAtomValue(squireEnvironment.itemsMarkOpened.permissionAtom(environmentId));
  const markOpened = useAtomCommand(squireEnvironment.itemsMarkOpened, { reportFailure: false });
  // The route keys the page by Squire, so this holds once per view open.
  const marked = useRef(false);
  useEffect(() => {
    if (!ready || !allowed || marked.current) return;
    marked.current = true;
    void markOpened({ environmentId, input: { requestId: randomUUID(), cardIds: [] } });
  }, [allowed, environmentId, markOpened, ready]);
}

function SquireView(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly isLead: boolean;
  readonly team: ReadonlyArray<SquireSnapshotEntry>;
  readonly search: SquireViewSearch;
}) {
  const { environmentId, entry, search } = props;
  const squireId = entry.squire.id;
  const navigate = useNavigate();
  const [mainWidth, setMainWidth] = useState(0);
  const [inboxOpen, setInboxOpen] = useState(false);
  const layout = squireViewLayout(mainWidth, inboxOpen);
  const [collapsed, setCollapsed] = useLocalStorage(
    squireConversationCollapsedKey(environmentId, squireId),
    SQUIRE_CONVERSATION_COLLAPSED_DEFAULT,
    Schema.Boolean,
  );
  const pane = squireConversationPane(entry.squire);
  const conversation = squireConversationLayout(pane, collapsed);

  // Re-renders only when the width crosses a layout breakpoint, not on every resize step.
  const observeWidth = (element: HTMLDivElement | null) => {
    if (element === null) return;
    return observeResize(element, (entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width === undefined) return;
      setMainWidth((previous) =>
        squireViewBreakpoint(previous) === squireViewBreakpoint(width) ? previous : width,
      );
    });
  };

  const setSearch = (patch: Parameters<typeof nextSquireViewSearch>[1]) =>
    void navigate({
      to: "/squires/$environmentId/$squireId",
      params: { environmentId, squireId },
      search: nextSquireViewSearch(search, patch),
      replace: true,
    });
  const openSettings = () => openSquireSetup({ kind: "edit", environmentId, squireId });
  useSquireLeadOpen(environmentId, props.isLead);

  return (
    <div ref={observeWidth} className="@container/squire flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SquireTopbar
          environmentId={environmentId}
          squireId={squireId}
          name={entry.squire.name}
          inbox={{ offered: layout.inboxOffered, open: inboxOpen, onOpenChange: setInboxOpen }}
        />
        {/* The queue is the primary surface: it scrolls with the header, so an expanded card shows in full. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          style={
            conversation.kind === "expanded"
              ? { flex: "0 1 auto", maxHeight: squireExpandedQueueMaxHeight(conversation) }
              : undefined
          }
        >
          <SquireHeader
            environmentId={environmentId}
            entry={entry}
            team={props.team}
            teamFilter={search.squire ?? null}
            onTeamFilterChange={(squire) => setSearch({ squire })}
            portraitSize={SQUIRE_HEADER_PORTRAIT_PX}
            onOpenSettings={openSettings}
          />
          {props.isLead ? (
            <SquireLeadOnboarding
              environmentId={environmentId}
              lead={entry}
              showFigure={layout.companionPanel !== "shown"}
            />
          ) : null}
          <SquireQueue
            environmentId={environmentId}
            entry={entry}
            isLead={props.isLead}
            teamFilter={search.squire ?? null}
            chip={search.filter ?? "all"}
            onChipChange={(chip: SquireQueueChip) => setSearch({ chip })}
            selectedItemId={search.item ?? null}
            onSelectItem={(item: SquireCardId | null) => setSearch({ item })}
            layout={layout.queueLayout}
          />
        </div>
        {/* Holds sit right above the conversation they would steer. */}
        <SquireBanners environmentId={environmentId} entry={entry} />
        <SquireConversation
          environmentId={environmentId}
          entry={entry}
          pane={pane}
          layout={conversation}
          onCollapsedChange={setCollapsed}
        />
      </div>
      {/* Below 1,100 px or with the inbox open, the 64 px header portrait stands in. */}
      {layout.companionPanel === "shown" ? (
        <SquireCompanionPanel environmentId={environmentId} entry={entry} team={props.team} />
      ) : null}
    </div>
  );
}

/** The home thread's own view, secondary to the queue and collapsed until opened. */
function SquireConversation(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly pane: SquireConversationPane;
  readonly layout: SquireConversationLayout;
  readonly onCollapsedChange: (collapsed: boolean) => void;
}) {
  const { environmentId, entry, pane, layout } = props;
  const homeShell = useSquireHomeShell(environmentId, entry);
  const working = useSquireIndicator(environmentId, entry).state === "working";
  const expanded = layout.kind === "expanded";
  const [miniText, setMiniText] = useState("");
  // Set when the slim line expands the pane, so the real composer takes over the focus.
  const focusOnExpand = useRef(false);
  // A send from the slim line opens on its new turn, not on the newest card.
  const [openedBySend, setOpenedBySend] = useState(false);
  useEffect(() => {
    if (!expanded || !focusOnExpand.current) return;
    focusOnExpand.current = false;
    // Child effects run first, so the newly mounted ChatView already listens for this.
    dispatchSnapShotComposerFocus();
  }, [expanded]);

  const quickSend = useQuickSteer();
  // Opens the pane on send so the message and the reply show; a failed send lands in the real
  // composer's draft, after anything already there, so nothing typed is lost.
  const sendMini = async () => {
    if (pane.kind !== "thread") return;
    const text = miniText.trim();
    if (text === "") return;
    setMiniText("");
    focusOnExpand.current = true;
    setOpenedBySend(true);
    props.onCollapsedChange(false);
    const failure = await quickSend(environmentId, pane.threadId, text).then(
      () => null,
      (error: unknown) => error,
    );
    if (failure === null) return;
    const threadRef = scopeThreadRef(environmentId, pane.threadId);
    const drafts = useComposerDraftStore.getState();
    const draft = squireMiniComposerDraft(text, drafts.getComposerDraft(threadRef)?.prompt ?? null);
    if (draft !== null) drafts.setPrompt(threadRef, draft);
    toastManager.add({
      type: "error",
      title: failure instanceof Error ? failure.message : "The message could not be sent.",
      description: "It is kept in the conversation's composer.",
    });
  };

  if (pane.kind === "needs_provider") {
    return (
      <section aria-label="Conversation" className="shrink-0 border-t border-border">
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>{pane.title}</EmptyTitle>
            <EmptyDescription>
              {pane.description}{" "}
              <Link
                to="/settings/providers"
                search={{ environmentId }}
                className="text-primary underline underline-offset-4"
              >
                Provider settings
              </Link>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    );
  }
  if (pane.kind !== "thread" || layout.kind === "none" || layout.kind === "prompt") return null;
  const toggle = (
    <Button
      size="xs"
      variant="ghost"
      aria-expanded={expanded}
      onClick={() => {
        setOpenedBySend(false);
        props.onCollapsedChange(expanded);
      }}
    >
      <ChevronDownIcon className={cn("transition-transform", !expanded && "-rotate-90")} />
      Conversation
    </Button>
  );
  if (!expanded) {
    // ChatView stays unmounted while collapsed; its draft lives in the composer draft store.
    return (
      <section
        aria-label="Conversation"
        className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2"
      >
        <div className="flex shrink-0 items-center gap-2">
          {toggle}
          <span className="text-xs text-muted-foreground">
            {squireConversationHint(homeShell, working)}
          </span>
        </div>
        {/* One action sends, the way the notch quick steer does: the real composer is
            unmounted, so a hand-off to it needed a second Submit there. */}
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMini();
          }}
        >
          <Input
            size="sm"
            aria-label={`Message ${entry.squire.name}`}
            placeholder={
              squireComposerPlaceholder({ name: entry.squire.name, role: entry.squire.role }) ?? ""
            }
            value={miniText}
            onChange={(event) => setMiniText(event.target.value)}
          />
          {/* The full composer's own send face, so the collapsed composer's send matches it. */}
          <ComposerSendButton
            type="submit"
            aria-label={`Send to ${entry.squire.name}`}
            disabled={miniText.trim() === ""}
          >
            <SendIcon aria-hidden className="size-[19px]" strokeWidth={1.5} />
          </ComposerSendButton>
        </form>
      </section>
    );
  }
  return (
    <section
      aria-label="Conversation"
      className="flex min-h-0 flex-col border-t border-border"
      style={{ flex: "1 1 0" }}
    >
      <div className="flex shrink-0 items-center px-4 py-1">{toggle}</div>
      {/* ChatView fills a bounded flex box: its root is `flex min-h-0 flex-1 overflow-hidden`. */}
      <div className="flex min-h-0 flex-1">
        <AppReferencesProvider environmentId={environmentId} threadId={pane.threadId}>
          <ChatView
            environmentId={environmentId}
            threadId={pane.threadId}
            routeKind="server"
            controls={SQUIRE_THREAD_CONTROLS}
            // A tall showcase card opens at its top, not its tail above the composer.
            openAtNewestAppCard={!openedBySend}
          />
        </AppReferencesProvider>
      </div>
    </section>
  );
}

/**
 * A marked home thread opens as its Squire view. With the capability off the thread lists
 * as an ordinary one, so it stays on the thread route.
 */
export function useSquireViewForThread(
  threadRef: ScopedThreadRef | null,
  shell: { readonly squire?: SquireThreadMarker | undefined } | null,
) {
  const capable = useAtomValue(
    threadRef === null ? NOT_CAPABLE : squireCapableAtom(threadRef.environmentId),
  );
  return threadRef === null || !capable
    ? null
    : squireViewForThread(threadRef.environmentId, shell);
}

const NOT_CAPABLE = Atom.make(false);
