import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import type { ReactNode, Ref, RefObject } from "react";
import {
  Platform,
  StyleSheet,
  View,
  type ColorValue,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { withUniwind } from "uniwind";

import { useGlassPalette } from "../lib/useGlassPalette";
import { cn } from "../lib/cn";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import { GlassBackdrop } from "./GlassBackdrop";

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
  /** Base color for the frosted tint, or solid fill when blur is unavailable. */
  readonly fallbackColor?: ColorValue;
  readonly blurTarget?: RefObject<View | null>;
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
  fallbackColor,
  blurTarget,
  fallbackClassName,
  className,
  style,
  ...props
}: GlassSurfaceProps) {
  const { accent, edge, dark: isDarkMode, opaque } = useGlassPalette();
  const accountTint =
    !opaque && tintColor === undefined && tintColorClassName === undefined && chrome !== "none"
      ? themeColorWithAlpha(accent, isDarkMode ? 0.09 : 0.04)
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
          borderColor: edge,
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
        chrome === "none" ? "border-0 border-transparent" : "border border-border",
        fallbackClassName,
        className,
        opaque ? "bg-card" : undefined,
      )}
      style={[surfaceStyle, style]}
    >
      <GlassBackdrop blurTarget={blurTarget} fallbackColor={fallbackColor} />
      {opaque || chrome === "none" ? null : (
        // Account-tinted sheen over the frosted backdrop, matching the native glass tint.
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              experimental_backgroundImage: isDarkMode
                ? `linear-gradient(150deg, ${themeColorWithAlpha(accent, 0.16)} 0%, #ffffff08 12%, #ffffff00 45%, #00000018 100%)`
                : `linear-gradient(150deg, #ffffff9c 0%, #ffffff00 42%, ${themeColorWithAlpha(accent, 0.08)} 100%)`,
            },
          ]}
        />
      )}
      {children}
    </View>
  );
}
