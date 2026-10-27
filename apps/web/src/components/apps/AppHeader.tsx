import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { ScopedProjectRef } from "@lecturn/contracts";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, ExternalLinkIcon, PlusIcon, SettingsIcon } from "lucide-react";

import { openAppUrl } from "../../lib/openAppUrl";
import { AppIcon } from "./AppIcon";
import { AppRowAction, AppRowTrailing, AppWorkingBadge } from "./AppRow";
import { appTargetWorkspace, appWorkspaceOpenUrl, type AppsSidebarApp } from "./AppsSidebar.logic";
import { useCanOpenApp } from "./useAppClosedBanner";
import { useAppPresentation } from "./useAppsSidebarApps";

/**
 * The selected app, drawn as one row like a project header: the way back to every app, who it
 * is, its state and working count, and what it can do from here.
 */
export function AppHeader({
  app,
  onBack,
  onNewThread,
}: {
  readonly app: AppsSidebarApp;
  readonly onBack: () => void;
  readonly onNewThread: (projectRef: ScopedProjectRef) => void;
}) {
  const router = useRouter();
  const presentation = useAppPresentation(app);
  const target = appTargetWorkspace(app);
  const canOpenApp = useCanOpenApp(target?.project.environmentId ?? null);
  const openUrl = canOpenApp ? appWorkspaceOpenUrl(presentation.openUrlTemplate, target) : null;
  return (
    <div
      data-thread-selection-safe
      data-testid="app-header"
      className="flex min-w-0 items-center gap-1 pb-2"
    >
      <AppRowAction label="Back to all apps" onClick={onBack}>
        <ArrowLeftIcon aria-hidden />
      </AppRowAction>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-xs font-medium text-sidebar-foreground">
        <AppIcon iconDataUrl={presentation.iconDataUrl} />
        <span className="min-w-0 truncate" data-testid="app-header-name">
          {presentation.name}
        </span>
      </span>
      <AppRowTrailing
        chip={presentation.chip}
        working={
          <AppWorkingBadge app={app} state={presentation.state} testId="app-header-working" />
        }
      >
        {target ? (
          <AppRowAction
            label={`New thread in ${target.project.title}`}
            onClick={() =>
              onNewThread(scopeProjectRef(target.project.environmentId, target.project.id))
            }
          >
            <PlusIcon aria-hidden />
          </AppRowAction>
        ) : null}
        {openUrl ? (
          <AppRowAction
            label={`Open in ${presentation.name}`}
            onClick={() => openAppUrl(openUrl, presentation.openUrlTemplate)}
          >
            <ExternalLinkIcon aria-hidden />
          </AppRowAction>
        ) : null}
        <AppRowAction
          label={`${presentation.name} settings`}
          onClick={() => void router.navigate({ to: "/settings/apps" })}
        >
          <SettingsIcon aria-hidden />
        </AppRowAction>
      </AppRowTrailing>
    </div>
  );
}
