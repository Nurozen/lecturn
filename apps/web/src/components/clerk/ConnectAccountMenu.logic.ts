import {
  MAX_CONNECT_ACCOUNTS,
  type AddAccountBlockedReason,
  type AddAccountGate,
} from "@lecturn/client-runtime/relay";

import type { ConnectAccountProfiles } from "../../cloud/connectAccounts";

export interface ConnectAccountMenuRow {
  readonly accountId: string;
  /** The account's email, or a stand-in until one was seen. */
  readonly name: string;
  readonly initials: string;
  readonly imageUrl: string | null;
  readonly active: boolean;
  /** Known, but without a signed-in session. Its environments stay disconnected. */
  readonly needsSignIn: boolean;
  /** Signed in. Clerk's profile opens for the active account, so managing makes it active. */
  readonly canManage: boolean;
  /** Signed in but not active. Surfaces without a picker follow the active account. */
  readonly canActivate: boolean;
}

export interface ConnectAccountMenuModel {
  readonly rows: ReadonlyArray<ConnectAccountMenuRow>;
  /** null hides the action. A reason shows it disabled. */
  readonly addAccount:
    | null
    | { readonly enabled: true }
    | { readonly enabled: false; readonly reason: string };
  readonly canSignOutAll: boolean;
}

export const BLOCKED_REASONS: Record<AddAccountBlockedReason, string> = {
  "single-session": "This Lecturn Connect service allows one signed-in account at a time.",
  "unowned-environments":
    "A saved Connect environment has no owner account yet. Remove it in Settings, or wait until its account lists it.",
  "account-limit": `You can stay signed in to ${MAX_CONNECT_ACCOUNTS} accounts. Sign out of one to add another.`,
};

/**
 * Why another account cannot be added, or null when one can. The first
 * sign-in on a client adds nothing to a list, so no gate applies to it.
 */
export function addAccountBlockedReason(input: {
  readonly gate: AddAccountGate;
  readonly knownAccountCount: number;
}): string | null {
  const { gate } = input;
  return gate.available || input.knownAccountCount === 0 ? null : BLOCKED_REASONS[gate.reason];
}

export const UNKNOWN_ACCOUNT_NAME = "Lecturn Connect account";

export function accountInitials(email: string | undefined): string {
  const letters = (email ?? "").split("@")[0]?.match(/[\p{L}\p{N}]/gu) ?? [];
  return (letters.slice(0, 2).join("") || "?").toUpperCase();
}

export function buildConnectAccountMenu(input: {
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly needsSignIn: ReadonlyArray<string>;
  readonly activeAccountId: string | null;
  readonly profiles: ConnectAccountProfiles;
  readonly gate: AddAccountGate;
}): ConnectAccountMenuModel {
  // Clerk's active account can be a moment ahead of the known list.
  const accountIds =
    input.activeAccountId === null || input.knownAccountIds.includes(input.activeAccountId)
      ? input.knownAccountIds
      : [...input.knownAccountIds, input.activeAccountId];
  const rows = accountIds.map((accountId) => {
    const profile = input.profiles.get(accountId);
    const active = accountId === input.activeAccountId;
    const needsSignIn = !active && input.needsSignIn.includes(accountId);
    return {
      accountId,
      name: profile?.label ?? profile?.email ?? UNKNOWN_ACCOUNT_NAME,
      initials: accountInitials(profile?.email),
      imageUrl: profile?.imageUrl ?? null,
      active,
      needsSignIn,
      canManage: active || !input.needsSignIn.includes(accountId),
      canActivate: !active && !input.needsSignIn.includes(accountId),
    };
  });
  return {
    rows,
    addAccount: input.gate.available
      ? { enabled: true }
      : { enabled: false, reason: BLOCKED_REASONS[input.gate.reason] },
    canSignOutAll: rows.length > 1,
  };
}

/** The rejection `@clerk/electron` gives a second OAuth flow while one is waiting on the browser. */
export function isOAuthFlowPendingError(cause: unknown): boolean {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "object" && cause !== null && "message" in cause
        ? String((cause as { readonly message: unknown }).message)
        : typeof cause === "string"
          ? cause
          : "";
  return /oauth flow is already pending/i.test(message);
}

/** What "Sign in again" remembers: who was expected, and the add-account gate at that moment. */
export interface PendingSignInAgain {
  readonly expectedAccountId: string;
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly gate: AddAccountGate;
}

/**
 * "Sign in again" opens the same sign-in as "Add account", so somebody else
 * can come out of it. Returns the account to sign out again: a new one, while
 * the gate would not have let an account be added.
 */
export function unexpectedSignInToReject(input: {
  readonly pending: PendingSignInAgain;
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly needsSignIn: ReadonlyArray<string>;
}): { readonly accountId: string; readonly reason: string } | null {
  const { pending } = input;
  if (pending.gate.available) {
    return null;
  }
  const accountId = input.knownAccountIds.find(
    (id) =>
      id !== pending.expectedAccountId &&
      !pending.knownAccountIds.includes(id) &&
      !input.needsSignIn.includes(id),
  );
  return accountId === undefined
    ? null
    : { accountId, reason: BLOCKED_REASONS[pending.gate.reason] };
}
