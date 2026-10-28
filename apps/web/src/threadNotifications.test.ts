import { AppId } from "@lecturn/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  revealNotifiedAppThread,
  threadNotificationApp,
  threadNotificationTitle,
} from "./threadNotifications";
import { useThreadSelectionStore } from "./threadSelectionStore";
import { useUiStateStore } from "./uiStateStore";

const SOUND_SECONDS = 0.6;

const audio = { currentTime: 0, started: 0 };

class FakeAudioContext {
  state = "running";
  destination = {};
  get currentTime() {
    return audio.currentTime;
  }
  resume() {
    return Promise.resolve();
  }
  decodeAudioData() {
    return Promise.resolve({ duration: SOUND_SECONDS });
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {
        audio.started += 1;
      },
    };
  }
}

async function loadUnlocked() {
  const notifications = await import("./threadNotifications");
  notifications.unlockNotificationAudio();
  return notifications;
}

beforeEach(() => {
  vi.resetModules();
  audio.currentTime = 0;
  audio.started = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playNotificationSound", () => {
  it("plays one sound for threads that complete together", async () => {
    const { playNotificationSound } = await loadUnlocked();

    // All four are waiting on the first decode when the sound becomes playable.
    await Promise.all(
      Array.from({ length: 4 }, () => playNotificationSound("completion", () => true)),
    );

    expect(audio.started).toBe(1);
  });

  it("skips a completion that lands while the sound is still playing", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);

    audio.currentTime = SOUND_SECONDS / 2;
    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(1);
  });

  it("plays again once the previous sound has ended", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);

    audio.currentTime = SOUND_SECONDS;
    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(2);
  });

  it("still plays an input alert over a completion sound", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);

    await playNotificationSound("input", () => true);

    expect(audio.started).toBe(2);
  });

  it("leaves the slot free when a sound is turned off before it plays", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => false);

    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(1);
  });
});

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
