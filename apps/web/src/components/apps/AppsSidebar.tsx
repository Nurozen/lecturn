import type { EnvironmentId, ScopedProjectRef } from "@lecturn/contracts";
import { useRouter } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { resolveActiveThreadRouteRef } from "../../threadRoutes";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarHierarchyPanel } from "../sidebar/SidebarHierarchyPanel";
import { Button } from "../ui/button";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { AppHeader } from "./AppHeader";
import { AppPairingRow } from "./AppPairingRow";
import { AppRow } from "./AppRow";
import { AppsGroup } from "./AppsGroup";
import { AppsModeSwitch } from "./AppsModeSwitch";
import {
  appsNewThreadWorkspace,
  appsSidebarActiveThreadKey,
  appsSidebarVisibleThreads,
  appTreeGroupKey,
  isAppTreeGroupCollapsed,
  resolveAppsSidebarScope,
  type AppsSidebarApp,
  type AppTreeGroup,
} from "./AppsSidebar.logic";
import { AppWorkspaceTree, type AppThreadSupport, type AppTreeContext } from "./AppWorkspaceTree";
import { useAppsSidebarApps } from "./useAppsSidebarApps";
import {
  useAppsSidebarThreadJumps,
  usePublishAppsNewThreadTarget,
} from "./useAppsSidebarShortcuts";
import { useAppThreadActions } from "./useAppThreadActions";

// One object per combination keeps memoized rows from re-rendering on every tree render.
const THREAD_SUPPORT: Readonly<Record<string, AppThreadSupport>> = {
  "false:false": { pinning: false, settlement: false },
  "false:true": { pinning: false, settlement: true },
  "true:false": { pinning: true, settlement: false },
  "true:true": { pinning: true, settlement: true },
};

function AppsEmptyState() {
  const router = useRouter();
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-sidebar-muted-foreground"
    >
      <LayoutGridIcon aria-hidden className="size-5" />
      <p>No connected apps yet. An app asks to connect from its own window.</p>
      <Button
        size="xs"
        variant="outline"
        onClick={() => void router.navigate({ to: "/settings/apps" })}
      >
        Connected apps settings
      </Button>
    </div>
  );
}

function AppEntry({
  app,
  context,
  onSelect,
}: {
  readonly app: AppsSidebarApp;
  readonly context: AppTreeContext;
  readonly onSelect: () => void;
}) {
  const group = { kind: "app", appId: app.appId } as const;
  const collapsed = isAppTreeGroupCollapsed(context.collapsedByKey, group);
  return (
    <li className="list-none">
      <AppRow
        app={app}
        collapsed={collapsed}
        onToggle={() => context.onToggle(group)}
        onSelect={onSelect}
        onNewThread={context.onNewThread}
      />
      <SidebarHierarchyPanel open={!collapsed}>
        <ul className="flex flex-col">
          {app.pairing.map((pairing) => (
            <AppPairingRow key={pairing.key} pairing={pairing} />
          ))}
          <AppWorkspaceTree app={app} context={context} />
        </ul>
      </SidebarHierarchyPanel>
    </li>
  );
}

/**
 * Apps mode's sidebar body: every connected app with its workspaces, or one app under its
 * header. It renders in place of the Projects tree and shares the sidebar's header.
 */
export function AppsSidebar() {
  const apps = useAppsSidebarApps();
  const scopeKey = useUiStateStore((state) => state.sidebarAppScopeKey);
  const setScopeKey = useUiStateStore((state) => state.setSidebarAppScopeKey);
  const collapsedByKey = useUiStateStore((state) => state.sidebarAppCollapsedByKey);
  const setCollapsed = useUiStateStore((state) => state.setSidebarAppCollapsed);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const serverConfigs = useServerConfigs();
  const actions = useAppThreadActions();
  const handleNewThread = useNewThreadHandler();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const threads = useThreadShells();

  const selected = resolveAppsSidebarScope(apps, scopeKey);
  const activeThreadKey = appsSidebarActiveThreadKey(routeThreadRef, threads);
  const jumpLabelByKey = useAppsSidebarThreadJumps({
    threads: appsSidebarVisibleThreads({ apps, selected, collapsedByKey }),
    routeThreadRef,
    routeRowThreadKey: activeThreadKey,
    open: actions.open,
  });
  usePublishAppsNewThreadTarget(appsNewThreadWorkspace({ apps, selected, activeThreadKey }));
  const selectApp = (appId: string | null) => {
    clearSelection();
    setScopeKey(appId);
  };
  const context: AppTreeContext = {
    collapsedByKey,
    onToggle: (group: AppTreeGroup) =>
      setCollapsed(appTreeGroupKey(group), !isAppTreeGroupCollapsed(collapsedByKey, group)),
    activeThreadKey,
    jumpLabelByKey,
    actions,
    supports: (environmentId: EnvironmentId) => {
      const capabilities = serverConfigs.get(environmentId)?.environment.capabilities;
      return THREAD_SUPPORT[
        `${capabilities?.threadPinning === true}:${capabilities?.threadSettlement === true}`
      ]!;
    },
    onNewThread: (projectRef: ScopedProjectRef) => {
      if (isMobile) setOpenMobile(false);
      void handleNewThread(projectRef);
    },
  };

  if (apps.length === 0) return <AppsEmptyState />;
  return (
    <TooltipProvider delay={150} closeDelay={0} timeout={400}>
      {selected ? (
        <>
          <AppHeader
            app={selected}
            onBack={() => selectApp(null)}
            onNewThread={context.onNewThread}
          />
          <AppsGroup>
            {selected.pairing.map((pairing) => (
              <AppPairingRow key={pairing.key} pairing={pairing} />
            ))}
            <AppWorkspaceTree app={selected} context={context} />
          </AppsGroup>
        </>
      ) : (
        <AppsGroup>
          {apps.map((app) => (
            <AppEntry
              key={app.appId}
              app={app}
              context={context}
              onSelect={() => selectApp(app.appId)}
            />
          ))}
        </AppsGroup>
      )}
    </TooltipProvider>
  );
}

/**
 * Apps mode for the legacy sidebar, which keeps its own Projects body: the same chrome
 * around the Apps body.
 */
export function StandaloneAppsSidebar() {
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <div className="flex flex-col gap-1">
              <AppsModeSwitch />
            </div>
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
          <AppsSidebar />
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
