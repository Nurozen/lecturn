import { describe, expect, it } from "vite-plus/test";
import { MOBILE_THEME_IDS, type MobileThemeVariables } from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";
import { getMobileUniwindThemeName } from "./mobileThemeRuntime";
import { glassAccessibilityThemeUpdates, withGlassAccessibility } from "./glassTheme";

describe("accessible glass palettes", () => {
  it("makes every registered palette opaque and restores its original material on opt-out", () => {
    const opaque = new Map(
      glassAccessibilityThemeUpdates(true, "ios").map((value) => [
        value.themeName,
        value.variables,
      ]),
    );
    const transparent = new Map(
      glassAccessibilityThemeUpdates(false, "ios").map((value) => [
        value.themeName,
        value.variables,
      ]),
    );
    const themeNames = MOBILE_THEME_IDS.flatMap((id) =>
      (["light", "dark"] as const).map((appearance) => getMobileUniwindThemeName(id, appearance)),
    );
    expect(glassAccessibilityThemeUpdates(true, "ios")).toHaveLength(new Set(themeNames).size);
    expect(opaque.size).toBe(new Set(themeNames).size);
    for (const id of MOBILE_THEME_IDS) {
      for (const appearance of ["light", "dark"] as const) {
        const name = getMobileUniwindThemeName(id, appearance);
        const base = getMobileThemeRuntimeVariables(id, appearance, "ios");
        for (const role of ["--color-glass-surface", "--color-card-translucent"] as const) {
          expect(opaque.get(name)![role]).toBe(base["--color-card"]);
          expect(opaque.get(name)![role]).toMatch(/^#[\da-f]{6}$/i);
          expect(transparent.get(name)![role]).toBe(base[role]);
          expect(transparent.get(name)![role]).not.toBe(opaque.get(name)![role]);
        }
      }
    }
  });

  it("keeps a scoped palette opaque so it cannot re-apply translucent glass", () => {
    const base = getMobileThemeRuntimeVariables(MOBILE_THEME_IDS[0], "dark", "ios");
    const scoped: MobileThemeVariables = { ...base, "--color-card": "#123456" };
    const opaque = withGlassAccessibility(scoped, true);
    expect(opaque["--color-glass-surface"]).toBe("#123456");
    expect(opaque["--color-card-translucent"]).toBe("#123456");
    expect({
      ...opaque,
      "--color-glass-surface": scoped["--color-glass-surface"],
      "--color-card-translucent": scoped["--color-card-translucent"],
    }).toEqual(scoped);
    expect(withGlassAccessibility(scoped, false)).toEqual(scoped);
  });
});
