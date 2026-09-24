import { accountTintColor } from "@lecturn/shared/accountTint";
import { appAtomRegistry } from "../../state/atom-registry";
import { knownConnectAccountsAtom } from "./knownAccounts";
import { getMultiAccountPushSupported } from "../agent-awareness/multiAccountCapability";
import {
  releaseAgentAwarenessAccounts,
  syncAgentAwarenessAccounts,
  unregisterAgentAwarenessAccount,
  setAgentAwarenessAccountAppearance,
} from "../agent-awareness/remoteRegistration";

export function syncAccountPushProviders(
  providers: ReadonlyMap<string, () => Promise<string | null>>,
  primaryAccountId: string | null,
): void {
  for (const account of appAtomRegistry.get(knownConnectAccountsAtom))
    setAgentAwarenessAccountAppearance(
      account.accountId,
      account.label,
      accountTintColor(account.preset),
    );
  syncAgentAwarenessAccounts(providers, primaryAccountId, getMultiAccountPushSupported());
}
export const releaseAccountPushProviders = releaseAgentAwarenessAccounts;
export const unregisterAccountPush = unregisterAgentAwarenessAccount;
