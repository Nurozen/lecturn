import { useMemo } from "react";
import { View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { AppsScreen } from "../apps/AppsScreen";
import { AppsToolbar } from "../apps/AppsToolbar.android";
import { PullRequestToolbar } from "../pull-requests/PullRequestToolbar.android";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceNavigation } from "./AndroidWorkspaceNavigation";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";

export function WorkspaceRootScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const context = useMemo(
    () => ({
      ...workspace,
      bottomClearance: workspace.state.selectedTab === "threads" ? fabClearance + 16 : 16,
    }),
    [workspace, fabClearance],
  );

  if (layout.usesSplitView) {
    return workspace.state.selectedTab === "threads" ? (
      <HomeRouteScreen />
    ) : workspace.state.selectedTab === "apps" ? (
      <>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title="Apps" />
        <View className="flex-1 items-center justify-center px-10">
          <EmptyState
            title="Select an app"
            detail="Choose an app from the sidebar to see its threads."
            variant="plain"
          />
        </View>
      </>
    ) : (
      <>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title="Pull requests" />
        <View className="flex-1 items-center justify-center px-10">
          <EmptyState
            title="Select a pull request"
            detail="Choose a pull request from the sidebar to review it."
            variant="plain"
          />
        </View>
      </>
    );
  }

  return (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-header">
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <SafeAreaInsetsContext value={{ ...insets, bottom: 0 }}>
          <View className="flex-1">
            {workspace.state.selectedTab === "threads" ? (
              <HomeRouteScreen />
            ) : workspace.state.selectedTab === "apps" ? (
              <>
                <AppsToolbar />
                <ScreenContent>
                  <AppsScreen />
                </ScreenContent>
              </>
            ) : (
              <>
                <PullRequestToolbar />
                <ScreenContent>
                  <PullRequestsScreen />
                </ScreenContent>
              </>
            )}
          </View>
        </SafeAreaInsetsContext>
        <AndroidWorkspaceNavigation />
      </View>
    </WorkspaceTabsContext>
  );
}
