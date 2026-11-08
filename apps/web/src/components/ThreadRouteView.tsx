import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import type { ScopedThreadRef } from "@lecturn/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

import ChatView from "./ChatView";
import { AppReferencesProvider } from "./embed/AppReferencesProvider";
import { BackgroundThreadContext } from "./chat/backgroundThread";
import { resolveDraftPromotionNavigationTarget, threadHasStarted } from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { SidebarInset } from "./ui/sidebar";
import { useSquireViewForThread } from "./squire/SquirePage";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { useEnvironmentThreadRefs, useThreadRefs, useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
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
 * Render in the shared layout to retain ChatView across route swaps; plain server threads remain unkeyed.
 * `background` keeps the thread mounted, inert and in place under Settings or Usage.
 */
export function ThreadRouteView({
  target,
  background = false,
}: {
  target: ThreadRouteTarget;
  background?: boolean;
}) {
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
  // Lecturn: a marked home thread opens as its Squire view instead.
  const squireView = useSquireViewForThread(
    target.kind === "server" ? target.threadRef : null,
    serverThreadShell,
  );
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const promotedDraftId = useComposerDraftStore((store) =>
    target.kind === "server" ? store.getDraftIdByRef(target.threadRef) : null,
  );
  // Latch the key through promotion because the draft record disappears after the route swap.
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
  // Until the shell lists the thread, its own load (HTTP, then the socket)
  // decides whether it exists. Read only then: once listed, ChatView keeps
  // this stream open and its updates need not re-render the route.
  const unlistedThreadRef =
    target.kind === "server" && serverThreadShell === null && draftThread === null
      ? target.threadRef
      : null;
  const unlistedThreadDetail = useEnvironmentThread(
    unlistedThreadRef?.environmentId ?? null,
    unlistedThreadRef?.threadId ?? null,
  );
  const renderState = resolveThreadRouteRenderState({
    accountGone: accountGone !== null,
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    unlistedThreadDetail,
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
    if (!canonicalThreadRef || background) {
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
  }, [background, canonicalThreadRef, navigate]);

  useEffect(() => {
    if (background || target.kind !== "draft" || draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [background, canonicalThreadRef, draftSession, navigate, target.kind]);

  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete) {
      return;
    }
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads && !background) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [background, bootstrapComplete, environmentHasAnyThreads, navigate, renderState, target]);

  // Lecturn: replace, so Back skips the thread route that only redirects.
  const squireViewEnvironmentId = squireView?.environmentId ?? null;
  const squireViewSquireId = squireView?.squireId ?? null;
  useEffect(() => {
    if (background || squireViewEnvironmentId === null || squireViewSquireId === null) return;
    void navigate({
      to: "/squires/$environmentId/$squireId",
      params: { environmentId: squireViewEnvironmentId, squireId: squireViewSquireId },
      replace: true,
    });
  }, [background, navigate, squireViewEnvironmentId, squireViewSquireId]);

  // Settings opens over this thread, so its account pickers default to it.
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
  } else if (
    // Lecturn: a home thread redirecting to its Squire view never mounts ChatView here.
    squireView === null &&
    (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null))
  ) {
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
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={background}
    >
      {accountGone !== null ? (
        <Suspense fallback={null}>
          <AccountGoneNotice account={accountGone} />
        </Suspense>
      ) : null}
      <BackgroundThreadContext value={background}>{view}</BackgroundThreadContext>
    </SidebarInset>
  );
}
