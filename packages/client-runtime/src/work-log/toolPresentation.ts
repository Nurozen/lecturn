import type {
  ToolActivityIcon,
  ToolActivityNativeAppReference,
  ToolActivitySource,
  ToolActivitySurface,
} from "@t3tools/contracts";

export interface ExtractedToolActivityPresentation {
  readonly toolSurface?: ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
  readonly toolSource?: ToolActivitySource;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function imageUrl(value: unknown): string | undefined {
  const raw = trimmedString(value, 4096);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function pageUrl(value: unknown): string | undefined {
  const raw = trimmedString(value, 4096);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function nativeAppReference(value: unknown): ToolActivityNativeAppReference | undefined {
  const app = asRecord(value);
  const appId = trimmedString(app?.appId, 512);
  if (
    (app?._tag === "app-id" || app?.kind === "appId") &&
    appId &&
    /^[A-Za-z0-9._-]+$/u.test(appId)
  ) {
    return { _tag: "app-id", appId };
  }
  const displayName = trimmedString(app?.displayName, 160);
  if ((app?._tag === "display-name" || app?.kind === "displayName") && displayName) {
    return { _tag: "display-name", displayName };
  }
  return undefined;
}

function browserName(value: unknown): string | undefined {
  const displayName = trimmedString(value, 160);
  const normalized = displayName?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("chrome") || normalized === "chromium") return "Chrome";
  if (normalized.includes("edge")) return "Microsoft Edge";
  if (normalized.includes("firefox")) return "Firefox";
  if (normalized.includes("safari")) return "Safari";
  if (normalized.includes("arc")) return "Arc";
  if (normalized === "iab" || normalized.includes("in-app")) return "Browser";
  return displayName;
}

function browserApp(name: string): ToolActivityNativeAppReference | undefined {
  switch (name) {
    case "Chrome":
      return { _tag: "display-name", displayName: "Google Chrome" };
    case "Microsoft Edge":
    case "Firefox":
    case "Safari":
    case "Arc":
      return { _tag: "display-name", displayName: name };
    default:
      return undefined;
  }
}

function knownAppName(appId: string): string | undefined {
  const names: Readonly<Record<string, string>> = {
    "com.apple.finder": "Finder",
    "com.apple.safari": "Safari",
    "com.google.chrome": "Chrome",
    "com.microsoft.edgemac": "Microsoft Edge",
    "org.mozilla.firefox": "Firefox",
    "company.thebrowser.browser": "Arc",
  };
  return names[appId.toLowerCase()];
}

function sourceKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

function invocationNativeAppReference(
  args: Record<string, unknown> | undefined,
): ToolActivityNativeAppReference | undefined {
  const explicit =
    nativeAppReference(args?.app) ??
    nativeAppReference({ kind: "appId", appId: args?.appId }) ??
    nativeAppReference({ kind: "displayName", displayName: args?.appName ?? args?.application });
  if (explicit) return explicit;
  const directName = trimmedString(typeof args?.app === "string" ? args.app : undefined, 160);
  if (directName) return { _tag: "display-name", displayName: directName };
  const code = typeof args?.code === "string" ? args.code : "";
  const codeName = /\bapp\s*:\s*["'](?<name>[^"'\r\n]{1,160})["']/u.exec(code)?.groups?.name;
  const displayName = trimmedString(codeName, 160);
  return displayName ? { _tag: "display-name", displayName } : undefined;
}

function activityIcon(value: unknown): ToolActivityIcon | undefined {
  const icon = asRecord(value);
  if (icon?._tag === "website") {
    const resolvedPageUrl = pageUrl(icon.pageUrl);
    const faviconUrl = imageUrl(icon.faviconUrl);
    const faviconUrlDark = imageUrl(icon.faviconUrlDark);
    if (resolvedPageUrl) {
      return {
        _tag: "website",
        pageUrl: resolvedPageUrl,
        ...(faviconUrl ? { faviconUrl } : {}),
        ...(faviconUrlDark ? { faviconUrlDark } : {}),
      };
    }
  }
  if (icon?._tag === "native-app") {
    const app =
      nativeAppReference(icon.app) ?? nativeAppReference({ _tag: "app-id", appId: icon.appId });
    if (app) return { _tag: "native-app", app };
  }
  if (icon?._tag === "themed-logo") {
    const logoUrl = imageUrl(icon.logoUrl);
    const logoUrlDark = imageUrl(icon.logoUrlDark);
    if (logoUrl) {
      return {
        _tag: "themed-logo",
        logoUrl,
        ...(logoUrlDark ? { logoUrlDark } : {}),
      };
    }
  }
  return undefined;
}

function activitySource(value: unknown): ToolActivitySource | undefined {
  const source = asRecord(value);
  const key = trimmedString(source?.key, 512);
  const name = trimmedString(source?.name, 160);
  const kind = source?.kind;
  if (!key || !name || (kind !== "browser" && kind !== "computer" && kind !== "integration")) {
    return undefined;
  }
  const icon = activityIcon(source?.icon);
  return { key, name, kind, ...(icon ? { icon } : {}) };
}

function themedLogoIcon(
  ...values: ReadonlyArray<unknown>
): Extract<ToolActivityIcon, { readonly _tag: "themed-logo" }> | undefined {
  for (const value of values) {
    const record = asRecord(value);
    const logoUrl = imageUrl(record?.logoUrl);
    if (!logoUrl) continue;
    const logoUrlDark = imageUrl(record?.logoUrlDark ?? record?.logoDarkUrl);
    return {
      _tag: "themed-logo",
      logoUrl,
      ...(logoUrlDark ? { logoUrlDark } : {}),
    };
  }
  return undefined;
}

/**
 * Reads the provider-neutral fields first, then falls back to raw Codex metadata
 * so a newer client still presents existing threads written by an older server.
 */
export function extractToolActivityPresentation(
  payloadValue: unknown,
): ExtractedToolActivityPresentation {
  const payload = asRecord(payloadValue);
  const explicitSurface =
    payload?.toolSurface === "browser" || payload?.toolSurface === "computer"
      ? payload.toolSurface
      : undefined;
  const explicitIcon = activityIcon(payload?.toolIcon);
  const explicitSource = activitySource(payload?.toolSource);
  if (explicitSurface && explicitSource) {
    return {
      toolSurface: explicitSurface,
      ...(explicitIcon ? { toolIcon: explicitIcon } : {}),
      toolSource: explicitSource,
    };
  }

  const item = asRecord(asRecord(payload?.data)?.item);
  const metadata = asRecord(asRecord(item?.result)?._meta);
  const rawSurface = asRecord(metadata?.["codex/toolSurface"]);
  const surface =
    explicitSurface === undefined ||
    (explicitSurface === "browser" && rawSurface?.kind === "browserUse") ||
    (explicitSurface === "computer" && rawSurface?.kind === "computerUse")
      ? rawSurface
      : undefined;
  const sourceLogo = themedLogoIcon(
    surface,
    asRecord(metadata?.source),
    asRecord(item?.appContext),
  );
  if (surface?.kind === "browserUse") {
    const screenshot = asRecord(surface.screenshot);
    const browserUse = asRecord(metadata?.browser_use);
    const tabs = Array.isArray(surface.openTabs) ? surface.openTabs.map(asRecord).toReversed() : [];
    const selectedPage = [
      { record: screenshot, url: screenshot?.pageUrl },
      { record: browserUse, url: browserUse?.url },
      ...tabs.map((tab) => ({ record: tab, url: tab?.url })),
    ]
      .map((candidate) => ({ ...candidate, pageUrl: pageUrl(candidate.url) }))
      .find((candidate) => candidate.pageUrl !== undefined);
    const resolvedPageUrl = selectedPage?.pageUrl;
    const faviconUrl = imageUrl(
      selectedPage?.record?.faviconUrl ?? selectedPage?.record?.favIconUrl,
    );
    const faviconUrlDark = imageUrl(
      selectedPage?.record?.faviconUrlDark ?? selectedPage?.record?.favIconUrlDark,
    );
    const name =
      browserName(asRecord(item?.appContext)?.appName) ??
      browserName(surface.browserFamily) ??
      browserName(surface.backend) ??
      "Browser";
    const nativeBrowserApp = browserApp(name);
    return {
      toolSurface: "browser",
      ...(explicitIcon
        ? { toolIcon: explicitIcon }
        : resolvedPageUrl
          ? {
              toolIcon: {
                _tag: "website",
                pageUrl: resolvedPageUrl,
                ...(faviconUrl ? { faviconUrl } : {}),
                ...(faviconUrlDark ? { faviconUrlDark } : {}),
              },
            }
          : {}),
      toolSource:
        explicitSource ??
        ({
          key: `browser-use:${sourceKeyPart(name) || "browser"}`,
          name,
          kind: name === "Browser" ? "browser" : "integration",
          ...(sourceLogo
            ? { icon: sourceLogo }
            : nativeBrowserApp
              ? { icon: { _tag: "native-app", app: nativeBrowserApp } as const }
              : {}),
        } satisfies ToolActivitySource),
    };
  }
  if (surface?.kind === "computerUse") {
    const app = nativeAppReference(surface.app);
    const args = asRecord(item?.arguments);
    const name =
      trimmedString(asRecord(item?.appContext)?.appName, 160) ??
      trimmedString(args?.appName, 160) ??
      trimmedString(args?.application, 160) ??
      trimmedString(typeof args?.app === "string" ? args.app : undefined, 160) ??
      (app?._tag === "display-name" ? app.displayName : undefined) ??
      (app?._tag === "app-id" ? knownAppName(app.appId) : undefined) ??
      "Computer Use";
    return {
      toolSurface: "computer",
      ...(app
        ? { toolIcon: { _tag: "native-app", app } }
        : explicitIcon
          ? { toolIcon: explicitIcon }
          : {}),
      toolSource:
        explicitSource ??
        ({
          key:
            app?._tag === "app-id"
              ? `native-app:${app.appId.toLowerCase()}`
              : app?._tag === "display-name"
                ? `native-app-name:${app.displayName.toLowerCase()}`
                : "computer-use",
          name,
          kind: "computer",
          ...(sourceLogo
            ? { icon: sourceLogo }
            : app
              ? { icon: { _tag: "native-app", app } as const }
              : {}),
        } satisfies ToolActivitySource),
    };
  }
  if (explicitSurface === "computer" && !explicitSource) {
    const app = invocationNativeAppReference(asRecord(item?.arguments));
    const name =
      (app?._tag === "display-name" ? app.displayName : undefined) ??
      (app?._tag === "app-id" ? knownAppName(app.appId) : undefined) ??
      "Computer Use";
    return {
      toolSurface: "computer",
      ...(explicitIcon
        ? { toolIcon: explicitIcon }
        : app
          ? { toolIcon: { _tag: "native-app", app } }
          : {}),
      toolSource: {
        key:
          app?._tag === "app-id"
            ? `native-app:${app.appId.toLowerCase()}`
            : app?._tag === "display-name"
              ? `native-app-name:${sourceKeyPart(app.displayName)}`
              : "computer-use",
        name,
        kind: "computer",
        ...(app ? { icon: { _tag: "native-app", app } } : {}),
      },
    };
  }
  if (explicitSurface === "browser" && !explicitSource) {
    return {
      toolSurface: "browser",
      ...(explicitIcon ? { toolIcon: explicitIcon } : {}),
      toolSource: { key: "browser-use:browser", name: "Browser", kind: "browser" },
    };
  }
  return {
    ...(explicitSurface ? { toolSurface: explicitSurface } : {}),
    ...(explicitIcon ? { toolIcon: explicitIcon } : {}),
    ...(explicitSource ? { toolSource: explicitSource } : {}),
  };
}
