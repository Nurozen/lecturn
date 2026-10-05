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
import {
  pendingLiveActivityResponses,
  liveActivityLinkRevision,
  acknowledgeLiveActivityResponse,
  subscribeLiveActivityLinks,
} from "./activityLinking";

export function useAgentNotificationNavigation(): void {
  const linkTo = useLinkTo();
  const navigation = useNavigation();
  const accountsReady = useAtomValue(connectAccountsReadyAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const accounts = useAtomValue(knownConnectAccountsAtom);
  const handledResponseIds = useRef(new Set<string>());
  const pendingResponses = useRef(new Set<unknown>());
  const requestedSignIns = useRef(new Set<string>());
  const initialResponseRead = useRef(false);
  const notificationTapRevision = useRef(0);
  const observedLinkRevision = useRef(0);

  useEffect(() => {
    if (!accountsReady || !catalog.isReady) return;
    for (const account of appAtomRegistry.get(knownConnectAccountsAtom)) {
      if (account.signedIn) requestedSignIns.current.delete(account.accountId);
    }
    const handleResponse = (response: unknown, retain = true) => {
      const result = routeAgentNotificationResponseOnce({
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
          requestSignIn: (accountId: string) => {
            if (requestedSignIns.current.has(accountId)) return;
            requestedSignIns.current.add(accountId);
            navigation.navigate("SettingsSheet", {
              screen: "SettingsAddAccount",
              params: { accountId },
            });
          },
        },
      });
      if (result === "deferred" && retain) pendingResponses.current.add(response);
      else pendingResponses.current.delete(response);
      return result;
    };
    const clearSupersededResponses = () => {
      const revision = liveActivityLinkRevision();
      if (revision !== observedLinkRevision.current) {
        pendingResponses.current.clear();
        observedLinkRevision.current = revision;
      }
    };
    clearSupersededResponses();
    const hasPendingActivity = pendingLiveActivityResponses().length > 0;
    if (!hasPendingActivity) {
      for (const response of pendingResponses.current) handleResponse(response);
    }
    const drainActivityLinks = () => {
      clearSupersededResponses();
      const activityResponses = pendingLiveActivityResponses();
      if (activityResponses.length) pendingResponses.current.clear();
      for (const [id, response] of activityResponses) {
        if (handleResponse(response, false) === "handled") acknowledgeLiveActivityResponse(id);
      }
    };
    drainActivityLinks();
    const unsubscribeLinks = subscribeLiveActivityLinks(drainActivityLinks);

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      notificationTapRevision.current++;
      pendingResponses.current.clear();
      for (const [id] of pendingLiveActivityResponses()) acknowledgeLiveActivityResponse(id);
      handleResponse(response);
    });
    if (!initialResponseRead.current) {
      initialResponseRead.current = true;
      const activityRevision = liveActivityLinkRevision();
      const notificationRevision = notificationTapRevision.current;
      void consumeLastAgentNotificationResponse({
        getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
        clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
        handleResponse: (response) => {
          // A stale saved notification must not override the URL or a newer tap
          // that arrived while the native launch response was being read.
          if (
            !hasPendingActivity &&
            activityRevision === 0 &&
            activityRevision === liveActivityLinkRevision() &&
            notificationRevision === notificationTapRevision.current
          )
            handleResponse(response);
        },
      });
    }

    return () => {
      subscription.remove();
      unsubscribeLinks();
    };
  }, [accountsReady, catalog, accounts, linkTo, navigation]);
}
