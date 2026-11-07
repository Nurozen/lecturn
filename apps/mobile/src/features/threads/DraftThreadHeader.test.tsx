import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  appBarProps: null as { readonly onBack?: () => void } | null,
  canGoBack: true,
  goBack: vi.fn(),
  dispatch: vi.fn(),
  tabDispatch: vi.fn(),
  status: vi.fn((target: unknown) => target),
  runStackedAction: vi.fn(),
}));

vi.mock("react-native", () => ({
  BackHandler: { addEventListener: vi.fn() },
  Keyboard: { dismiss: vi.fn(), isVisible: () => false },
  Platform: { OS: "android" },
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: vi.fn() },
  useFocusEffect: vi.fn(),
  useNavigation: () => ({
    canGoBack: () => native.canGoBack,
    dispatch: native.dispatch,
    getParent: () => undefined,
    getState: () => ({ key: "root", index: 1, routes: [{ name: "Home" }, { name: "Thread" }] }),
    goBack: native.goBack,
    navigate: vi.fn(),
  }),
}));
vi.mock("../workspace/WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => ({ dispatch: native.tabDispatch }),
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: { readonly onBack?: () => void }) => {
    native.appBarProps = props;
    return null;
  },
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/ScreenHeaderButton", () => ({ ScreenHeaderButton: () => null }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: undefined }) }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-vcs-action-state", () => ({
  useVcsActionState: () => ({ currentLabel: null }),
}));
vi.mock("../../state/vcs", () => ({
  vcsActionManager: { runStackedAction: native.runStackedAction },
  vcsEnvironment: { pull: {}, status: native.status },
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    composerKeyboardActive: false,
    layout: { usesSplitView: false },
    panes: { auxiliaryPaneVisible: false },
    toggleAuxiliaryPane: vi.fn(),
  }),
}));
vi.mock("../pull-requests/pullRequestGlyphs", () => ({ PullRequestGlyph: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("./useThreadHeaderOptions", () => ({
  useThreadHeaderOptions: () => ({
    fallback: null,
    options: {},
    optionsVersion: 0,
    sidebar: false,
  }),
}));

import { DraftThreadHeader } from "./DraftThreadHeader";

const thread = { environmentId: "environment", id: "thread" } as unknown as EnvironmentThreadShell;

function project(fields: object) {
  return { title: "Project", ...fields } as unknown as EnvironmentProject;
}

function renderHeader(fields: object, cwd: string | null) {
  renderToStaticMarkup(<DraftThreadHeader thread={thread} project={project(fields)} cwd={cwd} />);
  return native.appBarProps;
}

const staveSpace = {
  workspaceRoot: "/spaces/lecturn",
  stave: {
    spaceId: "lecturn",
    isSaga: false,
    repos: [],
    memories: [],
    primaryRepoPath: "/spaces/lecturn/lecturn",
    primaryBranch: "lecturn/main",
  },
};

beforeEach(() => {
  native.appBarProps = null;
  native.canGoBack = true;
  vi.clearAllMocks();
});

describe("DraftThreadHeader", () => {
  it("reads a Stave draft's status from the primary repo, not the space root", () => {
    renderHeader(staveSpace, "/spaces/lecturn");
    expect(native.status).toHaveBeenCalledWith({
      environmentId: "environment",
      input: { cwd: "/spaces/lecturn/lecturn" },
    });
  });

  it("targets a Stave draft's git actions at the primary repo, not the space root", () => {
    renderHeader(staveSpace, "/spaces/lecturn");
    expect(native.runStackedAction).toHaveBeenCalledWith({
      environmentId: "environment",
      cwd: "/spaces/lecturn/lecturn",
    });
  });

  it("reads a selected worktree's status from that worktree", () => {
    renderHeader({ workspaceRoot: "/repo" }, "/repo/.lecturn/worktrees/feature");
    expect(native.status).toHaveBeenCalledWith({
      environmentId: "environment",
      input: { cwd: "/repo/.lecturn/worktrees/feature" },
    });
  });

  it("returns from an Android draft to where it opened, keeping the workspace tab", () => {
    renderHeader({ workspaceRoot: "/repo" }, "/repo")?.onBack?.();
    expect(native.goBack).toHaveBeenCalledOnce();
    expect(native.tabDispatch).not.toHaveBeenCalled();
    expect(native.dispatch).not.toHaveBeenCalled();
  });

  it("falls back to the workspace list when a linked draft has nothing below it", () => {
    native.canGoBack = false;
    renderHeader({ workspaceRoot: "/repo" }, "/repo")?.onBack?.();
    expect(native.tabDispatch).toHaveBeenCalledWith({ type: "select", tab: "threads" });
    expect(native.dispatch).toHaveBeenCalledOnce();
  });
});
