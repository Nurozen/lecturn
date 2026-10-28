// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type LayoutHandler = (event: { nativeEvent: { layout: { width: number } } }) => void;
interface MenuAction {
  readonly id: string;
  readonly title: string;
}

const harness = vi.hoisted(() => ({
  workspace: null as null | {
    readonly isTabActive: () => boolean;
    readonly state: { readonly selectedTab: string };
  },
  rowLayout: null as LayoutHandler | null,
  menuActions: null as readonly MenuAction[] | null,
  pressMenuAction: null as ((id: string) => void) | null,
  showList: new Map<string, () => void>(),
}));

vi.mock("react-native", () => ({
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Keyboard: { dismiss: () => {}, isVisible: () => false },
  Platform: { OS: "android" },
  View: (props: {
    readonly className?: string;
    readonly onLayout?: LayoutHandler;
    readonly children?: ReactNode;
  }) => {
    if (props.className === "flex-row items-center gap-1")
      harness.rowLayout = props.onLayout ?? null;
    return <div>{props.children}</div>;
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ getState: () => undefined }),
  useNavigationState: () => true,
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  NATIVE_WORKSPACE_COLUMNS_SUPPORTED: false,
}));
vi.mock("../workspace/WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => harness.workspace,
}));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceListNavigation: (tab: string) => {
    let show = harness.showList.get(tab);
    if (show === undefined) {
      show = vi.fn();
      harness.showList.set(tab, show);
    }
    return show;
  },
}));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({
  AndroidHeaderIconButton: (props: { readonly accessibilityLabel: string }) => (
    <button aria-label={props.accessibilityLabel} />
  ),
}));
vi.mock("../../components/ui/AndroidAnchoredMenu", () => ({
  AndroidAnchoredMenu: (props: {
    readonly actions: readonly MenuAction[];
    readonly onPressAction: (event: { nativeEvent: { event: string } }) => void;
    readonly children: (open: () => void) => ReactNode;
  }) => {
    harness.menuActions = props.actions;
    harness.pressMenuAction = (id) => props.onPressAction({ nativeEvent: { event: id } });
    return <>{props.children(() => {})}</>;
  },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { readonly numberOfLines?: number; readonly children?: ReactNode }) => (
    <span data-lines={props.numberOfLines}>{props.children}</span>
  ),
}));
vi.mock("../../components/ui/FloatingActionButton", () => ({ FloatingActionButton: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../../components/ui/SearchField", () => ({ SearchField: () => null }));
vi.mock("../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ fabSize: 56, scale: 1 }),
}));
vi.mock("../../components/ui/useToolbarLayout", () => ({
  useToolbarLayout: () => ({ height: 56, paddingTop: 0, paddingBottom: 7 }),
}));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({ useHardwareKeyboardCommand: () => {} }));
vi.mock("./WorkspaceConnectionTitle", () => ({
  WorkspaceConnectionTitle: (props: { readonly brand: ReactNode }) => <>{props.brand}</>,
}));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ state: { hasConnections: false } }),
}));
vi.mock("../pull-requests/pullRequestGlyphs", () => ({
  PullRequestGlyph: { pullRequest: "pull-request" },
}));

import { INLINE_LIST_BUTTONS_MIN_ROW_WIDTH, ThreadListToolbar } from "./ThreadListToolbar";

let container: HTMLDivElement;
let root: Root | null = null;

function render(sidebar: boolean, rowWidth: number) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  act(() =>
    root!.render(
      <ThreadListToolbar
        sidebar={sidebar}
        searchQuery=""
        onSearchQueryChange={() => {}}
        filterActions={[]}
        filterCustomized={false}
        onFilterAction={() => {}}
        onOpenSettings={() => {}}
        onOpenEnvironments={() => {}}
      />,
    ),
  );
  act(() => harness.rowLayout?.({ nativeEvent: { layout: { width: rowWidth } } }));
}

function buttons() {
  return Array.from(container.querySelectorAll("button"), (button) =>
    button.getAttribute("aria-label"),
  );
}

// The 280dp sidebar of an 800dp window or a narrow foldable, minus the toolbar's 7dp padding.
const NARROW_SIDEBAR_ROW = 266;
// The 380dp sidebar of a landscape tablet.
const WIDE_SIDEBAR_ROW = 366;

beforeEach(() => {
  harness.workspace = { isTabActive: () => true, state: { selectedTab: "threads" } };
  harness.rowLayout = null;
  harness.menuActions = null;
  harness.pressMenuAction = null;
  harness.showList.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe("ThreadListToolbar sidebar header", () => {
  it("keeps the brand on one line", () => {
    render(true, NARROW_SIDEBAR_ROW);
    const brand = Array.from(container.querySelectorAll("span")).find(
      (span) => span.textContent === "Lecturn",
    );
    expect(brand?.dataset.lines).toBe("1");
  });

  it("moves Show apps and Show pull requests into a More menu in a narrow sidebar", () => {
    render(true, NARROW_SIDEBAR_ROW);
    expect(buttons()).toEqual(["Search threads", "Open settings", "More actions"]);
    expect(harness.menuActions?.map((action) => action.title)).toEqual([
      "Show apps",
      "Show pull requests",
    ]);

    act(() => harness.pressMenuAction?.("apps"));
    expect(harness.showList.get("apps")).toHaveBeenCalledTimes(1);
    act(() => harness.pressMenuAction?.("pullRequests"));
    expect(harness.showList.get("pullRequests")).toHaveBeenCalledTimes(1);
  });

  it("keeps the list buttons inline once the brand has room", () => {
    render(true, WIDE_SIDEBAR_ROW);
    expect(buttons()).toEqual([
      "Show apps",
      "Show pull requests",
      "Search threads",
      "Open settings",
    ]);
  });

  it("switches at the documented width", () => {
    render(true, INLINE_LIST_BUTTONS_MIN_ROW_WIDTH - 1);
    expect(buttons()).toContain("More actions");
    act(() =>
      harness.rowLayout?.({
        nativeEvent: { layout: { width: INLINE_LIST_BUTTONS_MIN_ROW_WIDTH } },
      }),
    );
    expect(buttons()).not.toContain("More actions");
    expect(buttons()).toContain("Show apps");
  });

  it("shows no list buttons outside the sidebar", () => {
    render(false, NARROW_SIDEBAR_ROW);
    expect(buttons()).toEqual(["Search threads", "Open settings"]);
    expect(harness.menuActions).toBeNull();
  });
});
