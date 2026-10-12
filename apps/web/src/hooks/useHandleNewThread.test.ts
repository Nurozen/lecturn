import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
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

  const remoteSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree",
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null as { instanceId: string; model: string } | null,
  };
  return {
    remoteSettings,
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    reset(nextStoredDraft: typeof storedDraft) {
      storedDraft = nextStoredDraft;
      remoteSettings.defaultThreadEnvMode = "local";
      remoteSettings.defaultModelSelection = null;
      draftStore.setModelSelection.mockClear();
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: false }
      : new Map([
          [
            "environment-ssh",
            {
              settings: testState.remoteSettings,
            },
          ],
        ]),
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
vi.mock("@lecturn/shared/threadEnvMode", () => ({
  resolveDefaultThreadEnvMode: (input: {
    readonly projectFile: "local" | "worktree" | null;
    readonly globalDefault: "local" | "worktree";
  }) => input.projectFile ?? input.globalDefault,
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
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
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
  resolveNewDraftStartFromOrigin: () => false,
  resolveNewThreadEnvModeSources: () => ({
    forcedMode: null,
    projectSetting: null,
    consultProjectFile: true,
  }),
}));
vi.mock("../lib/lecturnProjectFileDefaults", () => ({
  readLecturnProjectFileDefaultThreadEnvMode: () => testState.projectFileRead,
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
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultThreadEnvMode: null,
      defaultModelSelection: null,
    },
  ],
  readThreadShell: () => null,
  useProjects: () => [],
  useThread: () => null,
}));
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

import { useNewThreadHandler } from "./useHandleNewThread";

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

  it.each([
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
  ])("abandons a delayed %s draft open when the user navigates elsewhere", async (_, draft) => {
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
});

afterEach(() => vi.unstubAllGlobals());

describe("Android empty drafts", () => {
  it.each([
    ["new", null],
    [
      "reusable Full",
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
        runtimeMode: "full-access",
      },
    ],
  ] as const)("opens a %s draft without requesting device access", async (_, draft) => {
    testState.reset(draft);
    const getAccessState = vi.fn();
    const requestFullAccess = vi.fn();
    vi.stubGlobal("window", {
      symbaHost: { protocolVersion: 2, getAccessState, requestFullAccess },
    });
    testState.completeProjectFileRead(null);
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    expect(opened).toEqual({
      draftId: draft?.draftId ?? "draft-delayed",
      threadId: draft?.threadId ?? "thread-delayed",
    });
    expect(testState.router.navigate).toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalled();
    expect(getAccessState).not.toHaveBeenCalled();
    expect(requestFullAccess).not.toHaveBeenCalled();
  });
});
