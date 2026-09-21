import { ArcaneBackdrop } from "../../components/ArcaneBackdrop";
import { useAuth } from "@clerk/expo";
import { AuthView, UserProfileView } from "@clerk/expo/native";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { MobileAccountProfile } from "./MobileAccountProfile";
import { SettingsAddAccountAuthContent } from "./SettingsAddAccountRouteScreen";
import { AppText } from "../../components/AppText";
import { connectMultiAccount, hasCloudPublicConfig } from "../cloud/publicConfig";

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
    connectMultiAccount ? (
      props.route.params?.accountId ? (
        <MobileAccountProfile accountId={props.route.params.accountId} />
      ) : (
        <SettingsAddAccountAuthContent />
      )
    ) : (
      <ConfiguredSettingsAuthRouteScreen />
    )
  ) : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const handleHostBack = useCallback(
    () => navigation.dispatch(StackActions.popTo("SettingsContent")),
    [navigation],
  );
  const hasBeenSignedIn = useRef(isSignedIn);
  if (isSignedIn) {
    hasBeenSignedIn.current = true;
  }

  useEffect(() => {
    if (hasBeenSignedIn.current && isLoaded && isSignedIn === false) {
      navigation.dispatch(StackActions.popTo("SettingsContent"));
    }
  }, [isLoaded, isSignedIn, navigation]);

  return (
    <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
      <ArcaneBackdrop emphasis="sidebar" />
      {isLoaded ? (
        hasBeenSignedIn.current ? (
          <UserProfileView isDismissible={false} onHostBack={handleHostBack} />
        ) : (
          <>
            <SafeAreaView edges={["top"]}>
              <View className="border-b border-border px-5 py-3">
                <AppText className="text-center text-sm text-muted-foreground">
                  Can't find your verification email? Be sure to check your spam or junk folder for
                  an email from Lecturn.
                </AppText>
              </View>
            </SafeAreaView>
            <AuthView isDismissible={false} onHostBack={handleHostBack} />
          </>
        )
      ) : null}
    </View>
  );
}
