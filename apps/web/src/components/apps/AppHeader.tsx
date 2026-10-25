import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { ScopedProjectRef } from "@lecturn/contracts";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, ExternalLinkIcon, PlusIcon, SettingsIcon } from "lucide-react";

import { openAppUrl } from "../../lib/openAppUrl";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AppIcon } from "./AppIcon";
import { appTargetWorkspace, appWorkspaceOpenUrl, type AppsSidebarApp } from "./AppsSidebar.logic";
import { useCanOpenApp } from "./useAppClosedBanner";
import { useAppPresentation } from "./useAppsSidebarApps";

/** The selected app: who it is, what it can do from here, and the way back to every app. */
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
    <div data-thread-selection-safe data-testid="app-header" className="flex flex-col gap-1.5 pb-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Back to all apps"
          onClick={onBack}
        >
          <ArrowLeftIcon aria-hidden />
        </Button>
        <AppIcon iconDataUrl={presentation.iconDataUrl} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
          {presentation.name}
        </span>
        {presentation.chip ? (
          <Badge variant={presentation.chip.variant} size="sm">
            {presentation.chip.label}
          </Badge>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`${presentation.name} settings`}
          onClick={() => void router.navigate({ to: "/settings/apps" })}
        >
          <SettingsIcon aria-hidden />
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {target ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              onNewThread(scopeProjectRef(target.project.environmentId, target.project.id))
            }
          >
            <PlusIcon aria-hidden />
            New thread
          </Button>
        ) : null}
        {openUrl ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => openAppUrl(openUrl)}>
            Open in {presentation.name}
            <ExternalLinkIcon aria-hidden />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
