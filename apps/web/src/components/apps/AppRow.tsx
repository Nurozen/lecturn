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
  appWorkingBadge,
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
            className="rounded px-1 text-xs text-muted-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-3.5"
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
 * The state chip, the working count, then the row's actions, all shown at rest as a project
 * header's are.
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
      {chip === null ? null : chip.label === chip.description ? (
        <Badge variant={chip.variant} size="sm" data-testid="sidebar-app-state">
          {chip.label}
        </Badge>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={<Badge variant={chip.variant} size="sm" data-testid="sidebar-app-state" />}
          >
            {chip.label}
          </TooltipTrigger>
          <TooltipPopup>{chip.description}</TooltipPopup>
        </Tooltip>
      )}
      {working}
      <span data-testid="app-row-actions" className="flex shrink-0 items-center">
        {children}
      </span>
    </>
  );
}

/** A count, not "N working", so the row's actions fit beside the name at the default width. */
export function AppWorkingBadge({
  app,
  state,
  testId,
}: {
  readonly app: AppsSidebarApp;
  readonly state: Parameters<typeof appWorkingBadge>[1];
  readonly testId: string;
}) {
  const badge = appWorkingBadge(app, state);
  if (badge === null) return null;
  return (
    <Badge variant={badge.variant} size="sm" data-testid={testId}>
      {badge.count}
      <span className="sr-only"> working</span>
    </Badge>
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
      className="lecturn-project-header flex items-center gap-1 pt-2"
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
      {/* With its actions shown at rest a long name truncates at the default width, as a
          project's does, so the tooltip reads it whole. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-lecturn-hover
              aria-label={`Show only ${presentation.name}`}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-xs font-medium text-sidebar-foreground"
              onClick={onSelect}
            />
          }
        >
          <span data-testid="sidebar-app-icon" className="contents">
            <AppIcon iconDataUrl={presentation.iconDataUrl} />
          </span>
          <span className="min-w-0 truncate" data-testid="sidebar-app-name">
            {presentation.name}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right">{presentation.name}</TooltipPopup>
      </Tooltip>
      <AppRowTrailing
        chip={presentation.chip}
        working={<AppWorkingBadge app={app} state={presentation.state} testId="app-row-working" />}
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
