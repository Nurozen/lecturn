import "../../../index.css";

import { DEFAULT_SQUIRE_COMPANION, type SquireCompanion } from "@lecturn/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import { createManualCompanionClock, setCompanionClockForTests } from "../companion/companionClock";
import { acquireCompanionLease } from "../companion/companionLease";
import type { CompanionElement } from "../companion/types";
import { loadCompanionRuntime } from "../SquireCompanion";
import { SquireProposalBust } from "./SquireProposalSummary";

// Fixture 00's proposals, each set to animate, plus an emblem proposal.
const PROPOSALS: ReadonlyArray<SquireCompanion> = [
  {
    ...DEFAULT_SQUIRE_COMPANION,
    appearance: "male",
    hood: "up",
    equipment: "grimoire",
    palette: "rose",
    motion: "lively",
  },
  {
    ...DEFAULT_SQUIRE_COMPANION,
    appearance: "female",
    hood: "up",
    equipment: "astrolabe",
    palette: "sage",
    motion: "subtle",
  },
  {
    ...DEFAULT_SQUIRE_COMPANION,
    appearance: "male",
    hood: "down",
    equipment: "helmet",
    palette: "moonstone",
    motion: "lively",
  },
  { ...DEFAULT_SQUIRE_COMPANION, presence: "emblem", palette: "sage", frame: "seal" },
];

let frames = 0;
let clock: ReturnType<typeof createManualCompanionClock>;

// Installs a counting manual clock and the companion runtime for one test; disposing restores
// the real clock and removes the grid container.
async function setup() {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  frames = 0;
  const manual = createManualCompanionClock();
  clock = manual;
  setCompanionClockForTests({
    now: manual.now,
    cancelFrame: manual.cancelFrame,
    hasFocus: manual.hasFocus,
    requestFrame(callback) {
      frames++;
      return manual.requestFrame(callback);
    },
  });
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;top:0;left:0;display:grid;grid-template-columns:repeat(2,auto);gap:8px;padding:8px";
  document.body.append(container);
  const env = {
    container,
    [Symbol.dispose]() {
      container.remove();
      setCompanionClockForTests(null);
      vi.restoreAllMocks();
    },
  };
  try {
    await loadCompanionRuntime();
  } catch (error) {
    env[Symbol.dispose]();
    throw error;
  }
  return env;
}

const companions = (container: HTMLElement) => [
  ...container.querySelectorAll<CompanionElement>("squire-rig, squire-emblem"),
];

async function settledFrames(container: HTMLElement) {
  // Art decodes asynchronously; a still figure paints once it lands.
  await vi.waitFor(
    () => {
      const elements = companions(container);
      expect(elements).toHaveLength(PROPOSALS.length);
      for (const element of elements) expect(element.debugState.reason).toBe("still");
    },
    { timeout: 10_000 },
  );
}

describe("proposal busts", () => {
  it("three still busts and an emblem run no frames and leave the live companion its lease", async () => {
    using env = await setup();
    let panelHolding = false;
    const panel = acquireCompanionLease("panel", (holding) => {
      panelHolding = holding;
    });
    expect(panelHolding).toBe(true);

    await using _screen = await render(
      <>
        {PROPOSALS.map((companion) => (
          <SquireProposalBust
            key={JSON.stringify(companion)}
            companion={companion}
            label="Proposal"
          />
        ))}
      </>,
      { container: env.container },
    );
    await settledFrames(env.container);
    clock.advance(2_000);
    // Pointer activity wakes a live rig; a still one must stay put.
    for (const element of companions(env.container)) {
      element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    }
    clock.advance(1_000);

    expect(frames).toBe(0);
    expect(clock.pendingFrames).toBe(0);
    expect(panelHolding).toBe(true);
    for (const element of companions(env.container)) {
      expect(element.getAttribute("motion")).toBe("still");
      expect(element.debugState.pendingRAF).toBe(0);
    }
    // The busts are cropped boxes about 110 px tall, figures included.
    for (const bust of env.container.querySelectorAll("[data-testid=squire-proposal-bust]")) {
      expect(bust.getBoundingClientRect().height).toBeCloseTo(110, 0);
    }
    panel.release();
  });

  it("a live overlay companion would take the lease and run frames (the check above can fail)", async () => {
    using env = await setup();
    let panelHolding = false;
    const panel = acquireCompanionLease("panel", (holding) => {
      panelHolding = holding;
    });
    const live = document.createElement("squire-rig") as CompanionElement;
    live.setAttribute("placement", "overlay");
    env.container.append(live);
    expect(panelHolding).toBe(false);
    live.remove();
    expect(panelHolding).toBe(true);
    panel.release();
  });
});
