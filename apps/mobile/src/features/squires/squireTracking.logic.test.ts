import type { SquireEnvironmentState } from "@lecturn/client-runtime/state/squire";
import type { SquireGrantInput } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  squiresWithThreadDecisions,
  squireThreadTracking,
  squireTrackingActions,
} from "./squireTracking.logic";

const thread = { id: "thread-1", projectId: "project-1" };
const target = { threadId: "thread-1", projectId: "project-1" };

function state(
  squires: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly role?: "lead" | "squire";
    readonly lifecycle?: string;
    readonly grants?: ReadonlyArray<SquireGrantInput>;
    readonly openDecisionCount?: number;
  }>,
  lead: string | null = null,
): SquireEnvironmentState {
  // Only the fields tracking reads; the rest of a snapshot entry is irrelevant here.
  return {
    lead,
    rooms: [],
    squires: squires.map((squire) => ({
      squire: {
        id: squire.id,
        name: squire.name,
        role: squire.role ?? "squire",
        lifecycle: squire.lifecycle ?? "ready",
        grants: squire.grants ?? [],
      },
      openDecisionCount: squire.openDecisionCount ?? 0,
    })),
  } as unknown as SquireEnvironmentState;
}

describe("squireThreadTracking", () => {
  it("tracks a thread through its own grant or its project's", () => {
    expect(squireThreadTracking([{ kind: "thread", targetId: "thread-1" }], target)).toBe(
      "tracked",
    );
    expect(squireThreadTracking([{ kind: "project", targetId: "project-1" }], target)).toBe(
      "tracked",
    );
    expect(squireThreadTracking([{ kind: "project", targetId: "project-2" }], target)).toBe(
      "untracked",
    );
  });

  it("lets an exclusion on the thread beat every grant, as the server does", () => {
    expect(
      squireThreadTracking(
        [
          { kind: "project", targetId: "project-1" },
          { kind: "thread", targetId: "thread-1" },
          { kind: "exclusion", targetId: "thread-1" },
        ],
        target,
      ),
    ).toBe("untracked");
  });

  it("cannot tell whether a Stave space or saga covers the thread", () => {
    expect(squireThreadTracking([{ kind: "staveSpace", targetId: "space-1" }], target)).toBe(
      "unknown",
    );
    expect(
      squireThreadTracking(
        [
          { kind: "staveSaga", targetId: "saga-1" },
          { kind: "thread", targetId: "thread-1" },
        ],
        target,
      ),
    ).toBe("tracked");
  });
});

describe("squireTrackingActions", () => {
  it("offers Track or Stop tracking per non-Lead Squire, by name", () => {
    const environment = state(
      [
        { id: "lead", name: "Lead", role: "lead" },
        { id: "release", name: "Release", grants: [{ kind: "project", targetId: "project-1" }] },
        { id: "docs", name: "docs" },
        { id: "stave", name: "Stave", grants: [{ kind: "staveSpace", targetId: "space-1" }] },
        { id: "gone", name: "Gone", lifecycle: "deleting" },
      ],
      "lead",
    );
    expect(squireTrackingActions(environment, thread)).toEqual([
      { kind: "track", squireId: "docs", label: "Track with docs" },
      { kind: "untrack", squireId: "release", label: "Stop tracking with Release" },
      { kind: "track", squireId: "stave", label: "Track with Stave" },
    ]);
  });

  it("never offers tracking on a Squire's own threads", () => {
    const environment = state([{ id: "release", name: "Release" }]);
    expect(
      squireTrackingActions(environment, {
        ...thread,
        squire: { squireId: "release", role: "home" },
      }),
    ).toEqual([]);
    expect(
      squireTrackingActions(environment, {
        ...thread,
        squire: { squireId: "release", role: "probe" },
      }),
    ).toEqual([]);
    expect(squireTrackingActions(null, thread)).toEqual([]);
  });
});

describe("squiresWithThreadDecisions", () => {
  it("queries only Squires that may track the thread and have open decisions", () => {
    const environment = state([
      {
        id: "release",
        name: "Release",
        grants: [{ kind: "thread", targetId: "thread-1" }],
        openDecisionCount: 2,
      },
      {
        id: "idle",
        name: "Idle",
        grants: [{ kind: "thread", targetId: "thread-1" }],
        openDecisionCount: 0,
      },
      {
        id: "elsewhere",
        name: "Elsewhere",
        grants: [{ kind: "project", targetId: "project-2" }],
        openDecisionCount: 4,
      },
      {
        id: "stave",
        name: "Stave",
        grants: [{ kind: "staveSaga", targetId: "saga-1" }],
        openDecisionCount: 1,
      },
    ]);
    expect(squiresWithThreadDecisions(environment, thread)).toEqual([
      { squireId: "release", name: "Release" },
      { squireId: "stave", name: "Stave" },
    ]);
  });
});
