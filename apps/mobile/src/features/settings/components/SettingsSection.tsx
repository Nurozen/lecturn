import { GlassCard } from "../../../components/GlassCard";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

export function SettingsSection(props: { readonly title?: string; readonly children: ReactNode }) {
  return (
    <View className="gap-2">
      {props.title ? (
        <Text className="px-2 text-sm font-lecturn-medium text-foreground-muted">
          {props.title}
        </Text>
      ) : null}
      <GlassCard radius={24} className="overflow-hidden">
        {props.children}
      </GlassCard>
    </View>
  );
}
