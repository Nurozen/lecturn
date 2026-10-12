import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { chooseLoadBalancedEnvironment } from "@lecturn/client-runtime/load-balancing";
import type { EnvironmentId } from "@lecturn/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useMemo } from "react";

import { serverEnvironment } from "../state/server";

function createSelectionAtom(
  environmentIds: readonly EnvironmentId[],
  weights: Readonly<Record<string, number>>,
) {
  return Atom.make((get) => {
    const resources = environmentIds.map((environmentId) => {
      const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
      return {
        environmentId,
        resources: result._tag === "Success" ? result.value : null,
        receivedAt: result._tag === "Success" ? result.timestamp : 0,
        pending: result._tag === "Initial" || result.waiting,
        weight: weights[environmentId] ?? 50,
      };
    });
    return {
      pending: resources.some((resource) => resource.pending),
      environmentId: chooseLoadBalancedEnvironment(resources, Date.now()) as EnvironmentId | null,
    };
  });
}

/** Only subscribes for unresolved automatic drafts, so idle clients do not poll hosts. */
export function useLoadBalancedEnvironment(
  environmentIds: readonly EnvironmentId[],
  weights: Readonly<Record<string, number>>,
) {
  const registry = useContext(RegistryContext);
  const refresh = useCallback(
    (ids: readonly EnvironmentId[]) => {
      for (const environmentId of ids) {
        registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
      }
    },
    [registry],
  );
  const selectionAtom = useMemo(
    () => createSelectionAtom(environmentIds, weights),
    [environmentIds, weights],
  );
  return { refresh, ...useAtomValue(selectionAtom) };
}
