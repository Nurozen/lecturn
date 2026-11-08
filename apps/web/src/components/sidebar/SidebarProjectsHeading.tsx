import { ChevronDownIcon } from "lucide-react";

import { cn } from "../../lib/utils";

interface ShelfToggle {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

function ShelfToggleButton(
  props: ShelfToggle & { readonly label: string; readonly testId?: string },
) {
  if (props.count === 0) return null;
  return (
    <button
      type="button"
      data-lecturn-hover
      aria-expanded={props.expanded}
      onClick={props.onToggle}
      data-testid={props.testId}
      className="flex min-w-0 items-center gap-1 whitespace-nowrap"
    >
      <ChevronDownIcon
        aria-hidden
        className={cn("lecturn-hierarchy-chevron size-3 shrink-0", !props.expanded && "-rotate-90")}
      />
      <span className="min-w-0 truncate">{props.label}</span>
      <span>({props.count})</span>
    </button>
  );
}

export function SidebarProjectsHeading(props: {
  readonly working: ShelfToggle;
  readonly snoozed: ShelfToggle;
}) {
  const bothShelves = props.working.count > 0 && props.snoozed.count > 0;
  return (
    <li
      data-thread-selection-safe
      className="lecturn-projects-heading @container flex list-none items-center gap-2 px-2 py-2 text-xs text-muted-foreground"
    >
      {/* Two shelf toggles fill the default sidebar width: the static label yields to them. */}
      <span
        className={cn(
          "mr-auto min-w-0 truncate font-medium",
          bothShelves && "@max-[14rem]:sr-only",
        )}
      >
        Projects
      </span>
      <ShelfToggleButton label="Working" testId="sidebar-working-shelf-toggle" {...props.working} />
      <ShelfToggleButton label="Snoozed" {...props.snoozed} />
    </li>
  );
}
