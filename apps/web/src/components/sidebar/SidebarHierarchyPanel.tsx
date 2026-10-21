import type { ReactNode } from "react";

import { Collapsible, CollapsiblePanel } from "../ui/collapsible";

/** Keeps closing content inert while its measured height folds out of view. */
export function SidebarHierarchyPanel({
  open,
  children,
  className,
}: {
  readonly open: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <Collapsible open={open} className="contents">
      <CollapsiblePanel
        inert={!open || undefined}
        aria-hidden={!open || undefined}
        variant="hierarchy"
        className={className}
        style={(state) =>
          state.open && state.transitionStatus === "idle" ? { overflow: "visible" } : {}
        }
      >
        {children}
      </CollapsiblePanel>
    </Collapsible>
  );
}
