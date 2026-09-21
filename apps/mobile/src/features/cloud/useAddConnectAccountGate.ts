import { useAuth, useClerk } from "@clerk/expo";
import { useAtomValue } from "@effect/atom-react";
import { decideAddAccountGate } from "@lecturn/client-runtime/relay";
import { Platform } from "react-native";
import { environmentCatalog } from "../../connection/catalog";
import { mobileAccountAdditionAllowed } from "../settings/SettingsRouteScreen.logic";
import { useMultiAccountPushSupported } from "../agent-awareness/multiAccountCapability";
import { connectAccountsReadyAtom, useConnectAccounts } from "./knownAccounts";

export function useAddConnectAccountGate() {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const accounts = useConnectAccounts();
  const accountsReady = useAtomValue(connectAccountsReadyAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const unlisted = useAtomValue(environmentCatalog.unlistedRelayEnvironmentIdsValueAtom);
  const pushSupported = useMultiAccountPushSupported();
  const environment = (
    clerk as unknown as {
      __internal_environment?: { authConfig?: { singleSessionMode?: unknown } };
    }
  ).__internal_environment;
  const mode = environment?.authConfig?.singleSessionMode;
  const gate = decideAddAccountGate({
    clerkSingleSessionMode: isLoaded && typeof mode === "boolean" ? mode : undefined,
    targets: [...catalog.entries.values()].map((entry) => entry.target),
    unlistedRelayEnvironmentIds: unlisted,
    knownAccountCount: accounts.length,
  });
  const available = mobileAccountAdditionAllowed({
    loaded: isLoaded && accountsReady,
    accountCount: accounts.length,
    sharedGateAvailable: gate.available,
    catalogReady: catalog.isReady,
    platform: Platform.OS,
    multiAccountPush: pushSupported,
  });
  const reason = available
    ? null
    : !isLoaded || !accountsReady
      ? "Checking accounts…"
      : Platform.OS === "ios" && !pushSupported
        ? "This relay supports push for one account. Add account requires push support for every account."
        : !catalog.isReady
          ? "Checking environments…"
          : gate.available
            ? null
            : gate.reason === "account-limit"
              ? "Up to five accounts can be signed in."
              : gate.reason === "unowned-environments"
                ? "Wait for your existing environments to finish linking to their account."
                : "Adding accounts is not available for this sign-in service.";
  return { available, reason };
}
