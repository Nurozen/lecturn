import { AccountSurface } from "../components/AccountSurface";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeftIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useSettingsRestore } from "../components/settings/SettingsPanels";

import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { PhoneSettingsCategorySelect } from "../components/settings/PhoneSettingsCategorySelect";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useBackToChat } from "../components/settings/SettingsNavigation";
import { usePhoneAuthViewport } from "../onboarding/usePhoneAuthViewport";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { useEnvironments } from "../state/environments";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SETTINGS_DEVICE_ONLY_PATHS } from "../components/settings/SettingsScopeSentence";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
} from "../components/settings/settingsSearch";

function RestoreDeviceDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      Restore device defaults
    </Button>
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash);
  const autoSettlementAvailability = searchTarget?.requiresThreadAutoSettlement
    ? getThreadAutoSettlementSearchAvailability(environments, scope)
    : null;
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    autoSettlementAvailability &&
    !autoSettlementAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={autoSettlementAvailability.eligibleEnvironmentIds}
      >
        {autoSettlementAvailability.eligibleEnvironmentIds.length > 0
          ? `${searchTarget.title} requires a supporting environment. Choose one to continue.`
          : `${searchTarget.title} requires a supporting environment. Connect or update an environment to continue.`}
      </SettingsScopeNotice>
    );
  }
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {`${searchTarget.title} is not available for the selected target. Choose its owning scope to continue.`}
      </SettingsScopeNotice>
    );
  }
  if (SETTINGS_DEVICE_ONLY_PATHS.has(pathname) || pathname === "/settings/projects") {
    return children;
  }
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">{scope.message}</p>
      </SettingsPageContainer>
    );
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Reconnect {scope.label} to change its settings.
        </p>
      </SettingsPageContainer>
    );
  }
  return children;
}

function SettingsContentLayout() {
  const location = useLocation();
  const backToChat = useBackToChat();
  const { isMobile } = useSidebar();
  const navigateToMainApp = useNavigateToMainApp();
  const { search, environment } = useSettingsScope();
  const contentScopeKey =
    location.pathname === "/settings/diagnostics" || location.pathname === "/settings/providers"
      ? environment?.environmentId
      : JSON.stringify(search);
  // Phones unwind to the chat they came from; wider layouts return to the
  // last main app page however many utility pages were visited since.
  const navigateBackWithinApp = useCallback(() => {
    if (isMobile) backToChat();
    else void navigateToMainApp();
  }, [backToChat, isMobile, navigateToMainApp]);
  const viewportRef = usePhoneAuthViewport(!isElectron);
  const [restoreSignal, setRestoreSignal] = useState(0);
  const showRestoreDefaults = location.pathname === "/settings/general";
  const handleRestored = () => setRestoreSignal((value) => value + 1);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
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
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate"
    >
      <AccountSurface className="phone-settings-viewport lecturn-settings-surface lecturn-project-settings flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
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
              <div className="ms-auto hidden shrink-0 items-center gap-2 sm:flex">
                <RestoreDeviceDefaultsButton onRestored={handleRestored} />
              </div>
            ) : null}
          </div>
        </WorkspacePageHeader>

        {showRestoreDefaults ? (
          <div className="flex shrink-0 justify-end px-4 pb-2 sm:hidden">
            <RestoreDeviceDefaultsButton onRestored={handleRestored} />
          </div>
        ) : null}
        <div key={`${contentScopeKey}:${restoreSignal}`} className="min-h-0 flex flex-1 flex-col">
          <SettingsScopeBoundary pathname={location.pathname}>
            <Outlet />
          </SettingsScopeBoundary>
        </div>
      </AccountSurface>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsScopeProvider
      search={rawSearch}
      singleEnvironment={pathname === "/settings/providers"}
      onChange={(next) => {
        // Send every axis so the retain middleware sees an explicit target
        // even when the choice is "all", which is the absence of a key.
        void navigate({
          to: pathname,
          search: () => ({
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
          }),
          hash: "",
          resetScroll: false,
        });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
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
