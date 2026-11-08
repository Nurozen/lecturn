import { useAtomValue } from "@effect/atom-react";
import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SquireId,
  SquireThreadMarker,
} from "@lecturn/contracts";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { observeResize } from "../../lib/observeResize";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import {
  squireCapableAtom,
  squireEnvironment,
  useSquireEnvironmentState,
} from "../../state/squires";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { SQUIRE_THREAD_CONTROLS } from "../chat/chatViewControls";
import { AppReferencesProvider } from "../embed/AppReferencesProvider";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SquireCompanionPanel } from "./companion/SquireCompanionPanel";
import { SquireLeadOnboarding, useSquireLeadOnboardingCardIds } from "./lead/SquireLeadOnboarding";
import { useSquireLeadOpen } from "./lead/useSquireLeadOpen";
import { openSquireSetup } from "./setup/squireSetupStore";
import { SquireBanners } from "./SquireBanners";
import { SquireTopbar } from "./SquireHeader";
import { squireConversationPane, squirePageState, squireViewWide } from "./squirePage.logic";
import { squireViewForThread } from "./squireView.logic";
import { useSquireChatApprovals } from "./chat/squireApprovalsState";

export function SquirePage(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
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
          chatFirst={config?.environment.capabilities.squireChatFirst === true}
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
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- sends the server one mark-opened request per view open once the view is ready and allowed
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
  readonly chatFirst: boolean;
}) {
  const { environmentId, entry } = props;
  const squireId = entry.squire.id;
  const [wide, setWide] = useState(false);
  const observeWidth = (element: HTMLDivElement | null) => {
    if (element === null) return;
    return observeResize(element, (entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width !== undefined) setWide(squireViewWide(width));
    });
  };
  useSquireLeadOpen(environmentId, props.isLead);

  return (
    <div ref={observeWidth} className="@container/squire flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SquireTopbar
          environmentId={environmentId}
          entry={entry}
          isLead={props.isLead}
          onOpenSettings={() => openSquireSetup({ kind: "edit", environmentId, squireId })}
        />
        {props.isLead ? (
          <div className="max-h-1/2 shrink-0 overflow-y-auto">
            <SquireLeadOnboarding environmentId={environmentId} lead={entry} showFigure={!wide} />
          </div>
        ) : null}
        {/* Holds sit right above the conversation they would steer. */}
        <SquireBanners environmentId={environmentId} entry={entry} />
        <SquireConversation
          environmentId={environmentId}
          entry={entry}
          isLead={props.isLead}
          chatFirst={props.chatFirst}
        />
      </div>
      {/* Below 1,100 px the topbar portrait stands in. */}
      {wide ? <SquireCompanionPanel environmentId={environmentId} entry={entry} /> : null}
    </div>
  );
}

/** The page is the chat: the home thread's ChatView, with approvals at their place in it. */
function SquireConversation(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly isLead: boolean;
  readonly chatFirst: boolean;
}) {
  const { environmentId, entry, isLead, chatFirst } = props;
  const squireId = entry.squire.id;
  const pane = squireConversationPane(entry.squire);
  const shownAbove = useSquireLeadOnboardingCardIds(environmentId, isLead ? squireId : null);
  const approvals = useSquireChatApprovals({
    environmentId,
    squireId,
    isLead,
    chatFirst,
    shownAbove,
  });

  if (pane.kind === "needs_provider") {
    return (
      <section aria-label="Conversation" className="min-h-0 flex-1 border-t border-border">
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
  if (pane.kind !== "thread") return null;
  return (
    <section aria-label="Conversation" className="flex min-h-0 flex-1">
      {/* ChatView fills a bounded flex box: its root is `flex min-h-0 flex-1 overflow-hidden`. */}
      <AppReferencesProvider environmentId={environmentId} threadId={pane.threadId}>
        <ChatView
          environmentId={environmentId}
          threadId={pane.threadId}
          routeKind="server"
          controls={SQUIRE_THREAD_CONTROLS}
          // A tall showcase card opens at its top, not its tail above the composer.
          openAtNewestAppCard
          squireApprovals={approvals}
        />
      </AppReferencesProvider>
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
