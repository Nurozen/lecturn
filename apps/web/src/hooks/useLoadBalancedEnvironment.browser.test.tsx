import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type HostResourcesSnapshot } from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useLoadBalancedEnvironment } from "./useLoadBalancedEnvironment";

const { hostResources } = vi.hoisted(() => ({ hostResources: vi.fn() }));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  return { ...actual, serverEnvironment: { ...actual.serverEnvironment, hostResources } as never };
});

let root: Root | undefined;
let registry: AtomRegistry.AtomRegistry;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  registry?.dispose();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  const environmentId = EnvironmentId.make("fixture-machine");
  const resource = Atom.make<AsyncResult.AsyncResult<HostResourcesSnapshot, never>>(
    AsyncResult.initial(),
  );
  hostResources.mockReturnValue(resource);
  const ids = [environmentId];
  const weights = { [environmentId]: 50 };
  let selection: ReturnType<typeof useLoadBalancedEnvironment> | undefined;
  function Fixture() {
    const current = useLoadBalancedEnvironment(ids, weights);
    useEffect(() => {
      selection = current;
    }, [current]);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root!.render(
      <RegistryContext.Provider value={registry}>
        <Fixture />
      </RegistryContext.Provider>,
    ),
  );
  return {
    environmentId,
    selection: () => selection,
    update: (result: AsyncResult.AsyncResult<HostResourcesSnapshot, never>) =>
      act(async () => registry.set(resource, result)),
  };
}

describe("automatic environment selection", () => {
  it("reports unavailable only after a failed probe, and clears it during retry", async () => {
    const fixture = await mount();
    expect(fixture.selection()).toMatchObject({
      pending: true,
      failed: false,
      environmentId: null,
    });
    await fixture.update(AsyncResult.failure(Cause.die("offline")));
    expect(fixture.selection()).toMatchObject({
      pending: false,
      failed: true,
      environmentId: null,
    });
    await fixture.update(
      AsyncResult.waiting(AsyncResult.failure<HostResourcesSnapshot>(Cause.die("offline"))),
    );
    expect(fixture.selection()).toMatchObject({
      pending: true,
      failed: false,
      environmentId: null,
    });
  });

  it("keeps capacity exhaustion distinct from failure and selects a recovered machine", async () => {
    const fixture = await mount();
    const snapshot = {
      sampledAt: Date.now(),
      cpuCount: 8,
      cpuUtilization: 0.99,
      totalMemoryBytes: 16_000_000_000,
      availableMemoryBytes: 8_000_000_000,
    } satisfies HostResourcesSnapshot;
    await fixture.update(AsyncResult.success(snapshot));
    expect(fixture.selection()).toMatchObject({
      pending: false,
      failed: false,
      environmentId: null,
    });
    await fixture.update(AsyncResult.success({ ...snapshot, cpuUtilization: 0.25 }));
    expect(fixture.selection()).toMatchObject({
      pending: false,
      failed: false,
      environmentId: fixture.environmentId,
    });
  });
});
