import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

const nightSky = require("../../assets/lecturn-night-sky.webp");

/** Static decoration behind content, never a scrolling or animated texture. */
export function ArcaneBackdrop({
  emphasis = "quiet",
}: {
  readonly emphasis?: "quiet" | "sidebar";
}) {
  const { themeAppearance } = useAppearancePreferences();
  const opacity =
    themeAppearance === "dark"
      ? emphasis === "sidebar"
        ? 0.34
        : 0.17
      : emphasis === "sidebar"
        ? 0.07
        : 0.035;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { opacity, overflow: "hidden" }]}
    >
      <Image
        source={nightSky}
        contentFit="cover"
        contentPosition="right center"
        transition={0}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
