import { type Discovery } from "@lecturn/client-runtime/relay";
import type { AtomCommandResult } from "@lecturn/client-runtime/state/runtime";
import { EnvironmentId } from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

type DiscoveredEnvironments = Discovery.RelayEnvironmentDiscoveryState["environments"];

const discovery = vi.hoisted(() => ({
  state: null as Discovery.RelayEnvironmentDiscoveryState | null,
  listeners: new Set<() => void>(),
  refresh: vi.fn<() => Promise<AtomCommandResult<void, never>>>(),
  register: vi.fn(),
  listEnvironments: vi.fn<() => Promise<DiscoveredEnvironments>>(),
  accountStatesAtom: Symbol("accountStates"),
  knownAccountsAtom: Symbol("knownAccounts"),
  accountProfilesAtom: Symbol("accountProfiles"),
  accountByEnvironmentIdAtom: Symbol("accountByEnvironmentId"),
  accountIds: [] as string[],
  accountStates: new Map<string, Discovery.RelayEnvironmentDiscoveryState>(),
  accountOwners: new Map<EnvironmentId, string>(),
  profiles: new Map<string, { label: string }>(),
}));

vi.mock(import("~/state/relay"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    relayEnvironmentDiscovery: {
      ...actual.relayEnvironmentDiscovery,
      accountStatesValueAtom: discovery.accountStatesAtom as never,
    },
  };
});
// Fixtures default to a single account unless a test supplies account discovery.
vi.mock(import("~/cloud/knownAccounts"), async (original) => ({
  ...(await original()),
  knownConnectAccountsAtom: discovery.knownAccountsAtom as never,
}));
vi.mock(import("~/cloud/connectAccounts"), async (original) => ({
  ...(await original()),
  connectAccountProfilesAtom: discovery.accountProfilesAtom as never,
  accountByEnvironmentIdAtom: discovery.accountByEnvironmentIdAtom as never,
}));
vi.mock(import("@effect/atom-react"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomValue: ((atom: Parameters<typeof actual.useAtomValue>[0]) =>
      (atom as unknown) === discovery.knownAccountsAtom
        ? { accountIds: discovery.accountIds, needsSignIn: [], synced: true }
        : (atom as unknown) === discovery.accountStatesAtom
          ? discovery.accountStates
          : (atom as unknown) === discovery.accountByEnvironmentIdAtom
            ? discovery.accountOwners
            : (atom as unknown) === discovery.accountProfilesAtom
              ? discovery.profiles
              : actual.useAtomValue(atom)) as never,
  };
});
vi.mock(import("../sidebar/AccountMark"), () => ({
  AccountMark: (({ environmentId }: { environmentId: EnvironmentId }) => (
    <span data-account-mark={environmentId} />
  )) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { relayEnvironmentDiscovery } = await import("~/state/relay");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === relayEnvironmentDiscovery.refresh
        ? discovery.refresh
        : discovery.register) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    discovery.listeners.add(listener);
    return () => discovery.listeners.delete(listener);
  };
  const read = () => {
    if (discovery.state === null) throw new Error("Discovery fixture is not initialized");
    return discovery.state;
  };
  return {
    ...(await original()),
    useRelayEnvironmentDiscovery: () => useSyncExternalStore(subscribe, read, read),
  };
});

import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { resolveOnboardingSetup } from "~/onboarding/targetEnvironment.logic";

const newMachineId = EnvironmentId.make("new-computer");
const linkedMachines: DiscoveredEnvironments = new Map([
  [
    newMachineId,
    {
      environment: {
        environmentId: newMachineId,
        label: "Work laptop",
        endpoint: {
          httpBaseUrl: "https://relay.example.test",
          wsBaseUrl: "wss://relay.example.test/ws",
          providerKind: "manual",
        },
        linkedAt: "2026-09-05T12:00:00.000Z",
      },
      availability: "online",
      status: Option.none(),
      error: Option.none(),
    },
  ],
]);

let container: HTMLDivElement;
let visibility: DocumentVisibilityState;

function publish(state: Discovery.RelayEnvironmentDiscoveryState) {
  discovery.state = state;
  for (const listener of discovery.listeners) listener();
}

const renderRows = (element: ReactElement) => render(element, { container });

const text = () => container.textContent ?? "";
const checkbox = () => container.querySelector<HTMLElement>('[role="checkbox"]')!;
const checked = () => checkbox().getAttribute("aria-checked") === "true";
const toggle = () => act(async () => checkbox().click());

function setup() {
  using stack = new DisposableStack();
  stack.use(fakeTimers());
  visibility = "visible";
  stack.use(vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility));
  container = document.createElement("div");
  discovery.listeners.clear();
  discovery.accountIds = [];
  discovery.accountStates = new Map();
  discovery.accountOwners = new Map();
  discovery.profiles = new Map();
  discovery.state = {
    environments: new Map(),
    listed: false,
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  discovery.listEnvironments.mockReset().mockResolvedValue(new Map());
  discovery.register.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  discovery.refresh.mockReset().mockImplementation(async () => {
    publish({
      environments: new Map(),
      listed: false,
      refreshing: true,
      offline: false,
      error: Option.none(),
    });
    const environments = await discovery.listEnvironments();
    publish({
      environments,
      listed: true,
      refreshing: false,
      offline: false,
      error: Option.none(),
    });
    return AsyncResult.success(undefined);
  });
  return stack.move();
}

describe("cloud onboarding discovery", () => {
  it.each(["expired session", "unlisted computer", "offline discovery", "loading discovery"])(
    "keeps saved selections editable with %s and preserves ownership on rediscovery",
    async (scenario) => {
      using _environment = setup();
      const localId = EnvironmentId.make("local-computer");
      const local = { environmentId: localId, connection: { phase: "connected" } };
      const saved = {
        environmentId: newMachineId,
        label: "Saved work laptop",
        connection: { phase: "available", error: null, traceId: null } as const,
        relayManaged: true,
      };
      discovery.accountIds = ["first-account", "expired-account"];
      discovery.profiles = new Map([
        ["first-account", { label: "Personal" }],
        ["expired-account", { label: "Work" }],
      ]);
      discovery.accountOwners.set(newMachineId, "expired-account");
      discovery.refresh.mockImplementation(async () => {
        publish({
          ...discovery.state!,
          refreshing: scenario === "loading discovery",
          offline: scenario === "offline discovery",
        });
        return AsyncResult.success(undefined);
      });
      const autoSelectedComputers = new Set([localId, newMachineId]);
      function Setup() {
        const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId>>(
          new Set([localId, newMachineId]),
        );
        return (
          <>
            <CloudEnvironmentConnectRows
              primaryEnvironmentId={localId}
              savedEnvironments={[saved]}
              showSavedEnvironments
              selection={{
                autoSelectedComputers,
                selectedIds,
                onChange: (id, checked) =>
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(id);
                    else next.delete(id);
                    return next;
                  }),
              }}
            />
            <button disabled={!resolveOnboardingSetup([local, saved], selectedIds).ready}>
              Continue
            </button>
          </>
        );
      }
      await using _screen = await renderRows(<Setup />);
      const continueButton = () =>
        [...container.querySelectorAll("button")].find(
          (element) => element.textContent === "Continue",
        )!;
      const section = () => container.querySelector("section");
      expect(checked()).toBe(true);
      expect(checkbox().hasAttribute("data-disabled")).toBe(false);
      // Continue skips the saved computer that is not connected rather than locking.
      expect(continueButton().disabled).toBe(false);
      expect(section()?.getAttribute("aria-label")).toBe("Work");
      expect(container.querySelector(`[data-account-mark="${newMachineId}"]`)).not.toBeNull();
      expect(text()).toContain("Saved work laptop");
      await toggle();
      expect(checked()).toBe(false);
      expect(continueButton().disabled).toBe(false);

      // Another account lists the same computer; its saved catalog owner still wins.
      discovery.accountStates.set("first-account", {
        ...discovery.state!,
        environments: linkedMachines,
      });
      await act(async () => publish({ ...discovery.state!, environments: linkedMachines }));
      expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
      expect(checked()).toBe(false);
      expect(section()?.getAttribute("aria-label")).toBe("Work");
      expect(continueButton().disabled).toBe(false);
      expect(discovery.register).not.toHaveBeenCalled();
      expect(discovery.accountOwners.get(newMachineId)).toBe("expired-account");
    },
  );

  it("auto-connects a computer under the account that discovered it", async () => {
    using _environment = setup();
    discovery.accountIds = ["first-account", "second-account"];
    discovery.accountStates = new Map([
      ["first-account", { ...discovery.state!, environments: new Map() }],
      ["second-account", { ...discovery.state!, environments: linkedMachines }],
    ]);
    discovery.listEnvironments.mockResolvedValue(linkedMachines);
    const onChange = vi.fn();
    await using _screen = await renderRows(
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={null}
        savedEnvironments={[]}
        showSavedEnvironments
        selection={{
          autoSelectedComputers: new Set(),
          selectedIds: new Set(),
          onChange,
        }}
      />,
    );

    expect(onChange).toHaveBeenCalledWith(newMachineId, true);
    expect(discovery.register).toHaveBeenCalledTimes(1);
    expect(discovery.register.mock.calls[0]?.[0]).toMatchObject({
      target: { environmentId: newMachineId, accountId: "second-account" },
    });
  });
});
