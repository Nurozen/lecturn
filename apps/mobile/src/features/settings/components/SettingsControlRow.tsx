import type { ComponentProps, ReactNode } from "react";
import { Platform, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";

export function SettingsControlRow(props: {
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}) {
  const android = Platform.OS === "android";
  return (
    <View
      className={cn(
        android
          ? "min-h-14 flex-row items-center gap-4 p-4 py-3"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3",
        android && props.subtitle && "min-h-18",
        props.disabled && "opacity-[0.45]",
      )}
    >
      {android ? (
        <SymbolView
          name={props.icon}
          size={24}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
      ) : (
        <View className="h-8 w-8 items-center justify-center rounded-full border border-border-subtle bg-glass-surface">
          <SymbolView
            name={props.icon}
            size={18}
            tintColorClassName="accent-primary"
            type="monochrome"
            weight="regular"
          />
        </View>
      )}
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base text-foreground">{props.label}</Text>
        {props.subtitle ? (
          <Text className="text-sm leading-normal text-foreground-muted">{props.subtitle}</Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}
