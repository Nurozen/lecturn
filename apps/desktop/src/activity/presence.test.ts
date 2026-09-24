import { describe, expect, it } from "vite-plus/test";
import type { DesktopActivityRow, DesktopActivitySnapshot } from "@lecturn/contracts";
import type { ActivityChange } from "./changes.ts";
import { ActivityAttentionGate, isUserPresent, isCurrentActivityAnnouncement } from "./presence.ts";

const row = (id: string, status: string): DesktopActivityRow => ({
  id,
  environmentId: "local",
  projectId: "p",
  threadId: id,
  title: id,
  subtitle: "main",
  status,
  actions: [],
});
const snapshot = (
  rows: DesktopActivityRow[],
  viewedThread?: DesktopActivitySnapshot["viewedThread"],
): DesktopActivitySnapshot => ({ summary: "", rows, ...(viewedThread ? { viewedThread } : {}) });
const change = (rowId: string, state: ActivityChange["state"]): ActivityChange => ({
  rowId,
  state,
  label: `${rowId} · ${state}`,
});

describe("isUserPresent", () => {
  it("requires a visible, focused window and input within the last 45 seconds", () => {
    expect(isUserPresent({ visible: true, focused: true, idleSeconds: 44 })).toBe(true);
    expect(isUserPresent({ visible: true, focused: true, idleSeconds: 45 })).toBe(false);
    expect(isUserPresent({ visible: true, focused: false, idleSeconds: 0 })).toBe(false);
    expect(isUserPresent({ visible: false, focused: true, idleSeconds: 0 })).toBe(false);
  });
});

describe("ActivityAttentionGate", () => {
  it("expires asynchronous replies before they can flash or open a stale preview", () => {
    const announcement = { change: change("a", "attention"), revision: 3 };
    const current = { ...snapshot([row("a", "Needs input")]), revision: 3 };
    expect(isCurrentActivityAnnouncement(announcement, current)).toBe(true);
    expect(isCurrentActivityAnnouncement(announcement, { ...current, revision: 4 })).toBe(false);
    expect(isCurrentActivityAnnouncement(announcement, { ...current, rows: [] })).toBe(false);
    expect(
      isCurrentActivityAnnouncement(announcement, { ...current, readyEnvironmentIds: [] }),
    ).toBe(false);
    expect(
      isCurrentActivityAnnouncement(announcement, {
        ...current,
        viewedThread: { environmentId: "local", threadId: "a" },
      }),
    ).toBe(false);
  });

  it("forgets a resolved alert even if the same state later reappears as cached data", () => {
    const gate = new ActivityAttentionGate();
    gate.offer(change("a", "attention"), true);
    gate.observe(snapshot([row("a", "Working")]));
    expect(gate.holding).toBe(false);
    gate.observe(snapshot([row("a", "Needs input")]));
    expect(gate.release(snapshot([row("a", "Needs input")]))).toBeUndefined();
  });
  it("fires immediately when the user is away and holds nothing", () => {
    const gate = new ActivityAttentionGate();
    expect(gate.offer(change("a", "attention"), false)).toBe(true);
    expect(gate.holding).toBe(false);
  });

  it("holds an alert while present and releases it exactly once", () => {
    const gate = new ActivityAttentionGate();
    expect(gate.offer(change("a", "attention"), true)).toBe(false);
    expect(gate.holding).toBe(true);
    const rows = snapshot([row("a", "Needs input")]);
    expect(gate.release(rows)).toEqual(change("a", "attention"));
    expect(gate.holding).toBe(false);
    expect(gate.release(rows)).toBeUndefined();
  });

  it("drops held alerts the user already dealt with", () => {
    const gate = new ActivityAttentionGate();
    gate.offer(change("resolved", "attention"), true);
    gate.offer(change("removed", "failed"), true);
    gate.offer(change("viewed", "complete"), true);
    expect(
      gate.release(
        snapshot([row("resolved", "Working"), row("viewed", "Completed")], {
          environmentId: "local",
          threadId: "viewed",
        }),
      ),
    ).toBeUndefined();
    expect(gate.holding).toBe(false);
  });

  it("spends a held alert when the user opens its thread, even after moving on", () => {
    const rows = [row("t", "Completed"), row("u", "Working")];
    const viewing = (threadId: string) => snapshot(rows, { environmentId: "local", threadId });

    const viewed = new ActivityAttentionGate();
    viewed.offer(change("t", "complete"), true);
    viewed.observe(viewing("u"));
    expect(viewed.holding).toBe(true);
    viewed.observe(viewing("t"));
    expect(viewed.holding).toBe(false);
    expect(viewed.release(snapshot(rows))).toBeUndefined();

    const movedOn = new ActivityAttentionGate();
    movedOn.offer(change("t", "complete"), true);
    movedOn.observe(viewing("t"));
    movedOn.observe(viewing("u"));
    expect(movedOn.release(snapshot(rows))).toBeUndefined();

    const neverViewed = new ActivityAttentionGate();
    neverViewed.offer(change("t", "complete"), true);
    neverViewed.observe(viewing("u"));
    expect(neverViewed.release(snapshot(rows))).toEqual(change("t", "complete"));
    expect(neverViewed.release(snapshot(rows))).toBeUndefined();
  });

  it("releases the most urgent of several held alerts", () => {
    const gate = new ActivityAttentionGate();
    gate.offer(change("done", "complete"), true);
    gate.offer(change("blocked", "attention"), true);
    expect(
      gate.release(snapshot([row("done", "Completed"), row("blocked", "Needs input")])),
    ).toEqual(change("blocked", "attention"));
  });

  it("does not hold progress news that is stale by the time the user looks away", () => {
    const gate = new ActivityAttentionGate();
    expect(gate.offer(change("a", "active"), true)).toBe(false);
    expect(gate.holding).toBe(false);
  });

  it("forgets a held alert once a newer change for that row fires", () => {
    const gate = new ActivityAttentionGate();
    gate.offer(change("a", "attention"), true);
    expect(gate.offer(change("a", "complete"), false)).toBe(true);
    expect(gate.release(snapshot([row("a", "Needs input")]))).toBeUndefined();
  });
});
