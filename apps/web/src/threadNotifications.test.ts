import { AppId } from "@lecturn/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  revealNotifiedAppThread,
  threadNotificationApp,
  threadNotificationTitle,
} from "./threadNotifications";
import { useThreadSelectionStore } from "./threadSelectionStore";
import { useUiStateStore } from "./uiStateStore";

const ROCKETWRIGHT = AppId.make("dev.rocketwright");
const OTHER = AppId.make("dev.other");
const appProject = { appBinding: { appId: ROCKETWRIGHT, workspaceRoot: "/work/rocket" } };

describe("threadNotificationApp", () => {
  it("names the app bound to the thread's project", () => {
    const app = threadNotificationApp(appProject, [
      { appId: OTHER, name: "Other" },
      { appId: ROCKETWRIGHT, name: "RocketWright" },
    ]);
    expect(app).toEqual({ appId: ROCKETWRIGHT, name: "RocketWright" });
    expect(threadNotificationTitle("Approval needed", app)).toBe("RocketWright: Approval needed");
  });

  it("falls back to the app id when no status names it", () => {
    const app = threadNotificationApp(appProject, []);
    expect(threadNotificationTitle("Thread completed", app)).toBe(
      "dev.rocketwright: Thread completed",
    );
  });

  it("leaves project threads and unloaded projects untitled", () => {
    expect(threadNotificationApp({}, [{ appId: ROCKETWRIGHT, name: "RocketWright" }])).toBeNull();
    expect(threadNotificationApp(undefined, [])).toBeNull();
    expect(threadNotificationTitle("Thread completed", null)).toBe("Thread completed");
  });
});

describe("revealNotifiedAppThread", () => {
  beforeEach(() => {
    useUiStateStore.setState({ sidebarMode: "projects", sidebarAppScopeKey: null });
    useThreadSelectionStore.getState().clearSelection();
  });

  it("switches the sidebar to Apps scoped to the thread's app", () => {
    useThreadSelectionStore.getState().toggleThread("env-1:selected");
    revealNotifiedAppThread({ appId: ROCKETWRIGHT, name: "RocketWright" });
    expect(useUiStateStore.getState()).toMatchObject({
      sidebarMode: "apps",
      sidebarAppScopeKey: ROCKETWRIGHT,
    });
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
  });

  it("moves an Apps sidebar scoped to another app", () => {
    useUiStateStore.setState({ sidebarMode: "apps", sidebarAppScopeKey: OTHER });
    revealNotifiedAppThread({ appId: ROCKETWRIGHT, name: "RocketWright" });
    expect(useUiStateStore.getState().sidebarAppScopeKey).toBe(ROCKETWRIGHT);
  });

  it("keeps Projects mode for a project thread", () => {
    revealNotifiedAppThread(null);
    expect(useUiStateStore.getState()).toMatchObject({
      sidebarMode: "projects",
      sidebarAppScopeKey: null,
    });
  });
});
