import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { useWorkspaceListNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import {
  BackHandler,
  Keyboard,
  type TextInputInstance,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MenuAction } from "@react-native-menu/menu";

import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { FloatingActionButton } from "../../components/ui/FloatingActionButton";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { Menu } from "../../components/ui/Menu";
import { SearchField } from "../../components/ui/SearchField";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceConnectionTitle } from "./WorkspaceConnectionTitle";
import { useWorkspaceState } from "../../state/workspace";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

// The resting row: pl-4 before the brand, then gap-1 before each button. Both are fixed dp, while
// the buttons and the "Lecturn" wordmark grow with the app text size (`scale`).
const BRAND_INSET = 14;
const BUTTON_GAP = 3.5;
/** The wordmark at the default text size (72dp measured), plus rounding room. */
const WORDMARK_WIDTH = 76;
/** Brand room the inline list buttons must leave at the default text size: a 320dp row. */
const INLINE_BRAND_ROOM = 100;

export type SidebarHeaderButtons = "inline" | "listMenu" | "listAndSettingsMenu";

function rowWidthFor(buttonCount: number, brandRoom: number, buttonSize: number) {
  return BRAND_INSET + buttonCount * (buttonSize + BUTTON_GAP) + brandRoom;
}

/**
 * The narrowest split-view sidebar (280dp, which every window under about 875dp gets) leaves a
 * 266dp row, where four buttons would wrap "Lecturn" onto two lines. Show apps and Show pull
 * requests then move into a More menu, as AndroidScreenHeader does for the other sidebar lists,
 * and at large text sizes Settings joins them once three buttons would cut the wordmark.
 * An unmeasured row starts with the list menu.
 */
export function resolveSidebarHeaderButtons(
  rowWidth: number | null,
  sizing: { readonly scale: number; readonly buttonSize: number },
): SidebarHeaderButtons {
  if (rowWidth === null) return "listMenu";
  if (rowWidth >= rowWidthFor(4, INLINE_BRAND_ROOM * sizing.scale, sizing.buttonSize)) {
    return "inline";
  }
  return rowWidth >= rowWidthFor(3, WORDMARK_WIDTH * sizing.scale, sizing.buttonSize)
    ? "listMenu"
    : "listAndSettingsMenu";
}

/** One toolbar height for the compact list and expanded sidebar, including search. */
export function ThreadListToolbar(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly filterActions: MenuAction[];
  readonly filterCustomized: boolean;
  readonly onFilterAction: NonNullable<ComponentProps<typeof Menu>["onPressAction"]>;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironments: () => void;
  readonly sidebar?: boolean;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
  readonly onRequestVisibility?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const isTabActive = workspace?.isTabActive;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const listFocused =
    homeFocused && (workspace === null || workspace.state.selectedTab === "threads");
  const controlSizing = useAndroidControlSizing();
  const { fabSize } = controlSizing;
  const { height: toolbarHeight, ...headerPadding } = useToolbarLayout();
  const { state } = useWorkspaceState();
  const { onRequestVisibility, onSearchQueryChange } = props;
  const showApps = useWorkspaceListNavigation("apps");
  const showPullRequests = useWorkspaceListNavigation("pullRequests");
  const searchRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const headerButtons =
    props.sidebar && workspace !== null
      ? resolveSidebarHeaderButtons(rowWidth, controlSizing)
      : null;
  const searching = searchOpen || props.searchQuery.length > 0;
  const openSearch = useCallback(() => {
    onRequestVisibility?.();
    setSearchOpen(true);
    searchRef.current?.focus();
    return true;
  }, [onRequestVisibility]);
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = useCallback(() => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  }, [onSearchQueryChange]);

  useEffect(() => {
    if (!searching || !listFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens can keep effects alive after a detail route opens.
      const state = navigation.getState();
      if (
        !state ||
        state.routes[state.index]?.name !== "Home" ||
        isTabActive?.("threads") === false
      )
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching, listFocused, navigation, isTabActive]);

  const filterIcon = props.filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const searchField = (
    <SearchField
      inputRef={searchRef}
      accessibilityLabel="Search threads"
      clearAccessibilityLabel="Clear search"
      placeholder="Search"
      value={props.searchQuery}
      onChangeText={onSearchQueryChange}
    />
  );

  return (
    <>
      <View
        onLayout={props.onLayout}
        className={
          props.sidebar ? "absolute inset-x-0 top-0 z-[4] bg-header px-2" : "bg-header px-2"
        }
        style={headerPadding}
      >
        <View
          onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
          className="flex-row items-center gap-1"
          style={{ minHeight: toolbarHeight }}
        >
          {searching ? (
            <>
              <AndroidHeaderIconButton
                accessibilityLabel="Close search"
                icon="arrow.left"
                onPress={closeSearch}
              />
              {searchField}
            </>
          ) : (
            <>
              <View className="min-w-0 flex-1 pl-4">
                <WorkspaceConnectionTitle
                  grow
                  onPress={props.onOpenEnvironments}
                  brand={<CompactBrandTitle allowFontScaling={false} fit />}
                />
              </View>
              {headerButtons === "inline" ? (
                <>
                  <AndroidHeaderIconButton
                    accessibilityLabel="Show apps"
                    icon="square.grid.2x2"
                    onPress={showApps}
                  />
                  <AndroidHeaderIconButton
                    accessibilityLabel="Show pull requests"
                    icon={PullRequestGlyph.pullRequest}
                    onPress={showPullRequests}
                  />
                </>
              ) : null}
              <AndroidHeaderIconButton
                accessibilityLabel="Search threads"
                icon="magnifyingglass"
                onPress={openSearch}
              />
              {headerButtons !== "listAndSettingsMenu" ? (
                <AndroidHeaderIconButton
                  accessibilityLabel="Open settings"
                  icon="gearshape"
                  onPress={props.onOpenSettings}
                />
              ) : null}
              {headerButtons === "listMenu" || headerButtons === "listAndSettingsMenu" ? (
                <AndroidAnchoredMenu
                  actions={[
                    { id: "apps", title: "Show apps" },
                    { id: "pullRequests", title: "Show pull requests" },
                    ...(headerButtons === "listAndSettingsMenu"
                      ? [{ id: "settings", title: "Open settings" }]
                      : []),
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "apps") showApps();
                    else if (nativeEvent.event === "pullRequests") showPullRequests();
                    else props.onOpenSettings();
                  }}
                >
                  {(open) => (
                    <AndroidHeaderIconButton
                      accessibilityLabel="More actions"
                      icon="ellipsis"
                      onPress={open}
                    />
                  )}
                </AndroidAnchoredMenu>
              ) : null}
            </>
          )}
        </View>
      </View>
      {state.hasConnections ? (
        <View
          className="absolute right-5 z-[5]"
          style={{
            bottom:
              (props.sidebar ? Math.max(insets.bottom, 12) + 6 : Math.max(insets.bottom, 16) + 16) +
              fabSize +
              8,
          }}
        >
          <AndroidAnchoredMenu actions={props.filterActions} onPressAction={props.onFilterAction}>
            {(open) => (
              <FloatingActionButton label="Filter threads" icon={filterIcon} onPress={open} />
            )}
          </AndroidAnchoredMenu>
        </View>
      ) : null}
    </>
  );
}
