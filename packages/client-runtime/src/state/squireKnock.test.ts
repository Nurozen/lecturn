import { EnvironmentId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createSquireKnockSession,
  randomSquireKnockPortrait,
  shouldSquireKnock,
  squireKnockHidden,
  squireKnockResetDescription,
  squireKnockSnoozedUntil,
  type SquireKnockInput,
} from "./squireKnock.ts";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");

const base: SquireKnockInput = {
  capabilities: { squireLiveSwitch: true },
  canWriteSettings: true,
  knock: { dismissed: false, snoozedUntil: "" },
  runningThreadCount: 2,
  now: NOW,
};

describe("shouldSquireKnock", () => {
  it("knocks when a busy user could turn Squires on right away", () => {
    expect(shouldSquireKnock(base)).toBe(true);
  });

  it("waits for two threads running at once", () => {
    expect(shouldSquireKnock({ ...base, runningThreadCount: 1 })).toBe(false);
  });

  it("stays away when Squires already run or the switch needs a restart", () => {
    expect(
      shouldSquireKnock({ ...base, capabilities: { squire: true, squireLiveSwitch: true } }),
    ).toBe(false);
    expect(shouldSquireKnock({ ...base, capabilities: {} })).toBe(false);
  });

  it("stays away from a client that cannot change the setting, or before settings load", () => {
    expect(shouldSquireKnock({ ...base, canWriteSettings: false })).toBe(false);
    expect(shouldSquireKnock({ ...base, knock: null })).toBe(false);
  });

  it("respects Don't show again and a snooze until it lapses", () => {
    expect(shouldSquireKnock({ ...base, knock: { dismissed: true, snoozedUntil: "" } })).toBe(
      false,
    );
    const snoozedUntil = squireKnockSnoozedUntil(NOW);
    expect(shouldSquireKnock({ ...base, knock: { dismissed: false, snoozedUntil } })).toBe(false);
    expect(
      shouldSquireKnock({
        ...base,
        knock: { dismissed: false, snoozedUntil },
        now: Date.parse(snoozedUntil) + 1,
      }),
    ).toBe(true);
  });
});

describe("squireKnockHidden", () => {
  it("snoozes for a week", () => {
    expect(squireKnockSnoozedUntil(NOW)).toBe("2026-11-12T12:00:00.000Z");
  });

  it("offers a reset only while the suggestion is hidden", () => {
    const snoozedUntil = squireKnockSnoozedUntil(NOW);
    expect(squireKnockResetDescription({ dismissed: true, snoozedUntil: "" }, NOW)).toMatch(
      /Don't show again/,
    );
    expect(squireKnockResetDescription({ dismissed: false, snoozedUntil }, NOW)).toMatch(/Not now/);
    expect(
      squireKnockResetDescription({ dismissed: false, snoozedUntil }, Date.parse(snoozedUntil)),
    ).toBeNull();
    expect(squireKnockResetDescription({ dismissed: false, snoozedUntil: "" }, NOW)).toBeNull();
  });

  it("treats an unreadable snooze as no snooze", () => {
    expect(squireKnockHidden({ dismissed: false, snoozedUntil: "soon" }, NOW)).toBe(false);
  });
});

describe("randomSquireKnockPortrait", () => {
  it("never draws the Lead's gold", () => {
    expect(randomSquireKnockPortrait(() => 0.9999)).toEqual({
      appearance: "male",
      hood: "up",
      palette: "rose",
    });
    expect(randomSquireKnockPortrait(() => 0)).toEqual({
      appearance: "female",
      hood: "down",
      palette: "brass",
    });
  });
});

describe("createSquireKnockSession", () => {
  it("knocks once per environment per session", () => {
    const session = createSquireKnockSession();
    const one = EnvironmentId.make("one");
    expect(session.claim(one)).toBe(true);
    expect(session.claim(one)).toBe(false);
    expect(session.claim(EnvironmentId.make("two"))).toBe(true);
    session.release(one);
    expect(session.claim(one)).toBe(true);
  });
});
