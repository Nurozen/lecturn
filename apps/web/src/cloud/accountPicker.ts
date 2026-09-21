import type { EnvironmentId } from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import type { ConnectAccountProfiles } from "./connectAccounts";

/** The account last chosen on each surface that asks "which account?". */
export const ACCOUNT_PICKER_STORAGE_KEY = "lecturn:account-picker:v1";
export const AccountPickerLastUsed = Schema.Record(Schema.String, Schema.String);
export type AccountPickerLastUsed = typeof AccountPickerLastUsed.Type;
export const NO_ACCOUNT_PICKER_LAST_USED: AccountPickerLastUsed = {};

/** Billing and Teams share one surface, so their tabs show the same account. */
export type AccountPickerSurface = "publish" | "account-settings" | "cli-authorize";

export const NEEDS_SIGN_IN_REASON = "Sign in to this account again to use it here.";
export const UNKNOWN_PICKER_ACCOUNT_NAME = "Lecturn Connect account";

/**
 * The environment of the thread that was open last. Settings replaces the
 * thread route, so its pickers still default to the thread the user came from.
 */
export const openThreadEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("connect:open-thread-environment"),
);

/** A picker only exists with the feature on and a real choice to make. */
export function accountPickerVisible(input: {
  readonly multiAccountEnabled: boolean;
  readonly knownAccountIds: ReadonlyArray<string>;
}): boolean {
  return input.multiAccountEnabled && input.knownAccountIds.length >= 2;
}

/**
 * The account a surface acts as. Without a picker that is Clerk's active
 * account, as it was before accounts could be chosen. With one it is the
 * first signed-in account of: the choice made while the surface is open, the
 * account the surface was opened for, the open thread's owner, the account
 * last used on this surface, and Clerk's active account. An account that needs sign-in is never
 * the answer, since it has no token to act with.
 */
export function resolvePickedAccount(input: {
  readonly multiAccountEnabled: boolean;
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly needsSignIn: ReadonlyArray<string>;
  readonly activeAccountId: string | null;
  readonly selectedAccountId?: string | null | undefined;
  readonly preferredAccountId?: string | null | undefined;
  readonly threadOwnerAccountId?: string | null | undefined;
  readonly lastUsedAccountId?: string | null | undefined;
}): string | null {
  if (!accountPickerVisible(input)) {
    return input.activeAccountId;
  }
  const usable = input.knownAccountIds.filter(
    (accountId) => !input.needsSignIn.includes(accountId),
  );
  return (
    [
      input.selectedAccountId,
      input.preferredAccountId,
      input.threadOwnerAccountId,
      input.lastUsedAccountId,
      input.activeAccountId,
    ].find((accountId) => accountId != null && usable.includes(accountId)) ??
    usable[0] ??
    null
  );
}

export interface AccountPickerRow {
  readonly accountId: string;
  readonly name: string;
  /** Set for an account that cannot be chosen. */
  readonly disabledReason: string | null;
}

export function buildAccountPickerRows(input: {
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly needsSignIn: ReadonlyArray<string>;
  readonly profiles: ConnectAccountProfiles;
}): ReadonlyArray<AccountPickerRow> {
  return input.knownAccountIds.map((accountId) => ({
    accountId,
    name: input.profiles.get(accountId)?.email ?? UNKNOWN_PICKER_ACCOUNT_NAME,
    disabledReason: input.needsSignIn.includes(accountId) ? NEEDS_SIGN_IN_REASON : null,
  }));
}

/** A choice made in a picker, and what its surface was open for at the time. */
export interface AccountPickerSelection {
  readonly accountId: string;
  readonly scope: string;
}

/**
 * What a surface is open for: the account it was opened for, or "" for none.
 * null is a closed surface, which holds no choice.
 */
export function accountPickerScope(input: {
  readonly open?: boolean | undefined;
  readonly preferredAccountId?: string | null | undefined;
}): string | null {
  return input.open === false ? null : (input.preferredAccountId ?? "");
}

/**
 * The choice that still holds. One surface has one choice, shared by all its
 * tabs, and it lasts until the surface closes or opens for another account.
 */
export function selectionInScope(
  selection: AccountPickerSelection | null,
  scope: string | null,
): string | null {
  return selection !== null && selection.scope === scope ? selection.accountId : null;
}

/** Drops an account from the last-used choices. The same record when it was in none. */
export function withoutPickerAccount(
  lastUsed: AccountPickerLastUsed,
  accountId: string,
): AccountPickerLastUsed {
  const kept = Object.entries(lastUsed).filter(([, usedId]) => usedId !== accountId);
  return kept.length === Object.keys(lastUsed).length ? lastUsed : Object.fromEntries(kept);
}

export function readAccountPickerLastUsed(): AccountPickerLastUsed {
  try {
    return (
      getLocalStorageItem(ACCOUNT_PICKER_STORAGE_KEY, AccountPickerLastUsed) ??
      NO_ACCOUNT_PICKER_LAST_USED
    );
  } catch {
    return NO_ACCOUNT_PICKER_LAST_USED;
  }
}

function storeAccountPickerLastUsed(
  change: (lastUsed: AccountPickerLastUsed) => AccountPickerLastUsed,
): void {
  const current = readAccountPickerLastUsed();
  const next = change(current);
  if (next === current) return;
  try {
    setLocalStorageItem(ACCOUNT_PICKER_STORAGE_KEY, next, AccountPickerLastUsed);
  } catch {
    // Without storage the next visit starts from the open thread's account.
  }
}

export function rememberAccountPickerChoice(
  surface: AccountPickerSurface,
  accountId: string,
): void {
  storeAccountPickerLastUsed((lastUsed) =>
    lastUsed[surface] === accountId ? lastUsed : { ...lastUsed, [surface]: accountId },
  );
}

/** Call when an account's data is removed, so no picker defaults to it afterwards. */
export function forgetAccountPickerAccount(accountId: string): void {
  storeAccountPickerLastUsed((lastUsed) => withoutPickerAccount(lastUsed, accountId));
}

const BILLING_ACCOUNT_STORAGE_KEY = "lecturn-connect-billing-account";

/**
 * The account the hosted billing page was opened for: `?account=` on a link
 * from another client, or the account a checkout left for, once Stripe
 * returns with `session_id`. Only a known account counts.
 */
export function resolveBillingAccountHint(input: {
  readonly multiAccountEnabled: boolean;
  readonly search: string;
  readonly checkoutAccountId: string | null;
  readonly knownAccountIds: ReadonlyArray<string>;
}): string | null {
  if (!input.multiAccountEnabled) return null;
  const params = new URLSearchParams(input.search);
  const hint = params.get("account") ?? (params.has("session_id") ? input.checkoutAccountId : null);
  return hint !== null && input.knownAccountIds.includes(hint) ? hint : null;
}

/** The billing page's URL on the hosted app, naming the account when one was chosen. */
export function hostedBillingUrl(input: {
  readonly hostedAppUrl: string;
  readonly tab?: "teams" | undefined;
  readonly accountId: string | null | undefined;
}): string {
  const url = new URL("/account/billing", input.hostedAppUrl);
  if (input.tab) url.searchParams.set("tab", input.tab);
  if (input.accountId) url.searchParams.set("account", input.accountId);
  return url.href;
}

/** Call before leaving for a Stripe checkout, so the return confirms as the same account. */
export function rememberBillingCheckoutAccount(accountId: string): void {
  try {
    window.sessionStorage.setItem(BILLING_ACCOUNT_STORAGE_KEY, accountId);
  } catch {
    // The return then resolves the account as any other visit does.
  }
}

export function readBillingCheckoutAccount(): string | null {
  try {
    return window.sessionStorage.getItem(BILLING_ACCOUNT_STORAGE_KEY);
  } catch {
    return null;
  }
}
