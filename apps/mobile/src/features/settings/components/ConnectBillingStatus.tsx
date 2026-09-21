import { ActivityIndicator, Pressable, View } from "react-native";
import { connectBillingSummary } from "./connectBillingSummary";
import { AppText as Text } from "../../../components/AppText";
import { useConnectBillingStatus } from "./useConnectBillingStatus";

/** Native companion status only: no purchase prompts, prices or external billing links. */
export function ConnectBillingStatus(props: { readonly accountId?: string | null } = {}) {
  const { signedIn, status, loading, refresh } = useConnectBillingStatus(props.accountId);
  if (!signedIn) return null;
  const summary = status ? connectBillingSummary(status) : null;
  return (
    <View className="gap-2 px-2 py-2">
      <Text className="text-sm font-medium text-foreground">Personal Connect subscription</Text>
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
            onPress={refresh}
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
