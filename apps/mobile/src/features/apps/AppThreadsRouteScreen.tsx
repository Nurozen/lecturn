import type { StaticScreenProps } from "@react-navigation/native";
import { View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import { useAndroidWorkspaceBack } from "../workspace/useAndroidWorkspaceNavigation";

/** Target of `lecturn://apps/<appId>`. */
export function AppThreadsRouteScreen(props: StaticScreenProps<{ readonly appId: string }>) {
  useAndroidWorkspaceBack("apps");
  return (
    <View className="flex-1 items-center justify-center bg-screen px-10">
      <EmptyState
        title="No threads yet"
        detail={`Threads started from ${props.route.params.appId} appear here.`}
        variant="plain"
      />
    </View>
  );
}
