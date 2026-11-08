import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import {
  Outlet,
  createFileRoute,
  redirect,
  useMatches,
  useRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";
import type { ScopedThreadRef } from "@lecturn/contracts";

import { DesktopActivityBridge } from "../components/pullRequest/DesktopActivityBridge";
import { useForkThread } from "../hooks/useForkThread";
import { registerCommands } from "../shortcuts/dispatcher";
import { isCommandPaletteOpen } from "../commandPaletteBus";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

function readRouteThreadRef(router: AnyRouter): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  return target?.kind === "server" ? target.threadRef : null;
}

/** The Fork thread shortcut needs the fork command hook, so it registers from the layout. */
function ChatRouteForkShortcut() {
  const router = useRouter();
  const { forkThreadAtLatestTurn } = useForkThread();
  const forkRouteThread = useEffectEvent((threadRef: ScopedThreadRef) => {
    void forkThreadAtLatestTurn(threadRef);
  });
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- registers the fork command handler with the command registry until unmount
  useEffect(
    () =>
      registerCommands(
        {
          "chat.fork": (event) => {
            event.preventDefault();
            event.stopPropagation();
            // Only server threads fork; the fork callback toasts when provider or turn state blocks it.
            const threadRef = readRouteThreadRef(router);
            if (threadRef) forkRouteThread(threadRef);
          },
        },
        { when: () => !isCommandPaletteOpen() },
      ),
    [router],
  );
  return null;
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  // Settings and Usage render over the thread that opened them, so ChatView never remounts.
  const [backgroundTarget, setBackgroundTarget] = useState(threadTarget);
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(threadTarget)) {
    setBackgroundTarget(threadTarget);
  }
  const shownTarget = modalOpen ? backgroundTarget : threadTarget;
  return (
    <>
      {modalOpen ? null : <ChatRouteForkShortcut />}
      <DesktopActivityBridge />
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
