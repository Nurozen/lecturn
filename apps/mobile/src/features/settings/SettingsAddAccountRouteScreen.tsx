import { useClerk } from "@clerk/expo";
import { AuthView } from "@clerk/expo/native";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { useConnectAccounts } from "../cloud/knownAccounts";
import { signOutMobileConnectAccount } from "../cloud/mobileAccountSignOut";
import { useAddConnectAccountGate } from "../cloud/useAddConnectAccountGate";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { AppText } from "../../components/AppText";

export function SettingsAddAccountRouteScreen(props: StaticScreenProps<{ accountId?: string }>) {
  const navigation = useNavigation();
  useEffect(() => {
    if (!hasCloudPublicConfig()) navigation.dispatch(StackActions.popTo("SettingsContent"));
  }, [navigation]);
  return hasCloudPublicConfig() ? (
    <SettingsAddAccountAuthContent expectedAccountId={props.route.params?.accountId} />
  ) : null;
}
export function SettingsAddAccountAuthContent({
  expectedAccountId,
}: {
  readonly expectedAccountId?: string;
}) {
  const accounts = useConnectAccounts();
  const clerk = useClerk();
  const gate = useAddConnectAccountGate();
  const navigation = useNavigation();
  const [entry, setEntry] = useState<{
    readonly accountIds: ReadonlyArray<string>;
    readonly canAddDifferent: boolean;
  } | null>(null);
  if (
    entry === null &&
    (gate.available ||
      (!!expectedAccountId &&
        accounts.some((account) => account.accountId === expectedAccountId && !account.signedIn)))
  ) {
    setEntry({
      accountIds: accounts.map((account) => account.accountId),
      canAddDifferent: gate.available,
    });
  }
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || entry === null) return;
    const added = accounts.find(
      (account) => account.signedIn && !entry.accountIds.includes(account.accountId),
    );
    const restored =
      expectedAccountId &&
      accounts.some((account) => account.accountId === expectedAccountId && account.signedIn);
    if (!added && !restored) return;
    settled.current = true;
    if (
      added &&
      expectedAccountId &&
      added.accountId !== expectedAccountId &&
      !entry.canAddDifferent
    ) {
      void signOutMobileConnectAccount(clerk, added.accountId).catch((error) =>
        console.error("Could not reject unexpected account", error),
      );
      Alert.alert("Account not added", "Sign in with the account you selected.");
    }
    navigation.dispatch(StackActions.popTo("SettingsContent"));
  }, [accounts, clerk, expectedAccountId, entry, navigation]);
  return (
    <View className="flex-1 bg-sheet">
      {entry !== null ? (
        <AuthView
          isDismissible={false}
          onHostBack={() => navigation.dispatch(StackActions.popTo("SettingsContent"))}
        />
      ) : (
        <AppText className="p-5 text-foreground">
          {gate.reason ?? "Adding an account is unavailable."}
        </AppText>
      )}
    </View>
  );
}
