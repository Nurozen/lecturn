import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useGlassAccessibility } from "../../lib/useGlassAccessibility";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { Pressable, View } from "react-native";
import { useAccountSurfaceColor } from "../../lib/accountTintContext";
import { AppText } from "../../components/AppText";
import type { HomeAccountHeaderListItem } from "./homeListItems";

export function AccountSectionHeader({
  item,
  onToggle,
}: {
  readonly item: HomeAccountHeaderListItem;
  readonly onToggle: () => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const opaque = useGlassAccessibility();
  const dark = themeAppearance === "dark";
  const color = useAccountSurfaceColor();
  const label = item.account?.label ?? "Direct connections";
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${label}${item.attention ? `, ${item.attention}` : ""}`}
      accessibilityState={{ expanded: !item.collapsed }}
      style={
        color
          ? {
              borderColor: themeColorWithAlpha(color, dark ? 0.42 : 0.3),
              borderLeftColor: color,
              borderLeftWidth: 2,
              ...(!opaque
                ? {
                    experimental_backgroundImage: `linear-gradient(110deg, ${themeColorWithAlpha(color, dark ? 0.16 : 0.08)} 0%, #ffffff00 74%)`,
                  }
                : {}),
            }
          : undefined
      }
      className={`mx-3 mt-4 mb-1 rounded-xl border border-border ${opaque ? "bg-card" : "bg-glass-surface"} px-3 py-3`}
    >
      <View className="flex-row items-center gap-2">
        <AppText className="flex-1 font-lecturn-semibold text-sm text-foreground" numberOfLines={1}>
          {label}
        </AppText>
        <AppText className="text-foreground-muted">{item.collapsed ? "›" : "⌄"}</AppText>
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
