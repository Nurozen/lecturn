/** Add only the primary host's verified publisher; arbitrary direct connections stay unowned. */
export function withPrimaryPublisher(
  relayOwners: ReadonlyMap<string, string>,
  primary: { readonly environmentId: string; readonly accountId: string } | null,
): ReadonlyMap<string, string> {
  if (!primary) return relayOwners;
  return new Map([...relayOwners, [primary.environmentId, primary.accountId]]);
}
