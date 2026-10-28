/**
 * The allowlisted variables the probe checks: those rocketwright-theme.json
 * sends. The contract's other variables are optional, and the probe fails any
 * variable the host did not send.
 */
export const EMBED_THEME_VARS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--muted",
  "--muted-foreground",
  "--secondary",
  "--secondary-foreground",
  "--border",
  "--input",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--ring",
  "--radius",
  "--font-sans",
  "--font-mono",
] as const;
export type EmbedThemeVar = (typeof EMBED_THEME_VARS)[number];

/** What the host sent in `ui/initialize`'s host context styles. */
export interface SentEmbedTheme {
  readonly variables: Readonly<Partial<Record<EmbedThemeVar, string>>>;
  readonly fontsCss?: string;
}

/** What the guest document reports, read in the guest itself. */
export interface ObservedGuestTheme {
  readonly variables: Readonly<Record<string, string>>;
  readonly loadedFamilies: ReadonlyArray<string>;
  readonly bodyFontFamily: string;
  readonly monoFontFamily: string;
}

export interface ThemeProbeCheck {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly passed: boolean;
}

export interface ThemeProbeReport {
  readonly passed: boolean;
  readonly checks: ReadonlyArray<ThemeProbeCheck>;
}

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/su, "$2");

export function parseFontFaceFamilies(css: string): ReadonlyArray<string> {
  const families = new Set<string>();
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/giu)) {
    const declaration = /font-family\s*:\s*([^;]+)/iu.exec(block[1] ?? "");
    if (declaration?.[1] !== undefined) families.add(unquote(declaration[1]));
  }
  return [...families];
}

function firstFontFamily(list: string): string {
  return unquote(list.split(",")[0] ?? "");
}

const normalizeValue = (value: string) => value.trim().replace(/\s+/gu, " ");

export type Rgb = readonly [number, number, number];

export function parseCssColor(value: string): Rgb | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/u.exec(text)?.[1];
  if (hex !== undefined) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;
    const channel = (start: number) => Number.parseInt(full.slice(start, start + 2), 16);
    return [channel(0), channel(2), channel(4)];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/u.exec(text);
  if (rgb === null) return null;
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

/** A decoded RGBA capture, as pngjs returns it. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export function samplePixel(image: RgbaImage, x: number, y: number): Rgb {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    throw new Error(`Sample point ${x},${y} is outside a ${image.width}x${image.height} capture.`);
  }
  const offset = (y * image.width + x) * 4;
  return [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0];
}

const formatRgb = (rgb: Rgb | null) => (rgb === null ? "unparseable" : `rgb(${rgb.join(", ")})`);

export function evaluateThemeProbe(input: {
  readonly sent: SentEmbedTheme;
  readonly observed: ObservedGuestTheme;
  readonly backgroundPixel: Rgb;
}): ThemeProbeReport {
  const { sent, observed } = input;
  const checks: Array<ThemeProbeCheck> = [];
  for (const name of EMBED_THEME_VARS) {
    const expected = sent.variables[name];
    const actual = observed.variables[name] ?? "";
    checks.push({
      name: `var ${name}`,
      expected: expected === undefined ? "(sent by the host)" : normalizeValue(expected),
      actual: normalizeValue(actual),
      passed: expected !== undefined && normalizeValue(expected) === normalizeValue(actual),
    });
  }
  const loaded = new Set(observed.loadedFamilies);
  for (const family of parseFontFaceFamilies(sent.fontsCss ?? "")) {
    checks.push({
      name: `font loaded ${family}`,
      expected: "loaded",
      actual: loaded.has(family) ? "loaded" : "not loaded",
      passed: loaded.has(family),
    });
  }
  for (const [role, variable, actual] of [
    ["body", "--font-sans", observed.bodyFontFamily],
    ["mono text", "--font-mono", observed.monoFontFamily],
  ] as const) {
    const expected = firstFontFamily(sent.variables[variable] ?? "");
    checks.push({
      name: `${role} font-family`,
      expected: expected === "" ? `(first family of ${variable})` : expected,
      actual: firstFontFamily(actual),
      passed: expected !== "" && expected === firstFontFamily(actual),
    });
  }
  const background = parseCssColor(sent.variables["--background"] ?? "");
  checks.push({
    name: "pane background pixel",
    expected: formatRgb(background),
    actual: formatRgb(input.backgroundPixel),
    passed:
      background !== null &&
      background.every((channel, index) => channel === input.backgroundPixel[index]),
  });
  return { passed: checks.every((check) => check.passed), checks };
}

/** The part of a Playwright Page (or an adapter over a guest's CDP session) the probe uses. */
export interface GuestEvaluator {
  evaluate<Result, Arg>(fn: (arg: Arg) => Result | Promise<Result>, arg: Arg): Promise<Result>;
}

interface GuestStyle {
  getPropertyValue(name: string): string;
  readonly fontFamily: string;
}
interface GuestElement {
  remove(): void;
  textContent: string | null;
}
interface GuestFontFace {
  readonly family: string;
  readonly status: string;
}
interface GuestDocument {
  readonly documentElement: GuestElement;
  readonly body: GuestElement & { append(node: GuestElement): void };
  readonly fonts: Iterable<GuestFontFace> & { readonly ready: Promise<unknown> };
  querySelector(selector: string): GuestElement | null;
  createElement(tag: string): GuestElement;
}
interface GuestGlobal {
  readonly document: GuestDocument;
  getComputedStyle(element: GuestElement): GuestStyle;
}

/** Runs inside the guest; it must not close over anything from this module. */
function readGuestTheme(variables: ReadonlyArray<string>) {
  const guest = globalThis as unknown as GuestGlobal;
  const doc = guest.document;
  return doc.fonts.ready.then(() => {
    const rootStyle = guest.getComputedStyle(doc.documentElement);
    const values: Record<string, string> = {};
    for (const name of variables) values[name] = rootStyle.getPropertyValue(name);
    const loadedFamilies = [...doc.fonts]
      .filter((face) => face.status === "loaded")
      .map((face) => face.family.replace(/^(["'])(.*)\1$/su, "$2"));
    let mono = doc.querySelector("code, pre, kbd, samp");
    let created = false;
    if (mono === null) {
      mono = doc.createElement("code");
      mono.textContent = "0";
      doc.body.append(mono);
      created = true;
    }
    const monoFontFamily = guest.getComputedStyle(mono).fontFamily;
    if (created) mono.remove();
    return {
      variables: values,
      loadedFamilies,
      bodyFontFamily: guest.getComputedStyle(doc.body).fontFamily,
      monoFontFamily,
    } satisfies ObservedGuestTheme;
  });
}

export function collectGuestTheme(guest: GuestEvaluator): Promise<ObservedGuestTheme> {
  return guest.evaluate(readGuestTheme, [...EMBED_THEME_VARS]);
}
