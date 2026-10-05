import { describe, expect, it } from "vite-plus/test";
import { buildSidebarSegments } from "../components/sidebar/sidebarSegments.logic";
import { withPrimaryPublisher } from "./environmentAccountOwnership";

const relayOwners = new Map([["remote", "work"]]);
const threads = [
  { environmentId: "local", id: "local-thread" },
  { environmentId: "remote", id: "remote-thread" },
  { environmentId: "direct", id: "direct-thread" },
];
function sections(primary: Parameters<typeof withPrimaryPublisher>[1]) {
  return buildSidebarSegments({
    segmentation: {
      knownAccountIds: ["personal", "work"],
      accountLabels: new Map(),
      accountByEnvironmentId: withPrimaryPublisher(relayOwners, primary),
    },
    collapsedSegmentIds: [],
    threads,
    projects: threads,
  });
}

describe("published local environment ownership", () => {
  it("groups the host's projects and threads under its publisher without claiming direct connections", () => {
    const result = sections({ environmentId: "local", accountId: "personal" });
    expect(result.map(({ accountId, projects }) => [accountId, projects.map((p) => p.id)])).toEqual(
      [
        ["personal", ["local-thread"]],
        ["work", ["remote-thread"]],
        [null, ["direct-thread"]],
      ],
    );
    expect(result[0]?.threads).toEqual([threads[0]]);
  });
  it("moves the host after unlink and explicit reassociation without moving other environments", () => {
    expect(sections(null).find((s) => s.accountId === null)?.threads).toEqual([
      threads[0],
      threads[2],
    ]);
    expect(
      sections({ environmentId: "local", accountId: "work" }).find((s) => s.accountId === "work")
        ?.threads,
    ).toEqual([threads[0], threads[1]]);
    expect([...relayOwners]).toEqual([["remote", "work"]]);
  });
  it("keeps a host with an unattached publisher outside other signed-in accounts", () => {
    const result = sections({ environmentId: "local", accountId: "unknown" });
    expect(result.find((s) => s.accountId === "personal")?.threads).toEqual([]);
    expect(result.find((s) => s.accountId === null)?.threads).toEqual([threads[0], threads[2]]);
  });
});
