import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_THEMES, type ThemeColors } from "./themePalettes.js";
import {
  ACCOUNT_TINT_PRESETS,
  accountTintContrast,
  parseAccountTintColor,
  readAccountAppearance,
  tintThemeColors,
} from "./accountTint.js";

describe("account tint", () => {
  it("keeps readable text over each built-in theme and preset in both appearances", () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const base of [theme.colors, ...Object.values(theme.variants ?? {})]) {
        for (const preset of ACCOUNT_TINT_PRESETS) {
          const tinted = tintThemeColors(base, preset.id);
          for (const [fg, bg] of [
            ["text", "canvas"],
            ["text", "surface"],
            ["messageForeground", "messageSurface"],
            ["messageActionForeground", "messageAction"],
            ["accentForeground", "accent"],
            ["sidebarForeground", "sidebar"],
          ] as const) {
            expect(
              accountTintContrast(tinted[fg], tinted[bg], tinted.canvas),
              `${theme.id} ${preset.id} ${fg}/${bg}`,
            ).toBeGreaterThanOrEqual(4.49);
          }
          expect(tinted.error).toBe(base.error);
          expect(tinted.warning).toBe(base.warning);
        }
      }
    }
  });
  it("preserves alpha from hex, rgba and OKLCH while tinting", () => {
    const theme = BUILT_IN_THEMES[0]!.colors;
    for (const color of [
      "#1238",
      "#11223380",
      "rgba(10, 20, 30, 0.3)",
      "rgb(10% 20% 30% / 40%)",
      "oklch(50% 0.03 180 / 0.2)",
    ]) {
      const colors: ThemeColors = { ...theme, border: color };
      expect(parseAccountTintColor(tintThemeColors(colors, "blue").border)?.alpha).toBeCloseTo(
        parseAccountTintColor(color)!.alpha,
        5,
      );
    }
  });
  it("falls back for unknown presets and selects an unused default", () => {
    const base = BUILT_IN_THEMES[0]!.colors;
    expect(tintThemeColors(base, "unknown")).toEqual(tintThemeColors(base, "jade"));
    expect(readAccountAppearance({}, "me@example.org", ["jade"])).toEqual({
      label: "example.org",
      preset: "teal",
    });
    expect(readAccountAppearance({ lecturn: { label: "x".repeat(60), preset: "bogus" } })).toEqual({
      label: "x".repeat(40),
      preset: "jade",
    });
  });
  it("composites translucent colors before measuring contrast", () => {
    expect(accountTintContrast("rgba(0,0,0,0)", "#fff")).toBe(1);
    expect(accountTintContrast("#000", "#fff")).toBeCloseTo(21);
  });
});
