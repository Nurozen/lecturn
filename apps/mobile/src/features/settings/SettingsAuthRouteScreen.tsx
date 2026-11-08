import type { UserProfileCustomPage } from "@clerk/expo/native-components";
import type { StaticScreenProps } from "@react-navigation/native";

import { MobileAccountProfile } from "./MobileAccountProfile";
import { SettingsAddAccountAuthContent } from "./SettingsAddAccountRouteScreen";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { LecturnConnectProfilePage } from "../cloud/LecturnConnectProfilePage";

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

// Without cloud config the app has no entry point here and appLinking drops the deep link.
export function SettingsAuthRouteScreen(
  props: StaticScreenProps<{ accountId?: string } | undefined>,
) {
  const accountId = props.route.params?.accountId;
  const customPages = accountId ? userProfileCustomPages(accountId) : undefined;

  return hasCloudPublicConfig() ? (
    accountId ? (
      <MobileAccountProfile accountId={accountId} {...(customPages ? { customPages } : {})} />
    ) : (
      <SettingsAddAccountAuthContent />
    )
  ) : null;
}
