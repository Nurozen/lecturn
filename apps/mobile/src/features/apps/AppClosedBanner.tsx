import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { useAppEmbedContext } from "../../state/apps";
import { useProject } from "../../state/entities";
import { appClosedBannerState } from "./apps-tab-state";

/** Shown on an app thread whose app holds no live lease: its live tools cannot run. */
export function AppClosedBanner(props: { readonly thread: EnvironmentThreadShell }) {
  const projectRef = {
    environmentId: props.thread.environmentId,
    projectId: props.thread.projectId,
  };
  const binding = useProject(projectRef)?.appBinding;
  const context = useAppEmbedContext(binding === undefined ? null : projectRef);
  const banner = appClosedBannerState({ context, binding });
  if (banner === null) return null;
  return (
    <View className="mx-4 mb-3 flex-row items-center gap-3 rounded-2xl border border-warning-border bg-warning px-3.5 py-3">
      <SymbolView name="cable.connector" size={16} tintColorClassName="accent-warning-foreground" />
      <AppText className="min-w-0 flex-1 text-sm font-lecturn-medium text-warning-foreground">
        {banner.title}
      </AppText>
    </View>
  );
}
