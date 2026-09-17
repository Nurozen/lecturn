import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@lecturn/contracts";
import type { RelayAgentActivityAggregateState } from "@lecturn/contracts/relay";
import { sanitizeAgentActivityAggregateState } from "./agentActivityPayloads.ts";
const row: RelayAgentActivityAggregateState["activities"][number] = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("pr-watch:one"),
  projectTitle: "Project",
  threadTitle: "PR #1",
  modelTitle: "Manager: idle",
  phase: "running",
  status: "CI pending",
  updatedAt: "2026-09-13T20:00:00Z",
  deepLink: "/pr-watches/environment/one",
  pullRequest: {
    watchId: "one",
    projectId: "project",
    number: 1,
    repository: "org/repo",
    state: "open",
    checks: "pending",
    requiredChecks: "pending",
    watching: true,
    manager: "idle",
    authorization: "waiting",
    stale: false,
  },
};
describe("PR activity payload bounds", () => {
  it("retains facts and authenticating app links", () => {
    const value = sanitizeAgentActivityAggregateState({
      title: "Lecturn",
      subtitle: "Agents and pull requests",
      activeCount: 1,
      updatedAt: row.updatedAt,
      activities: [row],
    });
    expect(value.activities[0]?.pullRequest).toEqual(row.pullRequest);
    expect(value.activities[0]?.deepLink).toBe(row.deepLink);
  });
  it("budgets UTF-8 bytes with mixed long cards without falsifying total work", () => {
    const value = sanitizeAgentActivityAggregateState({
      title: "Lecturn",
      subtitle: "Activity",
      activeCount: 10,
      updatedAt: row.updatedAt,
      activities: Array.from({ length: 10 }, () => ({
        ...row,
        projectTitle: "金".repeat(500),
        threadTitle: "金".repeat(500),
        modelTitle: "金".repeat(500),
      })),
    });
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(3200);
    expect(value.activeCount).toBe(10);
    expect(value.activities.length).toBeGreaterThan(0);
    expect(value.activities.length).toBeLessThan(5);
  });
  it("rejects external URL payloads", () => {
    const value = sanitizeAgentActivityAggregateState({
      title: "Lecturn",
      subtitle: "Activity",
      activeCount: 1,
      updatedAt: row.updatedAt,
      activities: [{ ...row, deepLink: "https://evil.test" }],
    });
    expect(value.activities[0]?.deepLink).toBe("/");
  });
});
