import { useContext, useId } from "react";
import { AccountSurfaceKeyContext } from "../lib/accountTintContext";
import { useGlassPalette } from "../lib/useGlassPalette";
import { AccountGlassSweep } from "./AccountGlassSweep";
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";
import { useAccountSurfaceColor } from "../lib/accountTintContext";
import { useGlassAccessibility } from "../lib/useGlassAccessibility";
import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

const nightSky = require("../../assets/lecturn-night-sky.webp");

/** The sky stays static; navigation may send a finite glass sweep behind content. */
export function ArcaneBackdrop({
  emphasis = "quiet",
  transitionKey,
}: {
  readonly emphasis?: "quiet" | "sidebar";
  readonly transitionKey?: string;
}) {
  const accountColor = useAccountSurfaceColor();
  const accountKey = useContext(AccountSurfaceKeyContext);
  const palette = useGlassPalette();
  const opaque = useGlassAccessibility();
  const gradientId = useId().replace(/:/g, "");
  const { themeAppearance } = useAppearancePreferences();
  const dark = themeAppearance === "dark";
  const opacity = opaque
    ? dark
      ? 0.12
      : 0.025
    : dark
      ? emphasis === "sidebar"
        ? 0.4
        : 0.24
      : emphasis === "sidebar"
        ? 0.07
        : 0.035;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { overflow: "hidden" }]}
    >
      <Image
        source={nightSky}
        contentFit="cover"
        contentPosition="right center"
        transition={0}
        style={[StyleSheet.absoluteFill, { opacity }]}
      />
      {!opaque ? (
        <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
              <Stop
                offset="0%"
                stopColor={palette.accent}
                stopOpacity={accountColor ? (dark ? 0.3 : 0.13) : 0.06}
              />
              <Stop offset="8%" stopColor={palette.accent} stopOpacity={dark ? 0.09 : 0.035} />
              <Stop offset="48%" stopColor={palette.accent} stopOpacity={0} />
              <Stop offset="85%" stopColor={palette.accent} stopOpacity={0} />
              <Stop
                offset="100%"
                stopColor={palette.accent}
                stopOpacity={accountColor ? (dark ? 0.1 : 0.04) : 0.025}
              />
            </LinearGradient>
            <RadialGradient id={`${gradientId}-bloom`} cx="0%" cy="48%" rx="72%" ry="65%">
              <Stop
                offset="0%"
                stopColor={palette.accent}
                stopOpacity={accountColor ? (dark ? 0.13 : 0.045) : 0}
              />
              <Stop offset="100%" stopColor={palette.accent} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
          <Rect width="100%" height="100%" fill={`url(#${gradientId}-bloom)`} />
        </Svg>
      ) : null}
      {transitionKey !== undefined ? (
        <AccountGlassSweep
          identity={accountKey ?? transitionKey}
          color={palette.light}
          disabled={opaque}
        />
      ) : null}
    </View>
  );
}
