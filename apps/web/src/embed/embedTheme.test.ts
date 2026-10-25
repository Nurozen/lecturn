// @effect-diagnostics nodeBuiltinImport:off - reads the embed-host's verbatim RocketWright token file.
import * as NodeFS from "node:fs";

import { EMBED_THEME_VARS, type EmbedHostContext } from "@lecturn/contracts/embedBridge";
import { htmlRenderTheme } from "@lecturn/shared/htmlRender";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getStandardThemeColors } from "../themePalette";
import {
  type EmbedDocument,
  getEmbedTheme,
  installEmbedTheme,
  parseFontFaceCss,
  subscribeEmbedTheme,
  withEmbedHostTheme,
} from "./embedTheme";

// The token file RocketWright generates (D17, decision 14): its full variable set plus fonts.
const rocketwright = JSON.parse(
  NodeFS.readFileSync(
    new URL("../../../../examples/embed-host/src/rocketwright-theme.json", import.meta.url),
    "utf8",
  ),
) as { variables: Record<string, string>; fontsCss: string };

const hostContext = (overrides: Partial<EmbedHostContext> = {}): EmbedHostContext => ({
  theme: "dark",
  displayMode: "inline",
  locale: "en-US",
  styles: { variables: rocketwright.variables, css: { fonts: rocketwright.fontsCss } },
  ...overrides,
});

function fakeStyle(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    colorScheme: "",
    get length() {
      return values.size;
    },
    item: (index: number) => [...values.keys()][index] ?? "",
    setProperty: (name: string, value: string | null) => {
      values.set(name, value ?? "");
    },
    removeProperty: (name: string) => {
      const previous = values.get(name) ?? "";
      values.delete(name);
      return previous;
    },
  };
}

class FakeFontFace {
  readonly status: string = "unloaded";
  readonly load = vi.fn(() => Promise.resolve(this));
  constructor(
    readonly family: string,
    readonly source: string,
    readonly descriptors: FontFaceDescriptors,
  ) {}
}

function fakeDocument() {
  const classes = new Set<string>();
  const fonts = new Set<FakeFontFace>();
  const root = {
    dataset: { themeId: "lecturn-chat", themeSelected: "true" } as Record<string, string>,
    classList: {
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    // What the index.html boot script and useTheme leave on the root of a Lecturn tab.
    style: fakeStyle({
      "--app-theme-canvas": "#061522",
      "--boot-background": "#061522",
      "background-color": "#061522",
      "--chat-content-max-width": "48rem",
    }),
  };
  const body = { style: fakeStyle({ "background-color": "#061522" }) };
  const doc = {
    documentElement: root,
    body,
    fonts: {
      add: (face: FontFace) => {
        fonts.add(face as unknown as FakeFontFace);
        return doc.fonts as unknown as FontFaceSet;
      },
      delete: (face: FontFace) => fonts.delete(face as unknown as FakeFontFace),
    },
  };
  return { doc: doc as unknown as EmbedDocument, root, body, classes, fonts };
}

function fakeBridge(initial: EmbedHostContext | null) {
  let listener: ((context: EmbedHostContext) => void) | null = null;
  return {
    hostContext: () => initial,
    subscribeHostContext: (next: (context: EmbedHostContext) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    send: (context: EmbedHostContext) => listener?.(context),
  };
}

beforeEach(() => {
  vi.stubGlobal("FontFace", FakeFontFace);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installEmbedTheme", () => {
  it("puts every allowlisted variable the host sent on the root, exactly as sent", () => {
    const { doc, root, classes } = fakeDocument();
    installEmbedTheme(fakeBridge(hostContext()), doc);

    for (const name of EMBED_THEME_VARS) {
      expect(root.style.values.get(name), name).toBe(rocketwright.variables[name]);
    }
    expect(root.style.values.get("--background")).toBe("#1b1e20");
    expect(classes.has("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
    expect(root.dataset.lecturnEmbed).toBe("");
  });

  it("drops the user's Lecturn theme from the root and keeps unrelated inline state", () => {
    const { doc, root, body } = fakeDocument();
    installEmbedTheme(null, doc);

    expect(root.dataset.themeId).toBeUndefined();
    expect(root.dataset.themeSelected).toBeUndefined();
    expect(root.style.values.has("--app-theme-canvas")).toBe(false);
    expect(root.style.values.has("--boot-background")).toBe(false);
    expect(root.style.values.has("background-color")).toBe(false);
    expect(body.style.values.has("background-color")).toBe(false);
    expect(root.style.values.get("--chat-content-max-width")).toBe("48rem");
    expect(root.dataset.lecturnEmbed).toBe("");
  });

  it("follows host-context changes: appearance, removed variables and new values", () => {
    const { doc, root, classes } = fakeDocument();
    const bridge = fakeBridge(null);
    installEmbedTheme(bridge, doc);
    expect(root.style.values.has("--background")).toBe(false);

    bridge.send(hostContext());
    bridge.send(
      hostContext({
        theme: "light",
        styles: { variables: { "--background": "#ffffff", "--primary": "#0f766e" } },
      }),
    );

    expect(classes.has("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.values.get("--background")).toBe("#ffffff");
    expect(root.style.values.get("--primary")).toBe("#0f766e");
    expect(root.style.values.has("--card")).toBe(false);
    expect(getEmbedTheme()).toEqual({
      appearance: "light",
      variables: { "--background": "#ffffff", "--primary": "#0f766e" },
    });
  });

  it("loads every sent font face up front and replaces them only when the fonts change", () => {
    const { doc, fonts } = fakeDocument();
    const bridge = fakeBridge(hostContext());
    installEmbedTheme(bridge, doc);

    const first = [...fonts];
    expect(first.map((face) => face.family).toSorted()).toEqual(
      parseFontFaceCss(rocketwright.fontsCss)
        .map((face) => face.family)
        .toSorted(),
    );
    expect(new Set(first.map((face) => face.family))).toEqual(new Set(["Inter", "JetBrains Mono"]));
    for (const face of first) expect(face.load).toHaveBeenCalledOnce();

    bridge.send(hostContext({ theme: "light" }));
    expect([...fonts]).toEqual(first);

    bridge.send(hostContext({ styles: { variables: rocketwright.variables } }));
    expect(fonts.size).toBe(0);
  });

  it("stops following the host once uninstalled", () => {
    const { doc, root } = fakeDocument();
    const bridge = fakeBridge(null);
    const uninstall = installEmbedTheme(bridge, doc);
    uninstall();
    bridge.send(hostContext());
    expect(root.style.values.has("--background")).toBe(false);
  });

  it("tells subscribers when the host theme changes", () => {
    const { doc } = fakeDocument();
    const listener = vi.fn();
    const unsubscribe = subscribeEmbedTheme(listener);
    installEmbedTheme(fakeBridge(hostContext()), doc);
    unsubscribe();
    expect(listener).toHaveBeenCalledOnce();
    expect(getEmbedTheme()?.appearance).toBe("dark");
  });
});

describe("parseFontFaceCss", () => {
  it("keeps data: sources whole, though they contain semicolons", () => {
    const faces = parseFontFaceCss(rocketwright.fontsCss);
    expect(faces.length).toBeGreaterThanOrEqual(3);
    for (const face of faces) {
      expect(face.source).toMatch(/^url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\)/u);
      expect(rocketwright.fontsCss).toContain(face.source);
    }
    expect(
      faces.filter((face) => face.family === "Inter").map((face) => face.descriptors.weight),
    ).toEqual(expect.arrayContaining(["400", "600"]));
  });

  it("reads quoting, descriptors and comments the way CSS does", () => {
    expect(
      parseFontFaceCss(
        "/* sans */ @font-face { font-family: 'RW Sans'; font-style: italic; font-weight: 300 700;" +
          ' unicode-range: U+0000-00FF; src: url("data:font/woff2;base64,AA==") format("woff2"); }' +
          "@font-face{font-family:RW Mono;src:url(data:font/woff2;base64,BB==)}" +
          "@font-face{font-weight:400}",
      ),
    ).toEqual([
      {
        family: "RW Sans",
        source: 'url("data:font/woff2;base64,AA==") format("woff2")',
        descriptors: { style: "italic", weight: "300 700", unicodeRange: "U+0000-00FF" },
      },
      { family: "RW Mono", source: "url(data:font/woff2;base64,BB==)", descriptors: {} },
    ]);
  });
});

describe("withEmbedHostTheme", () => {
  it("gives cards the host's tokens, its primary as their brand accent", () => {
    const base = htmlRenderTheme(getStandardThemeColors("dark"), "dark");
    const theme = withEmbedHostTheme(base, {
      appearance: "dark",
      variables: rocketwright.variables,
    });

    expect(theme.appearance).toBe("dark");
    expect(theme.variables["--background"]).toBe("#1b1e20");
    expect(theme.variables["--radius"]).toBe("6px");
    expect(theme.variables["--accent"]).toBe(rocketwright.variables["--primary"]);
    expect(theme.variables["--accent-foreground"]).toBe(
      rocketwright.variables["--primary-foreground"],
    );
    expect(theme.variables["--accent-surface"]).toBe(rocketwright.variables["--accent"]);
    expect(theme.variables["--success"]).toBe(base.variables["--success"]);
  });
});
