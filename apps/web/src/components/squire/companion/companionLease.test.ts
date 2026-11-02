import { afterEach, describe, expect, it } from "vite-plus/test";

import { acquireCompanionLease, type CompanionLease } from "./companionLease";

let leases: CompanionLease[] = [];

function claim(placement: "panel" | "overlay", log: string[], name: string) {
  const lease = acquireCompanionLease(placement, (holding) =>
    log.push(`${name}:${holding ? "run" : "yield"}`),
  );
  leases.push(lease);
  return lease;
}

afterEach(() => {
  for (const lease of leases) lease.release();
  leases = [];
});

describe("companion lease", () => {
  it("lets one companion run, overlays outranking the panel, and hands back on release", () => {
    const log: string[] = [];
    const panel = claim("panel", log, "panel");
    expect(panel.holding).toBe(true);

    const hover = claim("overlay", log, "hover");
    expect([panel.holding, hover.holding]).toEqual([false, true]);
    // The old holder stops before the new one starts.
    expect(log).toEqual(["panel:run", "panel:yield", "hover:run"]);

    const laterPanel = claim("panel", log, "laterPanel");
    expect(laterPanel.holding).toBe(false);

    hover.release();
    expect(laterPanel.holding).toBe(true);
    expect(panel.holding).toBe(false);

    laterPanel.release();
    expect(panel.holding).toBe(true);
  });

  it("re-ranks a claim whose placement changes and ignores a double release", () => {
    const log: string[] = [];
    const first = claim("panel", log, "first");
    const second = claim("panel", log, "second");
    expect(second.holding).toBe(true);
    first.setPlacement("overlay");
    expect([first.holding, second.holding]).toEqual([true, false]);
    first.release();
    first.release();
    expect(second.holding).toBe(true);
  });
});
