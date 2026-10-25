import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  EMBED_FONTS_CSS_MAX_BYTES,
  EMBED_GUEST_NOTIFICATIONS,
  EMBED_GUEST_REQUESTS,
  EMBED_HOST_NOTIFICATIONS,
  EMBED_MAX_MESSAGE_BYTES,
  EMBED_THEME_VARS,
  EmbedHostContext,
  EmbedInitializeParams,
  EmbedInitializeResult,
  EmbedJsonRpcMessage,
  checkEmbedMessageSize,
  embedInitializeParams,
  embedInitializeResult,
  isDataUrlFontFaceCss,
  utf8ByteLength,
} from "./embedBridge.ts";

const decodeInitializeParams = Schema.decodeUnknownSync(EmbedInitializeParams);
const decodeHostContext = Schema.decodeUnknownSync(EmbedHostContext);
const encodeInitializeResult = Schema.encodeSync(EmbedInitializeResult);
const isTurnState = Schema.is(EMBED_GUEST_NOTIFICATIONS["lecturn/turn.state"]);

const fontFace = (family: string, base64: string) =>
  `@font-face { font-family: "${family}"; font-weight: 400; src: url("data:font/woff2;base64,${base64}") format("woff2"); }`;

// The largest fonts payload the schema admits, as base64 woff2 data.
const maxFonts = () => {
  const overhead = utf8ByteLength(fontFace("Inter", ""));
  return fontFace("Inter", "A".repeat(EMBED_FONTS_CSS_MAX_BYTES - overhead));
};

const themeVariables = Object.fromEntries(
  EMBED_THEME_VARS.map((name) => [
    name,
    name.startsWith("--font")
      ? '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
      : name === "--radius"
        ? "0.5rem"
        : "oklch(0.2101 0.0068 236.95 / 0.92)",
  ]),
);

describe("JSON-RPC envelope", () => {
  const decode = Schema.decodeUnknownSync(EmbedJsonRpcMessage);

  it("tells requests, responses, errors and notifications apart", () => {
    expect(decode({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} })).toHaveProperty(
      "id",
      1,
    );
    expect(decode({ jsonrpc: "2.0", id: "a", result: {} })).toHaveProperty("result");
    expect(
      decode({ jsonrpc: "2.0", id: null, error: { code: -32002, message: "not initialized" } }),
    ).toHaveProperty("error.code", -32002);
    const notification = decode({ jsonrpc: "2.0", method: "lecturn/ready", params: {} });
    expect("id" in notification).toBe(false);
  });

  it("refuses non-2.0 and id-less responses", () => {
    expect(() => decode({ jsonrpc: "1.0", id: 1, method: "x" })).toThrow();
    expect(() => decode({ jsonrpc: "2.0", result: {} })).toThrow();
    expect(() => decode({ jsonrpc: "2.0", id: Number.NaN, result: {} })).toThrow();
  });
});

describe("handshake", () => {
  it("advertises the Lecturn dialect under experimental capabilities", () => {
    const params = decodeInitializeParams(embedInitializeParams());
    expect(params).toEqual({
      protocolVersion: "2026-01-26",
      appCapabilities: { experimental: { lecturn: { version: 1 } } },
    });
  });

  it("fits a host context with every theme variable and the largest fonts allowed", () => {
    const hostContext = decodeHostContext({
      theme: "dark",
      displayMode: "inline",
      locale: "en-US",
      styles: { variables: themeVariables, css: { fonts: maxFonts() } },
    });
    expect(Object.keys(hostContext.styles?.variables ?? {})).toHaveLength(EMBED_THEME_VARS.length);
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: encodeInitializeResult(embedInitializeResult(hostContext)),
    };
    const check = checkEmbedMessageSize(response);
    expect(check.fits).toBe(true);
    expect(check.bytes).toBeGreaterThan(EMBED_FONTS_CSS_MAX_BYTES);
  });

  it("names the size of a message over the envelope limit", () => {
    const check = checkEmbedMessageSize({ text: "x".repeat(EMBED_MAX_MESSAGE_BYTES) });
    expect(check.fits).toBe(false);
    if (!check.fits) expect(check.message).toContain(`${check.bytes} bytes`);
    expect(checkEmbedMessageSize({ big: 1n }).fits).toBe(false);
  });
});

describe("host theme", () => {
  const decode = Schema.decodeUnknownSync(EmbedHostContext);

  it("drops variables outside the allowlist instead of applying them", () => {
    const context = decode({
      theme: "light",
      displayMode: "inline",
      locale: "en",
      styles: { variables: { "--background": "#1b1e20", "--lecturn-thread-gold": "red" } },
    });
    expect(context.styles?.variables).toEqual({ "--background": "#1b1e20" });
  });

  it("caps fonts at 200 KB of UTF-8", () => {
    const base = { theme: "dark", displayMode: "inline", locale: "en" };
    expect(() => decode({ ...base, styles: { css: { fonts: maxFonts() } } })).not.toThrow();
    expect(() => decode({ ...base, styles: { css: { fonts: `${maxFonts()} ` } } })).toThrow();
  });

  it.each([
    ["one data-url face", fontFace("Inter", "d09GMgABAAAAA"), true],
    [
      "two faces with a comment",
      `/* Latin subset */ ${fontFace("Inter", "AAAA")}\n${fontFace("Mono", "BBBB")}`,
      true,
    ],
    ["unquoted data url", "@font-face{font-family:x;src:url(data:font/woff2;base64,AAAA)}", true],
    ["a network source", '@font-face{font-family:x;src:url("https://cdn.example/x.woff2")}', false],
    ["a relative source", "@font-face{font-family:x;src:url(/fonts/x.woff2)}", false],
    ["only local sources", '@font-face{font-family:x;src:local("Inter")}', false],
    ["a style rule beside the face", `${fontFace("Inter", "AAAA")} body { color: red }`, false],
    ["an import", `@import url("data:text/css,body{}"); ${fontFace("Inter", "AAAA")}`, false],
    ["nothing", "", false],
  ])("fonts css with %s: %s", (_label, css, accepted) => {
    expect(isDataUrlFontFaceCss(css)).toBe(accepted);
  });
});

describe("method payloads", () => {
  it("decodes one valid message for every method in each direction", () => {
    const samples: Record<string, unknown> = {
      "ui/initialize": embedInitializeParams(),
      "ui/open-link": { url: "rw:c/fins" },
      "lecturn/token.refresh": {},
      "ui/notifications/initialized": {},
      "ui/notifications/size-changed": { height: 640 },
      "lecturn/navigate": { ref: "rw:c/fins" },
      "lecturn/thread.changed": { threadId: null },
      "lecturn/turn.state": { threadId: "t", state: "awaiting-approval" },
      "lecturn/ready": { threadId: "t" },
      "ui/notifications/host-context-changed": { theme: "light" },
      "lecturn/composer.insertMention": { ref: "rw:c/fins", label: "Fins" },
      "lecturn/composer.setDraft": { text: "Size the fins" },
      "lecturn/thread.open": { threadId: "t" },
      "lecturn/thread.new": { title: "Fins", appData: '{"artifact":"fins"}' },
      "lecturn/providers.open": {},
    };
    const schemas = {
      ...Object.fromEntries(
        Object.entries(EMBED_GUEST_REQUESTS).map(([method, { params }]) => [method, params]),
      ),
      ...EMBED_GUEST_NOTIFICATIONS,
      ...EMBED_HOST_NOTIFICATIONS,
    };
    expect(Object.keys(schemas).sort()).toEqual(Object.keys(samples).sort());
    for (const [method, schema] of Object.entries(schemas)) {
      expect(Schema.is(schema as Schema.Top)(samples[method]), method).toBe(true);
    }
  });

  it("caps new-thread app data at 1 KB like the server does", () => {
    const is = Schema.is(EMBED_HOST_NOTIFICATIONS["lecturn/thread.new"]);
    expect(is({ appData: "x".repeat(1024) })).toBe(true);
    expect(is({ appData: "x".repeat(1025) })).toBe(false);
    expect(isTurnState({ threadId: "t", state: "busy" })).toBe(false);
  });
});
