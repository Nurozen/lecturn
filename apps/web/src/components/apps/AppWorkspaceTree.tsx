import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@lecturn/contracts";
import { ChevronDownIcon, EllipsisIcon, FileIcon, PlusIcon } from "lucide-react";
import {
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentScope } from "../../state/session";
import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";
import { JumpHintBadge } from "../sidebar/JumpHintBadge";
import { SidebarHierarchyPanel } from "../sidebar/SidebarHierarchyPanel";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AppSectionHeading } from "./AppSectionHeading";
import {
  APP_SECTION_ORDER,
  isAppTreeGroupCollapsed,
  type AppsSidebarApp,
  type AppsSidebarSections,
  type AppsSidebarWorkspace,
  type AppTreeGroup,
} from "./AppsSidebar.logic";
import type { AppThreadActions } from "./useAppThreadActions";

export interface AppThreadSupport {
  readonly pinning: boolean;
  readonly settlement: boolean;
}

export interface AppTreeContext {
  readonly collapsedByKey: Readonly<Record<string, boolean>>;
  readonly onToggle: (group: AppTreeGroup) => void;
  readonly activeThreadKey: string | null;
  /** Jump shortcut labels while the jump modifier is held; null hides them. */
  readonly jumpLabelByKey: ReadonlyMap<string, string> | null;
  readonly actions: AppThreadActions;
  readonly supports: (environmentId: EnvironmentId) => AppThreadSupport;
  readonly onNewThread: (projectRef: ScopedProjectRef) => void;
}

// Static on purpose: Apps mode schedules no frames while idle.
function StatusDot({ status }: { readonly status: ThreadStatusPill }) {
  return (
    <span
      role="img"
      aria-label={status.label}
      className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)}
    />
  );
}

/** An app's workspaces as the Projects tree draws projects, with visible section headings. */
export function AppWorkspaceTree({
  app,
  context,
}: {
  readonly app: AppsSidebarApp;
  readonly context: AppTreeContext;
}) {
  if (app.workspaces.length === 0) {
    return (
      <li className="lecturn-hierarchy-branch flex min-h-9 list-none items-center pt-2 text-xs text-sidebar-muted-foreground">
        Threads started from {app.name} appear here.
      </li>
    );
  }
  return app.workspaces.map((workspace) => (
    <AppWorkspaceBranch key={workspace.key} workspace={workspace} context={context} />
  ));
}

function AppWorkspaceBranch({
  workspace,
  context,
}: {
  readonly workspace: AppsSidebarWorkspace;
  readonly context: AppTreeContext;
}) {
  const group = { kind: "workspace", workspaceKey: workspace.key } as const;
  const collapsed = isAppTreeGroupCollapsed(context.collapsedByKey, group);
  const { project } = workspace;
  const sections = APP_SECTION_ORDER.filter((section) => workspace.sections[section].length > 0);
  return (
    <li className="lecturn-hierarchy-branch list-none" data-testid="sidebar-app-workspace">
      <div
        data-thread-selection-safe
        className="group/app-workspace lecturn-project-header flex items-center gap-1 pt-2"
      >
        <button
          type="button"
          data-lecturn-hover
          data-testid="sidebar-app-workspace-expand"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1.5 pl-1 text-left text-xs font-medium text-sidebar-foreground"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${project.title}`}
          aria-expanded={!collapsed}
          onClick={() => context.onToggle(group)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("lecturn-hierarchy-chevron size-3.5 shrink-0", collapsed && "-rotate-90")}
          />
          <span className="min-w-0 truncate">
            {project.title}
            {workspace.machineLabel ? (
              <span className="ml-1 text-3xs font-normal text-muted-foreground">
                · {workspace.machineLabel}
              </span>
            ) : null}
          </span>
          {workspace.status ? <StatusDot status={workspace.status} /> : null}
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-lecturn-hover
                aria-label={`New thread in ${project.title}`}
                className="rounded px-1 text-xs text-muted-foreground opacity-0 hover:bg-sidebar-row-hover focus-visible:opacity-100 group-hover/app-workspace:opacity-100"
                onClick={() =>
                  context.onNewThread(scopeProjectRef(project.environmentId, project.id))
                }
              >
                <PlusIcon aria-hidden className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup>New thread in {project.title}</TooltipPopup>
        </Tooltip>
      </div>
      <SidebarHierarchyPanel open={!collapsed}>
        <ul className="flex flex-col">
          {sections.length === 0 ? (
            <li className="lecturn-hierarchy-branch flex min-h-9 list-none items-center pt-2 text-xs text-sidebar-muted-foreground">
              No threads yet
            </li>
          ) : (
            sections.map((section) => (
              <AppSection key={section} section={section} workspace={workspace} context={context} />
            ))
          )}
        </ul>
      </SidebarHierarchyPanel>
    </li>
  );
}

function AppSection({
  section,
  workspace,
  context,
}: {
  readonly section: keyof AppsSidebarSections;
  readonly workspace: AppsSidebarWorkspace;
  readonly context: AppTreeContext;
}) {
  const group = { kind: "section", section, workspaceKey: workspace.key } as const;
  const collapsed = isAppTreeGroupCollapsed(context.collapsedByKey, group);
  const threads = workspace.sections[section];
  return (
    <li
      // The branch's ::before and ::after draw the tree connector.
      data-testid="sidebar-tree-connector"
      className={cn(
        "lecturn-hierarchy-branch list-none",
        section === "settled" && "lecturn-hierarchy-settled",
      )}
    >
      <AppSectionHeading
        section={section}
        count={threads.length}
        collapsed={collapsed}
        workspaceName={workspace.project.title}
        onToggle={() => context.onToggle(group)}
      />
      <SidebarHierarchyPanel open={!collapsed}>
        <ul className="flex flex-col gap-px">
          {threads.map((thread) => {
            const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
            return (
              <AppThreadRow
                key={threadKey}
                thread={thread}
                isActive={context.activeThreadKey === threadKey}
                jumpLabel={context.jumpLabelByKey?.get(threadKey) ?? null}
                isRenaming={context.actions.renamingThreadKey === threadKey}
                actions={context.actions}
                supports={context.supports(thread.environmentId)}
              />
            );
          })}
        </ul>
      </SidebarHierarchyPanel>
    </li>
  );
}

const AppThreadRow = memo(function AppThreadRow({
  thread,
  isActive,
  jumpLabel,
  isRenaming,
  actions,
  supports,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly isActive: boolean;
  readonly jumpLabel: string | null;
  readonly isRenaming: boolean;
  readonly actions: AppThreadActions;
  readonly supports: AppThreadSupport;
}) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const [draftTitle, setDraftTitle] = useState(thread.title);
  const renameSettledRef = useRef(false);
  const status = resolveThreadStatusPill({ thread });
  const pinned = thread.pinnedAt != null;
  const settled = thread.settledOverride === "settled";

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    actions.open(threadRef);
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      renameSettledRef.current = true;
      actions.commitRename(thread, draftTitle);
    } else if (event.key === "Escape") {
      event.preventDefault();
      renameSettledRef.current = true;
      actions.cancelRename();
    }
  };
  // Menu items render in a portal, and React still bubbles their clicks to the row.
  const menuAction = (run: () => void) => (event: ReactMouseEvent) => {
    event.stopPropagation();
    run();
  };

  return (
    <li className="list-none" data-thread-item={scopedThreadKey(threadRef)}>
      <div
        role="button"
        tabIndex={0}
        aria-label={thread.title}
        aria-current={isActive ? "page" : undefined}
        data-lecturn-thread-surface
        data-thread-active={isActive || undefined}
        data-account-selected={isActive || undefined}
        data-testid="app-thread-row"
        data-selected={isActive}
        className={cn(
          "group/app-thread relative flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
        )}
        onClick={() => {
          if (!isRenaming) actions.open(threadRef);
        }}
        onKeyDown={handleKeyDown}
      >
        <FileIcon
          aria-hidden
          data-testid="app-thread-row-icon"
          className="size-4 shrink-0 text-muted-foreground"
        />
        {isRenaming && canOperate ? (
          <input
            autoFocus
            value={draftTitle}
            aria-label="Thread title"
            onChange={(event) => setDraftTitle(event.target.value)}
            onFocus={(event) => {
              renameSettledRef.current = false;
              event.currentTarget.select();
            }}
            onKeyDown={handleRenameKeyDown}
            onBlur={() => {
              if (!renameSettledRef.current) actions.commitRename(thread, draftTitle);
            }}
            onClick={(event) => event.stopPropagation()}
            className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-xs text-card-foreground outline-none focus:border-foreground"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
        )}
        {status ? <StatusDot status={status} /> : null}
        {canOperate && !isRenaming ? (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Actions for ${thread.title}`}
                  data-testid="app-thread-row-menu"
                  onClick={(event) => event.stopPropagation()}
                  className={cn(
                    "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    // Out of flow while hidden, so an unselected title keeps the menu's width.
                    !isActive &&
                      "pointer-events-none absolute right-1.5 opacity-0 group-focus-within/app-thread:pointer-events-auto group-focus-within/app-thread:static group-focus-within/app-thread:opacity-100 group-any-hover/app-thread:pointer-events-auto group-any-hover/app-thread:static group-any-hover/app-thread:opacity-100 data-popup-open:pointer-events-auto data-popup-open:static data-popup-open:opacity-100",
                  )}
                />
              }
            >
              <EllipsisIcon aria-hidden className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={menuAction(() => {
                  setDraftTitle(thread.title);
                  actions.startRename(threadRef);
                })}
              >
                Rename
              </MenuItem>
              {supports.pinning ? (
                <MenuItem
                  onClick={menuAction(() =>
                    pinned ? actions.unpin(threadRef) : actions.pin(threadRef),
                  )}
                >
                  {pinned ? "Unpin" : "Pin"}
                </MenuItem>
              ) : null}
              {supports.settlement ? (
                <MenuItem
                  onClick={menuAction(() =>
                    settled ? actions.unsettle(threadRef) : actions.settle(threadRef),
                  )}
                >
                  {settled ? "Un-settle" : "Settle"}
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem onClick={menuAction(() => void actions.archive(thread))}>Archive</MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
        {jumpLabel ? <JumpHintBadge label={jumpLabel} /> : null}
      </div>
    </li>
  );
});
