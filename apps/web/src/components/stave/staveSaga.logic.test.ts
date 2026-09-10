import { describe, expect, it } from "vite-plus/test";
import type { StaveSagaMemberStatus, StaveSpaceListRow } from "@t3tools/contracts";
import {
  flattenSagaSidebarTree,
  parseSagaAfter,
  resolveSagaMemberSpace,
  staveSagaMemberBadges,
} from "./staveSaga.logic";

const member: StaveSagaMemberStatus = {
  id: "a",
  after: [],
  state: "live",
  dirty: false,
  repos: [],
  prs: [],
};
const repo = {
  name: "app",
  branch: "feat",
  base: "main",
  ahead: 0,
  behind: 0,
  baseHealth: "merged" as const,
};
const space: StaveSpaceListRow = {
  id: "a",
  path: "/spaces/a",
  isSaga: false,
  repos: [],
  archived: false,
  logicalId: "a",
  manifestCreatedAt: "2026-01-01T00:00:00Z",
  manifestVersion: 1,
  memories: [],
};

describe("saga roster presentation", () => {
  it("never labels zero edit repos or a partial merge as merged", () => {
    expect(staveSagaMemberBadges(member)).toEqual(["live"]);
    expect(
      staveSagaMemberBadges({
        ...member,
        repos: [repo, { ...repo, name: "api", baseHealth: "ok" }],
      }),
    ).toEqual(["live"]);
  });
  it("shows merged only for every edit repo in a live member and keeps dirty separate", () => {
    expect(staveSagaMemberBadges({ ...member, dirty: true, repos: [repo] })).toEqual([
      "live",
      "dirty",
      "merged",
    ]);
    expect(staveSagaMemberBadges({ ...member, state: "missing", repos: [repo] })).toEqual([
      "missing",
    ]);
  });
  it("retains unknown states without inferring success", () => {
    expect(
      staveSagaMemberBadges({
        ...member,
        state: "unknown",
        repos: [{ ...repo, baseHealth: "unknown" }],
      }),
    ).toEqual(["unknown"]);
  });
  it("deduplicates after ids without sorting away the user's order", () => {
    expect(parseSagaAfter("second, first second\nthird")).toEqual(["second", "first", "third"]);
    expect(parseSagaAfter(" , \n")).toEqual([]);
  });
});

describe("saga member mutation targets", () => {
  it("resolves by logical id and preserves the exact incarnation", () => {
    const archived = {
      ...space,
      id: "a-archive-stamp",
      archived: true,
      path: "/spaces/.archive/a-stamp",
    };
    expect(resolveSagaMemberSpace([archived], "a")).toBe(archived);
  });
  it("refuses ambiguous live/archive replacements", () => {
    expect(
      resolveSagaMemberSpace([space, { ...space, path: "/spaces/.archive/a" }], "a"),
    ).toBeUndefined();
  });
  it("never selects a saga or unreadable manifest as a member", () => {
    expect(
      resolveSagaMemberSpace(
        [
          { ...space, isSaga: true },
          { ...space, error: "unreadable" },
        ],
        "a",
      ),
    ).toBeUndefined();
  });
});

describe("sidebar collapse and traversal", () => {
  const a = { group: { key: "physical-a" }, children: [] };
  const b = { group: { key: "physical-b" }, children: [] };
  const saga = { group: { key: "existing-saga-group-key" }, children: [b, a] };
  const ordinary = { group: { key: "ordinary" }, children: [] };
  it("keeps dependency order and existing group keys for keyboard traversal", () => {
    expect(
      flattenSagaSidebarTree([saga, ordinary], () => true).map((node) => node.group.key),
    ).toEqual(["existing-saga-group-key", "physical-b", "physical-a", "ordinary"]);
  });
  it("removes collapsed members from traversal while keeping unrelated groups", () => {
    expect(flattenSagaSidebarTree([saga, ordinary], (node) => node !== saga)).toEqual([
      saga,
      ordinary,
    ]);
  });
  it("keeps an empty coordinator visible", () => {
    const empty = { ...saga, children: [] };
    expect(flattenSagaSidebarTree([empty], () => false)).toEqual([empty]);
  });
});
