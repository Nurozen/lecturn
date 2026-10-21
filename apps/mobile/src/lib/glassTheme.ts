import { MOBILE_THEME_IDS, type MobileThemeVariables } from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";
import { getMobileUniwindThemeName } from "./mobileThemeRuntime";

/** Raw material tokens must honor accessibility just like the outer glass components. */
export function glassAccessibilityVariables(variables: MobileThemeVariables, opaque: boolean) {
  return {
    "--color-glass-surface": opaque
      ? variables["--color-card"]
      : variables["--color-glass-surface"],
    "--color-card-translucent": opaque
      ? variables["--color-card"]
      : variables["--color-card-translucent"],
  };
}

/**
 * Full palette with the accessibility override applied. The root ScopedVariables
 * re-applies the active palette over every theme, so it must carry the override too.
 */
export function withGlassAccessibility(
  variables: MobileThemeVariables,
  opaque: boolean,
): MobileThemeVariables {
  return { ...variables, ...glassAccessibilityVariables(variables, opaque) };
}

/**
 * Update every registered palette so changing themes never flashes transparent controls.
 * Material You shares the default Uniwind theme, so each theme name is updated once.
 */
export function glassAccessibilityThemeUpdates(opaque: boolean, platform: string) {
  const updates = MOBILE_THEME_IDS.flatMap((id) =>
    (["light", "dark"] as const).map((appearance) => ({
      themeName: getMobileUniwindThemeName(id, appearance),
      variables: glassAccessibilityVariables(
        getMobileThemeRuntimeVariables(id, appearance, platform),
        opaque,
      ),
    })),
  );
  return updates.filter(
    (update, index) => updates.findIndex((other) => other.themeName === update.themeName) === index,
  );
}
