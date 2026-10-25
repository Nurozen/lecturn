import { AppId, type AppEmbedContext, ThreadId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { appClosedBanner } from "./useAppClosedBanner";

const ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const context = (overrides: Partial<AppEmbedContext> = {}): AppEmbedContext => ({
  appId: AppId.make("dev.rocketwright.desktop"),
  name: "RocketWright",
  iconDataUrl: ICON,
  refPrefixes: ["rw:"],
  openUrlTemplate: "rocketwright://open?workspace={workspaceRoot}&thread={threadId}",
  live: null,
  state: "granted",
  embedOrigins: [],
  ...overrides,
});

const binding = { appId: AppId.make("dev.rocketwright.desktop"), workspaceRoot: "/work/hopper 38" };
const threadId = ThreadId.make("thread-1");

describe("appClosedBanner", () => {
  it("names the app and opens it at the thread's workspace when its live lease is gone", () => {
    expect(
      appClosedBanner({ context: context(), binding, threadId, canOpenApp: true }),
    ).toStrictEqual({
      appId: "dev.rocketwright.desktop",
      title: "RocketWright closed: live tools unavailable",
      openLabel: "Open in RocketWright",
      openUrl: "rocketwright://open?workspace=%2Fwork%2Fhopper%2038&thread=thread-1",
    });
  });

  it("shows nothing while the app holds a live lease", () => {
    const live = { expiresAt: "2026-10-25T12:00:00.000Z" };
    expect(
      appClosedBanner({ context: context({ live }), binding, threadId, canOpenApp: true }),
    ).toBeNull();
  });

  it("does not trust a stale lease expiry over the server's live state", () => {
    const live = { expiresAt: "2000-01-01T00:00:00.000Z" };
    expect(
      appClosedBanner({ context: context({ live }), binding, threadId, canOpenApp: true }),
    ).toBeNull();
  });

  it.each(["revoked", "denied", "pairing-requested"] as const)(
    "shows nothing for a %s app, which is not merely closed",
    (state) => {
      expect(
        appClosedBanner({ context: context({ state }), binding, threadId, canOpenApp: true }),
      ).toBeNull();
    },
  );

  it("shows nothing for a thread outside an app project", () => {
    expect(
      appClosedBanner({ context: null, binding: null, threadId, canOpenApp: true }),
    ).toBeNull();
    expect(
      appClosedBanner({ context: context(), binding: null, threadId, canOpenApp: true }),
    ).toBeNull();
  });

  it("keeps the notice but drops Open in <App> off the server's machine", () => {
    const banner = appClosedBanner({ context: context(), binding, threadId, canOpenApp: false });
    expect(banner?.title).toBe("RocketWright closed: live tools unavailable");
    expect(banner?.openUrl).toBeNull();
  });

  it("drops Open in <App> for an app without an open URL, or one that does not parse", () => {
    for (const openUrlTemplate of [null, "not a url {workspaceRoot}"]) {
      const banner = appClosedBanner({
        context: context({ openUrlTemplate }),
        binding,
        threadId,
        canOpenApp: true,
      });
      expect(banner?.openUrl).toBeNull();
    }
  });

  it("opens a draft at its workspace alone", () => {
    expect(
      appClosedBanner({ context: context(), binding, threadId: null, canOpenApp: true })?.openUrl,
    ).toBe("rocketwright://open?workspace=%2Fwork%2Fhopper%2038&thread=");
  });
});
