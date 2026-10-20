import type { UserProfileCustomPage } from "@clerk/expo/native";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useLayoutEffect, useMemo } from "react";

import { MobileAccountProfile } from "./MobileAccountProfile";
import { SettingsAddAccountAuthContent } from "./SettingsAddAccountRouteScreen";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { LecturnConnectProfilePage } from "../cloud/LecturnConnectProfilePage";

// Custom rows in Clerk's native profile. Mirrors the web UserButton pages.
function userProfileCustomPages(accountId: string): UserProfileCustomPage[] {
  return [
    {
      path: "lecturn-connect",
      label: "Lecturn Connect",
      icon: "globe",
      content: <LecturnConnectProfilePage accountId={accountId} />,
    },
  ];
}

export function SettingsAuthRouteScreen(
  props: StaticScreenProps<{ accountId?: string } | undefined>,
) {
  const navigation = useNavigation();
  const accountId = props.route.params?.accountId;
  const customPages = useMemo(
    () => (accountId ? userProfileCustomPages(accountId) : undefined),
    [accountId],
  );

  useLayoutEffect(() => {
    if (!hasCloudPublicConfig()) {
      navigation.dispatch(StackActions.replace("SettingsContent"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? (
    accountId ? (
      <MobileAccountProfile accountId={accountId} {...(customPages ? { customPages } : {})} />
    ) : (
      <SettingsAddAccountAuthContent />
    )
  ) : null;
}
