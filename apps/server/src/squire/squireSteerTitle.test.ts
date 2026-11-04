import type { ThreadPullRequestLink } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { squireSteerTitle } from "./squireSteerTitle.ts";

const steer =
  "api-e2e is failing on #321. Rerun it with verbose logging, find the first failing assertion, and fix it without changing the rounding behavior you just shipped.";

const pr = (
  snapshot: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> | null,
): Pick<ThreadPullRequestLink, "number" | "snapshot"> => ({
  number: 321,
  snapshot:
    snapshot === null
      ? null
      : {
          state: "open",
          title: "Fix invoice rounding",
          headBranch: "fix/invoice-rounding",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-11-01T10:00:00.000Z",
          ...snapshot,
        },
});

describe("squireSteerTitle", () => {
  it("names the project, the PR, and what changed, never the steer itself", () => {
    expect(
      squireSteerTitle({
        project: "billing-service",
        threadTitle: "Fix invoice rounding",
        pullRequest: pr({ checksState: "failing", reviewDecision: "approved" }),
        steerKind: "fix-failing-check",
        steer,
      }),
    ).toBe("billing-service #321: required checks failing");
    expect(
      squireSteerTitle({
        project: "billing-service",
        threadTitle: "Fix invoice rounding",
        pullRequest: pr({ reviewDecision: "changes-requested" }),
        steerKind: "address-review",
        steer,
      }),
    ).toBe("billing-service #321: changes requested");
  });

  it("falls back to the steer kind when the PR shows nothing, then to the thread", () => {
    expect(
      squireSteerTitle({
        project: "billing-service",
        threadTitle: "Fix invoice rounding",
        pullRequest: pr({ checksState: "passing" }),
        steerKind: "rebase",
        steer,
      }),
    ).toBe("billing-service #321: needs a rebase");
    expect(
      squireSteerTitle({
        project: "billing-service",
        threadTitle: "Fix invoice rounding",
        pullRequest: null,
        steerKind: "continue",
        steer,
      }),
    ).toBe("Fix invoice rounding: continue");
  });

  it("uses the steer's first line only when nothing else names the card", () => {
    expect(
      squireSteerTitle({
        project: "",
        threadTitle: "",
        pullRequest: null,
        steerKind: "other",
        steer: "Rebase onto main.\nThen rerun.",
      }),
    ).toBe("Rebase onto main.");
  });
});
