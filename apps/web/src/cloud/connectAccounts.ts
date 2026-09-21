import { relayAccountByEnvironmentId } from "@lecturn/client-runtime/relay";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { knownConnectAccountsAtom } from "./knownAccounts";
import { connectMultiAccount } from "./publicConfig";

export const ACCOUNT_PROFILES_STORAGE_KEY = "lecturn:account-profiles:v1";

const AccountProfile = Schema.Struct({
  email: Schema.String,
  imageUrl: Schema.optional(Schema.String),
});
const AccountProfilesDocument = Schema.Record(Schema.String, AccountProfile);

/** What the UI shows for a Connect account. Kept so an account that needs sign-in still has a name. */
export type ConnectAccountProfile = typeof AccountProfile.Type;
export type ConnectAccountProfiles = ReadonlyMap<string, ConnectAccountProfile>;

function readStoredProfiles(): ConnectAccountProfiles {
  try {
    return new Map(
      Object.entries(
        getLocalStorageItem(ACCOUNT_PROFILES_STORAGE_KEY, AccountProfilesDocument) ?? {},
      ),
    );
  } catch {
    return new Map();
  }
}

export const connectAccountProfilesAtom = Atom.make<ConnectAccountProfiles>(
  readStoredProfiles(),
).pipe(Atom.keepAlive, Atom.withLabel("connect:account-profiles"));

/** A Clerk user as the profile list reads it. */
export interface ObservedClerkUser {
  readonly id: string;
  readonly primaryEmailAddress?: { readonly emailAddress: string } | null | undefined;
  readonly hasImage?: boolean | undefined;
  readonly imageUrl?: string | undefined;
}

/**
 * Signed-in users overwrite their profile, known accounts keep the one they
 * had, and every other profile is dropped.
 */
export function mergeAccountProfiles(input: {
  readonly current: ConnectAccountProfiles;
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly users: ReadonlyArray<ObservedClerkUser>;
}): ConnectAccountProfiles {
  const next = new Map<string, ConnectAccountProfile>();
  for (const accountId of input.knownAccountIds) {
    const user = input.users.find((candidate) => candidate.id === accountId);
    const email = user?.primaryEmailAddress?.emailAddress;
    const profile =
      user && email
        ? { email, ...(user.hasImage && user.imageUrl ? { imageUrl: user.imageUrl } : {}) }
        : input.current.get(accountId);
    if (profile) next.set(accountId, profile);
  }
  return next;
}

const sameProfiles = (left: ConnectAccountProfiles, right: ConnectAccountProfiles) =>
  left.size === right.size &&
  [...left].every(([accountId, profile]) => {
    const other = right.get(accountId);
    return other?.email === profile.email && other.imageUrl === profile.imageUrl;
  });

/** Records the signed-in users' emails next to the known-account list. */
export function observeAccountProfiles(
  registry: AtomRegistry.AtomRegistry,
  users: ReadonlyArray<ObservedClerkUser>,
): void {
  if (!connectMultiAccount) return;
  const current = registry.get(connectAccountProfilesAtom);
  const next = mergeAccountProfiles({
    current,
    knownAccountIds: registry.get(knownConnectAccountsAtom).accountIds,
    users,
  });
  if (sameProfiles(current, next)) return;
  registry.set(connectAccountProfilesAtom, next);
  try {
    setLocalStorageItem(
      ACCOUNT_PROFILES_STORAGE_KEY,
      Object.fromEntries(next),
      AccountProfilesDocument,
    );
  } catch {
    // Without storage the emails last for this page only.
  }
}

/** Owning Connect account per relay environment, from the catalog's `accountId` tags. */
export const accountByEnvironmentIdAtom = Atom.make((get) =>
  relayAccountByEnvironmentId(
    [...get(environmentCatalog.catalogValueAtom).entries.values()].map((entry) => entry.target),
  ),
).pipe(Atom.withLabel("connect:account-by-environment"));

/**
 * Short text that tells the known accounts apart: the email's local part, or
 * its domain when two known accounts share a local part, or the whole email
 * when that is shared too.
 */
export function accountMarkLabels(profiles: ConnectAccountProfiles): ReadonlyMap<string, string> {
  const parts = [...profiles].map(([accountId, { email }]) => {
    const at = email.lastIndexOf("@");
    return {
      accountId,
      email,
      local: at > 0 ? email.slice(0, at) : email,
      domain: at > 0 ? email.slice(at + 1) : email,
    };
  });
  const unique = (key: "local" | "domain", value: string) =>
    parts.filter((part) => part[key].toLowerCase() === value.toLowerCase()).length === 1;
  return new Map(
    parts.map((part) => [
      part.accountId,
      unique("local", part.local)
        ? part.local
        : unique("domain", part.domain)
          ? part.domain
          : part.email,
    ]),
  );
}

export interface AccountMark {
  readonly label: string;
  readonly email: string;
}

/**
 * The mark each environment shows. Empty with fewer than two known accounts,
 * and an environment that no account owns (direct, Tailscale, SSH, or an
 * untagged relay entry) never has one.
 */
export function buildAccountMarks(input: {
  readonly multiAccountEnabled: boolean;
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly profiles: ConnectAccountProfiles;
  readonly accountByEnvironmentId: ReadonlyMap<string, string>;
}): ReadonlyMap<string, AccountMark> {
  if (!input.multiAccountEnabled || input.knownAccountIds.length < 2) {
    return new Map();
  }
  const labels = accountMarkLabels(input.profiles);
  const marks = new Map<string, AccountMark>();
  for (const [environmentId, accountId] of input.accountByEnvironmentId) {
    const label = labels.get(accountId);
    const email = input.profiles.get(accountId)?.email;
    if (label !== undefined && email !== undefined && input.knownAccountIds.includes(accountId)) {
      marks.set(environmentId, { label, email });
    }
  }
  return marks;
}

export const accountMarkByEnvironmentIdAtom = Atom.make((get) =>
  buildAccountMarks({
    multiAccountEnabled: connectMultiAccount,
    knownAccountIds: get(knownConnectAccountsAtom).accountIds,
    profiles: get(connectAccountProfilesAtom),
    accountByEnvironmentId: get(accountByEnvironmentIdAtom),
  }),
).pipe(Atom.withLabel("connect:account-mark-by-environment"));

/**
 * The email to name an account by, or null while fewer than two accounts are
 * known, when "your account" is already unambiguous.
 */
export function accountEmailWhenSeveral(input: {
  readonly multiAccountEnabled: boolean;
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly profiles: ConnectAccountProfiles;
  readonly accountId: string | null | undefined;
}): string | null {
  if (!input.multiAccountEnabled || input.knownAccountIds.length < 2 || !input.accountId) {
    return null;
  }
  return input.profiles.get(input.accountId)?.email ?? null;
}

/**
 * The known account that published this computer while another account is
 * active. null in a single-account build, or when the publisher is a stranger
 * to this client, where signing out stays the way to take the computer over.
 */
export function knownPublishingAccount(input: {
  readonly multiAccountEnabled: boolean;
  readonly publisherId: string | null | undefined;
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly needsSignIn: ReadonlyArray<string>;
  readonly profiles: ConnectAccountProfiles;
}): {
  readonly accountId: string;
  readonly email: string | null;
  readonly signedIn: boolean;
} | null {
  const { publisherId } = input;
  if (!input.multiAccountEnabled || !publisherId || !input.knownAccountIds.includes(publisherId)) {
    return null;
  }
  return {
    accountId: publisherId,
    email: input.profiles.get(publisherId)?.email ?? null,
    signedIn: !input.needsSignIn.includes(publisherId),
  };
}

/**
 * Clerk's single-session setting from the loaded environment. clerk-js exposes
 * it only on an internal field, so every step is checked and anything
 * unexpected reads as unknown.
 */
export function readClerkSingleSessionMode(clerk: unknown): boolean | undefined {
  try {
    const environment = (clerk as { readonly __internal_environment?: unknown } | null)
      ?.__internal_environment;
    const mode = (
      environment as { readonly authConfig?: { readonly singleSessionMode?: unknown } } | null
    )?.authConfig?.singleSessionMode;
    return typeof mode === "boolean" ? mode : undefined;
  } catch {
    return undefined;
  }
}
