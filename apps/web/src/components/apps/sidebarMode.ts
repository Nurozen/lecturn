import { parseAppsSidebarSearch } from "@lecturn/shared/appLinks";
import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

import { useThreadSelectionStore } from "../../threadSelectionStore";
import { type SidebarMode, useUiStateStore } from "../../uiStateStore";

const SIDEBAR_REVEAL_EVENT = "lecturn:reveal-sidebar";

export interface SidebarModeTarget {
  readonly mode: SidebarMode;
  /** The app to select in Apps mode; null or absent keeps the current scope. */
  readonly appId?: string | null;
}

/**
 * Puts the sidebar in a mode, and optionally on one app, from outside the sidebar (palette,
 * keybinding, links). The sidebar is asked to show, because a mode change behind a hidden
 * sidebar looks like nothing happened.
 */
export function showSidebarMode(target: SidebarModeTarget): void {
  const ui = useUiStateStore.getState();
  const appId = target.mode === "apps" ? (target.appId ?? null) : null;
  if (ui.sidebarMode !== target.mode || (appId !== null && ui.sidebarAppScopeKey !== appId)) {
    // A selection made in one mode holds rows the other mode does not show.
    useThreadSelectionStore.getState().clearSelection();
    ui.setSidebarMode(target.mode);
    if (appId !== null) ui.setSidebarAppScopeKey(appId);
  }
  window.dispatchEvent(new Event(SIDEBAR_REVEAL_EVENT));
}

export function toggleSidebarMode(): void {
  showSidebarMode({
    mode: useUiStateStore.getState().sidebarMode === "apps" ? "projects" : "apps",
  });
}

export function onSidebarRevealRequest(listener: () => void): () => void {
  window.addEventListener(SIDEBAR_REVEAL_EVENT, listener);
  return () => window.removeEventListener(SIDEBAR_REVEAL_EVENT, listener);
}

/**
 * Applies a route's `?sidebar=apps&app=<appId>` (what app deep links open) once per query, so
 * the user can still switch modes while the URL keeps it.
 */
export function useSidebarModeSearchLink(): void {
  const search = useLocation({ select: (location) => location.searchStr });
  useEffect(() => {
    const target = parseAppsSidebarSearch(search);
    if (target !== null) showSidebarMode(target);
  }, [search]);
}
