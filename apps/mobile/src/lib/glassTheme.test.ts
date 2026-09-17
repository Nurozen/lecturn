import { describe, expect, it } from "vite-plus/test";
import { MOBILE_THEME_IDS } from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";
import { getMobileUniwindThemeName } from "./mobileThemeRuntime";
import { glassAccessibilityThemeUpdates } from "./glassTheme";

describe("accessible glass palettes", () => {
  it("makes every registered palette opaque and restores its original material on opt-out", () => {
    const opaque = new Map(
      glassAccessibilityThemeUpdates(true).map((value) => [value.themeName, value.variables]),
    );
    const transparent = new Map(
      glassAccessibilityThemeUpdates(false).map((value) => [value.themeName, value.variables]),
    );
    expect(opaque.size).toBe(MOBILE_THEME_IDS.length * 2);
    for (const id of MOBILE_THEME_IDS) {
      for (const appearance of ["light", "dark"] as const) {
        const name = getMobileUniwindThemeName(id, appearance);
        const base = getMobileThemeRuntimeVariables(id, appearance);
        for (const role of ["--color-glass-surface", "--color-card-translucent"] as const) {
          expect(opaque.get(name)![role]).toBe(base["--color-card"]);
          expect(opaque.get(name)![role]).toMatch(/^#[\da-f]{6}$/i);
          expect(transparent.get(name)![role]).toBe(base[role]);
          expect(transparent.get(name)![role]).not.toBe(opaque.get(name)![role]);
        }
      }
    }
  });
});
