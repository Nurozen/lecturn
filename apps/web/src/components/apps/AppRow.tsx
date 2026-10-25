import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { ScopedProjectRef } from "@lecturn/contracts";
import { ChevronDownIcon, ExternalLinkIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { openAppUrl } from "../../lib/openAppUrl";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AppIcon } from "./AppIcon";
import { appTargetWorkspace, appWorkspaceOpenUrl, type AppsSidebarApp } from "./AppsSidebar.logic";
import { useCanOpenApp } from "./useAppClosedBanner";
import { useAppPresentation } from "./useAppsSidebarApps";

function AppRowAction({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One app in the Apps group: fold chevron, icon, name, status and working chips, then New
 * thread and Open in, both aimed at the workspace the user touched last.
 */
export function AppRow({
  app,
  collapsed,
  onToggle,
  onSelect,
  onNewThread,
}: {
  readonly app: AppsSidebarApp;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onSelect: () => void;
  readonly onNewThread: (projectRef: ScopedProjectRef) => void;
}) {
  const presentation = useAppPresentation(app);
  const target = appTargetWorkspace(app);
  const canOpenApp = useCanOpenApp(target?.project.environmentId ?? null);
  const openUrl = canOpenApp ? appWorkspaceOpenUrl(presentation.openUrlTemplate, target) : null;
  return (
    <div
      data-thread-selection-safe
      data-testid="app-row"
      className="lecturn-project-header flex items-center gap-1 pt-2"
    >
      <button
        type="button"
        data-lecturn-hover
        className="rounded p-1 text-muted-foreground hover:bg-sidebar-row-hover"
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${presentation.name}`}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("lecturn-hierarchy-chevron size-3.5", collapsed && "-rotate-90")}
        />
      </button>
      <button
        type="button"
        data-lecturn-hover
        aria-label={`Show only ${presentation.name}`}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-xs font-medium text-sidebar-foreground"
        onClick={onSelect}
      >
        <AppIcon iconDataUrl={presentation.iconDataUrl} />
        <span className="min-w-0 truncate">{presentation.name}</span>
      </button>
      {presentation.chip ? (
        <Badge variant={presentation.chip.variant} size="sm" data-testid="app-row-status">
          {presentation.chip.label}
        </Badge>
      ) : null}
      {app.workingCount > 0 ? (
        <Badge variant="info" size="sm" data-testid="app-row-working">
          {app.workingCount} working
        </Badge>
      ) : null}
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
    </div>
  );
}
