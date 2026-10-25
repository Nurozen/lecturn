import { ChevronDownIcon, ClockIcon, PinIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { AppsSidebarSections } from "./AppsSidebar.logic";

const SECTION_LABELS = {
  pinned: "Pinned",
  active: "Active",
  settled: "Settled",
} as const satisfies Record<keyof AppsSidebarSections, string>;

/**
 * A visible section heading in an app workspace. Projects mode marks the same sections
 * with invisible drag boundaries; Apps mode has no drag and names them instead.
 */
export function AppSectionHeading({
  section,
  count,
  collapsed,
  workspaceName,
  onToggle,
}: {
  readonly section: keyof AppsSidebarSections;
  readonly count: number;
  readonly collapsed: boolean;
  readonly workspaceName: string;
  readonly onToggle: () => void;
}) {
  const label = SECTION_LABELS[section];
  const settled = section === "settled";
  const Icon = settled ? ClockIcon : PinIcon;
  return (
    <div className="pt-2">
      <button
        type="button"
        data-thread-selection-safe
        data-lecturn-hover
        aria-expanded={!collapsed}
        aria-label={`${label} threads in ${workspaceName} (${count})`}
        onClick={onToggle}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 rounded px-1 text-left text-xs font-medium",
          settled ? "lecturn-settled-label" : "text-sidebar-foreground/80",
        )}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span>{label}</span>
        {settled ? (
          <span className="tabular-nums">({count})</span>
        ) : (
          <ChevronDownIcon
            aria-hidden
            className={cn("lecturn-hierarchy-chevron size-3.5", collapsed && "-rotate-90")}
          />
        )}
      </button>
    </div>
  );
}
