export type SidebarScopeKind = "projects" | "apps";

const SCOPE_NOUNS = {
  projects: { singular: "project", plural: "projects" },
  apps: { singular: "app", plural: "apps" },
} as const satisfies Record<SidebarScopeKind, { singular: string; plural: string }>;

export interface SidebarScopeRowModel {
  readonly label: string;
  readonly triggerLabel: string;
  readonly addLabel: string;
}

export function sidebarScopeRowModel(input: {
  readonly kind: SidebarScopeKind;
  /** Display name of the selected scope; null when the row shows every scope. */
  readonly selectedLabel: string | null;
}): SidebarScopeRowModel {
  const noun = SCOPE_NOUNS[input.kind];
  // A blank name must not read as "All ...": the list is still narrowed.
  const selected =
    input.selectedLabel === null ? null : input.selectedLabel.trim() || `Untitled ${noun.singular}`;
  const filterLabel = `Filter threads by ${noun.singular}`;
  return {
    label: selected ?? `All ${noun.plural}`,
    // The visible label already names the scope; the accessible name keeps the
    // action so screen readers announce what activating the row does.
    triggerLabel: selected ? `${filterLabel}: ${selected}` : filterLabel,
    addLabel: `Add ${noun.singular}`,
  };
}
