/** Most Connect accounts one client keeps signed in at once. */
export const MAX_CONNECT_ACCOUNTS = 5;

/** The slice of a catalog entry's target that account ownership reads. */
export interface AccountOwnedTarget {
  readonly _tag: string;
  readonly environmentId: string;
  readonly accountId?: string | undefined;
}

export type AddAccountBlockedReason =
  /** The build serves a single account. */
  | "disabled"
  /** Clerk's multi-session setting is off, or could not be read. */
  | "single-session"
  /** A relay environment has no owner yet, so a second account could claim it. */
  | "unowned-environments"
  | "account-limit";

export type AddAccountGate =
  | { readonly available: true }
  | { readonly available: false; readonly reason: AddAccountBlockedReason };

/**
 * Whether another Connect account may be added. `clerkSingleSessionMode` is
 * what the loaded Clerk environment reports; anything but `false` blocks,
 * since Clerk's sign-in does nothing in single-session mode. Relay entries
 * without an owner block too, except the ones the registry holds as unlisted:
 * no signed-in account lists those, so none can be handed to the new account.
 */
export function decideAddAccountGate(input: {
  readonly multiAccountEnabled: boolean;
  readonly clerkSingleSessionMode: boolean | undefined;
  readonly targets: Iterable<AccountOwnedTarget>;
  readonly unlistedRelayEnvironmentIds: ReadonlySet<string>;
  readonly knownAccountCount: number;
}): AddAccountGate {
  if (!input.multiAccountEnabled) {
    return { available: false, reason: "disabled" };
  }
  if (input.clerkSingleSessionMode !== false) {
    return { available: false, reason: "single-session" };
  }
  for (const target of input.targets) {
    if (
      target._tag === "RelayConnectionTarget" &&
      target.accountId === undefined &&
      !input.unlistedRelayEnvironmentIds.has(target.environmentId)
    ) {
      return { available: false, reason: "unowned-environments" };
    }
  }
  if (input.knownAccountCount >= MAX_CONNECT_ACCOUNTS) {
    return { available: false, reason: "account-limit" };
  }
  return { available: true };
}

/**
 * Owning account per relay environment. Direct, Tailscale, and SSH
 * environments belong to no account, and neither does an untagged relay entry.
 */
export function relayAccountByEnvironmentId<Target extends AccountOwnedTarget>(
  targets: Iterable<Target>,
): ReadonlyMap<Target["environmentId"], string> {
  const owners = new Map<Target["environmentId"], string>();
  for (const target of targets) {
    if (target._tag === "RelayConnectionTarget" && target.accountId !== undefined) {
      owners.set(target.environmentId, target.accountId);
    }
  }
  return owners;
}

export interface AccountBucket<Item> {
  /** null holds what no account owns. */
  readonly accountId: string | null;
  readonly items: ReadonlyArray<Item>;
}

/**
 * Splits items by owning account in `accountOrder`, keeping item order inside
 * a bucket. Empty buckets are left out, and the no-account bucket comes last,
 * along with items whose account is not in `accountOrder`.
 */
export function bucketByAccount<Item>(
  items: ReadonlyArray<Item>,
  accountOf: (item: Item) => string | null | undefined,
  accountOrder: ReadonlyArray<string>,
): ReadonlyArray<AccountBucket<Item>> {
  const owned = (item: Item) => {
    const accountId = accountOf(item) ?? null;
    return accountId !== null && accountOrder.includes(accountId) ? accountId : null;
  };
  return [...accountOrder, null]
    .map((accountId) => ({ accountId, items: items.filter((item) => owned(item) === accountId) }))
    .filter((bucket) => bucket.items.length > 0);
}
