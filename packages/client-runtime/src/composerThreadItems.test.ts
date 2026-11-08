import { EnvironmentId, SquireId, ThreadId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
  type ComposerThreadCandidate,
} from "./composerThreadItems.ts";

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
    linkedEnvironments: new Map(),
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
        linkedEnvironments: new Map(),
        excludeThreadId: null,
        query: "release",
        listing: listing === null ? null : new Map([[environmentId, listing]]),
        now: Date.parse("2026-10-23T00:00:00.000Z"),
      }).map((item) => item.thread.threadId);
    expect(ids({ squire: true })).toEqual([ThreadId.make("plain")]);
    // With the switch off they are ordinary threads, so their history stays reachable.
    expect(ids(null)).toHaveLength(3);
  });

  it("hides a linked machine's Squire threads by that machine's listing", () => {
    const vps = EnvironmentId.make("env-vps");
    const squire = { squireId: SquireId.make("sq-1"), role: "home" } as const;
    const items = matchComposerThreadItems({
      shells: [
        shell("here", "Release notes", { squire }),
        shell("there", "Release notes", { environmentId: vps, squire }),
      ],
      environmentId,
      linkedEnvironments: new Map([[vps, "Hetzner VPS"]]),
      excludeThreadId: null,
      query: "release",
      listing: new Map([[vps, { squire: true }]]),
      now: Date.parse("2026-10-23T00:00:00.000Z"),
    });
    expect(items.map((item) => item.thread.threadId)).toEqual(["here"]);
  });
});

it("also offers threads on linked machines, naming the machine, but no other machine's", () => {
  const vps = EnvironmentId.make("env-vps");
  const items = matchComposerThreadItems({
    shells: [
      shell("here", "Deploy script"),
      shell("there", "Deploy script", { environmentId: vps }),
      shell("unlinked", "Deploy notes", { environmentId: EnvironmentId.make("env-unlinked") }),
    ],
    environmentId,
    linkedEnvironments: new Map([[vps, "Hetzner VPS"]]),
    excludeThreadId: null,
    query: "deploy",
    listing: null,
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, label, description }) => ({ thread, label, description }))).toEqual([
    { thread: { environmentId, threadId: "here" }, label: "Deploy script", description: "Thread" },
    {
      thread: { environmentId: vps, threadId: "there" },
      label: "Deploy script",
      description: "Thread on Hetzner VPS",
    },
  ]);
});

describe("matchComposerEnvironmentItems", () => {
  const environments = [
    { environmentId: EnvironmentId.make("env-here"), label: "Laptop", machine: "laptop" },
    { environmentId: EnvironmentId.make("env-vps"), label: "Hetzner VPS", machine: "cloud" },
    { environmentId: EnvironmentId.make("env-mini"), label: "Mac mini", machine: "mac-mini" },
  ] as const;

  it("offers the other machines matching the query, never the composer's own", () => {
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "  vps ",
      }),
    ).toEqual([
      {
        id: "environment:env-vps",
        type: "environment",
        environmentId: "env-vps",
        machine: "cloud",
        label: "Hetzner VPS",
        description: "Machine",
      },
    ]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "lap",
      }),
    ).toEqual([]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "",
      }),
    ).toEqual([]);
  });
});
