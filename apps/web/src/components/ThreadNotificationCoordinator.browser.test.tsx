import { threadsForProjectsMode } from "@lecturn/client-runtime/state/app-projects";
import { WORKING_EXIT_GRACE_MS } from "@lecturn/client-runtime/state/thread-inbox";
import { AppId, EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import type { ClientSettings } from "@lecturn/contracts/settings";
import type { AnyRouter } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers, stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  limited: false,
  subagent: false,
  background: [] as Array<{ taskId: string; kind: "command" | "monitor" }>,
  delegatedChild: null as "running" | "approval" | null,
  appProject: false,
  appStatuses: [] as Array<{ environmentId: string; app: { appId: string; name: string } }>,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  settingsListeners: new Set<() => void>(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell() {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: state.subagent ? "parent" : null,
      relationshipToParent: state.subagent ? "subagent" : null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: null,
    status: state.completedAt
      ? "completed"
      : state.sessionError || state.turnError || state.limited
        ? "failed"
        : "running",
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: state.background,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const APP_ID = "dev.rocketwright";

function mockProjects() {
  return [
    {
      id: "project-1",
      title: "rocket-design",
      ...(state.appProject
        ? { appBinding: { appId: APP_ID, workspaceRoot: "/work/rocket-design" } }
        : {}),
    },
  ];
}

let stableParent: ReturnType<typeof mockThreadShell> | null = null;
function mockThreads() {
  if (state.delegatedChild === null) return [mockThreadShell()];
  stableParent ??= mockThreadShell();
  const child = {
    ...mockThreadShell(),
    id: "child-1",
    title: "Review the login form",
    creationSource: "mcp",
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: "thread-1",
      relationshipToParent: "subagent",
    },
    pendingRuntimeRequest:
      state.delegatedChild === "approval"
        ? { id: "request-2", kind: "command", createdAt: SHELL_NOW }
        : null,
  };
  return [stableParent, child];
}

// Read lazily by the mocks: their factories run before this module's own bindings exist.
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>(["env-1"]);
// Made in the mock factories: a module export is read as soon as its module evaluates.
const forkAtoms = vi.hoisted(() => ({
  appStatuses: null as unknown as Atom.Writable<ReadonlyArray<unknown>>,
  squireEnvironments: null as unknown as Atom.Writable<ReadonlyArray<unknown>>,
}));
let registry: AtomRegistry.AtomRegistry;

vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
  })) as never,
}));
vi.mock(import("../state/apps"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  forkAtoms.appStatuses = Atom.make<ReadonlyArray<unknown>>([]);
  return { ...(await original()), readableAppStatusesAtom: forkAtoms.appStatuses as never };
});
vi.mock(import("../state/squires"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  forkAtoms.squireEnvironments = Atom.make<ReadonlyArray<unknown>>([]);
  return {
    ...(await original()),
    readableSquireEnvironmentsAtom: forkAtoms.squireEnvironments as never,
  };
});
function pushSquireNotifications(sequences: number[]) {
  registry.set(forkAtoms.squireEnvironments, [
    {
      environmentId: "env-1",
      state: {
        squires: [
          {
            squire: { id: "lead", name: "Lead", permissions: { notify: "on" } },
            openDecisionCount: 1,
            recentActivity: sequences.map((sequence) => ({
              kind: "notification.pushed",
              sequence,
            })),
          },
        ],
      },
    },
  ]);
}
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: vi.fn(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.add as never, close: state.close },
  };
});

import { threadNotificationTag } from "../threadNotifications";
import { useUiStateStore } from "../uiStateStore";
import { startThreadNotifications } from "./ThreadNotificationCoordinator";

// The mocked modules read `state`, so every test starts by resetting all of it. The service
// starts on the first render, since some tests change state before it starts.
function setup() {
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
    limited: false,
    subagent: false,
    background: [],
    delegatedChild: null,
    appProject: false,
    appStatuses: [],
  });
  state.settingsListeners.clear();
  stableParent = null;
  const stack = new AsyncDisposableStack();
  registry = AtomRegistry.make();
  const testRegistry = registry;
  stack.defer(() => testRegistry.dispose());
  useUiStateStore.setState({ sidebarMode: "projects", sidebarAppScopeKey: null });
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => state.visible as DocumentVisibilityState),
  );
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused));
  stack.use(
    stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" })),
  );
  const router = {
    state: {
      get matches() {
        return [{ params: state.active }];
      },
    },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  let started = false;
  const renderCoordinator = async () => {
    testRegistry.set(forkAtoms.appStatuses, state.appStatuses);
    testRegistry.set(shellAtom("env-1"), {
      status: state.live ? "live" : "disconnected",
      snapshot: Option.some({ threads: mockThreads(), projects: mockProjects() }),
    });
    if (!started) {
      started = true;
      stack.defer(startThreadNotifications(testRegistry, router));
    }
  };
  return {
    render: renderCoordinator,
    // A completion notifies once the Working shelf's exit grace passes.
    complete: async () => {
      using _timers = fakeTimers();
      state.completedAt = "2026-09-13T10:00:00.000Z";
      await renderCoordinator();
      await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("squire notifications", () => {
  it("toasts only for intents pushed after the first look and opens the Squire", async () => {
    await using app = setup();
    pushSquireNotifications([1]);
    await app.render();
    expect(state.add).not.toHaveBeenCalled();
    pushSquireNotifications([1, 2]);
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast).toMatchObject({ title: "Lead", description: "1 item waits on you" });
    toast?.actionProps.onClick();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/squires/$environmentId/$squireId",
      params: { environmentId: "env-1", squireId: "lead" },
    });
  });
});

describe("app thread notifications", () => {
  function setupApp() {
    const app = setup();
    state.appProject = true;
    state.appStatuses = [{ environmentId: "env-1", app: { appId: APP_ID, name: "RocketWright" } }];
    return app;
  }

  function expectOpenedUnderApps() {
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(useUiStateStore.getState()).toMatchObject({
      sidebarMode: "apps",
      sidebarAppScopeKey: APP_ID,
    });
  }

  it("alerts from a thread the Projects list leaves out", () => {
    const environmentId = EnvironmentId.make("env-1");
    const projectId = ProjectId.make("project-1");
    const binding = { appId: AppId.make(APP_ID), workspaceRoot: "/work/rocket-design" };
    expect(
      threadsForProjectsMode(
        [{ environmentId, id: projectId, appBinding: binding }],
        [{ environmentId, projectId }],
      ),
    ).toEqual([]);
  });

  it.each([
    ["approval", "RocketWright: Approval needed"],
    ["completion", "RocketWright: Thread completed"],
  ] as const)(
    "toasts on %s in Projects mode and opens the thread under its app",
    async (event, title) => {
      await using app = setupApp();
      await app.render();
      using _timers = fakeTimers();
      if (event === "approval") state.approval = true;
      else state.completedAt = "2026-09-13T10:00:00.000Z";
      await app.render();
      await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
      expect(state.add).toHaveBeenCalledTimes(1);
      const toast = state.add.mock.calls[0]?.[0];
      expect(toast?.title).toBe(title);
      expect(toast?.description).toBe("Fix the login form");
      expect(useUiStateStore.getState().sidebarMode).toBe("projects");
      toast?.actionProps.onClick();
      expectOpenedUnderApps();
    },
  );

  it.each([
    ["approval", "RocketWright: Approval needed"],
    ["completion", "RocketWright: Thread completed"],
  ] as const)(
    "raises a system alert on %s that opens the thread under its app",
    async (event, title) => {
      await using app = setupApp();
      state.mode = "notifications";
      state.focused = false;
      await app.render();
      using _timers = fakeTimers();
      if (event === "approval") state.approval = true;
      else state.completedAt = "2026-09-13T10:00:00.000Z";
      await app.render();
      await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
      expect(state.notification).toHaveBeenCalledWith(
        title,
        expect.objectContaining({
          body: "Fix the login form",
          tag: threadNotificationTag(EnvironmentId.make("env-1"), ThreadId.make("thread-1")),
          silent: true,
        }),
      );
      const notification = state.notification.mock.results[0]?.value as EventTarget;
      using _focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
      notification.dispatchEvent(new Event("click"));
      expectOpenedUnderApps();
    },
  );

  it("leaves the sidebar in Projects mode when opening a project thread", async () => {
    await using app = setupApp();
    state.appProject = false;
    await app.render();
    await app.complete();
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Thread completed");
    toast?.actionProps.onClick();
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(useUiStateStore.getState().sidebarMode).toBe("projects");
  });
});
