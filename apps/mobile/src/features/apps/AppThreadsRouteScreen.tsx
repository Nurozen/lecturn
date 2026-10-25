import { AppId } from "@lecturn/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import * as Schema from "effect/Schema";
import { View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import { useAndroidWorkspaceBack } from "../workspace/useAndroidWorkspaceNavigation";
import { AppThreadsScreen } from "./AppThreadsScreen";

const isAppId = Schema.is(AppId);

/** Target of `lecturn://apps/<appId>`. */
export function AppThreadsRouteScreen(props: StaticScreenProps<{ readonly appId: string }>) {
  useAndroidWorkspaceBack("apps");
  const { appId } = props.route.params;
  if (!isAppId(appId)) {
    return (
      <View className="flex-1 items-center justify-center bg-screen px-10">
        <EmptyState title="App not found" detail={`${appId} is not an app id.`} variant="plain" />
      </View>
    );
  }
  return <AppThreadsScreen appId={appId} />;
}
