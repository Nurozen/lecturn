import type { ReactNode } from "react";

/** The boxed "Apps" group, drawn with the Projects tree's enclosure and heading. */
export function AppsGroup({ children }: { readonly children: ReactNode }) {
  return (
    <ul
      role="presentation"
      data-testid="sidebar-apps-group"
      className="lecturn-sidebar-tree lecturn-apps-tree lecturn-local-enclosure flex flex-col gap-px"
    >
      <li
        data-thread-selection-safe
        className="lecturn-projects-heading flex list-none items-center gap-2 px-2 py-2 text-xs text-muted-foreground"
      >
        <span className="mr-auto font-medium" data-testid="sidebar-apps-group-heading">
          Apps
        </span>
      </li>
      {children}
    </ul>
  );
}
