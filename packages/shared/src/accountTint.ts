import { type ThemeColorRole, type ThemeColors } from "./themePalettes.js";

/** Account colors avoid the red and amber reserved for errors and attention. */
export const ACCOUNT_TINT_PRESETS = [
  { id: "jade", label: "Jade", hue: 145 },
  { id: "teal", label: "Teal", hue: 180 },
  { id: "cyan", label: "Cyan", hue: 215 },
  { id: "blue", label: "Blue", hue: 250 },
  { id: "violet", label: "Violet", hue: 285 },
  { id: "orchid", label: "Orchid", hue: 320 },
] as const;
export type AccountTintPresetId = (typeof ACCOUNT_TINT_PRESETS)[number]["id"];
export type AccountAppearance = { readonly label: string; readonly preset: AccountTintPresetId };

export function resolveAccountTintPreset(value: unknown) {
  return ACCOUNT_TINT_PRESETS.find((preset) => preset.id === value) ?? ACCOUNT_TINT_PRESETS[0];
}

export function readAccountAppearance(
  metadata: unknown,
  email = "",
  usedPresets: ReadonlyArray<string> = [],
): AccountAppearance {
  const raw =
    metadata && typeof metadata === "object" && "lecturn" in metadata
      ? metadata.lecturn
      : undefined;
  const prefs = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fallback = email.slice(email.lastIndexOf("@") + 1) || "Connect account";
  const label = typeof prefs.label === "string" ? prefs.label.trim().slice(0, 40) : "";
  const preset =
    prefs.preset === undefined
      ? (ACCOUNT_TINT_PRESETS.find((entry) => !usedPresets.includes(entry.id)) ??
        ACCOUNT_TINT_PRESETS[0])
      : resolveAccountTintPreset(prefs.preset);
  return { label: label || fallback.slice(0, 40), preset: preset.id };
}

type Color = { L: number; C: number; h: number; alpha: number };
type Rgb = { r: number; g: number; b: number };
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const linear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const srgb = (value: number) =>
  clamp(value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);

function fromRgb({ r, g, b }: Rgb, alpha: number): Color {
  r = linear(r);
  g = linear(g);
  b = linear(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    C: Math.hypot(a, bb),
    h: (Math.atan2(bb, a) * 180) / Math.PI,
    alpha,
  };
}

function rawRgb({ L, C, h }: Color): Rgb {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function gamut(color: Color): Color {
  const fits = (C: number) =>
    Object.values(rawRgb({ ...color, C })).every((v) => v >= -0.000001 && v <= 1.000001);
  if (fits(color.C)) return color;
  let low = 0,
    high = color.C;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    if (fits(mid)) low = mid;
    else high = mid;
  }
  return { ...color, C: low };
}

function toRgb(color: Color): Rgb {
  const rgb = rawRgb(gamut(color));
  return { r: srgb(rgb.r), g: srgb(rgb.g), b: srgb(rgb.b) };
}

const component = (value: string, percent: number) =>
  value === "none"
    ? 0
    : Number(value.replace(/%$/, "")) * (value.endsWith("%") ? percent / 100 : 1);

/** Literal colors shared by native palettes and canonical web palettes. Unsupported CSS stays untouched. */
export function parseAccountTintColor(value: string): Color | null {
  const input = value.trim().toLowerCase();
  if (/^#[\da-f]{3,4}$|^#[\da-f]{6}([\da-f]{2})?$/.test(input)) {
    const hex =
      input.length <= 5
        ? input
            .slice(1)
            .split("")
            .map((v) => v + v)
            .join("")
        : input.slice(1);
    return fromRgb(
      {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
      },
      hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1,
    );
  }
  const match = /^(oklch|rgba?)\((.*)\)$/.exec(input);
  if (!match) return null;
  const parts = match[2]!.trim().split(/[\s,/]+/);
  if (parts.length < 3 || parts.length > 4) return null;
  const alpha = parts[3] === undefined ? 1 : clamp(component(parts[3], 1));
  let color: Color;
  if (match[1] === "oklch") {
    color = {
      L: clamp(component(parts[0]!, 1)),
      C: Math.max(0, component(parts[1]!, 0.4)),
      h: component(parts[2]!.replace(/deg$/, ""), 360),
      alpha,
    };
  } else {
    color = fromRgb(
      {
        r: clamp(component(parts[0]!, 255) / 255),
        g: clamp(component(parts[1]!, 255) / 255),
        b: clamp(component(parts[2]!, 255) / 255),
      },
      alpha,
    );
  }
  return Object.values(color).every(Number.isFinite) ? color : null;
}

function format(color: Color): string {
  const mapped = gamut(color);
  const number = (v: number) => String(Number(v.toFixed(6)));
  return `oklch(${number(mapped.L)} ${number(mapped.C)} ${number(((mapped.h % 360) + 360) % 360)}${mapped.alpha < 1 ? ` / ${number(mapped.alpha)}` : ""})`;
}

const luminance = (rgb: Rgb) =>
  0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
const composite = (fg: Rgb, bg: Rgb, alpha: number): Rgb => ({
  r: fg.r * alpha + bg.r * (1 - alpha),
  g: fg.g * alpha + bg.g * (1 - alpha),
  b: fg.b * alpha + bg.b * (1 - alpha),
});
const ratio = (a: Rgb, b: Rgb) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

/** Contrast after compositing both roles over their actual canvas. */
export function accountTintContrast(
  foreground: string,
  background: string,
  canvas = "#fff",
): number {
  const fg = parseAccountTintColor(foreground),
    bg = parseAccountTintColor(background),
    under = parseAccountTintColor(canvas);
  if (!fg || !bg || !under) return 1;
  const backgroundRgb = composite(toRgb(bg), toRgb(under), bg.alpha);
  return ratio(composite(toRgb(fg), backgroundRgb, fg.alpha), backgroundRgb);
}

export function accountTintColor(preset: unknown): string {
  const rgb = toRgb({ L: 0.62, C: 0.16, h: resolveAccountTintPreset(preset).hue, alpha: 1 });
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const surfaces: ReadonlyArray<ThemeColorRole> = [
  "canvas",
  "chrome",
  "toolbar",
  "toolbarControl",
  "toolbarControlHover",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "border",
  "input",
  "secondary",
  "muted",
  "accentSurface",
  "messageSurface",
  "codeBackground",
  "sidebar",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
];
const accents: ReadonlyArray<ThemeColorRole> = [
  "accent",
  "focus",
  "messageAction",
  "messageActionHover",
];
const foregrounds: ReadonlyArray<readonly [ThemeColorRole, ReadonlyArray<ThemeColorRole>, number]> =
  [
    ["text", ["canvas", "surface", "surfaceRaised", "surfaceOverlay", "input"], 4.5],
    ["textMuted", ["canvas", "surface"], 4.5],
    ["mutedForeground", ["muted"], 4.5],
    ["placeholder", ["canvas", "surface", "input"], 3],
    ["secondaryLabel", ["canvas", "surface"], 4.5],
    ["iconMuted", ["canvas", "surface"], 3],
    ["toolbarForeground", ["toolbar"], 4.5],
    ["toolbarControlForeground", ["toolbarControl", "toolbarControlHover"], 4.5],
    ["accentForeground", ["accent"], 4.5],
    ["secondaryForeground", ["secondary"], 4.5],
    ["accentSurfaceForeground", ["accentSurface"], 4.5],
    ["messageForeground", ["messageSurface"], 4.5],
    ["messageActionForeground", ["messageAction"], 4.5],
    ["codeForeground", ["codeBackground"], 4.5],
    [
      "sidebarForeground",
      ["sidebar", "sidebarRowHover", "sidebarRowActive", "sidebarRowSelected"],
      4.5,
    ],
    ["sidebarMutedForeground", ["sidebar"], 4.5],
  ];

/** Shift account surfaces without moving their lightness; then restore foreground contrast. Status roles stay intact. */
export function tintThemeColors(base: ThemeColors, preset: string | number): ThemeColors {
  const hue =
    typeof preset === "number" && Number.isFinite(preset)
      ? preset
      : resolveAccountTintPreset(preset).hue;
  const next = { ...base };
  for (const role of [...surfaces, ...accents]) {
    const color = parseAccountTintColor(base[role]);
    if (!color) continue;
    next[role] = format({
      ...color,
      h: hue,
      C: accents.includes(role)
        ? Math.max(0.1, Math.min(0.18, color.C))
        : Math.min(0.055, color.C * 0.35 + 0.018),
    });
  }
  for (const [role, backgrounds, floor] of foregrounds) {
    const original = parseAccountTintColor(base[role]);
    if (!original) continue;
    const score = (color: Color) =>
      Math.min(
        ...backgrounds.map((background) =>
          accountTintContrast(format(color), next[background], next.canvas),
        ),
      );
    const target = Math.max(
      floor,
      Math.min(
        ...backgrounds.map((background) =>
          accountTintContrast(base[role], base[background], base.canvas),
        ),
      ),
    );
    if (score(original) >= target) continue;
    // Search both directions: a custom palette need not agree with its declared appearance.
    const candidates = [0, 1].map((edge) => {
      let low = 0,
        high = 1;
      for (let step = 0; step < 22; step++) {
        const mix = (low + high) / 2;
        const candidate = { ...original, L: original.L + (edge - original.L) * mix };
        if (score(candidate) >= target + 0.005) high = mix;
        else low = mix;
      }
      return { ...original, L: original.L + (edge - original.L) * high };
    });
    const passing = candidates.filter((candidate) => score(candidate) >= target);
    const selected =
      passing.sort((a, b) => Math.abs(a.L - original.L) - Math.abs(b.L - original.L))[0] ??
      candidates.sort((a, b) => score(b) - score(a))[0]!;
    next[role] = format(selected);
  }
  const hover = parseAccountTintColor(next.messageActionHover);
  if (
    hover &&
    accountTintContrast(next.messageActionForeground, next.messageActionHover, next.canvas) < 4.5
  ) {
    // The hover is a solid action control too. Keep its foreground and adjust
    // the hover lightness only when that foreground cannot meet the floor.
    const action = parseAccountTintColor(next.messageAction)!;
    next.messageActionHover = format({ ...hover, L: action.L });
  }
  return next;
}
