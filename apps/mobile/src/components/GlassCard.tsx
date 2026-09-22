import { useAccountSurfaceColor } from "../lib/accountTintContext";
import type { ReactNode, Ref } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useGlassAccessibility } from "../lib/useGlassAccessibility";
import { cn } from "../lib/cn";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { themeColorWithAlpha } from "../lib/mobileTheme";

export interface GlassCardProps extends ViewProps {
  readonly ref?: Ref<View>;
  readonly children: ReactNode;
  readonly tone?: "default" | "accent" | "settled";
  readonly radius?: number;
  /** Opaque overlays keep the conversation underneath from bleeding into prompts. */
  readonly opaque?: boolean;
  /** Keep colored message bubbles dark enough for their contrasting text. */
  readonly sheen?: "regular" | "subtle";
}

/** Static material for scrolling content. Native refraction is reserved for floating chrome. */
export function GlassCard({
  children,
  tone = "default",
  radius = 22,
  opaque: forceOpaque = false,
  sheen = "regular",
  style,
  className,
  ...props
}: GlassCardProps) {
  const accountColor = useAccountSurfaceColor();
  const { themeAppearance } = useAppearancePreferences();
  const light = themeAppearance === "light";
  const theme = useUniwindTheme();
  const accessibleOpaque = useGlassAccessibility();
  const opaque = forceOpaque || accessibleOpaque;
  const accent = accountColor ?? theme["--color-primary"];
  return (
    <View
      {...props}
      className={cn(opaque ? "bg-card" : "bg-card-translucent", className)}
      style={[
        {
          borderRadius: radius,
          borderCurve: "continuous",
          overflow: "hidden",
          borderWidth: tone === "accent" ? 1.5 : StyleSheet.hairlineWidth,
          borderColor:
            tone === "accent"
              ? accent
              : tone === "settled"
                ? theme["--color-danger-foreground"]
                : accountColor && !opaque && sheen !== "subtle"
                  ? themeColorWithAlpha(accountColor, light ? 0.28 : 0.36)
                  : theme["--color-border"],
          ...(tone === "accent" && !opaque
            ? {
                borderLeftColor: accent,
                borderTopColor: themeColorWithAlpha(accent, light ? 0.5 : 0.65),
              }
            : {}),
        },
        style,
      ]}
    >
      {!opaque ? (
        <View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: radius,
              experimental_backgroundImage:
                sheen === "subtle"
                  ? "linear-gradient(150deg, #ffffff0a 0%, #ffffff00 42%, #00000008 100%)"
                  : light
                    ? `linear-gradient(150deg, #ffffff9c 0%, #ffffff00 42%, ${themeColorWithAlpha(accent, 0.08)} 100%)`
                    : `linear-gradient(150deg, ${themeColorWithAlpha(accent, tone === "accent" ? 0.26 : 0.12)} 0%, #ffffff08 12%, #ffffff00 45%, #00000018 100%)`,
            },
          ]}
        />
      ) : null}
      {children}
    </View>
  );
}
