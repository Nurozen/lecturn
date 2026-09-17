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

/** Update every registered palette so changing themes never flashes transparent controls. */
export function glassAccessibilityThemeUpdates(opaque: boolean) {
  return MOBILE_THEME_IDS.flatMap((id) =>
    (["light", "dark"] as const).map((appearance) => ({
      themeName: getMobileUniwindThemeName(id, appearance),
      variables: glassAccessibilityVariables(
        getMobileThemeRuntimeVariables(id, appearance),
        opaque,
      ),
    })),
  );
}
