import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@lecturn/client-runtime/connection";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";
import { connectedGenerationSignal } from "./primaryCloudLinkRefresh";

it("revalidates mounted link state after initial connection and reconnect, without querying retry stages", () => {
  const registry = AtomRegistry.make();
  const state = Atom.make<SupervisorConnectionState | undefined>(undefined);
  const signal = connectedGenerationSignal(state);
  let reads = 0;
  const link = Atom.make(() => ++reads).pipe(Atom.makeRefreshOnSignal(signal));
  const unsubscribe = registry.subscribe(link, () => {});
  expect(registry.get(link)).toBe(1);
  const update = (phase: SupervisorConnectionState["phase"], generation: number) => {
    registry.set(state, { ...AVAILABLE_CONNECTION_STATE, phase, generation });
    return registry.get(link);
  };
  expect(update("connecting", 1)).toBe(1);
  expect(update("connected", 1)).toBe(2);
  expect(update("backoff", 1)).toBe(2);
  expect(update("connecting", 2)).toBe(2);
  expect(update("connected", 2)).toBe(3);
  expect(update("connected", 2)).toBe(3);
  unsubscribe();
  registry.dispose();
});
