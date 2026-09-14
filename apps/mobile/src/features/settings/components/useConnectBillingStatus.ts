import { useAuth } from "@clerk/expo";
import { useFocusEffect } from "@react-navigation/native";
import { createBillingClient } from "@lecturn/client-runtime/relay";
import type { RelayBillingStatus } from "@lecturn/contracts";
import { useCallback, useState } from "react";
import { AppState } from "react-native";
import { resolveCloudPublicConfig } from "../../cloud/publicConfig";

import { useSessionRelayToken } from "../../cloud/useSessionRelayToken";

export function useConnectBillingStatus() {
  const { getToken, userId, sessionId, isSignedIn } = useAuth();
  const getRelayToken = useSessionRelayToken({ userId, sessionId, isSignedIn, getToken });
  const [refreshKey, setRefreshKey] = useState(0);
  const [result, setResult] = useState<{
    accountId: string;
    status: RelayBillingStatus | null;
    loading: boolean;
    refreshKey: number;
  } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!isSignedIn || !userId) return;
      let generation = 0;
      let disposed = false;
      const refresh = () => {
        const requestGeneration = ++generation;
        setResult({ accountId: userId, status: null, loading: true, refreshKey });
        const client = createBillingClient({
          relayUrl: resolveCloudPublicConfig().relay.url ?? "",
          getToken: getRelayToken,
        });
        const settle = (status: RelayBillingStatus | null) => {
          if (!disposed && requestGeneration === generation)
            setResult({ accountId: userId, status, loading: false, refreshKey });
        };
        void client.getStatus().then(settle, () => settle(null));
      };
      let appState = AppState.currentState;
      if (appState !== "background" && appState !== "inactive") refresh();
      const subscription = AppState.addEventListener("change", (nextState) => {
        if (nextState === "active" && appState !== "active") refresh();
        else if (nextState !== "active") ++generation;
        appState = nextState;
      });
      return () => {
        disposed = true;
        subscription.remove();
      };
    }, [getRelayToken, isSignedIn, userId, refreshKey]),
  );
  const current =
    result && result.accountId === userId && result.refreshKey === refreshKey ? result : null;
  return {
    signedIn: Boolean(isSignedIn && userId),
    status: current?.status ?? null,
    loading: !current || current.loading,
    refresh: () => setRefreshKey((value) => value + 1),
  };
}
