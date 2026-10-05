import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { environmentCatalog } from "../../connection/catalog";
import { connectAccountsReadyAtom, useConnectAccounts } from "../cloud/knownAccounts";
import { expandMobileAccountSection } from "../home/accountSectionExpansion";
import { resolveThreadAccountRoute } from "../threads/threadAccountRoute";

/** Keep stale Live Activity links outside the watch controls and their subscriptions. */
export function PullRequestWatchAccountGuard(props: {
  readonly environmentId: string;
  readonly accountId?: string;
  readonly children: ReactNode;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const accountsReady = useAtomValue(connectAccountsReadyAtom);
  const accounts = useConnectAccounts();
  const navigation = useNavigation();
  const target = [...catalog.entries.values()].find(
    (entry) => entry.target.environmentId === props.environmentId,
  )?.target;
  const decision = resolveThreadAccountRoute({
    catalogReady: catalog.isReady,
    accountsReady,
    target,
    requestedAccountId: props.accountId,
    accounts,
  });
  const owner = decision.kind === "ready" ? decision.accountId : null;
  useEffect(() => {
    if (owner) expandMobileAccountSection(owner);
  }, [owner]);
  if (decision.kind === "loading")
    return <LoadingScreen message="Opening pull request watch…" messagePlacement="above-spinner" />;
  if (decision.kind === "ready") return props.children;
  return (
    <View className="flex-1 justify-center bg-screen p-5">
      {decision.kind === "sign-in" ? (
        <EmptyState
          title="Sign in again"
          detail="Sign in to this pull request watch's Connect account to continue."
          actionLabel="Sign in again"
          onAction={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsAddAccount",
              params: { accountId: decision.accountId },
            })
          }
        />
      ) : (
        <EmptyState
          title="Pull request watch unavailable"
          detail="This link no longer belongs to an account connected to this environment."
        />
      )}
    </View>
  );
}
