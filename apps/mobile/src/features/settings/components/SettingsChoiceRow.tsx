import type { ComponentProps } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { ListChoiceRow } from "../../../components/ListChoiceRow";
import { themeColorWithAlpha } from "../../../lib/mobileTheme";
import { useGlassPalette } from "../../../lib/useGlassPalette";

/** Android takes the shared Material choice row; iOS keeps Lecturn's glass accent. */
export function SettingsChoiceRow(props: ComponentProps<typeof ListChoiceRow>) {
  if (Platform.OS === "android") return <ListChoiceRow {...props} />;
  return <GlassChoiceRow {...props} />;
}

function GlassChoiceRow(props: ComponentProps<typeof ListChoiceRow>) {
  const glass = useGlassPalette();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={props.label}
      accessibilityHint={props.description}
      accessibilityState={{ checked: props.selected, disabled: Boolean(props.disabled) }}
      className={
        props.separated
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3"
      }
      style={({ pressed }) => ({
        backgroundColor: pressed
          ? themeColorWithAlpha(glass.accent, glass.dark ? 0.12 : 0.07)
          : "transparent",
        opacity: props.disabled ? 0.5 : 1,
      })}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base text-foreground">{props.label}</Text>
        {props.description ? (
          <Text className="text-sm leading-normal text-foreground-muted">{props.description}</Text>
        ) : null}
      </View>
      <View className="size-6 items-center justify-center">
        {props.selected ? (
          <SymbolView
            name="checkmark"
            size={18}
            tintColor={glass.accent}
            type="monochrome"
            weight="semibold"
          />
        ) : null}
      </View>
    </Pressable>
  );
}
