import { EnvironmentId, SquireId, ThreadId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerThreadItems } from "./composerThreadItems.ts";

const env = EnvironmentId.make("env-1");
const shell = (
  id: string,
  title: string,
  overrides: Partial<Parameters<typeof matchComposerThreadItems>[0]["shells"][number]> = {},
) => ({
  environmentId: env,
  id: ThreadId.make(id),
  title,
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  ...overrides,
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
        environmentId: env,
        excludeThreadId: null,
        query: "release",
        listing,
      }).map((item) => item.thread.threadId);
    expect(ids({ squire: true })).toEqual([ThreadId.make("plain")]);
    // With the switch off they are ordinary threads, so their history stays reachable.
    expect(ids(null)).toHaveLength(3);
  });
});
