import { useRouter } from "@tanstack/react-router";

import { useThreadSelectionStore } from "../../threadSelectionStore";
import { type SidebarMode, useUiStateStore } from "../../uiStateStore";
import { SidebarScopeRow } from "../sidebar/SidebarScopeRow";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { AppsScopePicker } from "./AppsScopePicker";

const MODES = [
  { value: "projects", label: "Projects" },
  { value: "apps", label: "Apps" },
] as const satisfies ReadonlyArray<{ value: SidebarMode; label: string }>;

/**
 * The sidebar's Projects | Apps control. In Apps mode it also carries the "All apps" scope
 * row, which takes the place the host's own scope row has in Projects mode.
 */
export function AppsModeSwitch() {
  const router = useRouter();
  const mode = useUiStateStore((state) => state.sidebarMode);
  const setMode = useUiStateStore((state) => state.setSidebarMode);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  return (
    <>
      <div className="px-px">
        <ToggleGroup
          aria-label="Sidebar mode"
          value={[mode]}
          className="w-full"
          onValueChange={(next) => {
            const value = MODES.find((candidate) => candidate.value === next[0])?.value;
            if (value === undefined || value === mode) return;
            // A selection made in one mode holds rows the other mode does not show.
            clearSelection();
            setMode(value);
          }}
        >
          {MODES.map((candidate) => (
            <ToggleGroupItem key={candidate.value} value={candidate.value} className="flex-1">
              {candidate.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {mode === "apps" ? (
        <SidebarScopeRow kind="apps" onAdd={() => void router.navigate({ to: "/settings/apps" })}>
          <AppsScopePicker />
        </SidebarScopeRow>
      ) : null}
    </>
  );
}
