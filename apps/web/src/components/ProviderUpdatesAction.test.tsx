import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@lecturn/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
  updateProvider: vi.fn(),
}));

vi.mock("react/compiler-runtime", () => ({
  c: (size: number) => Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel")),
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "env-wsl",
        label: "WSL",
        connection: { phase: "connected" },
      },
    ],
  }),
  useEnvironmentProviders: () => new Map([["env-wsl", [provider()]]]),
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (options: unknown) => options,
  toastManager: { add: testState.addToast },
}));

import { useProviderUpdates } from "./ProviderUpdatesAction";

const failedUpdateOutput = "npm error code EACCES\nnpm error syscall rename";

function provider(updateState?: ServerProvider["updateState"]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex-wsl"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-26T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-06-26T12:00:00.000Z",
      message: "Update available.",
    },
    ...(updateState ? { updateState } : {}),
  };
}

describe("useProviderUpdates", () => {
  it("hands a failed update's command output to the toast", async () => {
    testState.updateProvider.mockResolvedValueOnce(
      AsyncResult.success({
        providers: [
          provider({
            status: "failed",
            startedAt: "2026-06-26T12:00:00.000Z",
            finishedAt: "2026-06-26T12:00:01.000Z",
            message: "Update command exited with code 243.",
            output: failedUpdateOutput,
          }),
        ],
      }),
    );

    await useProviderUpdates().updateAll();

    expect(testState.updateProvider).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env-wsl"),
      input: {
        provider: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex-wsl"),
      },
    });
    const toast = testState.addToast.mock.calls[0]?.[0] as {
      readonly description: ReactElement<{ readonly children: string }>;
      readonly data: {
        readonly expandableContent: ReactElement<{ readonly output: string }>;
        readonly expandableLabels: { readonly expand: string };
      };
    };
    expect(toast.description.props.children).toBe(
      "WSL · Codex: Update command exited with code 243. npm error code EACCES",
    );
    expect(toast.data.expandableContent.props.output).toBe(failedUpdateOutput);
    expect(toast.data.expandableLabels.expand).toBe("Show output");
  });
});
