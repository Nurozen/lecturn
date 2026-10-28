import { FolderIcon } from "lucide-react";

import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarScopeTrigger } from "../sidebar/SidebarScopeRow";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { AppIcon } from "./AppIcon";
import { resolveAppsSidebarScope } from "./AppsSidebar.logic";
import { useAppsSidebarApps } from "./useAppsSidebarApps";

interface AppScopeItem {
  readonly value: string;
  readonly label: string;
  readonly iconDataUrl: string | null;
}

const ALL_APPS: AppScopeItem = { value: "all", label: "All apps", iconDataUrl: null };

/** Apps mode's scope row picker: every app, or one app with its header and workspaces. */
export function AppsScopePicker() {
  const apps = useAppsSidebarApps({ withThreads: false });
  const scopeKey = useUiStateStore((state) => state.sidebarAppScopeKey);
  const setScopeKey = useUiStateStore((state) => state.setSidebarAppScopeKey);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selected = resolveAppsSidebarScope(apps, scopeKey);
  const items: AppScopeItem[] = [
    ALL_APPS,
    ...apps.map((app) => ({ value: app.appId, label: app.name, iconDataUrl: app.iconDataUrl })),
  ];
  const selectedItem = items.find((item) => item.value === selected?.appId) ?? ALL_APPS;

  return (
    <Combobox
      items={items}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      value={selectedItem}
      onValueChange={(item) => {
        if (!item) return;
        clearSelection();
        setScopeKey(item.value === ALL_APPS.value ? null : item.value);
      }}
    >
      <ComboboxTrigger
        render={
          <SidebarScopeTrigger
            kind="apps"
            selectedLabel={selected === null ? null : selectedItem.label}
            icon={
              selected === null ? undefined : <AppIcon iconDataUrl={selectedItem.iconDataUrl} />
            }
          />
        }
      />
      <ComboboxPopup
        align="start"
        className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
      >
        <ComboboxSearchInput aria-label="Search apps" placeholder="Search apps..." />
        <ComboboxEmpty>No matching apps.</ComboboxEmpty>
        <ComboboxList>
          {(item: AppScopeItem) => (
            <ComboboxItem key={item.value} hideIndicator value={item}>
              {item === ALL_APPS ? (
                <FolderIcon aria-hidden className="size-4 shrink-0" />
              ) : (
                <AppIcon iconDataUrl={item.iconDataUrl} />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
