import { AppId, EnvironmentId, type AppRegistration, type AppStatus } from "@lecturn/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  apps: [] as unknown[],
  canRead: true,
  canManage: true,
  calls: [] as Array<{ command: string; value: unknown }>,
  failNext: null as unknown,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "env-1") as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => state.canRead) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data: atom === null ? null : state.apps,
    error: null,
  })) as never,
}));
vi.mock(import("../../state/apps"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const refused = Atom.make(false);
  return {
    ...actual,
    appsEnvironment: {
      ...actual.appsEnvironment,
      revoke: {
        ...actual.appsEnvironment.revoke,
        permissionAtom: (() => (state.canManage ? allowed : refused)) as never,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { label: string }) => async (value: unknown) => {
    state.calls.push({ command: command.label, value });
    if (state.failNext !== null) {
      const error = state.failNext;
      state.failNext = null;
      const Cause = await import("effect/Cause");
      return { _tag: "Failure", cause: Cause.fail(error) };
    }
    return { _tag: "Success", value: {} };
  }) as never,
}));

import { AppPairingPromptCoordinator } from "./AppPairingPromptCoordinator";

const ICON = "data:image/png;base64,iVBORw0KGgo=";
const environmentId = EnvironmentId.make("env-1");

function registration(overrides: Partial<AppRegistration> = {}): AppRegistration {
  return {
    appId: AppId.make("dev.example.rocket"),
    name: "Rocket",
    iconDataUrl: ICON,
    toolPrefix: "rw",
    refPrefixes: ["rw:"],
    headlessTools: {
      command: "/opt/rocket/bin/rw",
      args: ["mcp", "--project", "{workspaceRoot}"],
      env: { RW_LOG: "debug" },
      cwd: "{workspaceRoot}",
    },
    liveTools: true,
    gatedTools: ["engine_simulate"],
    embedOrigins: ["http://127.0.0.1:*"],
    ...overrides,
  };
}

function pendingApp(overrides: Partial<AppStatus> = {}): AppStatus {
  const requested = registration();
  return {
    appId: requested.appId,
    name: requested.name,
    iconDataUrl: ICON,
    toolPrefix: "rw",
    refPrefixes: ["rw:"],
    openUrlTemplate: null,
    state: "pairing-requested",
    live: null,
    lastSeenAt: null,
    runtimeCeiling: null,
    headlessTools: requested.headlessTools ?? null,
    gatedTools: requested.gatedTools,
    embedOrigins: requested.embedOrigins ?? [],
    pendingRequest: {
      requestId: "request-1",
      registration: requested,
      requestedAt: "2026-10-25T10:00:00.000Z",
    },
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(state, { apps: [], canRead: true, canManage: true, calls: [], failNext: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<AppPairingPromptCoordinator />));
const prompt = () => document.querySelector<HTMLElement>('[data-testid="app-pairing-prompt"]');
const button = (label: string) => {
  const found = [...(prompt()?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`No ${label} button in the prompt`);
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());

describe("AppPairingPromptCoordinator", () => {
  it("shows the exact command, env and gated tools the app asked for", async () => {
    state.apps = [pendingApp()];
    await render();

    const text = prompt()?.textContent ?? "";
    expect(text).toContain("Connect Rocket to Lecturn?");
    expect(text).toContain("/opt/rocket/bin/rw mcp --project {workspaceRoot}");
    expect(text).toContain("RW_LOG");
    expect(text).toContain("debug");
    expect(text).toContain("rw_engine_simulate");
    expect(text).toContain("http://127.0.0.1:*");
    expect(text).toContain("Thread's mode");
    expect(prompt()?.querySelector(`img[src="${ICON}"]`)).not.toBeNull();
  });

  it("grants the waiting request and closes", async () => {
    state.apps = [pendingApp()];
    await render();
    await click(button("Approve"));

    expect(state.calls).toEqual([
      {
        command: "environment-data:apps:decide-pairing",
        value: { environmentId, input: { requestId: "request-1", decision: "grant" } },
      },
    ]);
    await vi.waitFor(() => expect(prompt()).toBeNull());
  });

  it("applies a chosen ceiling before granting, so the app never runs above it", async () => {
    state.apps = [pendingApp()];
    await render();
    const trigger = prompt()?.querySelector<HTMLElement>('[aria-label="Runtime ceiling"]');
    if (!trigger) throw new Error("No runtime ceiling select");
    await click(trigger);
    const readOnly = await vi.waitFor(() => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (candidate) => candidate.textContent?.startsWith("Read-only"),
      );
      if (!option) throw new Error("Read-only option not open yet");
      return option;
    });
    await click(readOnly);
    await click(button("Approve"));

    expect(state.calls.map((call) => call.value)).toEqual([
      { environmentId, input: { appId: "dev.example.rocket", ceiling: "read-only" } },
      { environmentId, input: { requestId: "request-1", decision: "grant" } },
    ]);
  });

  it("denies the waiting request", async () => {
    state.apps = [pendingApp()];
    await render();
    await click(button("Deny"));

    expect(state.calls).toEqual([
      {
        command: "environment-data:apps:decide-pairing",
        value: { environmentId, input: { requestId: "request-1", decision: "deny" } },
      },
    ]);
  });

  it("keeps the prompt open when the decision fails", async () => {
    state.apps = [pendingApp()];
    state.failNext = { _tag: "AppsError", code: "conflict", message: "Tool prefix taken." };
    await render();
    await click(button("Approve"));

    expect(prompt()).not.toBeNull();
  });

  it("offers a re-pair for a revoked app and flags a changed command", async () => {
    state.apps = [pendingApp({ state: "revoked" })];
    await render();
    expect(prompt()?.textContent).toContain("Pair Rocket again?");
    expect(() => button("Re-pair")).not.toThrow();

    state.apps = [
      pendingApp({
        state: "pairing-requested",
        headlessTools: { ...registration().headlessTools!, env: { RW_LOG: "info" } },
        pendingRequest: {
          requestId: "request-2",
          registration: registration(),
          requestedAt: "2026-10-25T10:01:00.000Z",
        },
      }),
    ];
    await render();
    expect(prompt()?.textContent).toContain("Rocket changed what it runs");
    expect(() => button("Approve changes")).not.toThrow();
  });

  it("goes away when another client answers, and returns for a new request", async () => {
    state.apps = [pendingApp()];
    await render();
    expect(prompt()).not.toBeNull();

    state.apps = [pendingApp({ state: "granted", pendingRequest: null })];
    await render();
    await vi.waitFor(() => expect(prompt()).toBeNull());
  });

  it("stays hidden for a client without access:write", async () => {
    state.apps = [pendingApp()];
    state.canManage = false;
    await render();
    expect(prompt()).toBeNull();
  });
});
