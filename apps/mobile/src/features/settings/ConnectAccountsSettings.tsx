import { useClerk } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { accountTintColor } from "@lecturn/shared/accountTint";
import { AppText as Text } from "../../components/AppText";
import { useConnectAccounts } from "../cloud/knownAccounts";
import { useAddConnectAccountGate } from "../cloud/useAddConnectAccountGate";
import { signOutMobileConnectAccount } from "../cloud/mobileAccountSignOut";
import { selectMobileProfileAccount } from "./mobileAccountProfile.logic";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsRow } from "./components/SettingsRow";

export function ConnectAccountsSettings({
  selectedAccountId,
  onSelect,
}: {
  readonly selectedAccountId: string | null;
  readonly onSelect: (accountId: string) => void;
}) {
  const accounts = useConnectAccounts();
  const gate = useAddConnectAccountGate();
  const clerk = useClerk();
  const navigation = useNavigation();
  const [busy, setBusy] = useState<string | null>(null);
  const openProfile = async (accountId: string) => {
    setBusy(accountId);
    try {
      await selectMobileProfileAccount(clerk, accountId);
      navigation.navigate("SettingsSheet", { screen: "SettingsAuth", params: { accountId } });
    } catch (error) {
      Alert.alert("Could not open account", error instanceof Error ? error.message : "Try again.");
    } finally {
      setBusy(null);
    }
  };
  const signOut = (accountId: string, label: string) =>
    Alert.alert(
      `Sign out of ${label}?`,
      "This account's connected environments will be removed from this device. Other accounts remain signed in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            setBusy(accountId);
            void signOutMobileConnectAccount(clerk, accountId)
              .then(
                ({ unregisterFailed }) => {
                  if (unregisterFailed)
                    Alert.alert(
                      "Signed out",
                      "This device could not unregister while offline. Push registration will be corrected the next time it connects.",
                    );
                },
                (error: unknown) =>
                  Alert.alert(
                    "Could not sign out",
                    error instanceof Error ? error.message : "Try again.",
                  ),
              )
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  return (
    <SettingsSection title="Connect accounts">
      {accounts.map((account) => (
        <View key={account.accountId} className="gap-1 px-4 py-3">
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selectedAccountId === account.accountId }}
            onPress={() => onSelect(account.accountId)}
            className="min-h-11 flex-row items-center gap-2"
          >
            <View
              style={{
                backgroundColor: accountTintColor(account.preset),
                width: 9,
                height: 9,
                borderRadius: 5,
              }}
            />
            <View className="flex-1">
              <Text className="font-semibold text-foreground">
                {account.label}
                {selectedAccountId === account.accountId ? " ✓" : ""}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {account.email || account.accountId}
              </Text>
            </View>
          </Pressable>
          {account.signedIn ? (
            <SettingsRow
              icon="person.crop.circle"
              label="Manage account"
              disabled={busy !== null}
              onPress={() => {
                void openProfile(account.accountId);
              }}
            />
          ) : (
            <SettingsRow
              icon="person.crop.circle"
              label="Sign in again"
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsAddAccount",
                  params: { accountId: account.accountId },
                })
              }
            />
          )}
          <Pressable
            accessibilityRole="button"
            disabled={busy !== null}
            onPress={() => signOut(account.accountId, account.label)}
            className="min-h-11 justify-center"
          >
            <Text className="text-sm text-foreground-muted">
              {busy === account.accountId ? "Signing out…" : "Sign out"}
            </Text>
          </Pressable>
        </View>
      ))}
      <SettingsRow
        icon="plus"
        label={accounts.length === 0 ? "Sign in" : "Add account"}
        disabled={!gate.available}
        onPress={() =>
          navigation.navigate("SettingsSheet", { screen: "SettingsAddAccount", params: {} })
        }
      />
      {gate.reason ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">{gate.reason}</Text>
      ) : null}
    </SettingsSection>
  );
}
