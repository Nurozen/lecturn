import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
} from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import {
  namedSnapshotsPerAccount,
  projectKeyMapPerAccount,
  snapshotsOfAccountScope,
  snapshotsPerAccount,
} from "./accountProjectGroups";

const work = EnvironmentId.make("relay-work");
const home = EnvironmentId.make("relay-home");
const local = EnvironmentId.make("local");
const accountByEnvironmentId = new Map<string, string>([
  [work, "user_work"],
  [home, "user_home"],
]);
const segmentation = {
  knownAccountIds: ["user_work", "user_home"],
  accountByEnvironmentId,
  accountLabels: new Map([
    ["user_work", "ada"],
    ["user_home", "grace"],
  ]),
};

function makeProject(id: string, environmentId: EnvironmentId, repository = "lecturn"): Project {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: repository,
    workspaceRoot: `/${environmentId}/${id}`,
    repositoryIdentity: {
      canonicalKey: `github.com/nurozen/${repository}`,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://github.com/nurozen/${repository}.git`,
      },
      provider: "github",
      owner: "nurozen",
      name: repository,
      displayName: repository,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

// The user's own order: home's clone first, then this device's, then work's.
const projects = [
  makeProject("lecturn-home", home),
  makeProject("notes-local", local, "notes"),
  makeProject("lecturn-local", local),
  makeProject("lecturn-work", work),
];
const input = {
  projects,
  settings: {
    sidebarProjectGroupingMode: "repository" as const,
    sidebarProjectGroupingOverrides: {},
  },
  primaryEnvironmentId: local,
  resolveEnvironmentLabel: () => null,
};
const members = (groups: ReturnType<typeof buildSidebarProjectSnapshots>) =>
  groups.map((group) => group.memberProjects.map((member) => member.id));

describe("snapshotsPerAccount", () => {
  it("is the unwrapped grouping while the sidebar is one list", () => {
    expect(snapshotsPerAccount(null, buildSidebarProjectSnapshots)).toBe(
      buildSidebarProjectSnapshots,
    );
    expect(namedSnapshotsPerAccount(null, buildSidebarProjectSnapshots)).toBe(
      buildSidebarProjectSnapshots,
    );
    expect(projectKeyMapPerAccount(null, buildPhysicalToLogicalProjectKeyMap)).toBe(
      buildPhysicalToLogicalProjectKeyMap,
    );
  });

  it("gives the same repository on two accounts two groups with distinct keys", () => {
    expect(members(buildSidebarProjectSnapshots(input))).toEqual([
      ["lecturn-home", "lecturn-local", "lecturn-work"],
      ["notes-local"],
    ]);
    const groups = snapshotsPerAccount(segmentation, buildSidebarProjectSnapshots)(input);
    expect(new Set(groups.map((group) => group.projectKey)).size).toBe(4);
    const keys = projectKeyMapPerAccount(segmentation, buildPhysicalToLogicalProjectKeyMap)(input);
    expect(new Set(keys.values())).toEqual(new Set(groups.map((group) => group.projectKey)));
  });

  it("keeps the order the projects came in, not the accounts' order", () => {
    const groups = snapshotsPerAccount(segmentation, buildSidebarProjectSnapshots)(input);
    expect(members(groups)).toEqual([
      ["lecturn-home"],
      ["notes-local"],
      ["lecturn-local"],
      ["lecturn-work"],
    ]);
  });

  it("names the account on groups that share a name, where no bar does", () => {
    const names = (groups: ReturnType<typeof buildSidebarProjectSnapshots>) =>
      groups.map((group) => group.displayName);
    const bare = names(snapshotsPerAccount(segmentation, buildSidebarProjectSnapshots)(input));
    expect(new Set(bare).size).toBe(2);
    const [homeName, notesName, localName, workName] = names(
      namedSnapshotsPerAccount(segmentation, buildSidebarProjectSnapshots)(input),
    );
    expect([homeName, workName]).toEqual([`${localName} (grace)`, `${localName} (ada)`]);
    expect(notesName).toBe(bare[1]);
  });
});

describe("snapshotsOfAccountScope", () => {
  it("is the unwrapped grouping for a plain project key", () => {
    expect(snapshotsOfAccountScope(null, buildSidebarProjectSnapshots)).toBe(
      buildSidebarProjectSnapshots,
    );
  });

  it("keeps the scoped account's members alone, under the key its segment links with", () => {
    const scoped = snapshotsOfAccountScope(
      { accountId: "user_work", accountByEnvironmentId },
      buildSidebarProjectSnapshots,
    )(input);
    expect(members(scoped)).toEqual([["lecturn-work"]]);
    const segmentGroup = snapshotsPerAccount(
      segmentation,
      buildSidebarProjectSnapshots,
    )(input).find((group) => group.memberProjects[0]?.id === "lecturn-work");
    expect(scoped[0]?.projectKey).toBe(segmentGroup?.projectKey);
  });
});
