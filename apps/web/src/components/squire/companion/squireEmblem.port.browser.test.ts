// Behavior the port adds to v5 (plan D43 "Added" row, spec P16.3 and P16.6), on an injected
// clock. The ported v5 contract checks live in squireEmblem.browser.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createManualCompanionClock, setCompanionClockForTests } from "./companionClock";
import { defineSquireEmblem, type SquireEmblemElement } from "./squireEmblem";

let clock: ReturnType<typeof createManualCompanionClock>;
let mounted: HTMLElement[] = [];

async function mountEmblem(attributes: Record<string, string> = {}) {
  defineSquireEmblem();
  const rig = document.createElement("squire-emblem") as SquireEmblemElement;
  rig.style.cssText = "display:block;width:340px;height:340px;position:absolute;left:0;top:0";
  rig.setAttribute("transitions", "off");
  for (const [name, value] of Object.entries(attributes)) rig.setAttribute(name, value);
  document.body.append(rig);
  mounted.push(rig);
  await vi.waitFor(() => expect(rig.debugState.reason).not.toBe("offscreen"));
  return rig;
}

function frames(rig: SquireEmblemElement) {
  return rig.debugState.frameCount;
}

function bodyPose(rig: SquireEmblemElement) {
  const pose = rig.debugState.pose;
  return pose ? Object.values(pose).filter((value) => typeof value === "number") : [];
}

function moved(before: number[], after: number[]) {
  return before.some((value, index) => Math.abs(value - (after[index] ?? value)) > 1e-3);
}

function pointerOver(rig: HTMLElement) {
  const rect = rig.getBoundingClientRect();
  rig.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 3,
    }),
  );
}

beforeEach(() => {
  clock = createManualCompanionClock({ frameMs: 1000 / 120 });
  setCompanionClockForTests(clock);
});

afterEach(() => {
  for (const element of mounted) element.remove();
  mounted = [];
  setCompanionClockForTests(null);
});

describe("<squire-emblem> port behavior", () => {
  it("renders at most 30 frames per second on a 120 Hz display", async () => {
    const rig = await mountEmblem();
    clock.advance(500);
    const start = frames(rig);
    clock.advance(2000);
    const rendered = frames(rig) - start;
    expect(rendered).toBeGreaterThanOrEqual(55);
    expect(rendered).toBeLessThanOrEqual(61);
    expect(rig.debugState.fps).toBeLessThanOrEqual(30.5);
  });

  it("settles to a still pose within 20.55 s and renders nothing afterwards", async () => {
    const rig = await mountEmblem({ state: "attentive" });
    clock.advance(20_550);
    expect(rig.debugState.reason).toBe("settled");
    expect(rig.debugState.pendingRAF).toBe(0);
    const settledFrames = frames(rig);
    const settledPose = bodyPose(rig);
    clock.advance(40_000);
    expect(frames(rig)).toBe(settledFrames);
    expect(bodyPose(rig)).toEqual(settledPose);
    expect(clock.pendingFrames).toBe(0);
  });

  it("wakes a settled rig for a gesture and for a state change, and both move", async () => {
    const rig = await mountEmblem();
    clock.advance(21_000);
    expect(rig.debugState.reason).toBe("settled");

    const before = bodyPose(rig);
    const nod = rig.play("nod");
    expect(rig.debugState.paused).toBe(false);
    clock.advance(600);
    expect(moved(before, bodyPose(rig))).toBe(true);
    clock.advance(3000);
    await expect(nod).resolves.toMatchObject({ name: "nod", played: true });

    clock.advance(21_000);
    expect(rig.debugState.reason).toBe("settled");
    const rested = bodyPose(rig);
    rig.setAttribute("state", "thinking");
    expect(rig.debugState.paused).toBe(false);
    clock.advance(1500);
    expect(moved(rested, bodyPose(rig))).toBe(true);
  });

  it("restarts the settle deadline on pointer movement and wakes a settled rig on pointer", async () => {
    const rig = await mountEmblem();
    clock.advance(15_000);
    pointerOver(rig);
    clock.advance(5_500);
    expect(rig.debugState.paused).toBe(false);
    clock.advance(14_000);
    expect(rig.debugState.paused).toBe(false);
    clock.advance(1_000);
    expect(rig.debugState.reason).toBe("settled");

    pointerOver(rig);
    expect(rig.debugState.paused).toBe(false);
    const woken = frames(rig);
    clock.advance(500);
    expect(frames(rig)).toBeGreaterThan(woken);
  });

  it("pauses while the window is unfocused, and pointer or play() resume nothing", async () => {
    const rig = await mountEmblem();
    clock.advance(300);
    clock.setFocused(false);
    expect(rig.debugState.reason).toBe("unfocused");
    const paused = frames(rig);
    pointerOver(rig);
    await expect(rig.play("greet")).resolves.toMatchObject({ played: false });
    clock.advance(2000);
    expect(frames(rig)).toBe(paused);
    expect(rig.debugState.reason).toBe("unfocused");

    clock.setFocused(true);
    expect(rig.debugState.paused).toBe(false);
    clock.advance(500);
    expect(frames(rig)).toBeGreaterThan(paused);
  });

  it("runs one live rig: the later panel or an overlay holds, the other yields its last frame", async () => {
    const first = await mountEmblem();
    clock.advance(300);
    const second = await mountEmblem();
    expect(first.debugState.reason).toBe("yielded");
    expect(second.debugState.paused).toBe(false);

    const frozen = frames(first);
    const frozenPose = bodyPose(first);
    pointerOver(first);
    await expect(first.play("nod")).resolves.toMatchObject({ played: false });
    clock.advance(1000);
    expect(frames(first)).toBe(frozen);
    expect(bodyPose(first)).toEqual(frozenPose);

    const overlay = await mountEmblem({ placement: "overlay" });
    const panelLater = await mountEmblem();
    expect(overlay.debugState.paused).toBe(false);
    expect(second.debugState.reason).toBe("yielded");
    expect(panelLater.debugState.reason).toBe("yielded");

    overlay.remove();
    expect(panelLater.debugState.paused).toBe(false);
    panelLater.remove();
    expect(second.debugState.paused).toBe(false);
  });

  it("keeps the attentive halo at constant opacity and scale with no beacon, ring, or pulse nodes", async () => {
    const rig = await mountEmblem({ state: "attentive" });
    clock.advance(2500);
    const root = rig.shadowRoot!;
    const halo = root.querySelector<SVGGraphicsElement>('[data-fx="halo"]');
    expect(halo).not.toBeNull();
    const sample = () => {
      const matrix = halo!.getCTM()!;
      return {
        opacity: Number(getComputedStyle(halo!).opacity),
        scale: Math.hypot(matrix.a, matrix.b),
      };
    };
    const first = sample();
    expect(first.opacity).toBeGreaterThan(0);
    for (let step = 0; step < 20; step++) {
      clock.advance(500);
      const next = sample();
      expect(next.opacity).toBeCloseTo(first.opacity, 3);
      expect(next.scale).toBeCloseTo(first.scale, 3);
    }
    expect(
      root.querySelectorAll(
        '[data-fx~="beacon"],[data-fx~="ring"],[data-fx~="pulse"],[data-fx~="lift"]',
      ),
    ).toHaveLength(0);
  });

  it("holds the knots still in every state (no knot pulse)", async () => {
    const emblem = await mountEmblem({ state: "idle" });
    clock.advance(1500);
    const knots = [...emblem.shadowRoot!.querySelectorAll<SVGElement>('[data-fx~="knot"]')];
    expect(knots.length).toBeGreaterThan(0);
    const shape = () =>
      knots.map((knot) => `${knot.getAttribute("r")}|${knot.getAttribute("transform")}`);
    for (const state of ["idle", "attentive", "thinking"]) {
      emblem.setAttribute("state", state);
      clock.advance(1500);
      const first = shape();
      clock.advance(4000);
      expect(shape()).toEqual(first);
    }
  });

  it("offers the Lead's gold palette", async () => {
    const brass = await mountEmblem({ palette: "brass" });
    const gold = await mountEmblem({ palette: "gold" });
    expect(gold.getConfiguration().palette).toBe("gold");
    const ink = (emblem: HTMLElement) =>
      [...emblem.shadowRoot!.querySelectorAll("[stroke],[fill]")]
        .map((node) => `${node.getAttribute("stroke")}|${node.getAttribute("fill")}`)
        .join();
    expect(ink(gold)).not.toBe(ink(brass));
  });
});
