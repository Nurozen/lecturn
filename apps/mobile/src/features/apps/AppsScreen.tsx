import { View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";

export function AppsScreen() {
  return (
    <View className="flex-1 items-center justify-center px-10">
      <EmptyState
        title="No connected apps"
        detail="Apps you connect to this environment appear here with their threads."
        variant="plain"
      />
    </View>
  );
}
