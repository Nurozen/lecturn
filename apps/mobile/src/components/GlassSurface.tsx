import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import type { ReactNode, Ref } from "react";
import {
  Platform,
  View,
  type ColorValue,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { withUniwind } from "uniwind";

import { useAccountSurfaceColor } from "../lib/accountTintContext";
import { cn } from "../lib/cn";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import { useGlassAccessibility } from "../lib/useGlassAccessibility";

// Explicit mappings keep the native glassEffectStyle enum out of style-array conversion.
const ThemedGlassView = withUniwind(GlassView, {
  style: { fromClassName: "className" },
  tintColor: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
});

interface GlassSurfaceProps extends ViewProps {
  readonly ref?: Ref<View>;
  readonly children: ReactNode;
  readonly glassEffectStyle?: "clear" | "regular" | "none";
  readonly tintColor?: ColorValue;
  readonly tintColorClassName?: string;
  readonly chrome?: "default" | "none";
  /** Styling used only when native Liquid Glass is unavailable. */
  readonly fallbackStyle?: StyleProp<ViewStyle>;
  /** Uniwind styling used only when native Liquid Glass is unavailable. */
  readonly fallbackClassName?: string;
}

export function GlassSurface({
  ref,
  children,
  glassEffectStyle = "regular",
  chrome = "default",
  tintColor,
  tintColorClassName,
  fallbackStyle,
  fallbackClassName,
  className,
  style,
  ...props
}: GlassSurfaceProps) {
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";
  const opaque = useGlassAccessibility();
  const theme = useUniwindTheme();
  const accountColor = useAccountSurfaceColor();
  const accent = accountColor ?? theme["--color-primary"];
  const accountTint =
    !opaque && tintColor === undefined && tintColorClassName === undefined && accountColor
      ? themeColorWithAlpha(accountColor, isDarkMode ? 0.13 : 0.06)
      : undefined;
  const supportsGlass = Platform.OS === "ios" && isGlassEffectAPIAvailable() && !opaque;
  const surfaceStyle: ViewStyle = {
    borderRadius: 28,
    borderCurve: "continuous",
    overflow: "hidden",
    shadowColor: chrome === "none" ? "transparent" : "#000000",
    shadowOpacity: chrome === "none" ? 0 : isDarkMode ? 0.22 : 0.08,
    shadowRadius: chrome === "none" ? 0 : 16,
    shadowOffset:
      chrome === "none"
        ? {
            width: 0,
            height: 0,
          }
        : {
            width: 0,
            height: 6,
          },
    elevation: chrome === "none" ? 0 : 6,
    ...(chrome === "none"
      ? {}
      : {
          borderWidth: 0.5,
          borderColor:
            accountColor && !opaque
              ? themeColorWithAlpha(accountColor, isDarkMode ? 0.42 : 0.3)
              : theme["--color-border"],
        }),
  };

  if (supportsGlass) {
    return (
      <ThemedGlassView
        {...props}
        ref={ref}
        className={cn(
          chrome === "none"
            ? "border-0 border-transparent bg-transparent"
            : "border border-border bg-glass-surface",
          className,
        )}
        glassEffectStyle={glassEffectStyle}
        tintColor={tintColor === undefined ? accountTint : String(tintColor)}
        tintColorClassName={
          tintColorClassName ??
          (tintColor === undefined && accountTint === undefined ? "accent-glass-tint" : undefined)
        }
        colorScheme={isDarkMode ? "dark" : "light"}
        style={[surfaceStyle, style]}
      >
        {children}
      </ThemedGlassView>
    );
  }

  return (
    <View
      {...props}
      ref={ref}
      className={cn(
        chrome === "none"
          ? "border-0 border-transparent bg-transparent"
          : "border border-border bg-glass-surface",
        fallbackClassName,
        className,
        opaque ? "bg-card" : undefined,
      )}
      style={[
        surfaceStyle,
        fallbackStyle,
        style,
        opaque || chrome === "none"
          ? undefined
          : {
              experimental_backgroundImage: isDarkMode
                ? `linear-gradient(150deg, ${themeColorWithAlpha(accent, 0.16)} 0%, #ffffff08 12%, #ffffff00 45%, #00000018 100%)`
                : `linear-gradient(150deg, #ffffff9c 0%, #ffffff00 42%, ${themeColorWithAlpha(accent, 0.08)} 100%)`,
            },
      ]}
    >
      {children}
    </View>
  );
}
