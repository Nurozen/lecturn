import { SquireId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  canForkNow: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
    fork: false,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("gates fork on environment capability and a completed turn", () => {
    const forkableState: ThreadActionMenuState = {
      ...baseState,
      canForkNow: true,
      supports: { ...baseState.supports, fork: true },
    };
    const enabled = buildThreadActionMenuItems(forkableState).find((item) => item.id === "fork");
    expect(enabled).toMatchObject({ label: "Fork thread", disabled: false });

    const blocked = buildThreadActionMenuItems({ ...forkableState, canForkNow: false }).find(
      (item) => item.id === "fork",
    );
    expect(blocked?.disabled).toBe(true);

    expect(
      ids({ ...forkableState, supports: { ...forkableState.supports, fork: false } }),
    ).not.toContain("fork");
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});

describe("Squire track items", () => {
  const menu = (tracked: boolean) => ({
    canTrack: true,
    canUntrack: true,
    squires: [{ id: SquireId.make("release"), name: "Release", tracked }],
  });
  const squireLabels = (state: ThreadActionMenuState) =>
    buildThreadActionMenuItems(state)
      .filter((item) => item.id.startsWith("squire-"))
      .map((item) => item.label);

  it("appears only with a Squire-capable environment and on ordinary threads", () => {
    expect(squireLabels(baseState)).toEqual([]);
    expect(squireLabels({ ...baseState, squireTrack: null })).toEqual([]);
    expect(
      squireLabels({ ...baseState, squireTrack: { isSquireThread: true, menu: menu(false) } }),
    ).toEqual([]);
    expect(
      squireLabels({ ...baseState, squireTrack: { isSquireThread: false, menu: menu(false) } }),
    ).toEqual(["Track with Release"]);
  });

  it("offers Stop tracking once the thread is tracked", () => {
    expect(
      squireLabels({ ...baseState, squireTrack: { isSquireThread: false, menu: menu(true) } }),
    ).toEqual(["Stop tracking (Release)"]);
  });
});
