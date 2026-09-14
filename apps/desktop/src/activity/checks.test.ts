import { describe, expect, it } from "vite-plus/test";
import { activityCheckSummary, activityCheckTally } from "./checks.ts";

describe("activity CI jobs", () => {
  it("shows running jobs and failures alongside completed jobs", () => {
    expect(
      activityCheckSummary({
        checks: [
          { name: "Server", status: "pending" },
          { name: "Web", status: "failure" },
          { name: "Rust", status: "success" },
          { name: "Mobile", status: "skipped" },
        ],
      }),
    ).toEqual({
      pending: 1,
      total: 4,
      unknown: 0,
      label: "4 CI jobs · 1 running / queued · 1 need attention · 1 passed",
    });
  });
  it("does not claim undisplayed jobs have finished", () => {
    expect(
      activityCheckSummary({ checks: [{ name: "Rust", status: "success" }], checkTotal: 51 }),
    ).toEqual({ pending: 0, total: 51, unknown: 50, label: "51 CI jobs · 1 passed" });
  });
});

it("never labels cancelled or skipped jobs as passed in the compact tally", () => {
  expect(
    activityCheckTally({
      checks: [
        { name: "lint", status: "success" },
        { name: "mobile", status: "skipped" },
      ],
    }),
  ).toBe("✓ 1/2");
  expect(activityCheckTally({ checks: [{ name: "test", status: "cancelled" }] })).toBe("− 1");
  expect(activityCheckTally({ checks: [{ name: "review", status: "action-required" }] })).toBe(
    "! 1",
  );
});
