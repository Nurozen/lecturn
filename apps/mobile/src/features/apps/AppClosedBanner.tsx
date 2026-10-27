import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import { Linking, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useAppEmbedContext } from "../../state/apps";
import { useProject } from "../../state/entities";
import { appClosedBannerState } from "./apps-tab-state";

/**
 * The app runs on the server's machine, so its link opens on this device only when the app is
 * installed here too; otherwise say where to open it.
 */
export async function openConnectedApp(input: {
  readonly url: string;
  readonly appName: string;
}): Promise<void> {
  try {
    await Linking.openURL(input.url);
  } catch {
    Dialog.alert(
      `Open ${input.appName} on its computer`,
      `${input.appName} is not installed on this device. Open it on the computer running Lecturn to bring back its live tools.`,
    );
  }
}

/** Shown on an app thread whose app holds no live lease: its live tools cannot run. */
export function AppClosedBanner(props: { readonly thread: EnvironmentThreadShell }) {
  const projectRef = {
    environmentId: props.thread.environmentId,
    projectId: props.thread.projectId,
  };
  const binding = useProject(projectRef)?.appBinding;
  const context = useAppEmbedContext(binding === undefined ? null : projectRef);
  const banner = appClosedBannerState({ context, binding, threadId: props.thread.id });
  if (banner === null || context === null) return null;
  const { openUrl } = banner;
  return (
    <View className="mx-4 mb-3 flex-row items-center gap-3 rounded-2xl border border-warning-border bg-warning px-3.5 py-3">
      <SymbolView name="cable.connector" size={16} tintColorClassName="accent-warning-foreground" />
      <AppText className="min-w-0 flex-1 text-sm font-lecturn-medium text-warning-foreground">
        {banner.title}
      </AppText>
      {openUrl !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={banner.openLabel}
          hitSlop={8}
          onPress={() => void openConnectedApp({ url: openUrl, appName: context.name })}
          // Capped so the title keeps room; a long app name ellipsizes at the label's tail.
          className="max-w-[50%] shrink flex-row items-center gap-1"
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <AppText
            className="shrink text-sm font-lecturn-medium text-warning-foreground"
            numberOfLines={1}
          >
            {banner.openLabel}
          </AppText>
          <SymbolView
            name="arrow.up.right.square"
            size={14}
            tintColorClassName="accent-warning-foreground"
          />
        </Pressable>
      ) : null}
    </View>
  );
}
