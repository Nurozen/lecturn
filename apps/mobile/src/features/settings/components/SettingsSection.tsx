import { GlassCard } from "../../../components/GlassCard";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

export function SettingsSection(props: {
  readonly title?: string;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      {props.title ? (
        <View className="flex-row items-center justify-between gap-3">
          <Text
            className={
              Platform.OS === "android"
                ? "px-4 text-sm font-lecturn-medium text-primary"
                : "px-2 text-sm font-lecturn-medium text-foreground-muted"
            }
          >
            {props.title}
          </Text>
          {props.trailing}
        </View>
      ) : null}
      <GlassCard radius={Platform.OS === "android" ? 28 : 24} className="overflow-hidden">
        {props.children}
      </GlassCard>
    </View>
  );
}
