import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { knownConnectAccountsAtom } from "../../cloud/knownAccounts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { addAccountBlockedReason } from "./ConnectAccountMenu.logic";
import { connectAccountCommandsAtom } from "./connectAccountCommands";
import { useConnectSignIn } from "./useConnectSignIn";
import { useConnectSignOut } from "./useConnectSignOut";

/** Runs the palette's account actions, and owns the dialogs they open. */
export function ConnectAccountCommandsHost() {
  const signIn = useConnectSignIn();
  const signOut = useConnectSignOut();
  const known = useAtomValue(knownConnectAccountsAtom);
  const blocked = addAccountBlockedReason({
    gate: signIn.gate,
    knownAccountCount: known.accountIds.length,
  });
  const latest = useRef({ signIn, signOut });
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- publishes the committed sign-in and sign-out hooks to a ref read by the registered account commands
  useEffect(() => {
    latest.current = { signIn, signOut };
  });
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- registers the account commands in the app atom registry while mounted and clears them on unmount
  useEffect(() => {
    appAtomRegistry.set(connectAccountCommandsAtom, {
      addAccountBlockedReason: blocked,
      addAccount: () => latest.current.signIn.addAccount(),
      signOut: (accountId) => latest.current.signOut.requestSignOutAccount(accountId),
      signOutAll: () => latest.current.signOut.requestSignOutAll(),
    });
    return () => appAtomRegistry.set(connectAccountCommandsAtom, null);
  }, [blocked]);
  return (
    <>
      {signOut.signOutDialog}
      {signIn.authPrompt}
    </>
  );
}
