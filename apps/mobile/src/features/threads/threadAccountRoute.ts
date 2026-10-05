export type ThreadAccountRoute =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "sign-in"; readonly accountId: string }
  | { readonly kind: "ready"; readonly accountId: string | null };

/** A stale activity must never open the same environment after it changed accounts. */
export function resolveThreadAccountRoute(input: {
  readonly catalogReady: boolean;
  readonly accountsReady: boolean;
  readonly target: { readonly _tag: string; readonly accountId?: string } | undefined;
  readonly requestedAccountId?: string;
  readonly accounts: ReadonlyArray<{ readonly accountId: string; readonly signedIn: boolean }>;
}): ThreadAccountRoute {
  if (!input.catalogReady) return { kind: "loading" };
  const owner = input.target?._tag === "RelayConnectionTarget" ? input.target.accountId : undefined;
  if (!input.target || (input.requestedAccountId && input.requestedAccountId !== owner))
    return { kind: "unavailable" };
  if (!owner)
    return input.target._tag === "RelayConnectionTarget"
      ? { kind: "unavailable" }
      : { kind: "ready", accountId: null };
  if (!input.accountsReady) return { kind: "loading" };
  const account = input.accounts.find((entry) => entry.accountId === owner);
  if (!account) return { kind: "unavailable" };
  return account.signedIn
    ? { kind: "ready", accountId: owner }
    : { kind: "sign-in", accountId: owner };
}
