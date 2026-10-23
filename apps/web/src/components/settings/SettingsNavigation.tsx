import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useSidebar } from "../ui/sidebar";

const ChatReturnContext = createContext<() => void>(() => undefined);

/** Keep the actual chat destination while settings sections change the history stack. */
export function SettingsNavigationProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const { pathname, historyIndex, isChat } = useRouterState({
    select: (state) => ({
      pathname: state.location.pathname,
      historyIndex: state.location.state.__TSR_index,
      isChat: state.matches.some(
        (match) =>
          match.pathname === state.location.pathname &&
          ["/_chat/", "/_chat/$environmentId/$threadId", "/_chat/draft/$draftId"].includes(
            match.routeId,
          ),
      ),
    }),
  });
  const chatReturn = useRef({ pathname: "/", index: historyIndex, remembered: false });
  useEffect(() => {
    if (isChat) chatReturn.current = { pathname, index: historyIndex, remembered: true };
    setOpenMobile(false);
  }, [isChat, pathname, historyIndex, setOpenMobile]);
  const backToChat = useStableCallback(() => {
    setOpenMobile(false);
    const destination = chatReturn.current;
    const delta = destination.index - router.history.location.state.__TSR_index;
    if (delta < 0) {
      if (!destination.remembered) {
        // A direct settings entry has no chat to restore. Replace that entry after
        // unwinding its sections so another Back cannot re-enter the settings loop.
        const unsubscribe = router.history.subscribe(() => {
          if (router.history.location.state.__TSR_index !== destination.index) return;
          unsubscribe();
          void navigate({ to: destination.pathname, replace: true });
        });
      }
      router.history.go(delta);
    } else {
      void navigate({ to: destination.pathname, replace: true });
    }
  });
  useEffect(() => {
    if (pathname !== "/settings" && !pathname.startsWith("/settings/")) return;
    const nativeBack = (event: Event) => {
      event.preventDefault();
      backToChat();
    };
    window.addEventListener("lecturn:native-back", nativeBack);
    return () => window.removeEventListener("lecturn:native-back", nativeBack);
  }, [pathname, backToChat]);
  return <ChatReturnContext value={backToChat}>{children}</ChatReturnContext>;
}

export function useBackToChat() {
  return useContext(ChatReturnContext);
}
