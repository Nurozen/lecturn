import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import { allowanceWindow } from "./DecisionsAccess.ts";
const seconds = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso)) / 1000;
const dates = (anchor: string, now: string) => {
  const window = allowanceWindow(seconds(anchor), seconds(now));
  return [window.start, window.end].map((value) =>
    DateTime.formatIso(DateTime.makeUnsafe(value * 1000)),
  );
};
describe("monthly Decisions allowance anniversaries", () => {
  it("clamps January 31 to February then restores March 31 without drift", () => {
    expect(dates("2025-01-31T12:30:00Z", "2025-02-28T12:30:00Z")).toEqual([
      "2025-02-28T12:30:00.000Z",
      "2025-03-31T12:30:00.000Z",
    ]);
    expect(dates("2025-01-31T12:30:00Z", "2025-03-30T12:30:00Z")).toEqual([
      "2025-02-28T12:30:00.000Z",
      "2025-03-31T12:30:00.000Z",
    ]);
  });
  it("uses leap days and monthly windows for annual subscriptions across years", () => {
    expect(dates("2023-01-31T01:02:03Z", "2024-02-29T01:02:03Z")).toEqual([
      "2024-02-29T01:02:03.000Z",
      "2024-03-31T01:02:03.000Z",
    ]);
    expect(dates("2024-02-29T01:02:03Z", "2025-02-28T01:02:02Z")).toEqual([
      "2025-01-29T01:02:03.000Z",
      "2025-02-28T01:02:03.000Z",
    ]);
    expect(dates("2024-02-29T01:02:03Z", "2025-02-28T01:02:03Z")).toEqual([
      "2025-02-28T01:02:03.000Z",
      "2025-03-29T01:02:03.000Z",
    ]);
  });
  it("rejects invalid or not-yet-started anchors", () => {
    expect(() => allowanceWindow(0, 1)).toThrow();
    expect(() => allowanceWindow(10, 9)).toThrow();
  });
});
