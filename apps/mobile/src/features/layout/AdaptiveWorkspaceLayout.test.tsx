import * as React from "react";
import * as ReactCompilerRuntime from "react/compiler-runtime";
import * as ReactJsxRuntime from "react/jsx-runtime";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as Layout from "../../lib/layout";
import { loadCompiledMobileModule } from "../../lib/reactCompilerModule.test-support";
import type * as AdaptiveWorkspaceLayoutModule from "./AdaptiveWorkspaceLayout";

// The inspector loop only exists in compiled code: the React Compiler decides which closures and
// derived objects keep their identity between renders. So this suite runs the layout module
// exactly as Metro ships it to Android and stubs only the native and navigation edges around it.
let layoutRenders = 0;
let screenRenders = 0;
let readerRenders = 0;
const navigation = { navigate: vi.fn(), dispatch: vi.fn(), getState: () => undefined };
const windowSize = { width: 1280, height: 800, scale: 2, fontScale: 1 };
const selectWorkspace = vi.fn();
const openThreadPullRequests = vi.fn();
const preferences = { value: { threadListFilters: undefined } };

function Passthrough(props: { readonly children?: React.ReactNode }) {
  return <>{props.children}</>;
}

let shownInspector: string | null = null;
function InspectorPaneStub(props: {
  readonly active: boolean;
  readonly renderInspector?: () => React.ReactNode;
}) {
  return props.active && props.renderInspector ? props.renderInspector() : null;
}
function PaneContent(props: { readonly name: string }) {
  React.useLayoutEffect(() => {
    shownInspector = props.name;
    return () => {
      if (shownInspector === props.name) shownInspector = null;
    };
  }, [props.name]);
  return null;
}

const stubModules: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": ReactJsxRuntime,
  "react/compiler-runtime": ReactCompilerRuntime,
  "../../lib/layout": Layout,
  "@lecturn/contracts": {
    EnvironmentId: { make: (value: string) => value },
    ThreadId: { make: (value: string) => value },
  },
  "@effect/atom-react": { useAtomValue: () => preferences },
  "effect/reactivity": {
    AsyncResult: { isSuccess: () => true, isFailure: () => false },
  },
  "@react-navigation/native": {
    // Like React Navigation's own hook for a focused screen: the effect re-runs whenever
    // the callback's identity changes.
    useFocusEffect: (effect: React.EffectCallback) => React.useEffect(() => effect(), [effect]),
    useNavigation: () => navigation,
    NavigationContext: React.createContext<unknown>(undefined),
    NavigationRouteContext: React.createContext<unknown>(undefined),
    CommonActions: { reset: (state: unknown) => ({ type: "RESET", state }) },
    StackActions: { replace: (name: string) => ({ type: "REPLACE", name }) },
  },
  "react-native": {
    Platform: { OS: "android", select: (options: { android?: unknown }) => options.android },
    useWindowDimensions: () => windowSize,
    View: Passthrough,
  },
  "react-native-reanimated": {
    __esModule: true,
    default: { View: Passthrough },
    runOnJS: (fn: unknown) => fn,
    useAnimatedStyle: () => ({}),
    useDerivedValue: () => React.useRef({ value: 0 }).current,
    useSharedValue: (value: number) => React.useRef({ value }).current,
    withTiming: (value: number) => value,
  },
  "../../lib/adaptive-navigation": {
    resolveThreadSelectionNavigationAction: () => "push",
    resolveThreadSelectionOverlayState: () => null,
  },
  "../../lib/scopedEntities": {
    scopedThreadKey: (environmentId: string, threadId: string) => `${environmentId}:${threadId}`,
  },
  "../../state/preferences": { mobilePreferencesAtom: {} },
  "../../state/project-grouping": {
    DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS: { sidebarProjectGroupingMode: "repository" },
    resolveMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "repository" }),
  },
  "../keyboard/hardwareKeyboardCommands": {
    parseActiveThreadPath: () => null,
    useHardwareKeyboardCommand: () => undefined,
  },
  "../home/AndroidHomeFab": { AndroidHomeFabLayout: Passthrough },
  "../workspace/AndroidWorkspaceSidebar": { AndroidWorkspaceSidebar: Passthrough },
  "../workspace/useAndroidWorkspaceSelection": {
    useAndroidWorkspaceSelection: () => selectWorkspace,
  },
  "../home/home-list-options": { HomeListOptionsProvider: Passthrough },
  "../threads/ThreadNavigationSidebar": { ThreadNavigationSidebar: () => null },
  "../threads/use-open-thread-pull-requests": {
    useOpenThreadPullRequests: () => openThreadPullRequests,
  },
  "../../components/RenderErrorBoundary": {
    RenderErrorBoundary: Passthrough,
    RenderFailureView: () => null,
  },
  "./workspace-pane-animation": { WORKSPACE_PANE_TIMING: { duration: 0 } },
  "./workspace-inspector-pane": { WorkspaceInspectorPane: InspectorPaneStub },
  "./workspace-content-width": { WorkspaceContentWidthContext: React.createContext(null) },
  "../../native/v5-workspace-context": {
    NativeWorkspaceModeContext: React.createContext(false),
    NativeWorkspaceInspectorContext: React.createContext(null),
  },
  "../../native/native-layout-metrics": {
    useNativeLayoutMetrics: () => {
      layoutRenders += 1;
      return null;
    },
  },
  "../../native/AndroidHingeObserver": { AndroidHingeObserver: () => null },
  "../../native/window-hinge-context": { WindowHingeContext: React.createContext(null) },
};

let layout: typeof AdaptiveWorkspaceLayoutModule;
let compilerEvents: readonly string[] = [];

beforeAll(() => {
  const compiled = loadCompiledMobileModule({
    file: "src/features/layout/AdaptiveWorkspaceLayout.tsx",
    modules: stubModules,
  });
  compilerEvents = compiled.compilerEvents;
  layout = compiled.exports as unknown as typeof AdaptiveWorkspaceLayoutModule;
});

const paneA = () => <PaneContent name="pane A" />;
const paneB = () => <PaneContent name="pane B" />;
let setScreenPane: (render: () => React.ReactNode) => void = () => undefined;
let rerenderScreen: () => void = () => undefined;

function InspectorScreen(props: { readonly initialPane: () => React.ReactNode }) {
  if (++screenRenders > 50) throw new Error("the inspector registration entered a render loop");
  const [pane, setPane] = React.useState(() => props.initialPane);
  const [, setTick] = React.useState(0);
  React.useLayoutEffect(() => {
    setScreenPane = (render) => setPane(() => render);
    rerenderScreen = () => setTick((tick) => tick + 1);
  });
  layout.useAdaptiveWorkspacePaneRole("inspector");
  layout.useRegisterWorkspaceInspector(pane);
  return null;
}

function ContextReader() {
  readerRenders += 1;
  layout.useAdaptiveWorkspaceLayout();
  return null;
}

let root: Root;
async function renderWorkspace(children: React.ReactNode) {
  await React.act(() =>
    root.render(
      <layout.AdaptiveWorkspaceLayout pathname="/" workspaceRouteKey={undefined}>
        {children}
      </layout.AdaptiveWorkspaceLayout>,
    ),
  );
}

beforeEach(() => {
  layoutRenders = 0;
  screenRenders = 0;
  readerRenders = 0;
  shownInspector = null;
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await React.act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("adaptive workspace inspector registration", () => {
  it("runs the React Compiler output Metro ships", () => {
    expect(compilerEvents).toContain("CompileSuccess");
    expect(compilerEvents.filter((kind) => kind !== "CompileSuccess")).toEqual([]);
  });

  it("settles once a focused screen registers its inspector pane", async () => {
    await renderWorkspace(<InspectorScreen initialPane={paneA} />);

    expect(shownInspector).toBe("pane A");
    expect(screenRenders).toBeLessThanOrEqual(3);
    expect(layoutRenders).toBeLessThanOrEqual(6);
  });

  it("keeps the registration while the screen re-renders for its own reasons", async () => {
    await renderWorkspace(<InspectorScreen initialPane={paneA} />);
    const settledLayoutRenders = layoutRenders;

    for (let index = 0; index < 3; index += 1) {
      await React.act(() => rerenderScreen());
    }

    expect(layoutRenders).toBe(settledLayoutRenders);
    expect(shownInspector).toBe("pane A");
  });

  it("hands over a new pane without re-rendering the rest of the workspace", async () => {
    await renderWorkspace(
      <>
        <ContextReader />
        <InspectorScreen initialPane={paneA} />
      </>,
    );
    const settledReaderRenders = readerRenders;

    await React.act(() => setScreenPane(paneB));

    expect(shownInspector).toBe("pane B");
    expect(readerRenders).toBe(settledReaderRenders);
  });

  it("lets only the current owner deactivate the inspector", async () => {
    await renderWorkspace(
      <>
        <InspectorScreen key="outgoing" initialPane={paneA} />
        <InspectorScreen key="incoming" initialPane={paneB} />
      </>,
    );
    expect(shownInspector).toBe("pane B");

    await renderWorkspace(<InspectorScreen key="incoming" initialPane={paneB} />);
    expect(shownInspector).toBe("pane B");

    await renderWorkspace(null);
    expect(shownInspector).toBeNull();
  });
});
