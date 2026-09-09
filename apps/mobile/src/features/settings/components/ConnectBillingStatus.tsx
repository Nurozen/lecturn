import { useAuth } from "@clerk/expo";
import { useFocusEffect } from "@react-navigation/native";
import { createBillingClient } from "@t3tools/client-runtime/relay";
import type { RelayBillingStatus } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { AppText as Text } from "../../../components/AppText";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";

/** Native companion status only: no purchase prompts, prices or external billing links. */
export function ConnectBillingStatus() {
  const { getToken, userId, isSignedIn } = useAuth();
  const [result, setResult] = useState<{
    accountId: string;
    status: RelayBillingStatus | null;
  } | null>(null);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (isSignedIn && userId) {
        const client = createBillingClient({
          relayUrl: resolveCloudPublicConfig().relay.url ?? "",
          getToken: () => getToken(resolveRelayClerkTokenOptions()),
        });
        void client.getStatus().then(
          (status) => {
            if (!cancelled) setResult({ accountId: userId, status });
          },
          () => {
            if (!cancelled) setResult({ accountId: userId, status: null });
          },
        );
      }
      return () => {
        cancelled = true;
      };
    }, [getToken, isSignedIn, userId]),
  );
  if (!isSignedIn || !userId) return null;
  const current = result?.accountId === userId ? result : null;
  const status = current?.status;
  const label = !current
    ? "Checking Connect subscription…"
    : !status || status.state === "unavailable"
      ? "Connect subscription status unavailable"
      : status.state === "disabled"
        ? "Connect subscription billing is not enabled"
        : status.accessReason === "suspended"
          ? "Connect access suspended for payment review"
          : status.hasAccess
            ? "Connect access active"
            : "Connect access is not active";
  return (
    <Text className="px-2 text-sm text-foreground-muted" accessibilityLiveRegion="polite">
      {label}
    </Text>
  );
}
