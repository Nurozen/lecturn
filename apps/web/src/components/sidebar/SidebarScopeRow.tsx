import { ChevronDownIcon, FolderIcon, FolderPlusIcon, PlusIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SidebarMenuButton } from "../ui/sidebar";
import { type SidebarScopeKind, sidebarScopeRowModel } from "./SidebarScopeRow.logic";
import { SidebarHeaderIconButton } from "./SidebarHeaderIconButton";

const ADD_ICONS = {
  projects: FolderPlusIcon,
  apps: PlusIcon,
} as const satisfies Record<SidebarScopeKind, unknown>;

/**
 * The scope picker row both sidebar modes share. `children` is the mode's
 * picker (a Combobox whose trigger renders `SidebarScopeTrigger`), so each
 * mode keeps its own items and state while the row looks the same.
 */
export function SidebarScopeRow({
  kind,
  onAdd,
  children,
}: {
  kind: SidebarScopeKind;
  onAdd: () => void;
  children: ReactNode;
}) {
  const { addLabel } = sidebarScopeRowModel({ kind, selectedLabel: null });
  const AddIcon = ADD_ICONS[kind];
  return (
    <div className="flex items-center gap-1">
      {children}
      <SidebarHeaderIconButton label={addLabel} onClick={onAdd}>
        <AddIcon />
      </SidebarHeaderIconButton>
    </div>
  );
}

export function SidebarScopeTrigger({
  kind,
  selectedLabel,
  icon,
  className,
  ...rest
}: {
  kind: SidebarScopeKind;
  /** Display name of the selected scope; null shows the all-scope label. */
  selectedLabel: string | null;
  /** Replaces the folder icon, e.g. with the selected project's favicon. */
  icon?: ReactNode;
  className?: string | undefined;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "size" | "variant" | "aria-label"
>) {
  const model = sidebarScopeRowModel({ kind, selectedLabel });
  return (
    <SidebarMenuButton
      type="button"
      aria-label={model.triggerLabel}
      {...rest}
      className={cn("min-w-0 flex-1", className)}
    >
      {icon ?? <FolderIcon />}
      <span className="min-w-0 flex-1 truncate">{model.label}</span>
      <ChevronDownIcon className="size-3.5" />
    </SidebarMenuButton>
  );
}
