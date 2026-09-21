import { useClerk } from "@clerk/react";

import { openConnectSignIn } from "../../cloud/singleAccountGuard";
import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "./authRedirect";

export function useLecturnConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    openConnectSignIn(clerk, resolveClerkSignInProps(window.location.href, isElectron));
  };
  return { authPrompt: null, openAuthPrompt };
}
