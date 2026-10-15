import type { EnvironmentId } from "@lecturn/contracts";

/** Prune removed catalog entries without dropping discoveries still being registered. */
export function reconcileOnboardingComputers(
  selectedIds: ReadonlySet<EnvironmentId>,
  catalogIds: ReadonlySet<EnvironmentId>,
  previousCatalogIds: ReadonlySet<EnvironmentId>,
  autoSelectedComputers: ReadonlySet<EnvironmentId>,
): ReadonlySet<EnvironmentId> {
  const next = new Set(selectedIds);
  for (const id of previousCatalogIds) {
    if (!catalogIds.has(id)) next.delete(id);
  }
  for (const id of catalogIds) {
    if (!autoSelectedComputers.has(id)) next.add(id);
  }
  return next.size === selectedIds.size && [...next].every((id) => selectedIds.has(id))
    ? selectedIds
    : next;
}

export function areOnboardingComputersReady(
  selectedIds: ReadonlySet<EnvironmentId>,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connection: { readonly phase: string };
  }>,
): boolean {
  return (
    selectedIds.size > 0 &&
    [...selectedIds].every((id) =>
      environments.some(
        (environment) =>
          environment.environmentId === id && environment.connection.phase === "connected",
      ),
    )
  );
}
