import {
  EMBED_THEME_VARS,
  type EmbedHostContext,
  type EmbedThemeVar,
} from "@lecturn/contracts/embedBridge";
import type { HtmlRenderTheme } from "@lecturn/shared/htmlRender";

/** What the host asked the pane to look like; null until its handshake answers. */
export interface EmbedTheme {
  readonly appearance: EmbedHostContext["theme"];
  readonly variables: Readonly<Partial<Record<EmbedThemeVar, string>>>;
}

let current: EmbedTheme | null = null;
const listeners = new Set<() => void>();

export const getEmbedTheme = (): EmbedTheme | null => current;

export function subscribeEmbedTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type RootElement = Pick<HTMLElement, "dataset" | "classList"> & {
  readonly style: Pick<
    CSSStyleDeclaration,
    "setProperty" | "removeProperty" | "length" | "item" | "colorScheme"
  >;
};

// The index.html boot script and useTheme theme the root from the user's stored Lecturn theme,
// which shares this origin; in the embed the host owns the look, so none of it may stay behind.
const ROOT_APPEARANCE_PREFIXES = ["--app-theme-", "--boot-"];

export function clearRootAppearanceOverrides(
  root: RootElement,
  body: { readonly style: Pick<CSSStyleDeclaration, "removeProperty"> } | null,
): void {
  delete root.dataset.themeId;
  delete root.dataset.themeSelected;
  const names: Array<string> = [];
  for (let index = 0; index < root.style.length; index += 1) names.push(root.style.item(index));
  for (const name of names) {
    if (ROOT_APPEARANCE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      root.style.removeProperty(name);
    }
  }
  root.style.removeProperty("background-color");
  body?.style.removeProperty("background-color");
}

/**
 * Inline properties on the root, as themePalette applies a palette: they outrank every
 * stylesheet rule for the root, so the computed tokens are exactly what the host sent.
 */
export function applyEmbedThemeToRoot(root: RootElement, theme: EmbedTheme): void {
  root.dataset.lecturnEmbed = "";
  root.classList.toggle("dark", theme.appearance === "dark");
  root.style.colorScheme = theme.appearance;
  for (const name of EMBED_THEME_VARS) {
    const value = theme.variables[name];
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}

export interface ParsedFontFace {
  readonly family: string;
  readonly source: string;
  readonly descriptors: FontFaceDescriptors;
}

const DESCRIPTOR_KEYS = {
  "font-style": "style",
  "font-weight": "weight",
  "font-stretch": "stretch",
  "unicode-range": "unicodeRange",
  "font-display": "display",
  "font-feature-settings": "featureSettings",
} satisfies Record<string, keyof FontFaceDescriptors>;

const isDescriptorKey = (name: string): name is keyof typeof DESCRIPTOR_KEYS =>
  Object.hasOwn(DESCRIPTOR_KEYS, name);

// A data: URL carries `;` (`data:font/woff2;base64,`), so declarations split only outside
// parentheses and strings.
function splitDeclarations(body: string): Array<string> {
  const declarations: Array<string> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      declarations.push(body.slice(start, index));
      start = index + 1;
    }
  }
  declarations.push(body.slice(start));
  return declarations;
}

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/su, "$2");

/**
 * `styles.css.fonts` decoded by the contract holds only `@font-face` rules with data: sources.
 * They become FontFace objects that load immediately, so a family is ready even before any text
 * on the page uses it.
 */
export function parseFontFaceCss(css: string): Array<ParsedFontFace> {
  const faces: Array<ParsedFontFace> = [];
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//gu, " ");
  for (const block of uncommented.matchAll(/@font-face\s*\{([^{}]*)\}/giu)) {
    let family: string | null = null;
    let source: string | null = null;
    const descriptors: Record<string, string> = {};
    for (const declaration of splitDeclarations(block[1] ?? "")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      const name = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (value === "") continue;
      if (name === "font-family") family = unquote(value);
      else if (name === "src") source = value;
      else if (isDescriptorKey(name)) descriptors[DESCRIPTOR_KEYS[name]] = value;
    }
    if (family !== null && source !== null) faces.push({ family, source, descriptors });
  }
  return faces;
}

type FontSet = Pick<FontFaceSet, "add" | "delete">;

const appliedFonts = new WeakMap<FontSet, { css: string; faces: Array<FontFace> }>();

function applyEmbedFonts(fonts: FontSet, css = ""): void {
  const applied = appliedFonts.get(fonts);
  if (applied?.css === css || (applied === undefined && css === "")) return;
  for (const face of applied?.faces ?? []) fonts.delete(face);
  const faces = parseFontFaceCss(css).map((parsed) => {
    const face = new FontFace(parsed.family, parsed.source, parsed.descriptors);
    fonts.add(face);
    // A face that fails to decode falls back to the next family in --font-sans or --font-mono.
    face.load().catch(() => undefined);
    return face;
  });
  appliedFonts.set(fonts, { css, faces });
}

/**
 * Cards sit on the host's surface, so they take its tokens. A card's `--accent` is the brand color
 * (HTML_RENDER_THEME_GUIDE), which is the host's `--primary`; the host's `--accent` is a hover
 * surface, which cards call `--accent-surface`. Tokens the host has no say over (status colors,
 * charts) keep Lecturn's values for the host's appearance.
 */
export function withEmbedHostTheme(theme: HtmlRenderTheme, embed: EmbedTheme): HtmlRenderTheme {
  const {
    "--accent": surface,
    "--accent-foreground": surfaceForeground,
    ...shared
  } = embed.variables;
  const brand = embed.variables["--primary"];
  const brandForeground = embed.variables["--primary-foreground"];
  return {
    appearance: embed.appearance,
    variables: {
      ...theme.variables,
      ...shared,
      ...(brand === undefined ? {} : { "--accent": brand, "--chart-1": brand }),
      ...(brandForeground === undefined ? {} : { "--accent-foreground": brandForeground }),
      ...(surface === undefined ? {} : { "--accent-surface": surface }),
      ...(surfaceForeground === undefined
        ? {}
        : { "--accent-surface-foreground": surfaceForeground }),
    },
  };
}

export function embedThemeFromHostContext(context: EmbedHostContext): EmbedTheme {
  return { appearance: context.theme, variables: context.styles?.variables ?? {} };
}

export interface EmbedDocument {
  readonly documentElement: RootElement;
  readonly body: { readonly style: Pick<CSSStyleDeclaration, "removeProperty"> } | null;
  readonly fonts: FontSet;
}

export function applyEmbedHostContext(doc: EmbedDocument, context: EmbedHostContext): void {
  clearRootAppearanceOverrides(doc.documentElement, doc.body);
  const theme = embedThemeFromHostContext(context);
  applyEmbedThemeToRoot(doc.documentElement, theme);
  applyEmbedFonts(doc.fonts, context.styles?.css?.fonts);
  current = theme;
  for (const listener of listeners) listener();
}

interface HostContextSource {
  readonly hostContext: () => EmbedHostContext | null;
  readonly subscribeHostContext: (listener: (context: EmbedHostContext) => void) => () => void;
}

/** Themes the embed document from the host's context, now and on every change. */
export function installEmbedTheme(
  bridge: HostContextSource | null,
  doc: EmbedDocument = document,
): () => void {
  doc.documentElement.dataset.lecturnEmbed = "";
  clearRootAppearanceOverrides(doc.documentElement, doc.body);
  if (bridge === null) return () => undefined;
  const context = bridge.hostContext();
  if (context !== null) applyEmbedHostContext(doc, context);
  return bridge.subscribeHostContext((next) => applyEmbedHostContext(doc, next));
}
