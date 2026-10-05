import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useAccountSurfaceColor } from "./accountTintContext";
import { themeColorWithAlpha } from "./mobileTheme";
import { useGlassAccessibility } from "./useGlassAccessibility";
import { useUniwindTheme } from "./useUniwindTheme";

/** Decorative glass colors never replace action, reading, or status palettes. */
export function useGlassPalette() {
  const { themeId, themeAppearance } = useAppearancePreferences();
  const accountColor = useAccountSurfaceColor();
  const theme = useUniwindTheme();
  const opaque = useGlassAccessibility();
  const dark = themeAppearance === "dark";
  const neutral = !accountColor && themeId === "lecturn";
  const accent =
    accountColor ?? (neutral ? (dark ? "#d5af63" : "#94713d") : theme["--color-primary"]);
  return {
    accent,
    edge: opaque ? theme["--color-border"] : themeColorWithAlpha(accent, dark ? 0.42 : 0.3),
    light: neutral && dark ? "#ead9b5" : accent,
    dark,
    opaque,
  };
}
