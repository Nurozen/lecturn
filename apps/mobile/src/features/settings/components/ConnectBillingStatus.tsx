import { useAuth } from "@clerk/expo";
import { useFocusEffect } from "@react-navigation/native";
import { createBillingClient } from "@t3tools/client-runtime/relay";
import type { RelayBillingStatus } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { connectBillingSummary } from "./connectBillingSummary";
import { AppText as Text } from "../../../components/AppText";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";

/** Native companion status only: no purchase prompts, prices or external billing links. */
export function ConnectBillingStatus() {
  const { getToken, userId, isSignedIn } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const [result, setResult] = useState<{
    accountId: string;
    status: RelayBillingStatus | null;
    loading: boolean;
    refreshKey: number;
  } | null>(null);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (isSignedIn && userId) {
        setResult({ accountId: userId, status: null, loading: true, refreshKey });
        const client = createBillingClient({
          relayUrl: resolveCloudPublicConfig().relay.url ?? "",
          getToken: () => getToken(resolveRelayClerkTokenOptions()),
        });
        void client.getStatus().then(
          (status) => {
            if (!cancelled) setResult({ accountId: userId, status, loading: false, refreshKey });
          },
          () => {
            if (!cancelled)
              setResult({ accountId: userId, status: null, loading: false, refreshKey });
          },
        );
      }
      return () => {
        cancelled = true;
      };
    }, [getToken, isSignedIn, userId, refreshKey]),
  );
  if (!isSignedIn || !userId) return null;
  const current = result?.accountId === userId && result.refreshKey === refreshKey ? result : null;
  const status = current?.status;
  const loading = !current || current.loading;
  const summary = status ? connectBillingSummary(status) : null;
  return (
    <View className="gap-2 px-2 py-2">
      <View className="flex-row items-center justify-between gap-3">
        <Text
          className="flex-1 text-sm font-medium text-foreground"
          accessibilityLiveRegion="polite"
        >
          {loading
            ? "Checking Connect access…"
            : (summary?.label ?? "Could not check Connect access")}
        </Text>
        {loading ? (
          <ActivityIndicator size="small" accessibilityLabel="Checking Connect access" />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh Connect access status"
            className="min-h-11 justify-center px-2"
            onPress={() => setRefreshKey((value) => value + 1)}
          >
            <Text className="text-sm text-foreground">Refresh</Text>
          </Pressable>
        )}
      </View>
      {!loading && !status && (
        <Text className="text-sm text-foreground-muted">Check your connection and try again.</Text>
      )}
      {!loading &&
        summary &&
        [summary.quota, summary.expiry, summary.features].filter(Boolean).map((line) => (
          <Text key={line} className="text-sm text-foreground-muted">
            {line}
          </Text>
        ))}
      <Text className="text-sm text-foreground-muted">Direct connections remain free.</Text>
    </View>
  );
}
