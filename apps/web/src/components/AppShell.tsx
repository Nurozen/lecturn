import { scopedProjectKey, scopeProjectRef } from "@lecturn/client-runtime/environment";
import { type ServerLifecycleWelcomePayload } from "@lecturn/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import { useDefaultThemeAdoption } from "../hooks/useDefaultTheme";
import { useEnvironmentThemeSync } from "../hooks/useEnvironmentTheme";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { configureClientTracing } from "../observability/clientTracing";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import { readProject, setActiveEnvironmentId, useActiveEnvironmentId } from "../state/entities";
import {
  primaryServerConfigAtom,
  primaryServerConfigEventAtom,
  primaryServerWelcomeAtom,
} from "../state/server";
import { useUiStateStore } from "../uiStateStore";
import { AppSidebarLayout } from "./AppSidebarLayout";
import { CommandPalette } from "./CommandPalette";
import { ConfirmDialogHost } from "./ConfirmDialogHost";
import { AddProjectToMachineDialogHost } from "./AddProjectToMachineDialog";
import { CustomSnoozeDialogHost } from "./CustomSnoozeDialog";
import { HostFreezeToastCoordinator } from "./HostFreezeToastCoordinator";
import { ImportFolderSessionsDialog } from "./ImportFolderSessionsDialog";
import { KeybindingsConfigWarning } from "./KeybindingsConfigWarning";
import {
  createKeybindingsUpdateToastController,
  type KeybindingsUpdateToastController,
} from "./KeybindingsUpdateToast.logic";
import { LegacyThreadMigrationToast } from "./LegacyThreadMigrationToast";
import { NightlyMobileBetaNotice } from "./NightlyMobileBeta";
import { PermissionUpdateNotice } from "./PermissionUpdateNotice";
import { ProjectCloneToastCoordinator } from "./ProjectCloneToastCoordinator";
import { ProviderDetectionProgress } from "./ProviderDetectionProgress";
import { ReopenClosedViewShortcut } from "./ReopenClosedViewShortcut";
import { BrowserChromeThemeSync } from "./RootDocumentSync";
import { SlowRpcRequestToastCoordinator } from "./SlowRpcRequestToastCoordinator";
import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";
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
import { PullRequestGuideRunCoordinator } from "./pullRequest/guide/PullRequestGuideRunCoordinator";
import { ChatGptWelcomeCoordinator } from "./settings/ChatGptWelcomeCoordinator";
import { ProviderAuthCallbackCoordinator } from "./settings/ProviderAuthCallbackCoordinator";
import { ThemeEditorHost } from "./settings/ThemeEditorHost";
import { DesktopUpdateLaunchNotice } from "./sidebar/updateEverythingRun";
import { StaveWizardDialog } from "./stave/StaveWizardDialog";
import { SquireRoomCreateHost } from "./squire/rooms/SquireRoomCreateHost";
import { SquireKnockCoordinator } from "./squire/SquireKnock";
import { SquireSetupHost } from "./squire/setup/SquireSetupHost";
import { AnchoredToastProvider, stackedThreadToast, ToastProvider, toastManager } from "./ui/toast";

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
      <ToastProvider>
        <AnchoredToastProvider>
          <BrowserChromeThemeSync key={pathname} />
          <EnvironmentThemeSync />
          <ProviderAuthCallbackCoordinator />
          <CustomSnoozeDialogHost />
          <GuestShareDialogHost />
          <CommandPalette>
            <AppSidebarLayout>
              <Outlet />
            </AppSidebarLayout>
          </CommandPalette>
        </AnchoredToastProvider>
      </ToastProvider>
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
    <ToastProvider>
      <AnchoredToastProvider>
        <BrowserChromeThemeSync key={pathname} />
        <EnvironmentThemeSync />
        <ProviderAuthCallbackCoordinator />
        <ChatGptWelcomeCoordinator />
        <FirstRunGate
          enabled={primaryEnvironmentAuthenticated}
          hostedStatic={authGateState.status === "hosted-static"}
        >
          {primaryEnvironmentAuthenticated ? <AuthenticatedTracingBootstrap /> : null}
          {primaryEnvironmentAuthenticated ? <DesktopAppActivationCoordinator /> : null}
          {primaryEnvironmentAuthenticated ? <DesktopWebLinkCoordinator /> : null}
          {isElectron ? <RunningThreadKeepAlive /> : null}
          <RelayClientInstallDialog />
          <ConnectOnboardingDialog />
          {primaryEnvironmentAuthenticated ? <AppPairingPromptCoordinator /> : null}
          <SshPasswordPromptDialog />
          <SnapShotCoordinator />
          <ThreadNotificationCoordinator />
          <ReopenClosedViewShortcut />
          <ConfirmDialogHost />
          <StaveWizardDialog />
          <SquireSetupHost />
          <SquireRoomCreateHost />
          <SquireKnockCoordinator />
          <ImportFolderSessionsDialog />
          <CustomSnoozeDialogHost />
          <GuestShareDialogHost />
          <SlowRpcRequestToastCoordinator />
          <HostFreezeToastCoordinator />
          <PermissionUpdateNotice />
          {primaryEnvironmentAuthenticated ? <LegacyThreadMigrationToast /> : null}
          <ProjectCloneToastCoordinator />
          <AddProjectToMachineDialogHost />
          <PullRequestGuideRunCoordinator />
          <HostedStaticEnvironmentBootstrap />
          {primaryEnvironmentAuthenticated ? (
            <EventRouter skipInitialBootstrapNavigation={returningFromWelcome} />
          ) : null}
          {isElectron ? <DesktopUpdateLaunchNotice /> : null}
          {/* Hosted Nightly is "hosted-static", not authenticated, and needs it too. */}
          <NightlyMobileBetaNotice />
          {appShell}
          {primaryEnvironmentAuthenticated ? <ProviderDetectionProgress /> : null}
          {/* Above the router: a theme draft is judged by walking the app, so the
              editor has to survive navigation away from settings. */}
          <ThemeEditorHost />
        </FirstRunGate>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function EnvironmentThemeSync() {
  useEnvironmentThemeSync();
  // Ordered after the palette sync so a first-run client adopting the
  // environment's own theme finds it already in the library.
  useDefaultThemeAdoption();
  return null;
}

function HostedStaticEnvironmentBootstrap() {
  const { environments } = useEnvironments();
  const activeEnvironmentId = useActiveEnvironmentId();

  useEffect(() => {
    if (
      environments.some(
        (environment) => environment.entry.target._tag === "PrimaryConnectionTarget",
      )
    ) {
      return;
    }

    if (activeEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = environments[0];
    if (!firstSavedEnvironment) {
      return;
    }

    setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [activeEnvironmentId, environments]);

  return null;
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => {
    void configureClientTracing();
  }, []);

  return null;
}

function EventRouter({
  skipInitialBootstrapNavigation,
}: {
  readonly skipInitialBootstrapNavigation: boolean;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironment = usePrimaryEnvironment();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverConfigEvent = useAtomValue(primaryServerConfigEventAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const skipInitialBootstrapNavigationRef = useRef(skipInitialBootstrapNavigation);
  const handledConfigEventRef = useRef(serverConfigEvent);
  const [keybindingsToastController] = useState<KeybindingsUpdateToastController>(() =>
    createKeybindingsUpdateToastController({}),
  );

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    setActiveEnvironmentId(payload.environment.environmentId);
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

  const handleServerConfigUpdated = useEffectEvent(() => {
    const decision = keybindingsToastController.handle(serverConfigEvent);
    if (!decision) {
      return;
    }

    if (decision._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Keybindings updated",
        description: "Keybindings configuration reloaded successfully.",
      });
      return;
    }

    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: (
          <KeybindingsConfigWarning
            message={decision.message}
            environmentId={primaryEnvironment?.environmentId ?? null}
            configPath={serverConfig?.keybindingsConfigPath ?? null}
            availableEditors={serverConfig?.availableEditors ?? []}
          />
        ),
      }),
    );
  });

  useEffect(() => {
    if (!serverConfig) {
      return;
    }

    setActiveEnvironmentId(serverConfig.environment.environmentId);
  }, [serverConfig]);

  useEffect(() => {
    handleWelcome(serverWelcome);
  }, [serverWelcome]);

  useEffect(() => {
    if (serverConfigEvent === null || handledConfigEventRef.current === serverConfigEvent) {
      return;
    }
    handledConfigEventRef.current = serverConfigEvent;
    handleServerConfigUpdated();
  }, [serverConfigEvent]);

  return null;
}
