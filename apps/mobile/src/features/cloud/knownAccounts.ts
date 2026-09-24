import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import type { MobileConnectAccount } from "./knownAccounts.logic";
export { reconcileMobileAccounts, type MobileConnectAccount } from "./knownAccounts.logic";

export const knownConnectAccountsAtom = Atom.make<ReadonlyArray<MobileConnectAccount>>([]).pipe(
  Atom.keepAlive,
);
export const connectAccountsReadyAtom = Atom.make(false).pipe(Atom.keepAlive);
export const connectAccountRemovalRevisionAtom = Atom.make(0).pipe(Atom.keepAlive);
export function useConnectAccounts(): ReadonlyArray<MobileConnectAccount> {
  return useAtomValue(knownConnectAccountsAtom);
}
