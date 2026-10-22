import { useNavigation } from "@react-navigation/native";
import { useState, type ComponentProps } from "react";
import { Platform, Pressable } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { ArcaneControlHighlight } from "../../../components/ArcaneControlHighlight";
import { ListRow } from "../../../components/ListRow";
import { ListRowLayout } from "../../../components/ListRowLayout";
import type { SettingsLegalDocumentTarget, SettingsSheetTarget } from "./settings-sheet-targets";

export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof ListRow>["icon"];
  readonly label: string;
  readonly value?: string;
  readonly valuePosition?: "below" | "trailing";
  readonly target?: SettingsSheetTarget;
  readonly fullScreenTarget?: SettingsLegalDocumentTarget;
  readonly onPress?: () => void;
}) {
  const navigation = useNavigation();
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const valueBelow =
    props.valuePosition === "below" ||
    (props.valuePosition === undefined && Platform.OS === "android");
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
  const content = {
    icon: props.icon,
    label: props.label,
    description: valueBelow ? props.value : undefined,
    detail: valueBelow ? undefined : props.value,
    disabled: props.disabled,
  };

  if (Platform.OS === "android") {
    return <ListRow {...content} onPress={handlePress} />;
  }

  // iOS keeps Lecturn's arcane press highlight over the shared row geometry.
  return (
    <Pressable
      accessibilityLabel={[props.label, props.value].filter(Boolean).join(", ")}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled) }}
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
      <ListRowLayout
        {...content}
        accessory={
          <SymbolView
            name="chevron.right"
            size={16}
            tintColorClassName="accent-chevron"
            type="monochrome"
            weight="semibold"
          />
        }
      />
    </Pressable>
  );
}
