import { threadsForProjectsMode } from "@lecturn/client-runtime/state/app-projects";
import { AppId, EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import type { ClientSettings } from "@lecturn/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal, type Screen } from "../../test/render";

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

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: mockThreads(), projects: mockProjects() }),
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => state.active) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((
    select: (
      settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">,
    ) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp })) as never,
  getClientSettings: (() => ({ notificationMode: state.mode })) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
}));
vi.mock(import("../state/apps"), async (original) => ({
  ...(await original()),
  useAppStatuses: (() => state.appStatuses) as never,
}));
// A store, not a plain return: the compiled coordinator only re-renders Squire alerts when
// their snapshot changes, as the real atom subscription would signal.
const squireStore = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<unknown>,
  listeners: new Set<() => void>(),
}));
function pushSquireNotifications(sequences: number[]) {
  squireStore.environments = [
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
  ];
  for (const listener of squireStore.listeners) listener();
}
vi.mock(import("../state/squires"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    squireStore.listeners.add(listener);
    return () => squireStore.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useSquireEnvironments: (() =>
      useSyncExternalStore(subscribe, () => squireStore.environments)) as never,
  };
});
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
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
import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

// The mocked modules read `state`, so every test starts by resetting all of it. The first
// render is left to the test because some tests change state before the coordinator mounts.
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
  stableParent = null;
  squireStore.environments = [];
  useUiStateStore.setState({ sidebarMode: "projects", sidebarAppScopeKey: null });
  const stack = new AsyncDisposableStack();
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => state.visible as DocumentVisibilityState),
  );
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused));
  stack.use(
    stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" })),
  );
  let screen: Screen | undefined;
  const renderCoordinator = async () => {
    if (screen) await screen.rerender(<ThreadNotificationCoordinator />);
    else screen = stack.use(await render(<ThreadNotificationCoordinator />));
  };
  return {
    render: renderCoordinator,
    complete: async () => {
      state.completedAt = "2026-09-13T10:00:00.000Z";
      await renderCoordinator();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("thread notifications", () => {
  it.each([true, false])("keeps subagents silent with focus=%s", async (focused) => {
    await using app = setup();
    state.subagent = true;
    state.focused = focused;
    state.mode = "notifications-and-sound";
    await app.render();
    await app.complete();
    state.input = true;
    await app.render();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("alerts on the parent when its delegated subagent asks for approval", async () => {
    await using app = setup();
    state.mode = "notifications-and-sound";
    state.delegatedChild = "running";
    await app.render();
    state.delegatedChild = "approval";
    await app.render();
    await app.render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Approval needed", description: "Fix the login form" }),
    );
  });

  it("alerts once with system alerts off and opens the completed thread", async () => {
    await using app = setup();
    await app.render();
    await app.complete();
    await app.render();
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Thread completed");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each(["active", "blurred", "hidden", "archived", "disabled"])(
    "does not show a completion toast for %s threads",
    async (condition) => {
      await using app = setup();
      await app.render();
      if (condition === "active") state.active.threadId = "thread-1";
      if (condition === "blurred") state.focused = false;
      if (condition === "hidden") state.visible = "hidden";
      if (condition === "archived") state.archivedAt = "2026-09-13T09:00:00.000Z";
      if (condition === "disabled") state.inApp = false;
      await app.complete();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["input", "Input needed"],
    ["approval", "Approval needed"],
    ["sessionError", "Thread failed"],
    ["turnError", "Thread failed"],
    ["limited", "Usage limit reached"],
  ] as const)("uses the same %s event for in-app and desktop alerts", async (event, title) => {
    await using app = setup();
    state.mode = "notifications-and-sound";
    await app.render();
    state[event] = true;
    await app.render();
    await app.render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(state.notification).not.toHaveBeenCalled();

    state[event] = false;
    await app.render();
    state.focused = false;
    state[event] = true;
    await app.render();
    await app.render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(title, {
      body: "Fix the login form",
      tag: expect.any(String),
      silent: true,
    });
  });

  it("alerts when only a dev server is left running, not while a monitor can wake the agent", async () => {
    await using app = setup();
    await app.render();
    state.background = [{ taskId: "watch", kind: "monitor" }];
    await app.complete();
    expect(state.add).not.toHaveBeenCalled();
    state.background = [{ taskId: "dev", kind: "command" }];
    await app.render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Thread completed" }),
    );
  });

  it("keeps background desktop alerts when in-app notifications are disabled", async () => {
    await using app = setup();
    state.focused = false;
    state.inApp = false;
    state.mode = "notifications";
    await app.render();
    await app.complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    state.inApp = true;
    await app.render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("does not replay a completion when opting in from all alerts off", async () => {
    await using app = setup();
    state.inApp = false;
    await app.render();
    await app.complete();
    state.inApp = true;
    await app.render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("compares the environment as well as the thread", async () => {
    await using app = setup();
    state.active = { environmentId: "env-2", threadId: "thread-1" };
    await app.render();
    await app.complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not replay completed threads on first load or reconnect", async () => {
    await using app = setup();
    await app.complete();
    state.live = false;
    await app.render();
    state.live = true;
    await app.render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("keeps sound but replaces the system popup when showing a toast", async () => {
    await using app = setup();
    state.mode = "notifications-and-sound";
    await app.render();
    await app.complete();
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("keeps system alerts when the app is in the background", async () => {
    await using app = setup();
    state.mode = "notifications";
    state.focused = false;
    await app.render();
    await app.complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("Thread completed", {
      body: "Fix the login form",
      tag: expect.any(String),
      silent: true,
    });
  });

  it("reveals the desktop window and opens the thread when a system alert is clicked", async () => {
    await using app = setup();
    const revealWindow = vi.fn(() => Promise.resolve());
    using _bridge = stubGlobal("desktopBridge", { revealWindow });
    state.mode = "notifications";
    state.focused = false;
    await app.render();
    await app.complete();
    const notification: EventTarget = state.notification.mock.results[0]?.value;
    notification.dispatchEvent(new Event("click"));
    expect(revealWindow).toHaveBeenCalledTimes(1);
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
  });
});

describe("squire notifications", () => {
  it("toasts only for intents pushed after the first look and opens the Squire", async () => {
    await using app = setup();
    pushSquireNotifications([1]);
    await app.render();
    expect(state.add).not.toHaveBeenCalled();
    await act(() => pushSquireNotifications([1, 2]));
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
      if (event === "approval") state.approval = true;
      else state.completedAt = "2026-09-13T10:00:00.000Z";
      await app.render();
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
      if (event === "approval") state.approval = true;
      else state.completedAt = "2026-09-13T10:00:00.000Z";
      await app.render();
      expect(state.notification).toHaveBeenCalledWith(title, {
        body: "Fix the login form",
        tag: threadNotificationTag(EnvironmentId.make("env-1"), ThreadId.make("thread-1")),
        silent: true,
      });
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
