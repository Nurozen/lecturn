import { describe, expect, it } from "vite-plus/test";

import {
  appLinkFromPath,
  appLinkPath,
  appLinkPathFromUrl,
  parseAppDeepLink,
  parseAppsSidebarSearch,
} from "./appLinks.ts";

describe("parseAppDeepLink", () => {
  it("reads the app and optional thread", () => {
    expect(parseAppDeepLink(new URL("lecturn://apps/com.rocketwright.app"))).toEqual({
      appId: "com.rocketwright.app",
    });
    expect(
      parseAppDeepLink(new URL("lecturn-dev://apps/com.rocketwright.app/threads/env-1/thread-1/")),
    ).toEqual({
      appId: "com.rocketwright.app",
      thread: { environmentId: "env-1", threadId: "thread-1" },
    });
  });

  it("rejects other hosts, invalid app ids and partial thread paths", () => {
    expect(parseAppDeepLink(new URL("lecturn://threads/env-1/thread-1"))).toBeNull();
    expect(parseAppDeepLink(new URL("lecturn://apps"))).toBeNull();
    expect(parseAppDeepLink(new URL("lecturn://apps/rocketwright"))).toBeNull();
    expect(parseAppDeepLink(new URL("lecturn://apps/Com.Rocketwright"))).toBeNull();
    expect(parseAppDeepLink(new URL(`lecturn://apps/a.${"b".repeat(127)}`))).toBeNull();
    expect(parseAppDeepLink(new URL("lecturn://apps/com.rw/threads/env-1"))).toBeNull();
    expect(parseAppDeepLink(new URL("lecturn://apps/com.rw/settings"))).toBeNull();
    expect(parseAppDeepLink(new URL("lecturn://apps/com.rw/threads/env-1/thread-1/x"))).toBeNull();
  });
});

describe("app link paths", () => {
  it("maps an app to its route and a thread to the thread route in Apps mode", () => {
    expect(appLinkPath({ appId: "com.rw" })).toBe("/apps/com.rw");
    expect(appLinkPath({ appId: "com.rw" }, "?x=1")).toBe("/apps/com.rw?x=1");
    expect(
      appLinkPath({ appId: "com.rw", thread: { environmentId: "env-1", threadId: "thread-1" } }),
    ).toBe("/env-1/thread-1?sidebar=apps&app=com.rw");
    expect(appLinkPathFromUrl(new URL("lecturn://apps/com.rw/threads/env-1/thread-1?x=1"))).toBe(
      "/env-1/thread-1?x=1&sidebar=apps&app=com.rw",
    );
    expect(appLinkPathFromUrl(new URL("lecturn://apps/rw"))).toBeNull();
  });

  it("rebuilds the deep link from an app path", () => {
    expect(appLinkFromPath("/apps/com.rw")).toBe("lecturn://apps/com.rw");
    expect(appLinkFromPath("/apps/com.rw?x=1", "lecturn-dev")).toBe(
      "lecturn-dev://apps/com.rw?x=1",
    );
    expect(appLinkFromPath("/env-1/thread-1?sidebar=apps&app=com.rw")).toBe(
      "lecturn://apps/com.rw/threads/env-1/thread-1",
    );
    expect(appLinkFromPath("/env-1/thread-1?x=1&sidebar=apps&app=com.rw")).toBe(
      "lecturn://apps/com.rw/threads/env-1/thread-1?x=1",
    );
  });

  it("leaves every other path alone", () => {
    expect(appLinkFromPath("/new?prompt=hi")).toBeNull();
    expect(appLinkFromPath("/env-1/thread-1")).toBeNull();
    expect(appLinkFromPath("/env-1/thread-1?app=com.rw")).toBeNull();
    expect(appLinkFromPath("/env-1/thread-1?sidebar=apps")).toBeNull();
    expect(appLinkFromPath("/env-1/thread-1?sidebar=apps&app=bad")).toBeNull();
    expect(appLinkFromPath("/apps/bad")).toBeNull();
  });

  it("round trips both link forms", () => {
    for (const link of [
      "lecturn://apps/com.rw",
      "lecturn://apps/com.rw/threads/env-1/thread-1",
      "lecturn://apps/com.rw/threads/env-1/thread-1?x=1",
    ]) {
      const path = appLinkPathFromUrl(new URL(link));
      expect(path).not.toBeNull();
      expect(appLinkFromPath(path ?? "")).toBe(link);
    }
  });
});

describe("parseAppsSidebarSearch", () => {
  it("reads the mode and the app to select", () => {
    expect(parseAppsSidebarSearch("?sidebar=apps&app=com.rw")).toEqual({
      mode: "apps",
      appId: "com.rw",
    });
    expect(parseAppsSidebarSearch("?sidebar=apps")).toEqual({ mode: "apps", appId: null });
    expect(parseAppsSidebarSearch("?sidebar=projects&app=com.rw")).toEqual({
      mode: "projects",
      appId: null,
    });
  });

  it("ignores queries without a known mode and drops invalid app ids", () => {
    expect(parseAppsSidebarSearch("")).toBeNull();
    expect(parseAppsSidebarSearch("?app=com.rw")).toBeNull();
    expect(parseAppsSidebarSearch("?sidebar=settings")).toBeNull();
    expect(parseAppsSidebarSearch("?sidebar=apps&app=Not%20An%20App")).toEqual({
      mode: "apps",
      appId: null,
    });
  });

  it("reads the query a thread deep link opens", () => {
    const path = appLinkPath({
      appId: "com.rw",
      thread: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(parseAppsSidebarSearch(new URL(path, "https://app.invalid").search)).toEqual({
      mode: "apps",
      appId: "com.rw",
    });
  });
});
