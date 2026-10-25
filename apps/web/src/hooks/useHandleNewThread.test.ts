import { describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeMode } from "@lecturn/contracts";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let projectRemoved = false;
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => null),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };

  // The target environment's settings, which the hook resolves project settings from.
  const remoteSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree",
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null as { instanceId: string; model: string } | null,
    defaultRuntimeMode: "full-access" as RuntimeMode,
  };
  return {
    remoteSettings,
    get targetSettings() {
      return remoteSettings;
    },
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get projectRemoved() {
      return projectRemoved;
    },
    removeProject() {
      projectRemoved = true;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree",
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      projectRemoved = false;
      remoteSettings.defaultThreadEnvMode = workspaceDefaults.envMode;
      remoteSettings.newWorktreesStartFromOrigin = workspaceDefaults.startFromOrigin;
      remoteSettings.defaultModelSelection = null;
      remoteSettings.defaultRuntimeMode = "full-access";
      draftStore.setModelSelection.mockClear();
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

const testServerConfigs = () =>
  new Map([
    [
      "environment-primary",
      {
        settings: {
          ...testState.targetSettings,
          newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
        },
      },
    ],
    ["environment-ssh", { settings: testState.targetSettings }],
  ]);

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => testServerConfigs() },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : testServerConfigs(),
}));
vi.mock("@lecturn/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@lecturn/client-runtime/state/projectGit", () => ({
  isStaveProject: () => false,
  normalizeProjectThreadWorkspace: (_project: unknown, workspace: unknown) => workspace,
  staveThreadStartMessage: () => null,
}));
vi.mock("@lecturn/contracts", () => ({
  DEFAULT_RUNTIME_MODE: "full-access",
  DEFAULT_SERVER_SETTINGS: {},
}));
vi.mock("@lecturn/shared/projectSettings", () => ({
  resolveProjectSettings: (
    settings: Record<string, unknown>,
    _projectId: unknown,
    _project: unknown,
    projectFile?: { defaultThreadEnvMode?: "local" | "worktree" } | null,
  ) => ({
    settings:
      projectFile === undefined
        ? settings
        : {
            ...settings,
            defaultThreadEnvMode:
              settings.defaultThreadEnvMode ?? projectFile?.defaultThreadEnvMode ?? "local",
          },
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    overrides: {},
  }),
  resolveNewThreadEnvMode: (input: {
    projectSettings: { settings: { defaultThreadEnvMode: "local" | "worktree" } };
  }) => input.projectSettings.settings.defaultThreadEnvMode,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("../composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
// Keeps the input order, so the first listed project is the default target.
vi.mock("../components/Sidebar.logic", () => ({
  orderItemsByPreferredIds: (input: { readonly items: ReadonlyArray<unknown> }) => [...input.items],
}));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => false,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  hasExplicitComposerModelSelection: () => false,
  resolveCarriedThreadModes: () => ({ runtimeMode: null, interactionMode: null }),
  resolveNewThreadEnvModeSources: () => ({
    forcedMode: undefined,
    projectSetting: null,
    consultProjectFile: true,
  }),
}));
vi.mock("../lib/lecturnProjectFileDefaults", () => ({
  readLecturnProjectFile: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => {
  const project = {
    id: "project-remote",
    environmentId: "environment-ssh",
    workspaceRoot: "/remote/project",
    defaultThreadEnvMode: null,
    defaultModelSelection: null,
  };
  return {
    readProject: () => (testState.projectRemoved ? null : project),
    readProjects: () => (testState.projectRemoved ? [] : [project]),
    readThreadShell: () => null,
    readThreadShells: () => [],
    useProjects: () => [],
    useThread: () => null,
  };
});
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { resolveDefaultNewThreadProjectRef, useNewThreadHandler } from "./useHandleNewThread";

describe("useNewThreadHandler", () => {
  it("opens a remote project with that machine’s model and workspace defaults", async () => {
    testState.reset(null);
    testState.remoteSettings.defaultThreadEnvMode = "worktree";
    testState.remoteSettings.defaultModelSelection = {
      instanceId: "codex_work",
      model: "remote-model",
    };
    testState.completeProjectFileRead(null);
    const result = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    expect(result?.draftId).toBe("draft-delayed");
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      { environmentId: "environment-ssh", projectId: "project-remote" },
      "draft-delayed",
      expect.objectContaining({ envMode: "worktree" }),
    );
    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      "draft-delayed",
      { instanceId: "codex_work", model: "remote-model" },
      { replaceOptions: true },
    );
  });
});

describe.each([
  ["new", null],
  [
    "reusable",
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    },
  ],
])("useNewThreadHandler with a %s draft", (_, draft) => {
  it.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
    "uses the target environment's %s permissions for new threads",
    async (runtimeMode) => {
      testState.reset(draft);
      testState.targetSettings.defaultRuntimeMode = runtimeMode;
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;
      const pendingOpen = useNewThreadHandler()(projectRef);
      testState.completeProjectFileRead(null);
      const opened = await pendingOpen;

      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining({ runtimeMode }),
      );
    },
  );

  it("abandons a delayed draft open when the user navigates elsewhere", async () => {
    testState.reset(draft);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });

  it("abandons a delayed draft open when the project is removed meanwhile", async () => {
    testState.reset(draft);
    const pendingOpen = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.removeProject();
    testState.completeProjectFileRead(null);

    await expect(pendingOpen).resolves.toBeNull();
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses the target environment's start-from-origin default of %s",
    async (startFromOrigin) => {
      testState.reset(draft, { envMode: "worktree", startFromOrigin });
      const openThread = useNewThreadHandler();
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;
      const pendingOpen = openThread(projectRef);

      testState.completeProjectFileRead(null);
      const opened = await pendingOpen;

      expect(opened).toEqual({
        draftId: draft?.draftId ?? "draft-delayed",
        threadId: draft?.threadId ?? "thread-delayed",
      });
      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining({ envMode: "worktree", startFromOrigin }),
      );
      if (draft) {
        expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
          draft.draftId,
          expect.objectContaining({ envMode: "worktree", startFromOrigin }),
        );
      }
    },
  );

  it.each([true, false])(
    "preserves an explicit start-from-origin choice of %s",
    async (startFromOrigin) => {
      testState.reset(draft, { envMode: "worktree", startFromOrigin: !startFromOrigin });
      const openThread = useNewThreadHandler();
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;

      const opened = await openThread(projectRef, { envMode: "worktree", startFromOrigin });

      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining({ envMode: "worktree", startFromOrigin }),
      );
    },
  );
});

describe("new-thread targets around app projects", () => {
  const project = (id: string, extra: object = {}) =>
    ({
      id,
      environmentId: "environment-primary",
      title: id,
      workspaceRoot: "/work/rocket",
      ...extra,
    }) as unknown as Parameters<typeof resolveDefaultNewThreadProjectRef>[0][number];
  const appProject = project("app-project", {
    appBinding: { appId: "dev.example.rocket", workspaceRoot: "/work/rocket" },
  });
  const normalProject = project("normal-project");

  it("never defaults to an app project, even when it sorts first", () => {
    expect(resolveDefaultNewThreadProjectRef([appProject, normalProject], [])).toEqual({
      environmentId: "environment-primary",
      projectId: "normal-project",
    });
  });

  it("has no default when only app projects exist", () => {
    expect(resolveDefaultNewThreadProjectRef([appProject], [])).toBeNull();
  });

  it("keeps a new thread from an app thread in that app's project", async () => {
    const handleNewThread = vi.fn(async () => null);
    await startNewThreadFromContext({
      activeDraftThread: null,
      activeThread: { environmentId: "environment-primary", projectId: "app-project" },
      defaultProjectRef: resolveDefaultNewThreadProjectRef([appProject, normalProject], []),
      handleNewThread,
    } as unknown as Parameters<typeof startNewThreadFromContext>[0]);
    expect(handleNewThread).toHaveBeenCalledWith({
      environmentId: "environment-primary",
      projectId: "app-project",
    });
  });
});
