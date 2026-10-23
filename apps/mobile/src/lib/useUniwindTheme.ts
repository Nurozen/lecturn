import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { MobileThemeVariables } from "./mobileTheme";

export function useUniwindTheme(): MobileThemeVariables {
  // The provider's palettes already carry the Reduce Transparency override.
  return useAppearancePreferences().themeVariables;
}
