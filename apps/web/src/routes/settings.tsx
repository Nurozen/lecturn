import { AccountSurface } from "../components/AccountSurface";
import { ArrowLeftIcon, RotateCcwIcon } from "lucide-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useCanGoBack,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { PhoneSettingsCategorySelect } from "../components/settings/PhoneSettingsCategorySelect";
import "../components/settings/project-settings-glass.css";
import { Button } from "../components/ui/button";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useBackToChat } from "../components/settings/SettingsNavigation";
import { usePhoneAuthViewport } from "../onboarding/usePhoneAuthViewport";
import "../components/settings/phone-settings.css";

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);

  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      Restore defaults
    </Button>
  );
}

function SettingsContentLayout() {
  const location = useLocation();
  const backToChat = useBackToChat();
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const navigateBackWithinApp = useCallback(() => {
    if (isMobile) backToChat();
    else if (canGoBack) window.history.back();
    else void navigate({ to: "/" });
  }, [backToChat, canGoBack, isMobile, navigate]);
  const viewportRef = usePhoneAuthViewport(!isElectron);
  const [restoreSignal, setRestoreSignal] = useState(0);
  const showRestoreDefaults = location.pathname === "/settings/general";
  const handleRestored = () => setRestoreSignal((value) => value + 1);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // A nested settings dialog owns Escape and returns focus to its trigger.
      if (event.target instanceof HTMLElement && event.target.closest('[role="dialog"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();

        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) {
          activeElement.blur();
        }

        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset
      ref={viewportRef}
      className="phone-settings-viewport h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate"
      data-settings-page-layout
    >
      <AccountSurface className="lecturn-settings-surface lecturn-project-settings flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 w-full items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-label="Back to chat"
              className="min-h-11 shrink-0 md:hidden"
              onClick={navigateBackWithinApp}
            >
              <ArrowLeftIcon className="size-4" />
              <span className="hidden sm:inline">Back to chat</span>
              <span className="sm:hidden">Chat</span>
            </Button>
            <div className="min-w-0 flex-1 md:hidden">
              <PhoneSettingsCategorySelect />
            </div>
            <div className="hidden min-w-0 flex-1 md:block">
              <SettingsBreadcrumb pathname={location.pathname} />
            </div>
            {showRestoreDefaults ? (
              <div className="ms-auto hidden items-center gap-2 sm:flex">
                <RestoreDefaultsButton onRestored={handleRestored} />
              </div>
            ) : null}
          </div>
        </WorkspacePageHeader>

        {showRestoreDefaults ? (
          <div className="flex shrink-0 justify-end px-4 pb-2 sm:hidden">
            <RestoreDefaultsButton onRestored={handleRestored} />
          </div>
        ) : null}
        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </AccountSurface>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
