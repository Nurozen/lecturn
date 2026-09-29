import { describe, expect, it, vi } from "vite-plus/test";
import {
  OrchestrationDispatchCommandError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ServerProvider,
  type VcsStatusResult,
} from "@lecturn/contracts";
import {
  FACTORY_LAUNCH_KEY,
  FACTORY_UNCONFIRMED_KEY,
  buildFactoryLaunch,
  factoryPullRequest,
  factoryThreadStatus,
  readFactoryLaunch,
  releaseFactoryLaunch,
  sendFactoryLaunch,
} from "./factoryLaunch";
import type { FactoryForm } from "./FactoryView.types";

const now = "2026-09-29T00:00:00.000Z";
const project: OrchestrationProjectShell = {
  id: ProjectId.make("project-a"),
  title: "Synthetic project",
  workspaceRoot: "/tmp/factory-synthetic",
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
};
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("custom-codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  models: [{ slug: "test-model", name: "Synthetic model", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const form: FactoryForm = {
  projectId: "project-a",
  sourceId: "claude",
  executorId: "custom-codex",
  modelId: "test-model",
  baseBranch: "develop",
  constraints: "Preserve compatibility",
  runtimeMode: "approval-required",
};
function intent() {
  return buildFactoryLaunch({
    environmentId: EnvironmentId.make("remote-b"),
    project,
    provider,
    form,
    sourceId: "claude",
    uuid: "12345678-1234-4234-9234-123456789abc",
    createdAt: now,
  });
}
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("Factory launch", () => {
  it("binds the selected environment, provider instance, model, base and permissions to an isolated bootstrap", () => {
    const launch = intent();
    expect(launch.environmentId).toBe("remote-b");
    expect(launch.command.modelSelection).toEqual({
      instanceId: "custom-codex",
      model: "test-model",
    });
    expect(launch.command.runtimeMode).toBe("approval-required");
    expect(launch.command.bootstrap?.createThread).toMatchObject({
      projectId: "project-a",
      worktreePath: null,
      branch: null,
    });
    expect(launch.command.bootstrap?.prepareWorktree).toEqual({
      projectCwd: project.workspaceRoot,
      baseBranch: "develop",
      branch: "factory/claude-12345678-1234-4234-9234-123456789abc",
      startFromOrigin: true,
    });
    expect(launch.command.message.text).toContain("develop");
    expect(launch.command.message.text).toContain("Preserve compatibility");
  });
  it("rejects unavailable provider, changed instance, nonexistent model, and missing branch before execution", () => {
    const input = {
      environmentId: EnvironmentId.make("remote-b"),
      project,
      provider,
      form,
      sourceId: "claude" as const,
      uuid: "12345678-1234-4234-9234-123456789abc",
      createdAt: now,
    };
    expect(() =>
      buildFactoryLaunch({ ...input, provider: { ...provider, installed: false } }),
    ).toThrow("ready execution");
    expect(() => buildFactoryLaunch({ ...input, form: { ...form, executorId: "wrong" } })).toThrow(
      "provider changed",
    );
    expect(() => buildFactoryLaunch({ ...input, form: { ...form, modelId: "absent" } })).toThrow(
      "available",
    );
    expect(() => buildFactoryLaunch({ ...input, form: { ...form, baseBranch: " " } })).toThrow(
      "base branch",
    );
  });
  it("persists before dispatch and removes only after acknowledgement", async () => {
    const store = storage();
    const launch = intent();
    await sendFactoryLaunch({
      storage: store,
      intent: launch,
      send: async (received) => {
        expect(readFactoryLaunch(store)).toEqual(launch);
        expect(received).toBe(launch);
      },
    });
    expect(store.getItem(FACTORY_LAUNCH_KEY)).toBeNull();
  });
  it("blocks concurrent launches and never replays bootstrap after an uncertain result or reload", async () => {
    const store = storage();
    const send = vi.fn(async () => {
      throw new Error("connection lost");
    });
    await expect(sendFactoryLaunch({ storage: store, intent: intent(), send })).rejects.toThrow(
      "connection lost",
    );
    expect(readFactoryLaunch(store)?.command.threadId).toBe(intent().command.threadId);
    await expect(sendFactoryLaunch({ storage: store, intent: intent(), send })).rejects.toThrow(
      "awaiting confirmation",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("clears a definitive server rejection so an explicit fresh launch can proceed", async () => {
    const store = storage();
    await expect(
      sendFactoryLaunch({
        storage: store,
        intent: intent(),
        send: async () => {
          throw new OrchestrationDispatchCommandError({
            message: "Stave workspace cannot create worktrees",
          });
        },
      }),
    ).rejects.toThrow("Stave workspace");
    expect(readFactoryLaunch(store)).toBeNull();
    const send = vi.fn(async () => undefined);
    await sendFactoryLaunch({ storage: store, intent: intent(), send });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(["EnvironmentRpcUnavailableError", "EnvironmentAuthorizationError"])(
    "clears a definitive %s before-send refusal",
    async (_tag) => {
      const store = storage();
      await expect(
        sendFactoryLaunch({
          storage: store,
          intent: intent(),
          send: async () => {
            throw Object.assign(new Error("Cannot send"), { _tag });
          },
        }),
      ).rejects.toThrow("Cannot send");
      expect(readFactoryLaunch(store)).toBeNull();
    },
  );
  it.each([false, true])(
    "does not clear a newer tab's intent when an older send settles (rejected: %s)",
    async (rejected) => {
      const store = storage();
      const newerRecord = JSON.stringify({ newer: true });
      const result = sendFactoryLaunch({
        storage: store,
        intent: intent(),
        send: async () => {
          store.setItem(FACTORY_LAUNCH_KEY, newerRecord);
          if (rejected)
            throw new OrchestrationDispatchCommandError({ message: "Rejected old launch" });
        },
      });
      if (rejected) await expect(result).rejects.toThrow("Rejected old launch");
      else await result;
      expect(store.getItem(FACTORY_LAUNCH_KEY)).toBe(newerRecord);
    },
  );
  it("does not dispatch if persistence fails", async () => {
    const send = vi.fn();
    await expect(
      sendFactoryLaunch({
        storage: {
          ...storage(),
          setItem: () => {
            throw new Error("quota");
          },
        },
        intent: intent(),
        send,
      }),
    ).rejects.toThrow("quota");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Factory launch lock release", () => {
  it("does not retire a newer record using an older displayed identity", () => {
    const store = storage();
    const newerRecord = JSON.stringify(intent());
    store.setItem(FACTORY_LAUNCH_KEY, newerRecord);
    expect(() => releaseFactoryLaunch(store, "{older unreadable record")).toThrow(
      "saved launch changed",
    );
    expect(store.getItem(FACTORY_LAUNCH_KEY)).toBe(newerRecord);
    expect(store.getItem(FACTORY_UNCONFIRMED_KEY)).toBeNull();
  });
  it("preserves the unconfirmed reference before clearing without dispatching", () => {
    const store = storage();
    const launch = intent();
    store.setItem(FACTORY_LAUNCH_KEY, JSON.stringify(launch));
    releaseFactoryLaunch(store);
    expect(readFactoryLaunch(store)).toBeNull();
    expect(JSON.parse(store.getItem(FACTORY_UNCONFIRMED_KEY)!)).toEqual([
      {
        environmentId: launch.environmentId,
        threadId: launch.command.threadId,
        commandId: launch.command.commandId,
        branch: launch.command.bootstrap?.prepareWorktree?.branch,
        createdAt: launch.command.createdAt,
      },
    ]);
  });
  it.each(["{malformed", JSON.stringify({ staleCommand: true })])(
    "archives an undecodable launch verbatim before clearing it",
    (rawRecord) => {
      const store = storage();
      store.setItem(FACTORY_LAUNCH_KEY, rawRecord);
      releaseFactoryLaunch(store);
      expect(store.getItem(FACTORY_LAUNCH_KEY)).toBeNull();
      expect(JSON.parse(store.getItem(FACTORY_UNCONFIRMED_KEY)!)).toEqual([
        { kind: "unreadable-launch", rawRecord },
      ]);
    },
  );
  it("retains unreadable launch bytes if audit persistence fails", () => {
    const store = storage();
    const rawRecord = "{malformed";
    store.setItem(FACTORY_LAUNCH_KEY, rawRecord);
    expect(() =>
      releaseFactoryLaunch({
        ...store,
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).toThrow("quota");
    expect(store.getItem(FACTORY_LAUNCH_KEY)).toBe(rawRecord);
  });
  it("retains the pending identity if saving the audit fails", () => {
    const store = storage();
    const launch = intent();
    store.setItem(FACTORY_LAUNCH_KEY, JSON.stringify(launch));
    expect(() =>
      releaseFactoryLaunch({
        ...store,
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).toThrow("quota");
    expect(readFactoryLaunch(store)).toEqual(launch);
  });
});

describe("Factory observed outcomes", () => {
  it("recognizes a gh-created PR only on the run's actual branch", () => {
    const status = {
      refName: "factory/test",
      pr: { number: 7, url: "https://github.com/example/repo/pull/7" },
    } as VcsStatusResult;
    expect(factoryPullRequest({ branch: "factory/test" }, status)).toEqual({
      label: "PR #7",
      url: status.pr?.url,
    });
    expect(factoryPullRequest({ branch: "another-branch" }, status)).toBeNull();
    expect(factoryPullRequest({ branch: "factory/test" }, null)).toBeNull();
  });
  it("never equates an ended turn with successful delivery and prioritizes attention/errors", () => {
    const thread = {
      session: null,
      latestTurn: { state: "completed" },
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    } as OrchestrationThreadShell;
    expect(factoryThreadStatus(thread)).toEqual({
      statusLabel: "Turn completed",
      statusTone: "neutral",
    });
    expect(factoryThreadStatus({ ...thread, hasPendingUserInput: true }).statusTone).toBe(
      "attention",
    );
    expect(
      factoryThreadStatus({ ...thread, latestTurn: { ...thread.latestTurn!, state: "error" } })
        .statusTone,
    ).toBe("error");
  });
});
