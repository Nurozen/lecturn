import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useGlassPalette } from "../../lib/useGlassPalette";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { AppText } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type { HomeAccountHeaderListItem } from "./homeListItems";

export function AccountSectionHeader({
  item,
  onToggle,
}: {
  readonly item: HomeAccountHeaderListItem;
  readonly onToggle: () => void;
}) {
  const { accent, dark } = useGlassPalette();
  const angle = useSharedValue(item.collapsed ? 0 : 90);
  useEffect(() => {
    angle.set(
      withTiming(item.collapsed ? 0 : 90, {
        duration: 420,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [angle, item.collapsed]);
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value}deg` }] }));
  const label = item.account?.label ?? "Direct connections";
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${label}${item.attention ? `, ${item.attention}` : ""}`}
      accessibilityState={{ expanded: !item.collapsed }}
      style={({ pressed }) => ({
        backgroundColor: themeColorWithAlpha(accent, pressed ? 0.14 : dark ? 0.035 : 0.025),
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
      })}
      className="min-h-12 px-3 py-3"
    >
      <View className="flex-row items-center gap-2">
        <Animated.View style={chevronStyle}>
          <SymbolView name="chevron.right" size={12} tintColor={accent} />
        </Animated.View>
        <AppText className="flex-1 font-lecturn-medium text-sm text-foreground" numberOfLines={1}>
          {label}
        </AppText>
      </View>
      {item.account && !item.account.signedIn ? (
        <AppText className="mt-1 text-xs text-foreground-muted">Sign in again</AppText>
      ) : null}
      {item.attention ? (
        <AppText className="mt-1 text-xs text-primary">{item.attention}</AppText>
      ) : null}
    </Pressable>
  );
}
