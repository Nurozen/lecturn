import * as Notifications from "expo-notifications";
import { accountOwnerTarget } from "@lecturn/client-runtime/connection";
import { relayAccountByEnvironmentId } from "@lecturn/client-runtime/relay";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { squireEnvironment } from "../../state/squire";
import { connectAccountsReadyAtom, knownConnectAccountsAtom } from "../cloud/knownAccounts";
import { expandMobileAccountSection } from "../home/accountSectionExpansion";
import { parseSquireRoutePath, squireHomeThreadPath } from "../squires/squireLinks";
import {
  acknowledgeLiveActivityResponse,
  liveActivityLinkRevision,
  pendingLiveActivityResponses,
  subscribeLiveActivityLinks,
} from "./activityLinking";
import { setAndroidThreadOnScreen } from "./androidNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

const pathnameOnScreenAtom = Atom.make("/").pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:agent-notification-pathname"),
);

// Lecturn: a Squire's pushes carry its home thread, which its Squire screen shows.
const threadOnScreenAtom = Atom.make((get): string | null => {
  const pathname = get(pathnameOnScreenAtom);
  const thread = threadDeepLinkOnScreen(pathname);
  if (thread !== null) return thread;
  const route = parseSquireRoutePath(pathname);
  if (route === null) return null;
  const config = get(serverEnvironment.configValueAtom(route.environmentId));
  if (config?.environment.capabilities.squire !== true) return null;
  const entry = get(squireEnvironment.entry(route.environmentId, route.squireId));
  const homeThreadId = entry?.squire.homeThreadId ?? null;
  return homeThreadId === null ? null : squireHomeThreadPath(route.environmentId, homeThreadId);
});

let deepLinkOnScreen: string | null = null;

/** Called with the workspace pathname on every root navigation state change. */
export function setAgentNotificationPathname(pathname: string): void {
  if (appAtomRegistry.get(pathnameOnScreenAtom) !== pathname) {
    appAtomRegistry.set(pathnameOnScreenAtom, pathname);
  }
}

/**
 * App-lifetime notification routing: foreground presentation suppresses the thread on screen,
 * and taps (cold-start too) open the deep link through `navigate`. Lecturn: taps and Live
 * Activity links wait until Connect accounts and the catalog can verify the owning account.
 */
export function installAgentNotificationNavigation(navigate: (href: string) => void): () => void {
  const handledResponseIds = new Set<string>();
  const pendingResponses = new Set<unknown>();
  const requestedSignIns = new Set<string>();
  let initialResponseRead = false;
  let notificationTapRevision = 0;
  let observedLinkRevision = 0;

  const unsubscribeThreadOnScreen = appAtomRegistry.subscribe(
    threadOnScreenAtom,
    (thread) => {
      deepLinkOnScreen = thread;
      setAndroidThreadOnScreen(thread);
    },
    { immediate: true },
  );
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(foregroundNotificationBehavior(notification, deepLinkOnScreen)),
  });

  const ownershipReady = () =>
    appAtomRegistry.get(connectAccountsReadyAtom) &&
    appAtomRegistry.get(environmentCatalog.catalogValueAtom).isReady;

  const handleResponse = (response: unknown, retain = true) => {
    const result = routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate,
      accountContext: {
        signedInAccountIds: appAtomRegistry
          .get(knownConnectAccountsAtom)
          .filter((account) => account.signedIn)
          .map((account) => account.accountId),
        accountByEnvironmentId: relayAccountByEnvironmentId(
          [...appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.values()].map(
            accountOwnerTarget,
          ),
        ),
        expandAccount: expandMobileAccountSection,
        requestSignIn: (accountId: string) => {
          if (requestedSignIns.has(accountId)) return;
          requestedSignIns.add(accountId);
          whenRootNavigationReady(() =>
            rootNavigationRef.navigate("SettingsAddAccount", { accountId }),
          );
        },
      },
    });
    if (result === "deferred" && retain) pendingResponses.add(response);
    else pendingResponses.delete(response);
    return result;
  };

  const clearSupersededResponses = () => {
    const revision = liveActivityLinkRevision();
    if (revision !== observedLinkRevision) {
      pendingResponses.clear();
      observedLinkRevision = revision;
    }
  };

  const drainActivityLinks = () => {
    if (!ownershipReady()) return;
    clearSupersededResponses();
    const activityResponses = pendingLiveActivityResponses();
    if (activityResponses.length) pendingResponses.clear();
    for (const [id, response] of activityResponses) {
      if (handleResponse(response, false) === "handled") acknowledgeLiveActivityResponse(id);
    }
  };

  const readInitialResponse = (hasPendingActivity: boolean) => {
    initialResponseRead = true;
    const activityRevision = liveActivityLinkRevision();
    const notificationRevision = notificationTapRevision;
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
          notificationRevision === notificationTapRevision
        )
          handleResponse(response);
      },
    });
  };

  // Re-runs whenever accounts or the catalog change, so deferred taps retry.
  const routePending = () => {
    if (!ownershipReady()) return;
    for (const account of appAtomRegistry.get(knownConnectAccountsAtom)) {
      if (account.signedIn) requestedSignIns.delete(account.accountId);
    }
    clearSupersededResponses();
    const hasPendingActivity = pendingLiveActivityResponses().length > 0;
    if (!hasPendingActivity) {
      for (const response of pendingResponses) handleResponse(response);
    }
    drainActivityLinks();
    if (!initialResponseRead) readInitialResponse(hasPendingActivity);
  };

  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    notificationTapRevision++;
    pendingResponses.clear();
    for (const [id] of pendingLiveActivityResponses()) acknowledgeLiveActivityResponse(id);
    if (ownershipReady()) handleResponse(response);
    else pendingResponses.add(response);
  });
  const unsubscribeLinks = subscribeLiveActivityLinks(drainActivityLinks);
  const unsubscribeOwnership = [
    appAtomRegistry.subscribe(connectAccountsReadyAtom, routePending),
    appAtomRegistry.subscribe(knownConnectAccountsAtom, routePending),
    appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, routePending),
  ];
  routePending();

  return () => {
    subscription.remove();
    unsubscribeLinks();
    for (const unsubscribe of unsubscribeOwnership) unsubscribe();
    unsubscribeThreadOnScreen();
    Notifications.setNotificationHandler(null);
  };
}
