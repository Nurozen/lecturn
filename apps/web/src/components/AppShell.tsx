import { scopedProjectKey, scopeProjectRef } from "@lecturn/client-runtime/environment";
import { type ServerLifecycleWelcomePayload } from "@lecturn/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { applyAppearanceContrast } from "~/appearanceContrast";
import { applyAppearanceFontVariables } from "~/appearanceFonts";
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
import { CustomSnoozeDialogHost } from "./CustomSnoozeDialog";
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
import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import { ReopenClosedViewShortcut } from "./ReopenClosedViewShortcut";
import { BrowserChromeThemeSync, DocumentTitleSync } from "./RootDocumentSync";
import { SlowRpcRequestToastCoordinator } from "./SlowRpcRequestToastCoordinator";
import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";
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
          <DocumentTitleSync />
          <BrowserChromeThemeSync key={pathname} />
          <ContrastAppearanceSync />
          <EnvironmentThemeSync />
          <GlassAppearanceSync />
          <FontAppearanceSync />
          <ProviderAuthCallbackCoordinator />
          <CustomSnoozeDialogHost />
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
        <DocumentTitleSync />
        <BrowserChromeThemeSync key={pathname} />
        <ContrastAppearanceSync />
        <EnvironmentThemeSync />
        <GlassAppearanceSync />
        <FontAppearanceSync />
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
          <SshPasswordPromptDialog />
          <SnapShotCoordinator />
          <ThreadNotificationCoordinator />
          <ReopenClosedViewShortcut />
          <ConfirmDialogHost />
          <StaveWizardDialog />
          <ImportFolderSessionsDialog />
          <CustomSnoozeDialogHost />
          <SlowRpcRequestToastCoordinator />
          <PermissionUpdateNotice />
          {primaryEnvironmentAuthenticated ? <LegacyThreadMigrationToast /> : null}
          <ProjectCloneToastCoordinator />
          <PullRequestGuideRunCoordinator />
          <HostedStaticEnvironmentBootstrap />
          {primaryEnvironmentAuthenticated ? (
            <EventRouter skipInitialBootstrapNavigation={returningFromWelcome} />
          ) : null}
          {primaryEnvironmentAuthenticated ? <ProviderUpdateLaunchNotification /> : null}
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

function ContrastAppearanceSync() {
  const appearanceContrast = useClientSettings((settings) => settings.appearanceContrast);
  const diffColorScheme = useClientSettings((settings) => settings.diffColorScheme);

  useEffect(() => {
    document.documentElement.dataset.diffColorScheme = diffColorScheme;
  }, [diffColorScheme]);

  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  useEffect(() => {
    document.documentElement.dataset.chatWidth = chatWidth;
  }, [chatWidth]);

  useEffect(() => {
    applyAppearanceContrast(document.documentElement, appearanceContrast);
  }, [appearanceContrast]);

  return null;
}

function GlassAppearanceSync() {
  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);

  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--glass-opacity", `${glassOpacity}%`);
    if (glassOpacity === 100) {
      style.setProperty("--glass-blur", "0px");
    } else {
      style.removeProperty("--glass-blur");
    }
  }, [glassOpacity]);

  return null;
}

function FontAppearanceSync() {
  const fontFamilySans = useClientSettings((settings) => settings.fontFamilySans);
  const fontFamilyCode = useClientSettings((settings) => settings.fontFamilyCode);
  const fontFamilyComposer = useClientSettings((settings) => settings.fontFamilyComposer);
  const fontSizeInterface = useClientSettings((settings) => settings.fontSizeInterface);
  const fontSizePrompt = useClientSettings((settings) => settings.fontSizePrompt);
  const fontSizeCode = useClientSettings((settings) => settings.fontSizeCode);
  const fontSmoothing = useClientSettings((settings) => settings.fontSmoothing);

  useEffect(() => {
    applyAppearanceFontVariables(document.documentElement, {
      sans: fontFamilySans,
      code: fontFamilyCode,
      composer: fontFamilyComposer,
      sizeInterface: fontSizeInterface,
      sizePrompt: fontSizePrompt,
      sizeCode: fontSizeCode,
      smoothing: fontSmoothing,
    });
  }, [
    fontFamilyCode,
    fontFamilyComposer,
    fontFamilySans,
    fontSizeCode,
    fontSizeInterface,
    fontSizePrompt,
    fontSmoothing,
  ]);

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
