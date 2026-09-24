/** A grouped project is account-colored only if every environment has the same owner. */
export function sidebarOwnerForEnvironments(
  environmentIds: ReadonlyArray<string>,
  owners: ReadonlyMap<string, string>,
): string | undefined {
  const firstOwner = environmentIds.length > 0 ? owners.get(environmentIds[0]!) : undefined;
  return firstOwner && environmentIds.every((id) => owners.get(id) === firstOwner)
    ? firstOwner
    : undefined;
}
