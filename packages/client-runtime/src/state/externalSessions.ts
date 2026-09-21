import { WS_METHODS } from "@lecturn/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createExternalSessionsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // Sessions change only when the user works in a provider's own tooling, so
    // a short stale window spares repeat opens a rescan. The family is keyed by
    // input, so every distinct search term is its own entry and its own request:
    // callers must debounce search input.
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:external-sessions:list",
      tag: WS_METHODS.externalSessionsList,
      staleTimeMs: 15_000,
      idleTtlMs: 5 * 60_000,
    }),
  };
}
