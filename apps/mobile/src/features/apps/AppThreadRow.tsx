import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { GlassCard } from "../../components/GlassCard";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { relativeTime } from "../../lib/time";
import { useGlassPalette } from "../../lib/useGlassPalette";
import { ThreadStatusBadge } from "../threads/thread-list-v2-items";
import type { ThreadRowProviderInstance } from "../threads/thread-provider-instance";
import { resolveThreadStatusBadge } from "../threads/thread-status-badge";
import { appThreadSubtitle, isAppThreadBusy } from "./apps-tab-state";

export const AppThreadRow = memo(function AppThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly providerInstance: ThreadRowProviderInstance | null;
  readonly selected?: boolean;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { thread } = props;
  const { accent } = useGlassPalette();
  const busy = isAppThreadBusy(thread);
  const subtitle = appThreadSubtitle(thread);
  // The thread list's badge, so a thread waiting on approval reads apart from a working one.
  const badge = resolveThreadStatusBadge(thread);
  const age = relativeTime(thread.latestUserMessageAt ?? thread.updatedAt);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[thread.title, badge?.label, subtitle, age].filter(Boolean).join(", ")}
      accessibilityState={{ selected: props.selected === true }}
      onPress={() => props.onSelectThread(thread)}
      className="py-1"
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <GlassCard radius={18} className="min-h-[60px] flex-row items-center gap-3 px-4 py-2.5">
        <View className="h-8 w-8 items-center justify-center" accessible={false}>
          {busy ? (
            <View
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: accent, boxShadow: `0 0 6px ${accent}` }}
            />
          ) : (
            <SymbolView name="doc.text" size={20} tintColorClassName="accent-icon-muted" />
          )}
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <AppText className="font-lecturn-medium text-base text-foreground" numberOfLines={1}>
            {thread.title}
          </AppText>
          {subtitle !== null ? (
            <AppText className="text-sm text-foreground-muted" numberOfLines={1}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
        <View className="flex-row items-center gap-2.5" accessible={false}>
          {props.providerInstance !== null ? (
            <View style={{ opacity: 0.7 }}>
              <ProviderIcon provider={props.providerInstance.driverKind} size={18} />
            </View>
          ) : null}
          {badge !== undefined ? (
            <ThreadStatusBadge label={badge} />
          ) : (
            <AppText className="text-sm text-foreground-muted">{age}</AppText>
          )}
        </View>
      </GlassCard>
    </Pressable>
  );
});
