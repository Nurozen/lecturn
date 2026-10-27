import { assert, it } from "vite-plus/test";

import {
  EMBED_THEME_VARS,
  evaluateThemeProbe,
  type ObservedGuestTheme,
  parseCssColor,
  parseFontFaceFamilies,
  samplePixel,
  type SentEmbedTheme,
} from "./themeProbe.ts";

const FONTS_CSS = [
  '@font-face { font-family: "RW Sans"; font-weight: 400; src: url(data:font/woff2;base64,AAAA) format("woff2"); }',
  "@font-face { font-family: 'RW Sans'; font-weight: 600; src: url(data:font/woff2;base64,BBBB); }",
  "@font-face{font-family:RW Mono;src:url(data:font/woff2;base64,CCCC)}",
].join("\n");

const SENT: SentEmbedTheme = {
  variables: {
    ...Object.fromEntries(EMBED_THEME_VARS.map((name) => [name, "#2a2f33"])),
    "--background": "#1b1e20",
    "--radius": "0.5rem",
    "--font-sans": '"RW Sans", ui-sans-serif, system-ui',
    "--font-mono": '"RW Mono", ui-monospace',
  },
  fontsCss: FONTS_CSS,
};

const OBSERVED: ObservedGuestTheme = {
  variables: { ...SENT.variables, "--font-sans": '"RW Sans",  ui-sans-serif, system-ui' },
  loadedFamilies: ["RW Sans", "RW Sans", "RW Mono"],
  bodyFontFamily: '"RW Sans", ui-sans-serif, system-ui',
  monoFontFamily: '"RW Mono", ui-monospace',
};

const failed = (report: ReturnType<typeof evaluateThemeProbe>) =>
  report.checks.filter((check) => !check.passed).map((check) => check.name);

it("passes when every sent variable, font and the background pixel match", () => {
  const report = evaluateThemeProbe({
    sent: SENT,
    observed: OBSERVED,
    backgroundPixel: [27, 30, 32],
  });
  assert.deepEqual(failed(report), []);
  assert.isTrue(report.passed);
  assert.equal(
    report.checks.filter((check) => check.name.startsWith("var ")).length,
    EMBED_THEME_VARS.length,
  );
});

it("fails a token that differs by one channel, in the variable and in the pixel", () => {
  const report = evaluateThemeProbe({
    sent: SENT,
    observed: { ...OBSERVED, variables: { ...OBSERVED.variables, "--ring": "#2a2f34" } },
    backgroundPixel: [27, 30, 33],
  });
  assert.isFalse(report.passed);
  assert.deepEqual(failed(report), ["var --ring", "pane background pixel"]);
});

it("fails a sent font that is not loaded or not used", () => {
  const notLoaded = evaluateThemeProbe({
    sent: SENT,
    observed: { ...OBSERVED, loadedFamilies: ["RW Sans"] },
    backgroundPixel: [27, 30, 32],
  });
  assert.deepEqual(failed(notLoaded), ["font loaded RW Mono"]);
  const notUsed = evaluateThemeProbe({
    sent: SENT,
    observed: { ...OBSERVED, monoFontFamily: "ui-monospace, monospace" },
    backgroundPixel: [27, 30, 32],
  });
  assert.deepEqual(failed(notUsed), ["mono text font-family"]);
});

it("fails an allowlisted variable the host never sent", () => {
  const { "--accent": _accent, ...partial } = SENT.variables;
  const report = evaluateThemeProbe({
    sent: { ...SENT, variables: partial },
    observed: OBSERVED,
    backgroundPixel: [27, 30, 32],
  });
  assert.deepEqual(failed(report), ["var --accent"]);
});

it("parses font-face families and css colors", () => {
  assert.deepEqual(parseFontFaceFamilies(FONTS_CSS), ["RW Sans", "RW Mono"]);
  assert.deepEqual(parseCssColor("#1B1E20"), [27, 30, 32]);
  assert.deepEqual(parseCssColor("#fff"), [255, 255, 255]);
  assert.deepEqual(parseCssColor("rgb(27, 30, 32)"), [27, 30, 32]);
  assert.deepEqual(parseCssColor("rgb(27 30 32 / 50%)"), [27, 30, 32]);
  assert.isNull(parseCssColor("oklch(0.2 0.01 250)"));
});

it("samples the capture at the given point", () => {
  const capture = { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4) };
  capture.data.set([27, 30, 32, 255], (2 * 4 + 1) * 4);
  assert.deepEqual(samplePixel(capture, 1, 2), [27, 30, 32]);
  assert.throws(() => samplePixel(capture, 4, 0), /outside/u);
});
