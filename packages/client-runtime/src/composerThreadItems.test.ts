import { EnvironmentId, SquireId, ThreadId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerThreadItems } from "./composerThreadItems.ts";

const env = EnvironmentId.make("env-1");
const otherEnv = EnvironmentId.make("env-2");
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
  it("offers nothing for a bare @ so the picker stays a file picker", () => {
    expect(
      matchComposerThreadItems({
        shells: [shell("t1", "Fix login")],
        environmentId: env,
        excludeThreadId: null,
        query: "  ",
        listing: null,
      }),
    ).toEqual([]);
  });

  it("matches titles within the environment, newest first, skipping self and archived", () => {
    const items = matchComposerThreadItems({
      shells: [
        shell("old", "Login flow", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        shell("new", "Login redesign", { updatedAt: "2026-02-01T00:00:00.000Z" }),
        shell("self", "Login self"),
        shell("gone", "Login archived", { archivedAt: "2026-01-02T00:00:00.000Z" }),
        shell("foreign", "Login elsewhere", { environmentId: otherEnv }),
        shell("nope", "Unrelated"),
      ],
      environmentId: env,
      excludeThreadId: ThreadId.make("self"),
      query: "LOGIN",
      listing: null,
    });
    expect(items.map((item) => item.thread.threadId)).toEqual(["new", "old"]);
    expect(items[0]).toMatchObject({ type: "thread", label: "Login redesign" });
  });

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
