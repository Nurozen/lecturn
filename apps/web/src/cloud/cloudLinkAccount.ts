import { knownPublishingAccount, type ConnectAccountProfiles } from "./connectAccounts";

const STRANGER_MESSAGE =
  "This environment is still published to a different Lecturn account. Sign out to stop its local relay, then sign in to the account you want to use. The previous owner can remove the offline environment from their account.";

export interface PublishAccountState {
  /** This computer is published, and not under the account being acted as. */
  readonly mismatch: boolean;
  readonly message: string | null;
  /** The publishing account, when choosing it is the way on. */
  readonly actAs: { readonly accountId: string; readonly label: string } | null;
  /** Whether unlinking is allowed, and whose token removes the registration. null means no token. */
  readonly unlink:
    | { readonly allowed: true; readonly tokenAccountId: string | null }
    | { readonly allowed: false };
}

/**
 * This computer links to one account. Says what the account being acted as
 * may do about a link that another account holds. One of this client's own
 * accounts can be chosen instead, or have its link removed from here. A
 * stranger's link stays out of reach, as it always was.
 */
export function describePublishAccount(input: {
  readonly multiAccountEnabled: boolean;
  readonly linked: boolean;
  readonly accountId: string | null | undefined;
  readonly accountSignedIn: boolean;
  readonly publisherId: string | null | undefined;
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly needsSignIn: ReadonlyArray<string>;
  readonly profiles: ConnectAccountProfiles;
  /** Whether the surface has a picker to choose the publisher with. */
  readonly canChoose: boolean;
}): PublishAccountState {
  const accountId = input.accountId ?? null;
  const mismatch =
    input.linked && input.accountSignedIn && accountId !== null && input.publisherId !== accountId;
  if (!mismatch) {
    return {
      mismatch,
      message: null,
      actAs: null,
      unlink: { allowed: true, tokenAccountId: accountId },
    };
  }
  const publisher = knownPublishingAccount({
    multiAccountEnabled: input.multiAccountEnabled,
    publisherId: input.publisherId,
    knownAccountIds: input.knownAccountIds,
    needsSignIn: input.needsSignIn,
    profiles: input.profiles,
  });
  if (publisher === null) {
    return { mismatch, message: STRANGER_MESSAGE, actAs: null, unlink: { allowed: false } };
  }
  const name = publisher.email ?? "Another of your accounts";
  return {
    mismatch,
    message: `${name} published this computer. ${publisher.signedIn ? "Choose it" : "Sign in to it again"} to change publishing, or unlink this computer.`,
    actAs:
      publisher.signedIn && input.canChoose
        ? { accountId: publisher.accountId, label: `Use ${publisher.email ?? "that account"}` }
        : null,
    unlink: { allowed: true, tokenAccountId: publisher.signedIn ? publisher.accountId : null },
  };
}
