import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * The card row's first line: the title (nested rows) or project name, the
 * markers, and the status slot whose hover actions cross-fade with the status.
 *
 * At rest only what is visible takes width, so the title keeps its room. The
 * hover actions (discard draft, Snooze, Settle) never move a visible marker:
 * on a row with a pin or a Woke label they open left of the markers and the
 * status stays; otherwise they take the status's place at the end of the line.
 */
export function SidebarRowStatusLine(props: {
  /** Draft mark, favicon and the title or project name; the part that gives way. */
  readonly children: ReactNode;
  /** Shown at rest between the title and the status (account mark, pin). */
  readonly markers: ReactNode;
  /** A pin or a Woke label is showing, so revealing the actions must not move it. */
  readonly anchored: boolean;
  readonly status: ReactNode;
  /** The status stays visible and clickable on hover (the Woke label). */
  readonly statusPersistent: boolean;
  readonly actions: ReactNode;
  /** Keeps the actions shown, e.g. while the snooze menu is open. */
  readonly actionsOpen: boolean;
  readonly slotHidden: boolean;
  /** Shown instead of the status slot, e.g. a drag's destination badge. */
  readonly slotReplacement?: ReactNode;
  readonly after?: ReactNode;
}) {
  const showActions = props.actions !== null && props.actions !== undefined;
  const leadingActions = props.anchored && props.slotReplacement === undefined;
  const actions = showActions ? (
    <span
      data-testid="sidebar-row-actions"
      className={cn(
        // Out of flow until revealed, so the hidden actions take no width at rest.
        // focus-visible, not focus-within: a mouse click leaves the Settle
        // button focused, and a plain focus-within would keep the controls
        // pinned over the status label once the pointer moves away (e.g. after
        // a failed settle) instead of cross-fading back.
        "pointer-events-none absolute flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100",
        leadingActions
          ? cn("shrink-0", props.slotHidden && "hidden")
          : "inset-y-0 right-0 justify-self-end [grid-area:1/1]",
        props.actionsOpen && "pointer-events-auto static opacity-100",
      )}
    >
      {props.actions}
    </span>
  ) : null;
  return (
    <div className="flex h-5 min-w-0 items-center gap-1.5">
      {props.children}
      {leadingActions ? actions : null}
      {props.markers}
      {props.slotReplacement !== undefined ? (
        props.slotReplacement
      ) : (
        <span
          data-testid="sidebar-row-status-slot"
          className={cn(
            "group/sidebar-status-slot relative ml-auto grid h-5 min-w-8 shrink-0 items-stretch justify-end text-xs",
            props.slotHidden && "hidden",
          )}
        >
          <span
            data-testid="sidebar-row-status"
            className={cn(
              props.statusPersistent
                ? "pointer-events-auto"
                : props.anchored
                  ? "pointer-events-none"
                  : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:opacity-0",
              "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity [grid-area:1/1]",
              props.actionsOpen && !props.anchored && "pointer-events-none opacity-0",
            )}
          >
            {props.status}
          </span>
          {leadingActions ? null : actions}
        </span>
      )}
      {props.after}
    </div>
  );
}
