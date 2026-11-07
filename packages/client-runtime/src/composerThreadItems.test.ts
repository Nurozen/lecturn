import { EnvironmentId, SquireId, ThreadId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerThreadItems, type ComposerThreadCandidate } from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate {
  return {
    environmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: null,
    archivedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

it("ranks thread mentions like the palette and leaves out subagent threads", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("newer-mid-word", "Remodel the settings page", {
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
      shell("word", "Fix model picker"),
      shell("subagent", "Model review", {
        lineage: {
          rootThreadId: ThreadId.make("word"),
          parentThreadId: ThreadId.make("word"),
          relationshipToParent: "subagent",
        },
      }),
      shell("other-environment", "Model docs", { environmentId: EnvironmentId.make("env-other") }),
    ],
    environmentId,
    excludeThreadId: null,
    query: "model",
    listing: null,
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map((item) => item.thread.threadId)).toEqual(["word", "newer-mid-word"]);
});

describe("matchComposerThreadItems", () => {
  it("leaves Squire threads out while the environment hides them", () => {
    const shells = [
      shell("home", "Release notes", {
        squire: { squireId: SquireId.make("sq-1"), role: "home" },
      }),
      shell("probe", "Release probe", {
        squire: { squireId: SquireId.make("sq-1"), role: "probe" },
      }),
      shell("plain", "Release checklist"),
    ];
    const ids = (listing: { squire?: boolean } | null) =>
      matchComposerThreadItems({
        shells,
        environmentId,
        excludeThreadId: null,
        query: "release",
        listing,
        now: Date.parse("2026-10-23T00:00:00.000Z"),
      }).map((item) => item.thread.threadId);
    expect(ids({ squire: true })).toEqual([ThreadId.make("plain")]);
    // With the switch off they are ordinary threads, so their history stays reachable.
    expect(ids(null)).toHaveLength(3);
  });
});
