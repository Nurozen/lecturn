import { Platform, ScrollView, View, type ScrollViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollViewMarker } from "react-native-screens";

import { ArcaneBackdrop } from "../../components/ArcaneBackdrop";
import { cn } from "../../lib/cn";
import { useDebouncedValue } from "../../state/queries";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { AppsTree } from "./AppThreadsScreen";

function AppsScrollView(props: ScrollViewProps) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollViewMarker style={{ flex: 1 }}>
      <ScrollView
        {...props}
        // Transparent so the backdrop drawn once behind the list shows through.
        className={cn(props.className, "bg-transparent")}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentOffset={props.contentOffset ?? { x: 0, y: -insets.top }}
      />
    </ScrollViewMarker>
  );
}

/** The Apps workspace tab: every connected app with its workspaces and threads. */
export function AppsScreen() {
  const workspace = useWorkspaceTabs();
  const insets = useSafeAreaInsets();
  const tab = workspace?.state.tabs.apps;
  const debouncedQuery = useDebouncedValue(tab?.query.trim() ?? "", 180);
  const query = tab === undefined || tab.searchMode === "resting" ? "" : debouncedQuery;
  const ios = Platform.OS === "ios";
  return (
    <View className="flex-1 bg-screen">
      <ArcaneBackdrop emphasis="sidebar" />
      <AppsTree
        searchQuery={query}
        contentBottomInset={Math.max(insets.bottom, workspace?.bottomClearance ?? 0) + 16}
        renderScrollComponent={ios ? AppsScrollView : undefined}
        contentTopInset={ios ? insets.top : 0}
        onScrollOffset={
          workspace === null ? undefined : (offset) => workspace.recordScrollOffset("apps", offset)
        }
      />
    </View>
  );
}
