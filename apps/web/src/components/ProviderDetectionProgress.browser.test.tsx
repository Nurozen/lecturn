import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@lecturn/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    label: string;
    connection: { phase: string };
    providers?: ServerProvider[];
  }>,
}));
const refresh = vi.hoisted(() => vi.fn(async () => ({ _tag: "Success" })));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => state) as never,
  useEnvironmentProviders: (() =>
    new Map(
      state.environments.flatMap((environment) =>
        environment.providers ? [[environment.environmentId, environment.providers]] : [],
      ),
    )) as never,
}));
vi.mock(import("../state/server"), async (original) => ({
  ...(await original()),
  serverEnvironment: { refreshProviders: {} } as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => refresh) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ children }: ComponentProps<"a">) => <a>{children}</a>) as never,
}));
import { ProviderDetectionProgress } from "./ProviderDetectionProgress";

const failed: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-10-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  discovery: { status: "error", phase: "provider" },
};
let root: Root;
let container: HTMLDivElement;
function environment(id: string, provider = failed, phase = "connected") {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: { phase },
    providers: [provider],
  };
}
async function render() {
  await act(async () => root.render(<ProviderDetectionProgress />));
}
const isEmpty = () => container.childElementCount === 0;
const dismissButtons = () => [
  ...container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Dismiss provider notification"]',
  ),
];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.environments = [environment("phone")];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("provider detection notifications", () => {
  it("keeps dismissal through repeated detection and reconnect, then re-arms after recovery", async () => {
    await render();
    expect(dismissButtons()).toHaveLength(1);
    await act(async () => dismissButtons()[0]!.click());
    expect(isEmpty()).toBe(true);
    state.environments = [
      environment("phone", { ...failed, discovery: { status: "detecting", phase: "provider" } }),
    ];
    await render();
    expect(isEmpty()).toBe(true);
    state.environments = [
      { environmentId: "phone", label: "phone", connection: { phase: "reconnecting" } },
    ];
    await render();
    state.environments = [
      environment("phone", { ...failed, discovery: { status: "timed-out", phase: "provider" } }),
    ];
    await render();
    expect(isEmpty()).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    state.environments = [
      environment("phone", {
        ...failed,
        status: "ready",
        discovery: { status: "ready", phase: "provider" },
      }),
    ];
    await render();
    state.environments = [environment("phone")];
    await render();
    expect(dismissButtons()).toHaveLength(1);
  });

  it("dismisses the shared shell probe without replacing it with another provider's copy", async () => {
    const shell = { ...failed, discovery: { status: "detecting", phase: "shell" } } as const;
    state.environments = [
      {
        ...environment("phone"),
        providers: [shell, { ...shell, instanceId: ProviderInstanceId.make("codex") }],
      },
    ];
    await render();
    expect(dismissButtons()).toHaveLength(1);
    await act(async () => dismissButtons()[0]!.click());
    expect(isEmpty()).toBe(true);
  });

  it("isolates dismissal by environment and preserves recovery for the other provider", async () => {
    state.environments = [environment("phone"), environment("laptop")];
    await render();
    await act(async () => dismissButtons()[0]!.click());
    expect(dismissButtons()).toHaveLength(1);
    expect(container.textContent).toContain("laptop");
    const retry = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    expect(refresh).toHaveBeenCalledWith({
      environmentId: "laptop",
      input: { instanceId: "claudeAgent" },
    });
    expect(dismissButtons()).toHaveLength(1);
  });
});
