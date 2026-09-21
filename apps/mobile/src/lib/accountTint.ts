import { parseAccountTintColor, tintThemeColors } from "@lecturn/shared/accountTint";
import {
  BUILT_IN_THEMES,
  getThemeColorsForAppearance,
  type ThemeColors,
} from "@lecturn/shared/themePalettes";
import {
  createMobileThemeVariables,
  themeColorWithAlpha,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeVariables,
} from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";

/** Keep the native header and semantic status colors outside the account treatment. */
export function mobileAccountTintVariables(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
  preset: string,
): MobileThemeVariables {
  const variables = getMobileThemeRuntimeVariables(themeId, appearance);
  const theme = BUILT_IN_THEMES.find((entry) => entry.id === themeId) ?? BUILT_IN_THEMES[0];
  const fallback = getThemeColorsForAppearance(theme, appearance) ?? theme.colors;
  const roles: Partial<Record<keyof ThemeColors, keyof MobileThemeVariables>> = {
    canvas: "--color-screen",
    chrome: "--color-sheet-solid",
    surface: "--color-card-alt",
    surfaceRaised: "--color-card",
    surfaceOverlay: "--color-glass-surface",
    text: "--color-foreground",
    textMuted: "--color-foreground-secondary",
    mutedForeground: "--color-foreground-muted",
    secondaryLabel: "--color-foreground-tertiary",
    iconMuted: "--color-icon-muted",
    border: "--color-border",
    input: "--color-input-border",
    muted: "--color-subtle",
    secondary: "--color-secondary",
    secondaryForeground: "--color-secondary-foreground",
    accent: "--color-primary",
    accentForeground: "--color-primary-foreground",
    accentSurface: "--color-inline-skill-background",
    accentSurfaceForeground: "--color-inline-skill-foreground",
    messageSurface: "--color-user-bubble",
    messageForeground: "--color-user-bubble-foreground",
    messageAction: "--color-user-bubble-skill-foreground",
    codeBackground: "--color-md-code-bg",
    codeForeground: "--color-md-code-text",
  };
  const base = { ...fallback };
  for (const [role, variable] of Object.entries(roles)) {
    const value = variables[variable];
    if (value) base[role as keyof ThemeColors] = value;
  }
  const tinted = createMobileThemeVariables(tintThemeColors(base, preset), appearance);
  return Object.fromEntries(
    Object.entries(tinted)
      .map(([key, value]) => {
        const original = parseAccountTintColor(variables[key as keyof MobileThemeVariables] ?? "");
        return [
          key,
          original && original.alpha < 1 ? themeColorWithAlpha(value, original.alpha) : value,
        ] as const;
      })
      .filter(
        ([key]) =>
          ![
            "--color-header",
            "--color-header-border",
            "--color-status-bar",
            "--color-danger",
            "--color-danger-border",
            "--color-danger-foreground",
            "--color-drawer",
            "--color-drawer-shadow",
            "--color-sidebar-search",
          ].includes(key),
      ),
  ) as MobileThemeVariables;
}
