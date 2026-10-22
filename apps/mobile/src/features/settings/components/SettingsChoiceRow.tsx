import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { themeColorWithAlpha } from "../../../lib/mobileTheme";
import { useGlassPalette } from "../../../lib/useGlassPalette";

export function SettingsChoiceRow(props: {
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const glass = useGlassPalette();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={
        props.separated
          ? "flex-row items-center gap-4 border-t border-border-subtle p-4"
          : "flex-row items-center gap-4 p-4"
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
        <Text className="text-sm leading-normal text-foreground-muted">{props.description}</Text>
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={18}
          tintColor={glass.accent}
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}
