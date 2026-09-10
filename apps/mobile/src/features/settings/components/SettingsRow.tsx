import { useNavigation } from "@react-navigation/native";
import { useState, type ComponentProps } from "react";
import { ArcaneControlHighlight } from "../../../components/ArcaneControlHighlight";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";

import { AppText as Text } from "../../../components/AppText";
import type { SettingsLegalDocumentTarget, SettingsSheetTarget } from "./settings-sheet-targets";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly value?: string;
  readonly target?: SettingsSheetTarget;
  readonly fullScreenTarget?: SettingsLegalDocumentTarget;
  readonly onPress?: () => void;
}) {
  const navigation = useNavigation();
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const content = (
    <View
      className={
        props.disabled
          ? "flex-row items-center gap-4 p-4 opacity-[0.45]"
          : "flex-row items-center gap-4 p-4"
      }
    >
      <SymbolView
        name={props.icon}
        size={22}
        tintColorClassName={"accent-icon"}
        type="monochrome"
        weight="regular"
      />
      <Text className="shrink-0 text-lg text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
      <View className="min-w-0 flex-1 items-end">
        {props.value ? (
          <Text
            className="max-w-[180px] text-right text-base text-foreground-muted"
            ellipsizeMode="middle"
            numberOfLines={1}
          >
            {props.value}
          </Text>
        ) : null}
      </View>
      <SymbolView
        name="chevron.right"
        size={16}
        tintColorClassName={"accent-chevron"}
        type="monochrome"
        weight="semibold"
      />
    </View>
  );

  const handlePress = () => {
    if (props.target) {
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: props.target },
      });
    } else if (props.fullScreenTarget) {
      navigation.navigate(props.fullScreenTarget);
    } else {
      props.onPress?.();
    }
  };

  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={handlePress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <ArcaneControlHighlight
        active={!props.disabled && (pressed || hovered || focused)}
        radius={12}
      />
      {content}
    </Pressable>
  );
}
