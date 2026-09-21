import { ChevronDownIcon } from "lucide-react";
import { lazy, Suspense, type CSSProperties } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { cn } from "../../lib/utils";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SidebarSignInAgainButton = lazy(() => import("../clerk/SidebarSignInAgainButton"));

/**
 * Heads one account's segment of the sidebar. It sticks inside the scroll
 * viewport, so an account scrolled out of view still shows what needs
 * attention there, and it is opaque because rows scroll underneath it.
 */
export function SidebarAccountBar(props: {
  readonly accountId: string;
  /** The account's email, or what stands in for it when this client never saw its profile. */
  readonly label: string;
  /** Id of the label, which names the segment's list. */
  readonly labelId: string;
  /** Id of the list the bar opens and closes. */
  readonly listId: string;
  readonly collapsed: boolean;
  readonly attention: ThreadStatusPill | null;
  readonly needsSignIn: boolean;
  readonly hasRows: boolean;
  readonly stickyOffsets: CSSProperties;
  readonly onToggle: (accountId: string) => void;
}) {
  const { label } = props;
  return (
    <div
      data-thread-selection-safe
      data-sidebar-account-bar={props.accountId}
      // h-7 is `ACCOUNT_BAR_HEIGHT_REM`, which the sticky offsets count in.
      className="sticky z-10 flex h-7 shrink-0 items-center gap-1.5 bg-sidebar px-1 text-xs"
      style={props.stickyOffsets}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-lecturn-hover
              aria-expanded={!props.collapsed}
              aria-controls={props.collapsed ? undefined : props.listId}
              aria-label={`${props.collapsed ? "Expand" : "Collapse"} ${label}`}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded py-0.5 pr-1 text-left font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              onClick={() => props.onToggle(props.accountId)}
            />
          }
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 shrink-0", props.collapsed && "-rotate-90")}
          />
          <span id={props.labelId} className="min-w-0 truncate">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      {props.needsSignIn ? (
        <>
          <span className="shrink-0 text-[0.6875rem] text-warning">Needs sign-in</span>
          {hasCloudPublicConfig() ? (
            <Suspense fallback={null}>
              <SidebarSignInAgainButton accountId={props.accountId} />
            </Suspense>
          ) : null}
        </>
      ) : !props.hasRows ? (
        <span className="shrink-0 text-[0.6875rem] text-sidebar-muted-foreground/60">
          No threads
        </span>
      ) : null}
      {props.attention ? (
        // No pulse here: a bar is always on screen, and a repainting dot never rests.
        <ThreadStatusLabel status={{ ...props.attention, pulse: false }} />
      ) : null}
    </div>
  );
}
