import { useNavigation, useRoute } from "@react-navigation/native";
import { use, useState, type ComponentProps } from "react";
import { Platform, Pressable } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { ArcaneControlHighlight } from "../../../components/ArcaneControlHighlight";
import { ListRow } from "../../../components/ui/ListRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { RowPressable } from "../../../components/ui/RowPressable";
import { cn } from "../../../lib/cn";
import type { SettingsLegalDocumentTarget, SettingsPageTarget } from "./settings-page-targets";
import { SettingsSidebarContext } from "./SettingsSection";
import { openSettings } from "../settings-navigation";

export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof ListRow>["icon"];
  readonly label: string;
  readonly value?: string;
  readonly valuePosition?: "below" | "trailing";
  readonly target?: SettingsPageTarget;
  readonly fullScreenTarget?: SettingsLegalDocumentTarget;
  readonly onPress?: () => void;
}) {
  const navigation = useNavigation();
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const sidebar = use(SettingsSidebarContext);
  // The Settings list opens pages in place of the detail column; a page's own rows push below.
  const inList = ["Home", "Settings"].includes(useRoute().name);
  const valueBelow =
    props.valuePosition === "below" ||
    (props.valuePosition === undefined && Platform.OS === "android");
  const content = {
    icon: props.icon,
    label: props.label,
    description: valueBelow ? props.value : undefined,
    detail: valueBelow ? undefined : props.value,
    disabled: props.disabled,
  };
  const onPress = () => {
    if (props.target) {
      if (inList) openSettings(navigation, props.target);
      else navigation.navigate(props.target);
    } else if (props.fullScreenTarget) {
      navigation.navigate(props.fullScreenTarget);
    } else {
      props.onPress?.();
    }
  };
  if (sidebar) {
    const selected = props.target !== undefined && props.target === sidebar.selected;
    return (
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={[props.label, props.value].filter(Boolean).join(", ")}
        accessibilityState={{ disabled: Boolean(props.disabled), selected }}
        disabled={props.disabled}
        onPress={onPress}
        className={cn("rounded-2xl", selected && "bg-subtle-strong")}
      >
        <ListRowLayout {...content} />
      </RowPressable>
    );
  }

  if (Platform.OS === "android") {
    return <ListRow {...content} onPress={onPress} />;
  }

  // iOS keeps Lecturn's arcane press highlight over the shared row geometry.
  return (
    <Pressable
      accessibilityLabel={[props.label, props.value].filter(Boolean).join(", ")}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={onPress}
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
