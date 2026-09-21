import * as Effect from "effect/Effect";
import { runtime } from "../../lib/runtime";
import { MobilePreferencesStore } from "../../persistence/mobile-preferences";
import { getComposerCloudAccountId } from "../../state/use-composer-drafts";
import { appAtomRegistry } from "../../state/atom-registry";
import { knownConnectAccountsAtom, connectAccountRemovalRevisionAtom } from "./knownAccounts";
const removing = new Set<string>();
let hydration: Promise<void> | null = null;
export function loadKnownConnectAccounts(): Promise<void> {
  return (hydration ??= runtime
    .runPromise(
      Effect.gen(function* () {
        const store = yield* MobilePreferencesStore;
        const preferences = yield* store.load;
        const legacyAccount =
          preferences.connectAccounts === undefined
            ? yield* Effect.tryPromise({ try: getComposerCloudAccountId, catch: (cause) => cause })
            : null;
        const accounts =
          preferences.connectAccounts ??
          (legacyAccount
            ? [{ accountId: legacyAccount, email: "", label: "Connect account", preset: "jade" }]
            : []);
        appAtomRegistry.set(
          knownConnectAccountsAtom,
          accounts.map((account) => ({ ...account, signedIn: false })),
        );
        for (const id of preferences.connectAccountsRemoving ?? []) removing.add(id);
      }),
    )
    .catch((error) => {
      hydration = null;
      throw error;
    }));
}
export function persistKnownConnectAccounts(): Promise<unknown> {
  const accounts = appAtomRegistry.get(knownConnectAccountsAtom);
  return runtime.runPromise(
    MobilePreferencesStore.pipe(
      Effect.flatMap((store) =>
        store.savePatch({
          connectAccounts: accounts.map(({ accountId, email, label, preset }) => ({
            accountId,
            email,
            label,
            preset,
          })),
          connectAccountsRemoving: [...removing],
        }),
      ),
    ),
  );
}
export function accountsPendingRemoval(): ReadonlySet<string> {
  return removing;
}
export async function markConnectAccountRemoval(accountId: string): Promise<void> {
  removing.add(accountId);
  try {
    await persistKnownConnectAccounts();
  } catch (error) {
    removing.delete(accountId);
    throw error;
  }
  notifyConnectAccountRemoval();
}
export async function cancelConnectAccountRemoval(accountId: string): Promise<void> {
  removing.delete(accountId);
  await persistKnownConnectAccounts();
}
export async function forgetConnectAccount(accountId: string): Promise<void> {
  const next = appAtomRegistry
    .get(knownConnectAccountsAtom)
    .filter((account) => account.accountId !== accountId);
  await runtime.runPromise(
    MobilePreferencesStore.pipe(
      Effect.flatMap((store) =>
        store.savePatch({
          connectAccounts: next.map(({ accountId, email, label, preset }) => ({
            accountId,
            email,
            label,
            preset,
          })),
          connectAccountsRemoving: [...removing].filter((id) => id !== accountId),
        }),
      ),
    ),
  );
  appAtomRegistry.set(knownConnectAccountsAtom, next);
  removing.delete(accountId);
}

export function notifyConnectAccountRemoval(): void {
  appAtomRegistry.set(
    connectAccountRemovalRevisionAtom,
    appAtomRegistry.get(connectAccountRemovalRevisionAtom) + 1,
  );
}
