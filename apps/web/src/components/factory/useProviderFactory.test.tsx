import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@lecturn/contracts";
import * as Option from "effect/Option";
import type { FactoryViewProps } from "./FactoryView.types";

const ports = vi.hoisted(() => ({
  connectionPhase: "connected",
  projects: [] as (OrchestrationProjectShell & { environmentId: EnvironmentId })[],
  shells: [] as (OrchestrationThreadShell & { environmentId: EnvironmentId })[],
  configs: new Map<string, { providers: ServerProvider[] }>(),
  start: vi.fn(),
  interrupt: vi.fn(),
  refresh: vi.fn(),
  steer: vi.fn(),
  navigate: vi.fn(),
  selected: vi.fn(),
  detail: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => ports.navigate }));
vi.mock("../../state/entities", () => ({
  useProjects: () => ports.projects,
  useServerConfigs: () => ports.configs,
  useThreadShells: () => ports.shells,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: ports.connectionPhase } }),
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { startTurn: "start", interruptTurn: "interrupt" },
  useEnvironmentThread: (...args: unknown[]) => ports.detail(...args),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "start" ? ports.start : command === "interrupt" ? ports.interrupt : ports.refresh,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({
    data: query ? { isRepo: true, refName: "main", pr: null } : null,
    error: null,
  }),
  formatEnvironmentQueryError: () => "Request failed",
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { status: (input: unknown) => input, refreshStatus: "refresh" },
}));
vi.mock("../pullRequest/useQuickSteer", () => ({ useQuickSteer: () => ports.steer }));
vi.mock("../ChatView.logic", () => ({ buildThreadTurnInterruptInput: vi.fn() }));
vi.mock("../../lib/utils", () => ({ randomUUID: () => "12345678-1234-4234-9234-123456789abc" }));

import { useProviderFactory } from "./useProviderFactory";
import { FACTORY_LAUNCH_KEY, FACTORY_UNCONFIRMED_KEY, readFactoryLaunch } from "./factoryLaunch";
const now = "2026-09-29T00:00:00.000Z";
const remoteId = EnvironmentId.make("remote-b");
const localId = EnvironmentId.make("local-a");
const runId = "12345678-1234-4234-9234-123456789abc";
const branch = `factory/claude-${runId}`;
function project(environmentId: EnvironmentId) {
  return {
    environmentId,
    id: ProjectId.make("same-project-id"),
    title: "Synthetic project",
    workspaceRoot: `/tmp/factory-fixture/${environmentId}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  } satisfies OrchestrationProjectShell & { environmentId: EnvironmentId };
}
function provider(instanceId: string, model: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: now,
    models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
}
function shell(overrides: Partial<OrchestrationThreadShell> = {}) {
  return {
    environmentId: remoteId,
    id: ThreadId.make(runId),
    projectId: ProjectId.make("same-project-id"),
    title: "Synthetic Factory run",
    modelSelection: {
      instanceId: ProviderInstanceId.make("remote-executor"),
      model: "remote-model",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } satisfies OrchestrationThreadShell & { environmentId: EnvironmentId };
}
const latestTurn: OrchestrationThreadShell["latestTurn"] = {
  turnId: TurnId.make("turn"),
  state: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  assistantMessageId: null,
};
function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}
let storage = memoryStorage();
let renderer: ReactTestRenderer | undefined;
let current: FactoryViewProps;
let selection: { environmentId?: string; threadId?: string };
function Harness() {
  const value = useProviderFactory({ selection, onSelectionChange: ports.selected });
  useEffect(() => {
    current = value;
  });
  return null;
}
async function mount() {
  await act(async () => {
    renderer = create(<Harness />);
  });
}
async function rerender() {
  await act(async () => {
    renderer!.update(<Harness />);
  });
}
async function configureRemote() {
  await act(async () =>
    current.onFormChange({
      projectId: JSON.stringify([remoteId, "same-project-id"]),
      sourceId: "claude",
      baseBranch: "develop",
      runtimeMode: "approval-required",
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  storage = memoryStorage();
  selection = {};
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ports.connectionPhase = "connected";
  ports.projects = [project(localId), project(remoteId)];
  ports.configs = new Map([
    [localId, { providers: [provider("local-executor", "local-model")] }],
    [remoteId, { providers: [provider("remote-executor", "remote-model")] }],
  ]);
  ports.shells = [];
  ports.start.mockReset().mockResolvedValue({ _tag: "Success" });
  ports.interrupt.mockResolvedValue({ _tag: "Success" });
  ports.refresh.mockResolvedValue({ _tag: "Success" });
  ports.detail.mockReturnValue({ data: Option.none(), error: Option.none(), status: "live" });
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Factory controller launch and recovery", () => {
  it("archives unreadable saved launch data before releasing its blocked recovery", async () => {
    const malformed = "{broken saved launch";
    storage.setItem(FACTORY_LAUNCH_KEY, malformed);
    await mount();
    await configureRemote();
    expect(current.recovery?.canInspect).toBe(false);
    expect(current.launchDisabledReason).not.toBeNull();
    await act(async () => current.onLaunch());
    expect(ports.start).not.toHaveBeenCalled();
    expect(storage.getItem(FACTORY_LAUNCH_KEY)).toBe(malformed);
    await act(async () => current.onReleaseRecovery());
    expect(current.recovery).toBeNull();
    expect(current.launchDisabledReason).toBeNull();
    expect(storage.getItem(FACTORY_LAUNCH_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(FACTORY_UNCONFIRMED_KEY)!)).toEqual([
      { kind: "unreadable-launch", rawRecord: malformed },
    ]);
    expect(ports.start).not.toHaveBeenCalled();
  });

  it("does not expose or interrupt an ordinary thread supplied through the Factory URL", async () => {
    ports.shells = [
      shell({
        branch: "feature/ordinary-task",
        latestTurn,
        worktreePath: "/tmp/factory-fixture/ordinary",
      }),
    ];
    selection = { environmentId: remoteId, threadId: runId };
    await mount();
    expect(current.run).toBeNull();
    expect(current.runs).toEqual([]);
    expect(ports.detail).toHaveBeenLastCalledWith(null, null);
    await act(async () => {
      current.onInterrupt();
      current.onOpenConversation();
    });
    expect(ports.interrupt).not.toHaveBeenCalled();
    expect(ports.navigate).not.toHaveBeenCalled();
  });

  it.each(["synchronizing", "cached", "empty"])(
    "keeps connected run controls available while history is %s",
    async (status) => {
      ports.shells = [shell({ latestTurn, worktreePath: "/tmp/factory-fixture/worktree" })];
      ports.detail.mockReturnValue({ data: Option.none(), error: Option.none(), status });
      selection = { environmentId: remoteId, threadId: runId };
      await mount();
      expect(ports.detail).toHaveBeenLastCalledWith(remoteId, runId);
      expect(current.run?.canSteer).toBe(true);
      expect(current.run?.canInterrupt).toBe(true);
      expect(current.run?.connectionLabel).toMatch(/^Connected · /);
      expect(current.run?.connectionLabel).not.toBe("Live environment");
      await act(async () => current.onInterrupt());
      expect(ports.interrupt).toHaveBeenCalledOnce();
    },
  );
  it("keeps controls unavailable for disconnected or deleted runs even with a running shell", async () => {
    ports.shells = [shell({ latestTurn, worktreePath: "/tmp/factory-fixture/worktree" })];
    ports.connectionPhase = "reconnecting";
    selection = { environmentId: remoteId, threadId: runId };
    await mount();
    expect(current.run?.canSteer).toBe(false);
    expect(current.run?.canInterrupt).toBe(false);
    expect(current.run?.connectionLabel).toBe("Last known state · reconnecting");
    ports.connectionPhase = "connected";
    ports.detail.mockReturnValue({ data: Option.none(), error: Option.none(), status: "deleted" });
    await rerender();
    expect(current.run?.canSteer).toBe(false);
    expect(current.run?.canInterrupt).toBe(false);
    await act(async () => current.onInterrupt());
    expect(ports.interrupt).not.toHaveBeenCalled();
  });

  it("allows interruption of observed background work after the parent turn completed", async () => {
    ports.shells = [
      shell({
        latestTurn: { ...latestTurn, state: "completed", completedAt: now },
        backgroundLiveness: "working",
        worktreePath: "/tmp/factory-fixture/worktree",
      }),
    ];
    selection = { environmentId: remoteId, threadId: runId };
    await mount();
    expect(current.run?.canInterrupt).toBe(true);
    await act(async () => current.onInterrupt());
    expect(ports.interrupt).toHaveBeenCalledTimes(1);
    expect(ports.interrupt).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: remoteId }),
    );
    expect(current.actionNotice).toContain("Interrupt requested");
  });

  it("routes one launch to the selected environment and instance, persisting identity before dispatch", async () => {
    let acknowledge!: () => void;
    ports.start.mockImplementation(async (request) => {
      expect(readFactoryLaunch(storage)).toEqual({
        environmentId: remoteId,
        command: request.input,
      });
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      return { _tag: "Success" };
    });
    await mount();
    await configureRemote();
    expect(current.launchDisabledReason).toBeNull();
    await act(async () => {
      current.onLaunch();
      current.onLaunch();
    });
    expect(ports.start).toHaveBeenCalledTimes(1);
    expect(current.launchPending).toBe(true);
    expect(ports.start).toHaveBeenCalledWith({
      environmentId: remoteId,
      input: expect.objectContaining({
        threadId: runId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: "remote-executor", model: "remote-model" },
        bootstrap: expect.objectContaining({
          prepareWorktree: expect.objectContaining({
            projectCwd: `/tmp/factory-fixture/${remoteId}`,
            baseBranch: "develop",
            branch,
          }),
        }),
      }),
    });
    await act(async () => acknowledge());
    expect(current.launchPending).toBe(false);
    expect(current.recovery).toBeNull();
    expect(storage.getItem(FACTORY_LAUNCH_KEY)).toBeNull();
    expect(ports.selected).toHaveBeenLastCalledWith({ environmentId: remoteId, threadId: runId });
  });
  it.each([false, true])(
    "does not reclaim selection after a deferred launch completes (unmounted: %s)",
    async (unmountBeforeAcknowledgement) => {
      let acknowledge!: () => void;
      ports.start.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
        return { _tag: "Success" };
      });
      const otherId = ThreadId.make("existing-factory-run");
      ports.shells = [
        shell({ id: otherId, latestTurn, worktreePath: "/tmp/factory-fixture/existing" }),
      ];
      await mount();
      await configureRemote();
      await act(async () => current.onLaunch());
      expect(ports.selected).toHaveBeenCalledExactlyOnceWith({
        environmentId: remoteId,
        threadId: runId,
      });
      expect(storage.getItem(FACTORY_LAUNCH_KEY)).not.toBeNull();
      await act(async () => current.onSelectRun(JSON.stringify([remoteId, otherId])));
      selection = { environmentId: remoteId, threadId: otherId };
      await rerender();
      expect(current.run?.id).toBe(JSON.stringify([remoteId, otherId]));
      if (unmountBeforeAcknowledgement) {
        await act(async () => renderer!.unmount());
        renderer = undefined;
      }
      const selectionsBeforeAcknowledgement = ports.selected.mock.calls.length;
      await act(async () => acknowledge());
      expect(storage.getItem(FACTORY_LAUNCH_KEY)).toBeNull();
      expect(ports.selected).toHaveBeenCalledTimes(selectionsBeforeAcknowledgement);
      expect(ports.selected).toHaveBeenLastCalledWith({
        environmentId: remoteId,
        threadId: otherId,
      });
      expect(ports.navigate).not.toHaveBeenCalled();
    },
  );

  it("retains uncertainty across rerender and remount without dispatching again", async () => {
    ports.start.mockRejectedValue(new Error("Connection lost before acknowledgement"));
    await mount();
    await configureRemote();
    await act(async () => current.onLaunch());
    expect(current.launchError).toContain("Connection lost");
    expect(current.recovery).not.toBeNull();
    const pending = storage.getItem(FACTORY_LAUNCH_KEY);
    await rerender();
    await act(async () => renderer!.unmount());
    await mount();
    await configureRemote();
    expect(current.launchDisabledReason).toContain("awaiting confirmation");
    await act(async () => {
      current.onInspectRecovery();
      current.onLaunch();
    });
    expect(current.recovery).not.toBeNull();
    expect(storage.getItem(FACTORY_LAUNCH_KEY)).toBe(pending);
    expect(ports.start).toHaveBeenCalledTimes(1);
  });
  it("requires matching environment, prepared worktree and observed turn to resolve recovery", async () => {
    ports.start.mockRejectedValue(new Error("Connection lost"));
    await mount();
    await configureRemote();
    await act(async () => current.onLaunch());
    selection = { environmentId: remoteId, threadId: runId };
    for (const partial of [
      shell(),
      shell({ worktreePath: "/tmp/factory-fixture/worktree" }),
      shell({ latestTurn }),
    ]) {
      ports.shells = [partial];
      await rerender();
      expect(current.recovery).not.toBeNull();
      expect(current.run?.canSteer).toBe(false);
      expect(storage.getItem(FACTORY_LAUNCH_KEY)).not.toBeNull();
    }
    ports.shells = [
      {
        ...shell({ latestTurn, worktreePath: "/tmp/factory-fixture/worktree" }),
        environmentId: localId,
      },
    ];
    await rerender();
    expect(current.recovery).not.toBeNull();
    ports.shells = [shell({ latestTurn, worktreePath: "/tmp/factory-fixture/worktree" })];
    await rerender();
    expect(current.recovery).toBeNull();
    expect(current.run?.canSteer).toBe(true);
    expect(storage.getItem(FACTORY_LAUNCH_KEY)).toBeNull();
    expect(ports.start).toHaveBeenCalledTimes(1);
    expect(ports.detail).toHaveBeenLastCalledWith(remoteId, runId);
  });
  it("explicitly releases the lock while retaining the uncertain reference and never replaying", async () => {
    ports.start.mockRejectedValue(new Error("Connection lost"));
    await mount();
    await configureRemote();
    await act(async () => current.onLaunch());
    expect(current.launchDisabledReason).toContain("awaiting confirmation");
    await act(async () => current.onReleaseRecovery());
    expect(current.recovery).toBeNull();
    expect(current.launchDisabledReason).toBeNull();
    expect(current.launchError).toBeNull();
    expect(storage.getItem(FACTORY_LAUNCH_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(FACTORY_UNCONFIRMED_KEY)!)).toEqual([
      expect.objectContaining({ environmentId: remoteId, threadId: runId, branch }),
    ]);
    expect(ports.start).toHaveBeenCalledTimes(1);
  });
  it("keeps a late steering response on its original run when selection changes", async () => {
    let finish!: () => void;
    ports.steer.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const otherId = ThreadId.make("other-thread");
    ports.shells = [
      shell({ latestTurn, worktreePath: "/tmp/factory-fixture/worktree" }),
      shell({ id: otherId, latestTurn, worktreePath: "/tmp/factory-fixture/other" }),
    ];
    selection = { environmentId: remoteId, threadId: runId };
    await mount();
    let result!: Promise<boolean>;
    await act(async () => {
      result = current.onSteer("Preserve compatibility");
    });
    expect(current.steerPending).toBe(true);
    selection = { environmentId: remoteId, threadId: otherId };
    await rerender();
    expect(current.steerPending).toBe(false);
    await act(async () => {
      finish();
      await result;
    });
    expect(current.actionNotice).toBeNull();
    expect(current.actionError).toBeNull();
    selection = { environmentId: remoteId, threadId: runId };
    await rerender();
    expect(current.actionNotice).toContain("Steering message received");
    expect(ports.steer).toHaveBeenCalledWith(remoteId, runId, "Preserve compatibility");
  });
});
