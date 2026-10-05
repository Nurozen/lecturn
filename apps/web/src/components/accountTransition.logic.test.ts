import { describe, expect, it } from "vite-plus/test";
import {
  accountWavePath,
  ACCOUNT_KNOCK_MS,
  ACCOUNT_TRANSITION_MS,
  ACCOUNT_WAVE_MS,
  shouldAnimateAccountSelection,
} from "./accountTransition.logic";

describe("account selection wave", () => {
  it("holds the boundary at the sidebar until the card impact", () => {
    const start = accountWavePath(1000, 800, 400, 0);
    expect(accountWavePath(1000, 800, 400, ACCOUNT_KNOCK_MS)).toEqual(start);
    expect(start.progress).toBe(0);
    expect(start.edge.startsWith("M -1 0")).toBe(true);
  });
  it("bends at the clicked card height and propagates across the pane", () => {
    const middle = accountWavePath(1000, 800, 400, ACCOUNT_KNOCK_MS + ACCOUNT_WAVE_MS / 2);
    expect(middle.progress).toBeCloseTo(0.5);
    const coordinates = [...middle.edge.matchAll(/-?\d+(?:\.\d+)?/g)].map(([value]) =>
      Number(value),
    );
    expect(coordinates[0]).toBeGreaterThan(0);
    expect(coordinates[0]).toBeLessThan(1000);
    expect(coordinates[6]).toBeGreaterThan(coordinates[4]!);
    expect(coordinates[5]).toBeLessThan(middle.bendY);
    expect(coordinates[9]).toBeGreaterThan(middle.bendY);
    expect(accountWavePath(1000, 800, 620, ACCOUNT_KNOCK_MS + ACCOUNT_WAVE_MS / 2).edge).not.toBe(
      middle.edge,
    );
  });
  it("settles beyond the right edge and clamps late frames", () => {
    const end = accountWavePath(1000, 800, 400, ACCOUNT_TRANSITION_MS);
    expect(end.progress).toBe(1);
    expect(end.edge.startsWith("M 1139 0")).toBe(true);
    expect(accountWavePath(1000, 800, 400, 99999)).toEqual(end);
  });
});

describe("selection boundaries", () => {
  const here = { project: "env:project", account: "one" };
  it("does not animate sibling threads or projects within the same account", () => {
    expect(shouldAnimateAccountSelection(false, here, here)).toBe(false);
    expect(shouldAnimateAccountSelection(true, here, { ...here, project: "env:other" })).toBe(
      false,
    );
  });
  it("animates project changes without multiple accounts, and ownership changes with them", () => {
    expect(shouldAnimateAccountSelection(false, here, { ...here, project: "env:other" })).toBe(
      true,
    );
    expect(shouldAnimateAccountSelection(true, here, { ...here, account: "two" })).toBe(true);
    expect(shouldAnimateAccountSelection(true, here, { project: "local:project" })).toBe(true);
  });
  it("skips unresolved project changes", () => {
    expect(shouldAnimateAccountSelection(false, {}, here)).toBe(false);
  });
  it("propagates the bend toward the edge on the side where impact began", () => {
    const early = ACCOUNT_KNOCK_MS + 200;
    const late = ACCOUNT_KNOCK_MS + 900;
    expect(accountWavePath(1000, 800, 200, late).bendY).toBeLessThan(
      accountWavePath(1000, 800, 200, early).bendY,
    );
    expect(accountWavePath(1000, 800, 600, late).bendY).toBeGreaterThan(
      accountWavePath(1000, 800, 600, early).bendY,
    );
  });
});
