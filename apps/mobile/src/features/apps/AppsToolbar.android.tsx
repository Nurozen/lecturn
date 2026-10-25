import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";

/** Keeps the environment switcher and Settings reachable while the Apps tab is selected. */
export function AppsToolbar() {
  const navigation = useNavigation();
  return (
    <AndroidScreenHeader
      title="Apps"
      titleContent={
        <View className="min-w-0 flex-1 pl-3">
          <WorkspaceConnectionTitle
            grow
            brand={
              <CompactBrandTitle allowFontScaling={false} accessibilityLabel="Lecturn, Apps" />
            }
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsEnvironments" },
              })
            }
          />
        </View>
      }
      actions={[
        {
          accessibilityLabel: "Open settings",
          icon: "gearshape",
          onPress: () =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            }),
        },
      ]}
    />
  );
}
