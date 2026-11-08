import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";
import { openSettings } from "../settings/settings-navigation";

/**
 * Keeps the environment switcher reachable while the Apps tab is selected. It draws the same
 * plain row as the Chats and Pulls tabs (`WorkspaceListToolbarRow`), so switching tabs leaves
 * the title where it was; Settings and the other lists live in the navigation bar or rail.
 */
export function AppsToolbar() {
  const navigation = useNavigation();
  const { height, paddingTop, paddingBottom } = useToolbarLayout();
  return (
    <View className="bg-header px-2" style={{ paddingTop, paddingBottom }}>
      <View className="flex-row items-center gap-1" style={{ minHeight: height }}>
        <View className="min-w-0 flex-1 pl-4">
          <WorkspaceConnectionTitle
            grow
            onPress={() => openSettings(navigation, "SettingsEnvironments")}
            brand={
              <CompactBrandTitle allowFontScaling={false} accessibilityLabel="Lecturn, Apps" fit />
            }
          />
        </View>
      </View>
    </View>
  );
}
