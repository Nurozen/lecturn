import type { ReactNode } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useGlassAccessibility } from "../lib/useGlassAccessibility";
import { cn } from "../lib/cn";

export interface GlassCardProps extends ViewProps {
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
  const { themeAppearance } = useAppearancePreferences();
  const light = themeAppearance === "light";
  const accessibleOpaque = useGlassAccessibility();
  const opaque = forceOpaque || accessibleOpaque;
  return (
    <View
      {...props}
      className={cn(
        opaque ? "bg-card" : "bg-card-translucent",
        tone === "accent" ? "border-primary/50 border-t-primary/70" : undefined,
        className,
      )}
      style={[
        {
          borderRadius: radius,
          borderCurve: "continuous",
          overflow: "hidden",
          borderWidth: StyleSheet.hairlineWidth,
          ...(tone === "default"
            ? {
                borderColor: light ? "#ffffffd9" : "#b9d3e345",
                borderTopColor: light ? "#ffffff" : "#cce5f067",
              }
            : tone === "settled"
              ? {
                  borderColor: light ? "#ad3c2f85" : "#ed624f85",
                  borderTopColor: light ? "#ad3c2fb8" : "#ed624fb8",
                }
              : {}),
          boxShadow: opaque
            ? undefined
            : [{ offsetX: 0, offsetY: 3, blurRadius: 9, color: light ? "#422c1810" : "#00000024" }],
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
                    ? "linear-gradient(150deg, #ffffff9c 0%, #ffffff00 42%, #bc764210 100%)"
                    : "linear-gradient(150deg, #d9edff18 0%, #ffffff00 42%, #00000018 100%)",
            },
          ]}
        />
      ) : null}
      {children}
    </View>
  );
}
