import { scopedProjectKey, scopeProjectRef } from "@lecturn/client-runtime/environment";
import { type ServerLifecycleWelcomePayload } from "@lecturn/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { readProject } from "../state/entities";
import { primaryServerConfigAtom, primaryServerWelcomeAtom } from "../state/server";
import { useUiStateStore } from "../uiStateStore";
import { AppSidebarLayout } from "./AppSidebarLayout";
import { CommandPalette } from "./CommandPalette";
import { ConfirmDialogHost } from "./ConfirmDialogHost";
import { AddProjectToMachineDialogHost } from "./AddProjectToMachineDialog";
import { CustomSnoozeDialogHost } from "./CustomSnoozeDialog";
import { ImportFolderSessionsDialog } from "./ImportFolderSessionsDialog";
import { NightlyMobileBetaNotice } from "./NightlyMobileBeta";
import { ProjectCloneToastCoordinator } from "./ProjectCloneToastCoordinator";
import { ProviderDetectionProgress } from "./ProviderDetectionProgress";
import { ReopenClosedViewShortcut } from "./ReopenClosedViewShortcut";
import { AppPairingPromptCoordinator } from "./apps/AppPairingPromptCoordinator";
import { GuestShareDialogHost } from "./chat/GuestShareControls";
import { ConnectOnboardingDialog } from "./cloud/ConnectOnboardingDialog";
import { RelayClientInstallDialog } from "./cloud/RelayClientInstallDialog";
import { DesktopAppActivationCoordinator } from "./desktop/DesktopAppActivationCoordinator";
import { DesktopWebLinkCoordinator } from "./desktop/DesktopWebLinkCoordinator";
import { RunningThreadKeepAlive } from "./desktop/RunningThreadKeepAlive";
import { SnapShotCoordinator } from "./desktop/SnapShotCoordinator";
import { SshPasswordPromptDialog } from "./desktop/SshPasswordPromptDialog";
import { FirstRunGate } from "./onboarding/FirstRunGate";
import { ChatGptWelcomeCoordinator } from "./settings/ChatGptWelcomeCoordinator";
import { ThemeEditorHost } from "./settings/ThemeEditorHost";
import { StaveWizardDialog } from "./stave/StaveWizardDialog";
import { SquireRoomCreateHost } from "./squire/rooms/SquireRoomCreateHost";
import { SquireKnockCoordinator } from "./squire/SquireKnock";
import { SquireSetupHost } from "./squire/setup/SquireSetupHost";

/**
 * The full app chrome (sidebar, command palette, coordinators). Loaded lazily by the root
 * route so routes that render without it, such as /embed, keep it out of their chunk graph.
 */
export default function AppShell({
  authGateState,
  pathname,
  returningFromWelcome,
}: {
  readonly authGateState: { readonly status: string };
  readonly pathname: string;
  readonly returningFromWelcome: boolean;
}) {
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";

  if (pathname === "/welcome") {
    return (
      <>
        <CustomSnoozeDialogHost />
        <GuestShareDialogHost />
        <CommandPalette>
          <AppSidebarLayout>
            <Outlet />
          </AppSidebarLayout>
        </CommandPalette>
      </>
    );
  }

  const appShell = (
    <CommandPalette>
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );

  return (
    <>
      <ChatGptWelcomeCoordinator />
      <FirstRunGate
        enabled={primaryEnvironmentAuthenticated}
        hostedStatic={authGateState.status === "hosted-static"}
      >
        {primaryEnvironmentAuthenticated ? <DesktopAppActivationCoordinator /> : null}
        {primaryEnvironmentAuthenticated ? <DesktopWebLinkCoordinator /> : null}
        {isElectron ? <RunningThreadKeepAlive /> : null}
        <RelayClientInstallDialog />
        <ConnectOnboardingDialog />
        {primaryEnvironmentAuthenticated ? <AppPairingPromptCoordinator /> : null}
        <SshPasswordPromptDialog />
        <SnapShotCoordinator />
        <ReopenClosedViewShortcut />
        <ConfirmDialogHost />
        <StaveWizardDialog />
        <SquireSetupHost />
        <SquireRoomCreateHost />
        <SquireKnockCoordinator />
        <ImportFolderSessionsDialog />
        <CustomSnoozeDialogHost />
        <GuestShareDialogHost />
        <ProjectCloneToastCoordinator />
        <AddProjectToMachineDialogHost />
        {primaryEnvironmentAuthenticated ? (
          <EventRouter skipInitialBootstrapNavigation={returningFromWelcome} />
        ) : null}
        {/* Hosted Nightly is "hosted-static", not authenticated, and needs it too. */}
        <NightlyMobileBetaNotice />
        {appShell}
        {primaryEnvironmentAuthenticated ? <ProviderDetectionProgress /> : null}
        {/* Above the router: a theme draft is judged by walking the app, so the
            editor has to survive navigation away from settings. */}
        <ThemeEditorHost />
      </FirstRunGate>
    </>
  );
}

function EventRouter({
  skipInitialBootstrapNavigation,
}: {
  readonly skipInitialBootstrapNavigation: boolean;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const skipInitialBootstrapNavigationRef = useRef(skipInitialBootstrapNavigation);

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    void (async () => {
      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      const bootstrapProject = readProject(
        scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
      );
      const bootstrapProjectKey =
        (bootstrapProject
          ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
          : null) ??
        (serverConfig?.cwd
          ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
          : null) ??
        scopedProjectKey(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        );
      useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

      if (readPathname() !== "/") {
        return;
      }
      if (skipInitialBootstrapNavigationRef.current) {
        skipInitialBootstrapNavigationRef.current = false;
        handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: payload.environment.environmentId,
          threadId: payload.bootstrapThreadId,
        },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  useEffect(() => {
    handleWelcome(serverWelcome);
  }, [serverWelcome]);

  return null;
}
