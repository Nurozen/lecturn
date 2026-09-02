import { describe, expect, it } from "@effect/vitest";

import { extractToolActivityPresentation } from "./toolPresentation.ts";

describe("extractToolActivityPresentation", () => {
  it("preserves explicit source metadata and theme-specific logos", () => {
    expect(
      extractToolActivityPresentation({
        toolSurface: "browser",
        toolSource: {
          key: "integration:example",
          name: "Example",
          kind: "integration",
          icon: {
            _tag: "themed-logo",
            logoUrl: "https://example.com/logo-light.png",
            logoUrlDark: "https://example.com/logo-dark.png",
          },
        },
      }),
    ).toEqual({
      toolSurface: "browser",
      toolSource: {
        key: "integration:example",
        name: "Example",
        kind: "integration",
        icon: {
          _tag: "themed-logo",
          logoUrl: "https://example.com/logo-light.png",
          logoUrlDark: "https://example.com/logo-dark.png",
        },
      },
    });
  });

  it("recovers the page and theme-specific favicons from older raw Codex events", () => {
    expect(
      extractToolActivityPresentation({
        data: {
          item: {
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "browserUse",
                  screenshot: {
                    pageUrl: "https://example.com/docs",
                    favIconUrl: "https://example.com/icon.png",
                    favIconUrlDark: "https://example.com/icon-dark.png",
                  },
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      toolSurface: "browser",
      toolIcon: {
        _tag: "website",
        pageUrl: "https://example.com/docs",
        faviconUrl: "https://example.com/icon.png",
        faviconUrlDark: "https://example.com/icon-dark.png",
      },
      toolSource: { key: "browser-use:browser", name: "Browser", kind: "browser" },
    });
  });

  it("keeps raw browser favicons associated with their page", () => {
    const presentation = extractToolActivityPresentation({
      data: {
        item: {
          result: {
            _meta: {
              "codex/toolSurface": {
                kind: "browserUse",
                screenshot: { pageUrl: "https://first.example/page" },
              },
              browser_use: {
                url: "https://second.example/page",
                faviconUrl: "https://second.example/favicon.png",
              },
            },
          },
        },
      },
    });

    expect(presentation).toMatchObject({
      toolIcon: { _tag: "website", pageUrl: "https://first.example/page" },
    });
    expect(presentation.toolIcon).not.toHaveProperty("faviconUrl");
  });

  it("prefers an explicit icon over raw browser fallback metadata", () => {
    expect(
      extractToolActivityPresentation({
        toolSurface: "browser",
        toolIcon: {
          _tag: "themed-logo",
          logoUrl: "https://example.com/logo.png",
        },
        data: {
          item: {
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "browserUse",
                  screenshot: { pageUrl: "https://example.com/page" },
                },
              },
            },
          },
        },
      }).toolIcon,
    ).toEqual({ _tag: "themed-logo", logoUrl: "https://example.com/logo.png" });
  });

  it("prefers an explicit icon over matching raw computer metadata", () => {
    expect(
      extractToolActivityPresentation({
        toolSurface: "computer",
        toolIcon: {
          _tag: "themed-logo",
          logoUrl: "https://example.com/editor.png",
        },
        data: {
          item: {
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "computerUse",
                  app: { kind: "appId", appId: "com.example.Editor" },
                },
              },
            },
          },
        },
      }).toolIcon,
    ).toEqual({ _tag: "themed-logo", logoUrl: "https://example.com/editor.png" });
  });

  it("honors an explicit surface over conflicting legacy metadata", () => {
    expect(
      extractToolActivityPresentation({
        toolSurface: "browser",
        data: {
          item: {
            result: {
              _meta: { "codex/toolSurface": { kind: "computerUse" } },
            },
          },
        },
      }),
    ).toEqual({
      toolSurface: "browser",
      toolSource: { key: "browser-use:browser", name: "Browser", kind: "browser" },
    });
  });

  it("uses matching legacy metadata to enrich an explicit surface", () => {
    expect(
      extractToolActivityPresentation({
        toolSurface: "browser",
        data: {
          item: {
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "browserUse",
                  screenshot: {
                    pageUrl: "https://example.com/docs",
                    faviconUrl: "https://example.com/favicon.png",
                  },
                },
              },
            },
          },
        },
      }).toolIcon,
    ).toEqual({
      _tag: "website",
      pageUrl: "https://example.com/docs",
      faviconUrl: "https://example.com/favicon.png",
    });
  });

  it("recovers source logos from older raw Codex events", () => {
    expect(
      extractToolActivityPresentation({
        data: {
          item: {
            appContext: {
              appName: "Chrome",
              logoUrl: "https://example.com/chrome.png",
              logoUrlDark: "https://example.com/chrome-dark.png",
            },
            result: {
              _meta: { "codex/toolSurface": { kind: "browserUse" } },
            },
          },
        },
      }).toolSource?.icon,
    ).toEqual({
      _tag: "themed-logo",
      logoUrl: "https://example.com/chrome.png",
      logoUrlDark: "https://example.com/chrome-dark.png",
    });

    expect(
      extractToolActivityPresentation({
        data: {
          item: {
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "computerUse",
                  logoUrl: "https://example.com/editor.png",
                },
              },
            },
          },
        },
      }).toolSource?.icon,
    ).toEqual({ _tag: "themed-logo", logoUrl: "https://example.com/editor.png" });
  });

  it("recovers browser and computer identity from older raw Codex code", () => {
    expect(
      extractToolActivityPresentation({
        data: {
          item: {
            arguments: { code: "const browser = await setupBrowserRuntime();" },
          },
        },
      }),
    ).toEqual({
      toolSurface: "browser",
      toolSource: { key: "browser-use:browser", name: "Browser", kind: "browser" },
    });

    expect(
      extractToolActivityPresentation({
        data: {
          item: {
            arguments: { code: 'await sky.click({ app: "Finder" })' },
          },
        },
      }),
    ).toEqual({
      toolSurface: "computer",
      toolIcon: {
        _tag: "native-app",
        app: { _tag: "display-name", displayName: "Finder" },
      },
      toolSource: {
        key: "native-app-name:finder",
        name: "Finder",
        kind: "computer",
        icon: {
          _tag: "native-app",
          app: { _tag: "display-name", displayName: "Finder" },
        },
      },
    });
  });

  it("uses collision-resistant source keys consistently", () => {
    const presentationForApp = (displayName: string) =>
      extractToolActivityPresentation({
        data: {
          item: {
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "computerUse",
                  app: { kind: "displayName", displayName },
                },
              },
            },
          },
        },
      });

    expect(presentationForApp("Foo Bar").toolSource?.key).toBe("native-app-name:foo bar");
    expect(presentationForApp("Foo-Bar").toolSource?.key).toBe("native-app-name:foo-bar");
    expect(
      extractToolActivityPresentation({
        toolSurface: "computer",
        data: { item: { arguments: { app: "Foo Bar" } } },
      }).toolSource?.key,
    ).toBe("native-app-name:foo bar");

    const maxLengthAppId = `com.${"a".repeat(508)}`;
    expect(
      extractToolActivityPresentation({
        data: {
          item: {
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "computerUse",
                  app: { kind: "appId", appId: maxLengthAppId },
                },
              },
            },
          },
        },
      }).toolSource?.key,
    ).toHaveLength(512);
  });
});
