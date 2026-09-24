import { useAuth, useClerk } from "@clerk/expo";
import { UserProfileView } from "@clerk/expo/native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import {
  mobileProfileOwnerMatches,
  selectMobileProfileAccount,
} from "./mobileAccountProfile.logic";

export function MobileAccountProfile({ accountId }: { readonly accountId: string }) {
  const clerk = useClerk();
  const { isLoaded, userId } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const [selection, setSelection] = useState<{
    readonly accountId: string;
    readonly error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    void selectMobileProfileAccount(clerk, accountId).then(
      () => {
        if (!cancelled) setSelection({ accountId, error: null });
      },
      (error: unknown) => {
        if (!cancelled)
          setSelection({
            accountId,
            error: error instanceof Error ? error.message : "Could not open this account.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [clerk, accountId, isLoaded]);
  const close = useCallback(
    () => navigation.dispatch(StackActions.popTo("SettingsContent")),
    [navigation],
  );
  if (!isLoaded || selection?.accountId !== accountId)
    return <LoadingScreen message="Opening account…" messagePlacement="above-spinner" />;
  if (selection.error || !mobileProfileOwnerMatches(accountId, userId, clerk.session?.user?.id))
    return (
      <View className="flex-1 justify-center bg-sheet p-5">
        <EmptyState
          title="Account unavailable"
          detail={
            selection.error ??
            "The selected account is no longer active. Reopen it from Settings to continue."
          }
          actionLabel="Back to settings"
          onAction={close}
        />
      </View>
    );
  return (
    <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
      <UserProfileView key={accountId} isDismissible={false} onHostBack={close} />
    </View>
  );
}
