import { AppId, type AppStatus } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyAppStatusStreamEvent, EMPTY_APP_STATUSES } from "./apps.ts";

function status(appId: string, overrides: Partial<AppStatus> = {}): AppStatus {
  return {
    appId: AppId.make(appId),
    name: appId,
    iconDataUrl: "data:image/png;base64,AA==",
    toolPrefix: "ex",
    refPrefixes: ["ex:"],
    openUrlTemplate: null,
    state: "granted",
    live: null,
    lastSeenAt: null,
    runtimeCeiling: null,
    headlessTools: null,
    gatedTools: [],
    embedOrigins: [],
    pendingRequest: null,
    ...overrides,
  };
}

describe("applyAppStatusStreamEvent", () => {
  it("folds a snapshot, upserts and removals into the current app list", () => {
    const rocket = status("dev.example.rocket");
    const counter = status("dev.example.counter");
    const snapshot = applyAppStatusStreamEvent(EMPTY_APP_STATUSES, {
      type: "snapshot",
      apps: [rocket, counter],
    });
    expect(snapshot).toEqual([rocket, counter]);

    const revoked = status("dev.example.rocket", { state: "revoked" });
    const updated = applyAppStatusStreamEvent(snapshot, { type: "upsert", app: revoked });
    expect(updated).toEqual([revoked, counter]);
    expect(snapshot).toEqual([rocket, counter]);

    const added = status("dev.example.flash", { state: "pairing-requested" });
    const withNew = applyAppStatusStreamEvent(updated, { type: "upsert", app: added });
    expect(withNew.map((app) => app.appId)).toEqual([
      "dev.example.rocket",
      "dev.example.counter",
      "dev.example.flash",
    ]);

    const removed = applyAppStatusStreamEvent(withNew, {
      type: "remove",
      appId: AppId.make("dev.example.counter"),
    });
    expect(removed).toEqual([revoked, added]);
  });

  it("replaces the whole list on a later snapshot, as after a reconnect", () => {
    const stale = [status("dev.example.rocket"), status("dev.example.counter")];
    const fresh = [status("dev.example.counter", { state: "denied" })];
    expect(applyAppStatusStreamEvent(stale, { type: "snapshot", apps: fresh })).toBe(fresh);
  });
});
