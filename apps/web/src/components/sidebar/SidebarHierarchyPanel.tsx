import type { ReactNode } from "react";

import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { cn } from "../../lib/utils";

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
        className={cn("lecturn-hierarchy-panel", className)}
        style={(state) =>
          state.open && state.transitionStatus === "idle" ? { overflow: "visible" } : {}
        }
      >
        {children}
      </CollapsiblePanel>
    </Collapsible>
  );
}
