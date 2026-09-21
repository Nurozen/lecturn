import { useAtomValue } from "@effect/atom-react";

import { accountEmailWhenSeveral, connectAccountProfilesAtom } from "./connectAccounts";
import { knownConnectAccountsAtom } from "./knownAccounts";
import { connectMultiAccount } from "./publicConfig";

/** The email a surface names its account by once two or more accounts are known, else null. */
export function useAccountEmailWhenSeveral(accountId: string | null | undefined): string | null {
  return accountEmailWhenSeveral({
    multiAccountEnabled: connectMultiAccount,
    knownAccountIds: useAtomValue(knownConnectAccountsAtom).accountIds,
    profiles: useAtomValue(connectAccountProfilesAtom),
    accountId,
  });
}
