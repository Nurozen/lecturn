import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import type { IncomingShareDraft } from "../sharing/incoming-share-model";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type VcsListRefsResult,
} from "@lecturn/contracts";
import { act, useEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  dispatch: vi.fn(),
  goBack: vi.fn(),
  noop: () => null,
  projects: [] as EnvironmentProject[],
  branches: {
    refs: [] as VcsListRefsResult["refs"],
    data: null as VcsListRefsResult | null,
    isPending: false,
    isFetchingNextPage: false,
    error: null,
    refresh: vi.fn(),
    loadNext: vi.fn(),
  },
  shareInbox: {
    getShare: vi.fn<(id: string) => IncomingShareDraft | null>(() => null),
    consumeShare: vi.fn(),
    reserveShare: vi.fn(),
    releaseShareReservation: vi.fn(),
    isLoading: false,
  },
}));
vi.mock("react-native", () => ({
  View: native.noop,
  Pressable: native.noop,
  ScrollView: native.noop,
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
}));
vi.mock("react-native-reanimated", () => ({ default: { View: native.noop } }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: vi.fn() },
  KeyboardStickyView: native.noop,
  useKeyboardState: () => false,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    dispatch: native.dispatch,
    goBack: native.goBack,
    getParent: () => null,
    addListener: () => () => {},
  }),
  useFocusEffect: () => {},
  usePreventRemove: () => {},
  StackActions: { replace: (name: string) => ({ type: "replace", name }), push: vi.fn() },
  CommonActions: { navigate: vi.fn() },
}));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: native.noop,
  NativeHeaderToolbar: Object.assign(native.noop, { Button: native.noop }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../lib/useFontFamily", () => ({ useFontFamily: () => "Lecturn" }));
vi.mock("../settings/appearance/useScaledTextRole", () => ({ useScaledTextRole: () => ({}) }));
vi.mock("./use-thread-settings-sheet-presentation", () => ({
  useThreadSettingsSheetPresentation: () => ({
    isVisible: false,
    onDismissed: vi.fn(),
    onStackTransitionsFinished: vi.fn(),
  }),
}));
vi.mock("./use-composer-command-menu", () => ({
  useComposerCommandMenu: () => ({ skills: [], selection: null, items: [] }),
}));
vi.mock("../voice-input/useVoiceInputController", () => ({
  useVoiceInputController: () => ({ state: { status: "idle" }, elapsedSeconds: 0 }),
}));
vi.mock("../voice-input/voiceInputPresentation", () => ({
  resolveVoiceComposerPresentation: () => ({ statusLabel: null }),
}));
vi.mock("./use-import-thread", () => ({
  useThreadImportAvailability: () => ({ available: false }),
}));
vi.mock("../sharing/IncomingShareProvider", () => ({ useIncomingShare: () => native.shareInbox }));
vi.mock("../agent-awareness/remoteRegistration", () => ({
  armAgentAwarenessLiveActivityForLocalWork: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "fixture-uuid" }));
vi.mock("../../lib/composerImages", () => ({
  composerStripAttachments: (attachments: ReadonlyArray<unknown>) => attachments,
  removePersistedComposerAttachmentFile: vi.fn(),
}));
vi.mock("../../lib/attachmentUpload", () => ({ releasePendingAttachmentUploads: vi.fn() }));
vi.mock("../sharing/incoming-share-storage", () => ({ loadIncomingShareDrafts: async () => [] }));
vi.mock("expo-file-system", () => ({
  Paths: { document: { uri: "file:///fixture" } },
  Directory: class {
    create() {}
    list() {
      return [];
    }
  },
  File: class {
    exists = false;
    create() {}
    write() {}
    moveSync() {}
    async text() {
      return "{}";
    }
  },
}));
vi.mock("../../state/thread-outbox-storage", () => ({
  expoThreadOutboxStorage: {
    load: async () => ({ messages: [], errors: [] }),
    write: async () => {},
    remove: async () => {},
  },
  flushThreadOutboxWrites: async () => {},
}));
vi.mock("../../state/entities", () => ({
  useListedProjects: () => native.projects,
  useListedThreadShells: () => [],
  useThreadShells: () => [],
  useEnvironmentServerConfig: () => null,
  useServerConfigs: () => new Map(),
}));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "none" }),
}));
vi.mock("./use-legacy-plan-mode-enabled", () => ({
  useLegacyPlanModeState: () => ({ enabled: false, loaded: true }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
  setPendingConnectionError: vi.fn(),
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false }),
}));
vi.mock("../../state/queries", () => ({
  useDebouncedValue: (value: string) => value,
  usePaginatedBranches: () => native.branches,
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { readFile: vi.fn(), delete: { label: "project.delete" } },
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: vi.fn() } }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    cancelProjectClone: { label: "clone.cancel" },
    retryProjectClone: { label: "clone.retry" },
  },
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("../../state/use-thread-outbox", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  const { threadOutboxManager } = await import("../../state/thread-outbox");
  return {
    holdEditingQueuedMessage: vi.fn(),
    releaseEditingQueuedMessage: vi.fn(),
    useThreadOutboxMessages: () => useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  };
});
vi.mock("../../state/composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    composerAttachmentUploadsAtom: Atom.make({}),
    composerAttachmentUploadBlockReason: () => null,
    composerAttachmentsStillUploading: () => false,
  };
});
vi.mock("../../components/ArcaneBackdrop", () => ({ ArcaneBackdrop: native.noop }));
vi.mock("../../components/ComposerEditor", () => ({ ComposerEditor: native.noop }));
vi.mock("../../components/ComposerToolbar", () => ({
  ComposerActionButton: native.noop,
  ComposerInlineControl: native.noop,
  ComposerToolbarRow: native.noop,
  ComposerToolbarScroller: native.noop,
}));
vi.mock("../../components/AndroidScreenHeader", () => ({ AndroidScreenHeader: native.noop }));
vi.mock("../../components/ComposerAttachmentButton", () => ({
  ComposerAttachmentButton: native.noop,
}));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: native.noop,
}));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: native.noop,
}));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: native.noop }));
vi.mock("../../components/VideoPreviewModal", () => ({ VideoPreviewModal: native.noop }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: native.noop }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: native.noop }));
vi.mock("../../components/AppText", () => ({ AppText: native.noop }));
vi.mock("./ThreadComposer", () => ({
  ComposerSurface: native.noop,
  COMPOSER_LAYOUT_TRANSITION: undefined,
}));
vi.mock("./ComposerCommandPopover", () => ({ ComposerCommandPopover: native.noop }));
vi.mock("../contextual/ContextualDraftControl", () => ({ ContextualDraftControl: native.noop }));
vi.mock("../voice-input/ComposerDictationControl", () => ({
  ComposerDictationCancelAction: native.noop,
  ComposerDictationPrimaryAction: native.noop,
  ComposerDictationStatus: native.noop,
  ComposerDictationToolbar: native.noop,
}));

import { NewTaskDraftScreen } from "./NewTaskDraftScreen";
import { NewTaskFlowProvider, useNewTaskFlow } from "./new-task-flow-provider";
import { appAtomRegistry } from "../../state/atom-registry";
import { enqueueThreadOutboxMessage, threadOutboxManager } from "../../state/thread-outbox";
import {
  composerDraftsAtom,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  resetComposerDraftsLoadState,
  mergeComposerDraftContent,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";

const project: EnvironmentProject = {
  environmentId: EnvironmentId.make("host"),
  id: ProjectId.make("project"),
  title: "Lecturn",
  workspaceRoot: "/fixture/lecturn",
  repositoryIdentity: null,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  scripts: [],
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
};
const initialProjectRef = {
  environmentId: project.environmentId,
  projectId: project.id,
  branch: "main",
  worktreePath: "/fixture/main-worktree",
};
const metadata = {
  threadId: "task",
  messageId: "message",
  commandId: "command",
  createdAt: "2026-10-14T00:00:00.000Z",
};
const contextual = { enabled: false, sourceIds: ["source"] };
let root: Root;
let flow: ReturnType<typeof useNewTaskFlow>;

function Probe() {
  const state = useNewTaskFlow();
  useEffect(() => {
    flow = state;
  }, [state]);
  return null;
}
async function render(props?: ComponentProps<typeof NewTaskDraftScreen>) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <NewTaskFlowProvider>
          <Probe />
          {props ? <NewTaskDraftScreen {...props} /> : null}
        </NewTaskFlowProvider>
      </RegistryContext.Provider>,
    ),
  );
}
function draftKeys() {
  return Object.keys(appAtomRegistry.get(composerDraftsAtom));
}
function loadBranches(defaultBranch: string, isRemote = false) {
  native.branches.refs = [
    { name: defaultBranch, current: false, isDefault: true, isRemote, worktreePath: null },
    {
      name: "feature",
      current: true,
      isDefault: false,
      isRemote: false,
      worktreePath: "/fixture/feature-worktree",
    },
  ];
  native.branches.data = {
    refs: native.branches.refs,
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: native.branches.refs.length,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  native.shareInbox.getShare.mockReturnValue(null);
  native.projects = [project];
  native.branches.refs = [];
  native.branches.data = null;
  appAtomRegistry.set(composerDraftsAtom, {});
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  resetComposerDraftsLoadState();
  await waitForComposerDraftsLoaded();
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
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("native direct new-task entry", () => {
  it.each([
    ["main", "host"],
    ["develop", "host"],
    ["main", "remote-account"],
    ["develop", "remote-account"],
  ])(
    "preserves the prepared local main checkout over available default %s on %s",
    async (defaultBranch, environment) => {
      const target = {
        ...project,
        environmentId: EnvironmentId.make(environment),
        defaultThreadEnvMode: "worktree" as const,
      };
      native.projects = [target];
      loadBranches(defaultBranch);
      await render();
      expect(flow.draftKey).toBeNull();
      const request = { ...initialProjectRef, environmentId: target.environmentId };
      await render({ initialProjectRef: request });
      const key = flow.draftKey!;
      const preparedSelection = {
        mode: "local",
        branch: "main",
        worktreePath: "/fixture/main-worktree",
        startFromOrigin: false,
      };
      expect(getComposerDraftSnapshot(key).workspaceSelection).toEqual(preparedSelection);
      expect(flow.workspaceMode).toBe("local");
      expect(flow.selectedBranchName).toBe("main");
      expect(flow.selectedWorktreePath).toBe(request.worktreePath);
      expect(flow.startFromOrigin).toBe(false);
      await act(() => flow.setPrompt("Use the prepared checkout"));
      expect(flow.buildPendingTaskMessage(metadata)).toMatchObject({
        environmentId: target.environmentId,
        text: "Use the prepared checkout",
        creation: {
          workspaceMode: "local",
          branch: "main",
          worktreePath: request.worktreePath,
        },
      });
      if (environment === "remote-account") {
        // Another account can expose the same project id without owning this draft.
        native.projects = [project, target];
      }
      loadBranches("replacement-default");
      await render({ initialProjectRef: request });
      expect(flow.selectedProject).toBe(target);
      expect(flow.draftKey).toBe(key);
      expect(draftKeys()).toEqual([key]);
      expect(getComposerDraftSnapshot(key).workspaceSelection).toEqual(preparedSelection);
    },
  );

  it.each([false, true])(
    "still initializes an ordinary worktree draft from a default ref (remote: %s)",
    async (isRemote) => {
      native.projects = [{ ...project, defaultThreadEnvMode: "worktree" }];
      const branch = isRemote ? "origin/develop" : "develop";
      loadBranches(branch, isRemote);
      await render({ initialProjectRef: { ...initialProjectRef, branch: null } });
      await act(() => flow.setPrompt("Create a worktree"));
      expect(getComposerDraftSnapshot(flow.draftKey!).workspaceSelection).toEqual({
        mode: "worktree",
        branch,
        worktreePath: null,
      });
      expect(flow.buildPendingTaskMessage(metadata)).toMatchObject({
        text: "Create a worktree",
        creation: { workspaceMode: "worktree", branch, worktreePath: null },
      });
    },
  );

  it("keeps the inferred project draft-free until entering its composer, then accepts a sendable prompt on the prepared branch", async () => {
    await render();
    expect(flow.selectedProject).toBe(project);
    expect(flow.draftKey).toBeNull();
    expect(draftKeys()).toEqual([]);
    await render({ initialProjectRef });
    const key = flow.draftKey;
    expect(key).not.toBeNull();
    expect(key).toMatch(/^new-task:[^:]+$/);
    expect(draftKeys()).toEqual([key]);
    await act(() => {
      flow.setPrompt("Task recovery fixture");
      updateComposerDraftSettings(key!, { contextual });
    });
    expect(flow.prompt).toBe("Task recovery fixture");
    expect(getComposerDraftSnapshot(key!).project).toMatchObject({
      environmentId: project.environmentId,
      projectId: project.id,
    });
    expect(flow.buildPendingTaskMessage(metadata)).toMatchObject({
      text: "Task recovery fixture",
      modelSelection: project.defaultModelSelection,
      creation: {
        projectId: project.id,
        workspaceMode: "local",
        branch: "main",
        worktreePath: initialProjectRef.worktreePath,
        contextual,
      },
    });
    await render({ initialProjectRef });
    expect(flow.draftKey).toBe(key);
    expect(draftKeys()).toEqual([key]);
  });

  it("also binds ordinary direct entry without a branch preset", async () => {
    await render({ initialProjectRef: { ...initialProjectRef, branch: null } });
    expect(flow.draftKey).not.toBeNull();
    await act(() => flow.setPrompt("Fresh task"));
    expect(flow.buildPendingTaskMessage(metadata)?.text).toBe("Fresh task");
  });

  it("keeps an active real draft's identity and content, and applies a branch preset only once", async () => {
    native.projects = [{ ...project, defaultThreadEnvMode: "worktree" }];
    loadBranches("develop");
    await render();
    await act(() => flow.setProject(project));
    const key = flow.draftKey!;
    await act(async () => {
      flow.setPrompt("Existing work");
      updateComposerDraftSettings(key, { contextual });
      await mergeComposerDraftContent(key, { text: "", attachments: [], sourceShareId: "share" });
    });
    await render({ initialProjectRef });
    expect(flow.draftKey).toBe(key);
    expect(draftKeys()).toEqual([key]);
    expect(getComposerDraftSnapshot(key)).toMatchObject({
      text: "Existing work",
      contextual,
      importedShareIds: ["share"],
      workspaceSelection: { branch: "main" },
    });
    await act(() =>
      flow.selectBranch({ name: "feature", current: false, isDefault: false, worktreePath: null }),
    );
    await render({ initialProjectRef });
    expect(flow.selectedBranchName).toBe("feature");
    expect(flow.buildPendingTaskMessage(metadata)?.creation?.contextual).toEqual(contextual);
    const otherProject = { ...project, id: ProjectId.make("other") };
    native.projects = [project, otherProject];
    await act(() => flow.setProject(otherProject));
    await render({ initialProjectRef });
    expect(flow.selectedProject).toBe(otherProject);
    expect(flow.draftKey).toBe(key);
    expect(flow.prompt).toBe("Existing work");
    expect(draftKeys()).toEqual([key]);
  });

  it("imports shared text into the newly bound branch draft once", async () => {
    native.projects = [{ ...project, defaultThreadEnvMode: "worktree" }];
    loadBranches("develop");
    const share: IncomingShareDraft = {
      schemaVersion: 1,
      id: "incoming-share",
      createdAt: metadata.createdAt,
      text: "Shared work",
      attachments: [],
      warnings: [],
    };
    native.shareInbox.getShare.mockReturnValue(share);
    await render({ initialProjectRef, incomingShareId: share.id });
    const key = flow.draftKey!;
    expect(getComposerDraftSnapshot(key)).toMatchObject({
      text: "Shared work",
      importedShareIds: [share.id],
    });
    expect(flow.buildPendingTaskMessage(metadata)).toMatchObject({
      text: "Shared work",
      creation: { branch: "main" },
    });
    await render({ initialProjectRef, incomingShareId: share.id });
    expect(flow.draftKey).toBe(key);
    expect(flow.prompt).toBe("Shared work");
    expect(draftKeys()).toEqual([key]);
  });

  it("waits for a resumed draft's project without creating a fallback draft", async () => {
    const key = createNewTaskDraft({ environmentId: project.environmentId, projectId: project.id });
    setComposerDraftText(key, "Resume after reconnect");
    native.projects = [{ ...project, environmentId: EnvironmentId.make("other-host") }];
    await render({ initialProjectRef, draftId: key });
    expect(flow.draftKey).toBeNull();
    expect(draftKeys()).toEqual([key]);
    native.projects = [project];
    await render({ initialProjectRef, draftId: key });
    expect(flow.draftKey).toBe(key);
    expect(flow.prompt).toBe("Resume after reconnect");
    expect(draftKeys()).toEqual([key]);
  });

  it("resumes the named recovered draft without applying the direct-entry project or branch", async () => {
    native.projects = [{ ...project, defaultThreadEnvMode: "worktree" }];
    loadBranches("develop");
    const key = createNewTaskDraft({ environmentId: project.environmentId, projectId: project.id });
    setComposerDraftText(key, "Recovered work");
    updateComposerDraftSettings(key, {
      contextual,
      workspaceSelection: {
        mode: "local",
        branch: "recovery",
        worktreePath: "/fixture/recovery-worktree",
        startFromOrigin: false,
      },
    });
    await render({ initialProjectRef, draftId: key });
    expect(flow.draftKey).toBe(key);
    expect(draftKeys()).toEqual([key]);
    expect(flow.buildPendingTaskMessage(metadata)).toMatchObject({
      text: "Recovered work",
      creation: {
        workspaceMode: "local",
        branch: "recovery",
        worktreePath: "/fixture/recovery-worktree",
        contextual,
      },
    });
  });

  it("edits the pending task in its own draft without replacing another draft or applying the branch preset", async () => {
    native.projects = [{ ...project, defaultThreadEnvMode: "worktree" }];
    loadBranches("develop");
    const key = createNewTaskDraft({ environmentId: project.environmentId, projectId: project.id });
    setComposerDraftText(key, "Other draft");
    const message = {
      environmentId: project.environmentId,
      threadId: ThreadId.make(metadata.threadId),
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text: "Pending work",
      attachments: [],
      modelSelection: project.defaultModelSelection!,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      creation: {
        projectId: project.id,
        projectTitle: project.title,
        projectCwd: project.workspaceRoot,
        workspaceMode: "local" as const,
        branch: "queued",
        worktreePath: "/fixture/queued-worktree",
        contextual,
      },
      createdAt: metadata.createdAt,
    };
    await enqueueThreadOutboxMessage(message);
    await render({ initialProjectRef, pendingTaskId: message.messageId });
    expect(flow.draftKey).toBe(`pending-task:${message.messageId}`);
    await act(() => flow.setPrompt("Edited pending work"));
    expect(flow.buildPendingTaskMessage(metadata)).toMatchObject({
      text: "Edited pending work",
      creation: {
        workspaceMode: "local",
        branch: "queued",
        worktreePath: "/fixture/queued-worktree",
        contextual,
      },
    });
    expect(getComposerDraftSnapshot(key).text).toBe("Other draft");
    expect(draftKeys().sort()).toEqual([key, `pending-task:${message.messageId}`].sort());
    await act(() => flow.finishEditingPendingTask());
  });
});
