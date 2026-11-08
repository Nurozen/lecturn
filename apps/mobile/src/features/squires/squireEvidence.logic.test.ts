import type { SquireCardRow, SquirePermissions } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  squireCiUnavailableText,
  squireProposalScopeLabels,
  squireProposalText,
  squireRowMetaText,
  squireRowTargetName,
} from "./squireEvidence.logic";

describe("rows", () => {
  const base = {
    kind: "proposal" as const,
    targetThreadId: null,
  } satisfies Partial<SquireCardRow>;

  it("names what a proposal would create", () => {
    const thread = {
      ...base,
      proposalProvider: { provider: "codex" as never, providerInstanceId: null },
    };
    expect(squireRowTargetName(thread, { threadTitle: null, projectTitle: "web" })).toBe(
      "New thread · web",
    );
    expect(squireRowTargetName(base, { threadTitle: null, projectTitle: "web" })).toBe(
      "New Squire · web",
    );
    expect(
      squireRowTargetName(
        {
          kind: "overlap",
          targetThreadId: null,
          overlapProviders: ["codex", "claudeAgent"] as never,
        },
        { threadTitle: null, projectTitle: null },
      ),
    ).toBe("2 threads");
  });

  it("names a thread's row Thread until its title loads", () => {
    const steer = { kind: "steer" as const, targetThreadId: "t1" as never };
    expect(squireRowTargetName(steer, { threadTitle: null, projectTitle: "web" })).toBe("Thread");
    expect(squireRowTargetName(steer, { threadTitle: "Fix login", projectTitle: "web" })).toBe(
      "Fix login",
    );
  });

  it("leaves the provider off in the Lead view and drops a target that repeats the title", () => {
    expect(
      squireRowMetaText({
        kind: "Action",
        title: "Fix login",
        raiser: null,
        name: "Login thread",
        provider: "Codex",
      }),
    ).toBe("Action · Login thread · Codex");
    expect(
      squireRowMetaText({
        kind: "Action",
        title: "Fix login",
        raiser: "Release",
        name: "fix login",
        provider: "Codex",
      }),
    ).toBe("Action · Release");
  });
});

describe("evidence", () => {
  it("names the checks to open when the CI log is unavailable", () => {
    const ciLog = {
      status: "unavailable" as const,
      headSha: "abc",
      jobs: [{ name: "api-e2e", url: null }],
      truncated: false,
    };
    expect(squireCiUnavailableText(ciLog)).toBe(
      "The failing job's log could not be read; see api-e2e.",
    );
    expect(squireCiUnavailableText({ ...ciLog, status: "log" })).toBeNull();
  });
});

describe("Lead items", () => {
  it("names a proposal's scope by project, with exclusions counted", () => {
    const labels = squireProposalScopeLabels(
      [
        { kind: "project", targetId: "p1" },
        { kind: "project", targetId: "gone" },
        { kind: "staveSpace", targetId: "plaudio" },
        { kind: "exclusion", targetId: "t1" },
        { kind: "exclusion", targetId: "t2" },
      ],
      (id) => (id === "p1" ? "lecturn" : null),
    );
    expect(labels).toEqual(["lecturn", "A project", "Space plaudio", "2 threads excluded"]);
  });

  it("reads a proposal's name, palette, permissions, and brief", () => {
    const permissions: SquirePermissions = {
      steer: "recommend",
      createThread: "auto",
      notify: "off",
    };
    const text = squireProposalText(
      {
        name: " Release ",
        brief: "  ",
        grants: [],
        permissions,
        companion: {
          presence: "figure",
          appearance: "female",
          hood: "up",
          palette: "sage",
        } as never,
      },
      () => null,
    );
    expect(text).toEqual({
      name: "Release",
      scope: "No scope yet",
      palette: "Sage",
      permissions: "Create thread Auto · Notify off",
      brief: null,
    });
  });
});
