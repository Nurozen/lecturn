import Svg, { Path } from "react-native-svg";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** Small staff silhouette shared with the web Stave workspace marker. */
export function StaveIcon({ size = 20 }: { readonly size?: number }) {
  const { themeAppearance } = useAppearancePreferences();
  const color = themeAppearance === "dark" ? "#e9bd72" : "#916522";
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M3 21 12.5 11.5M5.5 18.5l1.5 1.5M8 16l1.5 1.5" />
      <Path d="M12.5 12 9.5 8.5 12 3.5 12.5 7M12.5 12l4 1 4-4-3.5 1" />
      <Path d="m14 5 6-3-3 6-3 1Z" fill={color} strokeWidth={0.8} />
    </Svg>
  );
}
