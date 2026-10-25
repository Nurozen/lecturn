import type { WorkLogPresentationEntry } from "@lecturn/client-runtime/work-log/presentation";
import { appToolSource } from "@lecturn/shared/appToolPresentation";
import { describe, expect, it } from "vite-plus/test";

import { appToolRowOutcome } from "./AppToolWorkRow.logic";

const rocketWright = appToolSource({
  appId: "dev.rocketwright",
  name: "RocketWright",
  toolPrefix: "rw",
});

function entry(overrides: Partial<WorkLogPresentationEntry> = {}): WorkLogPresentationEntry {
  return {
    id: "item-1",
    createdAt: "2026-10-24T12:00:00.000Z",
    label: "rw_simulate baseline",
    tone: "tool",
    itemType: "dynamic_tool",
    toolLifecycleStatus: "completed",
    toolSource: rocketWright,
    ...overrides,
  };
}

describe("appToolRowOutcome", () => {
  it("keeps the standard row for tools no connected app serves", () => {
    const { toolSource: _appSource, ...unsourced } = entry();
    expect(appToolRowOutcome(unsourced, false)).toBeUndefined();
    expect(
      appToolRowOutcome(
        entry({
          toolSource: { key: "mcp:rocketwright", name: "rocketwright", kind: "integration" },
        }),
        false,
      ),
    ).toBeUndefined();
    expect(appToolRowOutcome(unsourced, true)).toBeUndefined();
  });

  it("marks a completed app tool as succeeded", () => {
    expect(appToolRowOutcome(entry(), false)).toBe("succeeded");
  });

  it("follows the row's failure reading over the lifecycle", () => {
    expect(appToolRowOutcome(entry(), true)).toBe("failed");
    expect(appToolRowOutcome(entry({ toolLifecycleStatus: "failed" }), true)).toBe("failed");
  });

  it("claims no success while the call is open or was stopped", () => {
    for (const toolLifecycleStatus of ["inProgress", "idle", "stopped"] as const) {
      expect(appToolRowOutcome(entry({ toolLifecycleStatus }), false)).toBe("pending");
    }
  });
});
