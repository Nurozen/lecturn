import { describe, expect, it } from "vite-plus/test";

import { makeProviderReplayGate } from "./replayGate.ts";

describe("makeProviderReplayGate", () => {
  it("retains processed receipts and wakes all waiters independently of emission", async () => {
    const gate = makeProviderReplayGate([]);
    let completed = 0;
    const first = gate.waitForProcessed("wake-end").then(() => completed++);
    const second = gate.waitForProcessed("wake-end").then(() => completed++);
    await gate.beforeEmit("wake-end");
    expect(completed).toBe(0);

    gate.recordProcessed("another-frame");
    await gate.waitForProcessed("another-frame");
    expect(completed).toBe(0);

    gate.recordProcessed("wake-end");
    await Promise.all([first, second]);
    expect(completed).toBe(2);
    await gate.waitForProcessed("wake-end");
  });
});
