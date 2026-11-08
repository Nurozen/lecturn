import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import {
  AppId,
  EnvironmentId,
  SquireCardId,
  SquireId,
  SquireSnapshot,
  ThreadId,
  type SquireActionLogKind,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  revealNotifiedAppThread,
  reportSquireAlert,
  squireNotificationIntents,
  squireNotificationTag,
  threadNotificationApp,
  threadNotificationTag,
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

    await Promise.all(
      Array.from({ length: 4 }, () => playNotificationSound("completion", () => true)),
    );

    expect(audio.started).toBe(1);
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

describe("Squire notification intents", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const decode = Schema.decodeUnknownSync(SquireSnapshot);
  const entry = (
    notify: "on" | "off",
    activity: ReadonlyArray<readonly [number, SquireActionLogKind]>,
  ): SquireSnapshotEntry => ({
    ...decode({
      squire: {
        id: "release",
        role: "squire",
        name: "Release",
        lifecycle: "ready",
        status: "active",
        homeProjectId: "project",
        homeThreadId: "home",
        providerInstanceId: null,
        modelSelection: null,
        summaryModelSelection: null,
        brief: "",
        grants: [],
        permissions: { notify },
        undoWindowSeconds: 10,
        digest: null,
        sweep: null,
        onboardedAt: null,
        automationPausedAt: null,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      },
      openDecisionCount: 1,
      countsByKind: { steer: 1, question: 0, overlap: 0, proposal: 0, fyi: 0 },
      held: [],
      budget: { steersLeft: 7, threadsLeft: 3 },
      conflicts: [],
      trackedCount: 1,
      containerNames: [],
      recentActivity: activity.map(([sequence, kind]) => ({ sequence, kind, at })),
      itemsRevision: 0,
      decisionRevision: 0,
    }),
    receivedAt: 0,
  });
  const state = (squire: SquireSnapshotEntry) => ({ lead: null, squires: [squire], rooms: [] });

  it("records where it stands on first look, then notifies once per new intent", () => {
    const first = squireNotificationIntents(null, state(entry("on", [[1, "notification.pushed"]])));
    expect(first.intents).toEqual([]);
    // A steer card, then a notify-only push and a pushed digest: three intents, three alerts.
    const next = squireNotificationIntents(
      first.seen,
      state(
        entry("on", [
          [1, "notification.pushed"],
          [2, "card.created"],
          [3, "notification.pushed"],
          [4, "notification.pushed"],
          [5, "notification.pushed"],
        ]),
      ),
    );
    expect(next.intents.map((intent) => intent.sequence)).toEqual([3, 4, 5]);
    expect(next.intents[0]!.title).toContain("Release");
    expect(
      squireNotificationIntents(next.seen, state(entry("on", [[5, "notification.pushed"]])))
        .intents,
    ).toEqual([]);
  });

  it("raises nothing for a question card, which writes no intent, or with Notify Off", () => {
    const seen = squireNotificationIntents(null, state(entry("on", []))).seen;
    expect(
      squireNotificationIntents(seen, state(entry("on", [[1, "card.created"]]))).intents,
    ).toEqual([]);
    expect(
      squireNotificationIntents(seen, state(entry("off", [[2, "notification.pushed"]]))).intents,
    ).toEqual([]);
  });

  it("notifies every intent of a Squire created after the first look", () => {
    const seen = squireNotificationIntents(null, { lead: null, squires: [], rooms: [] }).seen;
    const next = squireNotificationIntents(seen, state(entry("on", [[0, "notification.pushed"]])));
    expect(next.intents).toEqual([
      { squireId: "release", sequence: 0, title: "Release", body: "1 item waits on you" },
    ]);
  });

  it("tags a Squire alert apart from a thread alert with the same id", () => {
    const environmentId = EnvironmentId.make("env");
    const squireTag = squireNotificationTag(environmentId, SquireId.make("release"));
    expect(squireTag).toMatch(/^[0-9a-f]{16}$/);
    expect(squireTag).not.toBe(threadNotificationTag(environmentId, ThreadId.make("release")));
  });
});

describe("Squire alert delivery", () => {
  const log = [
    { id: 4, kind: "notification.pushed" as const, cardId: SquireCardId.make("card-4") },
    { id: 5, kind: "card.created" as const, cardId: SquireCardId.make("card-5") },
    { id: 5, kind: "notification.pushed" as const, cardId: SquireCardId.make("card-5") },
  ];

  it("reports one shown notification as one alerted call, for its own card", async () => {
    const report = vi.fn(async () => ({}));
    expect(await reportSquireAlert({ sequence: 5 }, { readLog: async () => log, report })).toBe(
      true,
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("card-5");
  });

  it("reports nothing when the intent's log row is missing or unreadable", async () => {
    const report = vi.fn(async () => ({}));
    expect(await reportSquireAlert({ sequence: 9 }, { readLog: async () => log, report })).toBe(
      false,
    );
    expect(await reportSquireAlert({ sequence: 5 }, { readLog: async () => null, report })).toBe(
      false,
    );
    expect(report).not.toHaveBeenCalled();
  });
});
