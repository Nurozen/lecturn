import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useWorkspaceListNavigation } from "../workspace/useAndroidWorkspaceNavigation";

/**
 * Keeps the environment switcher and Settings reachable while the Apps tab is selected. The
 * split-view sidebar has no navigation bar, so there it also switches to the other lists.
 */
export function AppsToolbar(props: { readonly sidebar?: boolean }) {
  const navigation = useNavigation();
  const showThreads = useWorkspaceListNavigation("threads");
  const showPullRequests = useWorkspaceListNavigation("pullRequests");
  return (
    <AndroidScreenHeader
      title="Apps"
      titleContent={
        <View className="min-w-0 flex-1 pl-3">
          <WorkspaceConnectionTitle
            grow
            brand={
              <CompactBrandTitle allowFontScaling={false} accessibilityLabel="Lecturn, Apps" fit />
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
        ...(props.sidebar
          ? [
              {
                accessibilityLabel: "Show threads",
                icon: "text.bubble",
                onPress: showThreads,
              } as const,
              {
                accessibilityLabel: "Show pull requests",
                icon: PullRequestGlyph.pullRequest,
                onPress: showPullRequests,
              } as const,
            ]
          : []),
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
