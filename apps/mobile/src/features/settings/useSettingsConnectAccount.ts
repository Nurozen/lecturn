import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { useConnectAccounts } from "../cloud/knownAccounts";

// The account picked on the Settings index also scopes the Notifications page,
// so the choice outlives either screen.
const pickedSettingsAccountIdAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);

/** Connect account that account-scoped settings (team, billing, Live Activities) act on. */
export function useSettingsConnectAccount() {
  const connectAccounts = useConnectAccounts();
  const pickedAccountId = useAtomValue(pickedSettingsAccountIdAtom);
  const setPickedAccountId = useAtomSet(pickedSettingsAccountIdAtom);
  const isSignedIn = connectAccounts.some((account) => account.signedIn);
  const selectedAccountId =
    pickedAccountId && connectAccounts.some((account) => account.accountId === pickedAccountId)
      ? pickedAccountId
      : (connectAccounts.find((account) => account.signedIn)?.accountId ??
        connectAccounts[0]?.accountId ??
        null);
  return { isSignedIn, selectedAccountId, setPickedAccountId };
}
