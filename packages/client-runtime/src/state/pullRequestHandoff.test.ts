import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ThreadId } from "@lecturn/contracts";
import { mergeHandoffMessage, selectMergeHandoffThread } from "./pullRequestHandoff.ts";

const a = { id: ThreadId.make("a"), title: "Manager" };
const b = { id: ThreadId.make("b"), title: "Other" };
describe("merge handoff", () => {
  it("uses the eligible explicit manager and never reroutes a missing one", () => {
    const watch = { managerThreadId: a.id, threadIds: [b.id] };
    expect(selectMergeHandoffThread(watch, [a, b])).toBe(a);
    expect(selectMergeHandoffThread(watch, [b])).toBeNull();
  });
  it("requires one associated recipient when no manager is assigned", () => {
    expect(selectMergeHandoffThread({ managerThreadId: null, threadIds: [a.id] }, [a, b])).toBe(a);
    expect(
      selectMergeHandoffThread({ managerThreadId: null, threadIds: [a.id, b.id] }, [a, b]),
    ).toBeNull();
    expect(selectMergeHandoffThread({ managerThreadId: null, threadIds: [] }, [a])).toBeNull();
  });
  it("targets the exact fork and PR with bounded, stable instructions", () => {
    const watch = {
      reference: {
        projectId: ProjectId.make("p"),
        host: "git.example.com",
        repository: "fork/repo",
        number: 32,
      },
      observation: null,
    };
    const message = mergeHandoffMessage(watch);
    expect(message).toContain("fork/repo #32");
    expect(message).toContain("https://git.example.com/fork/repo/pull/32");
    expect(message).toContain("required checks and repository merge rules");
    expect(message).toContain("Report blockers");
    expect(
      mergeHandoffMessage({
        ...watch,
        reference: { ...watch.reference, repository: "x".repeat(10000) },
      }).length,
    ).toBeLessThan(8000);
  });
});
