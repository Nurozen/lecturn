import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { ScopedProjectRef } from "@lecturn/contracts";
import { ChevronDownIcon, ExternalLinkIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { openAppUrl } from "../../lib/openAppUrl";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AppIcon } from "./AppIcon";
import {
  appStatusChip,
  appTargetWorkspace,
  appWorkspaceOpenUrl,
  type AppsSidebarApp,
} from "./AppsSidebar.logic";
import { useCanOpenApp } from "./useAppClosedBanner";
import { useAppPresentation } from "./useAppsSidebarApps";

/** Drawn like the Projects tree's project header actions. */
export function AppRowAction({
  label,
  testId,
  onClick,
  children,
}: {
  readonly label: string;
  readonly testId?: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-lecturn-hover
            aria-label={label}
            data-testid={testId}
            className="inline-flex items-center rounded px-1 py-0.5 text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-3.5"
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
 * The state chip, then a slot that shows the working count at rest and trades it for the
 * row's actions on hover or keyboard focus, so the name keeps the row's room. A touch-only
 * pointer cannot hover, so it always gets the actions. `group/app-row` must be on the row.
 */
export function AppRowTrailing({
  chip,
  working,
  children,
}: {
  readonly chip: ReturnType<typeof appStatusChip> | null;
  readonly working: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      {chip ? (
        <Badge variant={chip.variant} size="sm" data-testid="sidebar-app-state">
          {chip.label}
        </Badge>
      ) : null}
      <span className="group/app-row-slot relative flex shrink-0 items-center gap-1">
        {working ? (
          <span className="flex items-center group-any-hover/app-row:hidden group-has-[:focus-visible]/app-row-slot:hidden">
            {working}
          </span>
        ) : null}
        <span
          data-testid="app-row-actions"
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/app-row:pointer-events-auto group-any-hover/app-row:static group-any-hover/app-row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:opacity-100"
        >
          {children}
        </span>
      </span>
    </>
  );
}

/**
 * One app in the Apps group: fold chevron, icon, name, state chip and working count, then
 * New thread and Open in, both aimed at the workspace the user touched last.
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
      data-testid="sidebar-app-row"
      className="group/app-row lecturn-project-header flex items-center gap-1 pt-2"
    >
      <button
        type="button"
        data-lecturn-hover
        data-testid="sidebar-app-expand"
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
        <span data-testid="sidebar-app-icon" className="contents">
          <AppIcon iconDataUrl={presentation.iconDataUrl} />
        </span>
        <span className="min-w-0 truncate" data-testid="sidebar-app-name">
          {presentation.name}
        </span>
      </button>
      <AppRowTrailing
        chip={presentation.chip}
        working={
          app.workingCount > 0 ? (
            <Badge variant="info" size="sm" data-testid="app-row-working">
              {app.workingCount}
              <span className="sr-only"> working</span>
            </Badge>
          ) : null
        }
      >
        {target ? (
          <AppRowAction
            label={`New thread in ${target.project.title}`}
            testId="sidebar-app-new-thread"
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
            testId="sidebar-app-open"
            onClick={() => openAppUrl(openUrl, presentation.openUrlTemplate)}
          >
            <ExternalLinkIcon aria-hidden />
          </AppRowAction>
        ) : null}
      </AppRowTrailing>
    </div>
  );
}
