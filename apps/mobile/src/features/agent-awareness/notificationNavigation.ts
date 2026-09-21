import { expandMobileAccountSection } from "../home/accountSectionExpansion";
import { useAtomValue } from "@effect/atom-react";
import { relayAccountByEnvironmentId } from "@lecturn/client-runtime/relay";
import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectAccountsReadyAtom, knownConnectAccountsAtom } from "../cloud/knownAccounts";
import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useLinkTo, useNavigation } from "@react-navigation/native";

import { routeAgentNotificationResponseOnce } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

export function useAgentNotificationNavigation(): void {
  const linkTo = useLinkTo();
  const navigation = useNavigation();
  const accountsReady = useAtomValue(connectAccountsReadyAtom);
  const catalogReady = useAtomValue(environmentCatalog.catalogValueAtom).isReady;
  const handledResponseIds = useRef(new Set<string>());

  useEffect(() => {
    if (!accountsReady || !catalogReady) return;
    const handleResponse = (response: Notifications.NotificationResponse): void => {
      routeAgentNotificationResponseOnce({
        handledResponseIds: handledResponseIds.current,
        response,
        navigate: linkTo,
        accountContext: {
          signedInAccountIds: appAtomRegistry
            .get(knownConnectAccountsAtom)
            .filter((account) => account.signedIn)
            .map((account) => account.accountId),
          accountByEnvironmentId: relayAccountByEnvironmentId(
            [...appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.values()].map(
              (entry) => entry.target,
            ),
          ),
          expandAccount: expandMobileAccountSection,
          requestSignIn: (accountId: string) =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsAddAccount",
              params: { accountId },
            }),
        },
      });
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void consumeLastAgentNotificationResponse({
      getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
      clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
      handleResponse,
    });

    return () => {
      subscription.remove();
    };
  }, [accountsReady, catalogReady, linkTo, navigation]);
}
