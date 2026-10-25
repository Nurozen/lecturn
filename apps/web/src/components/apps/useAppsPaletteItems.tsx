import { FolderIcon, LayoutGridIcon } from "lucide-react";

import { useUiStateStore } from "../../uiStateStore";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  buildAppsPaletteItems,
  type AppsPaletteItems,
} from "../CommandPalette.logic";
import { AppIcon } from "./AppIcon";
import { appStatusChip } from "./AppsSidebar.logic";
import { showSidebarMode } from "./sidebarMode";
import { useAppsSidebarApps } from "./useAppsSidebarApps";

/** The command palette's Apps entries: the sidebar mode switch and "Open app…". */
export function useAppsPaletteItems(): AppsPaletteItems {
  const sidebarMode = useUiStateStore((state) => state.sidebarMode);
  const apps = useAppsSidebarApps({ withThreads: false });
  return buildAppsPaletteItems({
    sidebarMode,
    apps: apps.map((app) => ({
      appId: app.appId,
      name: app.name,
      icon: <AppIcon iconDataUrl={app.iconDataUrl} />,
      status: app.primary === null ? null : appStatusChip(app.primary.app).label,
    })),
    icons: {
      projects: <FolderIcon className={ITEM_ICON_CLASS} />,
      apps: <LayoutGridIcon className={ITEM_ICON_CLASS} />,
      appsAddon: <LayoutGridIcon className={ADDON_ICON_CLASS} />,
    },
    showSidebarMode,
  });
}
