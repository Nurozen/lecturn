import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import type { ScopedThreadRef } from "@lecturn/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

import ChatView from "./ChatView";
import { AppReferencesProvider } from "./embed/AppReferencesProvider";
import { resolveDraftPromotionNavigationTarget, threadHasStarted } from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { SidebarInset } from "./ui/sidebar";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { useEnvironmentThreadRefs, useThreadRefs, useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import {
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteRenderState,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { resolveAccountGone, signedOutEnvironmentsAtom } from "../cloud/accountGone";
import { openThreadEnvironmentIdAtom } from "../cloud/accountPicker";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";

const AccountGoneNotice = lazy(() => import("./clerk/AccountGoneNotice"));

/**
 * Plain server threads are unkeyed, so navigating between them reuses one instance as ChatView
 * expects. Rendered by the `_chat` layout rather than by the two leaf routes, since an element
 * only survives a route swap when the same parent renders it.
 */
export function ThreadRouteView({ target }: { target: ThreadRouteTarget }) {
  const navigate = useNavigate();
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const threadRefs = useThreadRefs();
  // Promotion can begin before the server creates the reserved thread.
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef: ScopedThreadRef | null =
    target.kind === "server" ? target.threadRef : inferredThreadRef;
  const serverThread = useQuietThreadShell(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? serverThreadRef : null,
  );
  const canonicalThreadRef =
    target.kind === "draft"
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending,
        })
      : null;

  const shellStatus = useEnvironmentShellStatus(serverThreadRef?.environmentId ?? null);
  const serverThreadShell = serverThread;
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const promotedDraftId = useComposerDraftStore((store) =>
    target.kind === "server" ? store.getDraftIdByRef(target.threadRef) : null,
  );
  // The draft record is removed once the promoted thread has started, which
  // is after the route swap. Latch the key so the element that carried the
  // draft keeps its identity for as long as this thread stays on screen.
  const [chatViewKey, setChatViewKey] = useState<{ threadKey: string; key: string } | null>(null);
  const serverThreadKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : null;
  const nextChatViewKey =
    serverThreadKey === null
      ? null
      : chatViewKey?.threadKey === serverThreadKey
        ? chatViewKey
        : promotedDraftId
          ? { threadKey: serverThreadKey, key: promotedDraftId }
          : null;
  if (nextChatViewKey !== chatViewKey) {
    setChatViewKey(nextChatViewKey);
  }
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    serverThreadRef ? store.hasDraftThreadsInEnvironment(serverThreadRef.environmentId) : false,
  );
  // A server thread whose account signed out (or left the catalog) renders
  // the account-gone notice instead of a ChatView that can never sync.
  const routeThreadRef = target.kind === "server" ? target.threadRef : null;
  const signedOutEnvironments = useAtomValue(signedOutEnvironmentsAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const accountGone = resolveAccountGone({
    environmentId: routeThreadRef?.environmentId ?? null,
    signedOutEnvironments,
    environmentInCatalog:
      routeThreadRef !== null && catalog.entries.has(routeThreadRef.environmentId),
  });
  const renderState = resolveThreadRouteRenderState({
    accountGone: accountGone !== null,
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    draftThreadExists: draftThread !== null,
  });
  const serverThreadStarted = threadHasStarted(serverThreadShell);
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (target.kind !== "draft" || draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate, target.kind]);

  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete) {
      return;
    }
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, renderState, target]);

  // Settings replaces this route, so its account pickers default to the thread left behind.
  const openEnvironmentId = routeThreadRef?.environmentId ?? null;
  useEffect(() => {
    if (openEnvironmentId !== null) {
      appAtomRegistry.set(openThreadEnvironmentIdAtom, openEnvironmentId);
    }
  }, [openEnvironmentId]);

  useEffect(() => {
    if (target.kind !== "server" || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(target.threadRef);
  }, [draftThread, serverThreadStarted, target]);

  let view: React.ReactNode = null;
  if (target.kind === "draft") {
    if (draftSession) {
      // Wrapped like the server view below, so promotion keeps the ChatView mounted.
      view = (
        <AppReferencesProvider
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
        >
          <ChatView
            key={target.draftId}
            draftId={target.draftId}
            environmentId={draftSession.environmentId}
            threadId={draftSession.threadId}
            routeKind="draft"
            forceExpandedMobileComposer
          />
        </AppReferencesProvider>
      );
    }
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    view = (
      <AppReferencesProvider
        environmentId={target.threadRef.environmentId}
        threadId={target.threadRef.threadId}
      >
        <ChatView
          key={nextChatViewKey?.key}
          environmentId={target.threadRef.environmentId}
          threadId={target.threadRef.threadId}
          routeKind="server"
        />
      </AppReferencesProvider>
    );
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      {accountGone !== null ? (
        <Suspense fallback={null}>
          <AccountGoneNotice account={accountGone} />
        </Suspense>
      ) : null}
      {view}
    </SidebarInset>
  );
}
