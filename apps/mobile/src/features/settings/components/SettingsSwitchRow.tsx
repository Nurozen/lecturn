import type { ComponentProps } from "react";
import { View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { ThemedSwitch } from "../../../components/ThemedSwitch";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function SettingsSwitchRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly subtitle?: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View
      className={
        props.disabled
          ? "min-h-14 flex-row items-center gap-3 px-4 py-3 opacity-[0.45]"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3"
      }
    >
      <View className="h-8 w-8 items-center justify-center rounded-full border border-border-subtle bg-glass-surface">
        <SymbolView
          name={props.icon}
          size={18}
          tintColorClassName={"accent-primary"}
          type="monochrome"
          weight="regular"
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-base text-foreground">{props.label}</Text>
        {props.subtitle ? (
          <Text className="text-sm text-foreground-muted">{props.subtitle}</Text>
        ) : null}
      </View>
      <ThemedSwitch
        accessibilityLabel={props.label}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}
