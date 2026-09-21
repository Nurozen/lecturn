import { describe, expect, it } from "vite-plus/test";
import { mobileAccountTintVariables } from "./accountTint";
import { MOBILE_THEME_IDS } from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";
import {
  accountTintContrast,
  parseAccountTintColor,
  ACCOUNT_TINT_PRESETS,
} from "@lecturn/shared/accountTint";
import { glassAccessibilityVariables } from "./glassTheme";
describe("mobile account tint", () => {
  it("keeps readable foregrounds for every shipped palette and preset", () => {
    for (const theme of MOBILE_THEME_IDS)
      for (const appearance of ["light", "dark"] as const)
        for (const preset of ACCOUNT_TINT_PRESETS) {
          const tinted = mobileAccountTintVariables(theme, appearance, preset.id);
          expect(
            accountTintContrast(tinted["--color-foreground"]!, tinted["--color-screen"]!),
          ).toBeGreaterThanOrEqual(4.49);
          const base = getMobileThemeRuntimeVariables(theme, appearance);
          expect(parseAccountTintColor(tinted["--color-glass-tint"]!)?.alpha).toBe(
            parseAccountTintColor(base["--color-glass-tint"]!)?.alpha,
          );
          expect(tinted["--color-header"]).toBeUndefined();
          expect(tinted["--color-danger"]).toBeUndefined();
          expect(Object.values(tinted).some((color) => color.startsWith("oklch("))).toBe(false);
        }
  });
  it("applies opaque glass after the account palette", () => {
    const base = getMobileThemeRuntimeVariables("lecturn", "dark");
    const tint = mobileAccountTintVariables("lecturn", "dark", "cyan");
    const combined = { ...base, ...tint };
    expect(glassAccessibilityVariables(combined, true)["--color-glass-surface"]).toBe(
      tint["--color-card"],
    );
  });
});
