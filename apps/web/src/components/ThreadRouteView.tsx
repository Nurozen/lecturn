import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

import ChatView from "./ChatView";
import { AppReferencesProvider } from "./embed/AppReferencesProvider";
import { BackgroundThreadContext } from "./chat/backgroundThread";
import { SidebarInset } from "./ui/sidebar";
import { useSquireViewForThread } from "./squire/SquirePage";
import { useComposerDraftStore } from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { useEnvironmentThreadRefs, useQuietThreadShell } from "../state/entities";
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
 * Unkeyed so navigating between server threads reuses one ChatView. Rendered by the `_chat`
 * layout, since an element only survives a route swap when the same parent renders it. Draft
 * promotion runs in the draft store; this only follows the redirect it leaves behind.
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
  const draftRedirect = useComposerDraftStore((store) =>
    draftId === null ? null : store.getPromotedDraftRedirect(draftId),
  );
  const serverThreadRef = target.kind === "server" ? target.threadRef : null;
  const serverThreadShell = useQuietThreadShell(serverThreadRef);
  const shellStatus = useEnvironmentShellStatus(serverThreadRef?.environmentId ?? null);
  // Lecturn: a marked home thread opens as its Squire view instead.
  const squireView = useSquireViewForThread(serverThreadRef, serverThreadShell);
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  // Reached from the sidebar before finalize, the thread still has its draft.
  const serverThreadDraftId = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftIdByRef(serverThreadRef) : null,
  );
  // The ChatView that carried a draft keeps its key through the redirect to its thread, and only
  // until the route leaves that thread, so later visits reuse the shared unkeyed ChatView.
  const [handoffKey, setHandoffKey] = useState<{ threadKey: string; key: string } | null>(null);
  const nextHandoffKey =
    draftId !== null && draftSession === null && draftRedirect
      ? handoffKey?.key === draftId
        ? handoffKey
        : { threadKey: scopedThreadKey(draftRedirect), key: draftId }
      : serverThreadRef && handoffKey?.threadKey === scopedThreadKey(serverThreadRef)
        ? handoffKey
        : serverThreadRef && serverThreadDraftId
          ? { threadKey: scopedThreadKey(serverThreadRef), key: serverThreadDraftId }
          : null;
  if (nextHandoffKey !== handoffKey) {
    setHandoffKey(nextHandoffKey);
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
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- clears pending file drops and navigates the router home once a server thread is confirmed missing
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
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- replaces the router location with the squire route when this thread belongs to a squire
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
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- writes the open thread's environment into the app atom registry for settings account pickers
  useEffect(() => {
    if (openEnvironmentId !== null) {
      appAtomRegistry.set(openThreadEnvironmentIdAtom, openEnvironmentId);
    }
  }, [openEnvironmentId]);

  let view: React.ReactNode = null;
  let redirect: React.ReactNode = null;
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
    } else if (draftRedirect) {
      // Same slot, wrapper and key as the server route renders, so the swap keeps this instance.
      view = (
        <AppReferencesProvider
          environmentId={draftRedirect.environmentId}
          threadId={draftRedirect.threadId}
        >
          <ChatView
            key={target.draftId}
            environmentId={draftRedirect.environmentId}
            threadId={draftRedirect.threadId}
            routeKind="server"
          />
        </AppReferencesProvider>
      );
      redirect = (
        <Navigate
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(draftRedirect)}
          replace
        />
      );
    } else {
      redirect = <Navigate to="/" replace />;
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
          key={nextHandoffKey?.key}
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
      {background ? null : redirect}
    </SidebarInset>
  );
}
