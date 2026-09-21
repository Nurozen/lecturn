import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { accountByEnvironmentIdAtom, connectAccountProfilesAtom } from "./connectAccounts";
import { connectMultiAccount } from "./publicConfig";

export interface SignedOutEnvironment {
  readonly accountId: string;
  readonly email: string | null;
}

/** Environments that left this page's catalog because their account was signed out. */
export const signedOutEnvironmentsAtom = Atom.make<ReadonlyMap<string, SignedOutEnvironment>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("connect:signed-out-environments"));

/** Adds the environments a leaving account owns to what was already recorded. */
export function withSignedOutAccount(input: {
  readonly current: ReadonlyMap<string, SignedOutEnvironment>;
  readonly accountId: string;
  readonly email: string | null;
  readonly accountByEnvironmentId: ReadonlyMap<string, string>;
}): ReadonlyMap<string, SignedOutEnvironment> {
  const next = new Map(input.current);
  for (const [environmentId, ownerId] of input.accountByEnvironmentId) {
    if (ownerId === input.accountId) {
      next.set(environmentId, { accountId: input.accountId, email: input.email });
    }
  }
  return next;
}

/**
 * Call before a signed-out account's environments are removed, while the
 * catalog still says which ones it owns, so an open thread can say why it
 * went away. Does nothing in a single-account build.
 */
export function recordSignedOutAccount(
  registry: AtomRegistry.AtomRegistry,
  accountId: string,
): void {
  if (!connectMultiAccount) return;
  registry.set(
    signedOutEnvironmentsAtom,
    withSignedOutAccount({
      current: registry.get(signedOutEnvironmentsAtom),
      accountId,
      email: registry.get(connectAccountProfilesAtom).get(accountId)?.email ?? null,
      accountByEnvironmentId: registry.get(accountByEnvironmentIdAtom),
    }),
  );
}

/**
 * The signed-out account behind an open thread's environment, or null. Only
 * while the environment is really gone: a failed cleanup leaves it in the
 * catalog, and signing in again brings it back.
 */
export function resolveAccountGone(input: {
  readonly multiAccountEnabled: boolean;
  readonly environmentId: string | null;
  readonly signedOutEnvironments: ReadonlyMap<string, SignedOutEnvironment>;
  readonly environmentInCatalog: boolean;
}): SignedOutEnvironment | null {
  if (!input.multiAccountEnabled || input.environmentId === null) return null;
  if (input.environmentInCatalog) return null;
  return input.signedOutEnvironments.get(input.environmentId) ?? null;
}
