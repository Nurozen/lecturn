import { expect, it } from "vite-plus/test";
import { retainActivityInteractions } from "./activityRecentStore";
it("bounds and sanitizes persisted activity interaction history", () => {
  expect(retainActivityInteractions(null)).toEqual({});
  expect(
    retainActivityInteractions({ bad: "not a date", numeric: 3, okay: "2026-09-14T01:00:00Z" }),
  ).toEqual({ okay: "2026-09-14T01:00:00Z" });
  const rows = Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => [
      String(i),
      new Date(1700000000000 + i * 1000).toISOString(),
    ]),
  );
  const retained = retainActivityInteractions(rows);
  expect(Object.keys(retained)).toHaveLength(100);
  expect(retained["0"]).toBeUndefined();
  expect(retained["149"]).toBe(rows["149"]);
});
