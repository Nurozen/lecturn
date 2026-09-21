import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useLayoutEffect } from "react";

import { MobileAccountProfile } from "./MobileAccountProfile";
import { SettingsAddAccountAuthContent } from "./SettingsAddAccountRouteScreen";
import { hasCloudPublicConfig } from "../cloud/publicConfig";

export function SettingsAuthRouteScreen(
  props: StaticScreenProps<{ accountId?: string } | undefined>,
) {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    if (!hasCloudPublicConfig()) {
      navigation.dispatch(StackActions.replace("SettingsContent"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? (
    props.route.params?.accountId ? (
      <MobileAccountProfile accountId={props.route.params.accountId} />
    ) : (
      <SettingsAddAccountAuthContent />
    )
  ) : null;
}
