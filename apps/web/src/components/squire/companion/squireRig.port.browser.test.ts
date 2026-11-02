// Behavior the port adds to v5 (plan D43 "Added" row, spec P16.3 and P16.6), on an injected
// clock. The ported v5 contract checks live in squireRig.browser.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createManualCompanionClock, setCompanionClockForTests } from "./companionClock";
import { defineSquireRig, type SquireRigElement } from "./squireRig";

let clock: ReturnType<typeof createManualCompanionClock>;
let mounted: HTMLElement[] = [];

async function mountRig(attributes: Record<string, string> = {}) {
  defineSquireRig();
  const rig = document.createElement("squire-rig") as SquireRigElement;
  // Stacked rigs overlap so the third and fourth are not below the test viewport.
  rig.style.cssText = "display:block;width:340px;height:500px;position:fixed;left:0;top:0";
  rig.setAttribute("transitions", "off");
  for (const [name, value] of Object.entries(attributes)) rig.setAttribute(name, value);
  document.body.append(rig);
  mounted.push(rig);
  await vi.waitFor(() => expect(rig.debugState.reason).not.toBe("offscreen"));
  return rig;
}

function frames(rig: SquireRigElement) {
  return rig.debugState.frameCount;
}

function bodyPose(rig: SquireRigElement) {
  const pose = rig.debugState.pose;
  return pose ? [pose.body, pose.head, pose.arm, pose.headPitch, pose.bodyY] : [];
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

describe("<squire-rig> port behavior", () => {
  it("renders at most 30 frames per second on a 120 Hz display", async () => {
    const rig = await mountRig();
    clock.advance(500);
    const start = frames(rig);
    clock.advance(2000);
    const rendered = frames(rig) - start;
    expect(rendered).toBeGreaterThanOrEqual(55);
    expect(rendered).toBeLessThanOrEqual(61);
    expect(rig.debugState.fps).toBeLessThanOrEqual(30.5);
  });

  it("settles to a still pose within 20.55 s and renders nothing afterwards", async () => {
    const rig = await mountRig({ state: "attentive" });
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
    const rig = await mountRig();
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
    const rig = await mountRig();
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
    const rig = await mountRig();
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
    const first = await mountRig();
    clock.advance(300);
    const second = await mountRig();
    expect(first.debugState.reason).toBe("yielded");
    expect(second.debugState.paused).toBe(false);

    const frozen = frames(first);
    const frozenPose = bodyPose(first);
    pointerOver(first);
    await expect(first.play("nod")).resolves.toMatchObject({ played: false });
    clock.advance(1000);
    expect(frames(first)).toBe(frozen);
    expect(bodyPose(first)).toEqual(frozenPose);

    const overlay = await mountRig({ placement: "overlay" });
    const panelLater = await mountRig();
    expect(overlay.debugState.paused).toBe(false);
    expect(second.debugState.reason).toBe("yielded");
    expect(panelLater.debugState.reason).toBe("yielded");

    overlay.remove();
    expect(panelLater.debugState.paused).toBe(false);
    panelLater.remove();
    expect(second.debugState.paused).toBe(false);
  });

  it("keeps the attentive halo at constant opacity and scale with no beacon, ring, or pulse nodes", async () => {
    const rig = await mountRig({ state: "attentive" });
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

  // CP8: at panel size attentive read as idle and thinking's grey oval read as the attentive
  // halo. Each state now has its own cue in the settled frame the panel shows after 20 s.
  it("settles each state on its own cue: attentive turns to the viewer under a gold halo, thinking holds a cool light", async () => {
    const settled = async (state: string) => {
      const rig = await mountRig({ state });
      clock.advance(20_550);
      expect(rig.debugState.reason).toBe("settled");
      const root = rig.shadowRoot!;
      const fillHue = (selector: string) => {
        const node = root.querySelector(selector);
        const id = /url\(#(.+)\)/.exec(node?.getAttribute("fill") ?? "")?.[1] ?? "";
        const stop = root.querySelector(`[id="${id}"] stop`);
        return hueOf(stop?.getAttribute("stop-color") ?? "");
      };
      const halo = root.querySelector<SVGElement>('[data-fx="halo"]')!;
      const shown = (node: Element | null) => {
        for (let n = node; n && n !== root.host; n = n.parentElement)
          if (n.getAttribute("display") === "none") return false;
        return node !== null;
      };
      const cues = {
        head: rig.debugState.pose!.head,
        eye: rig.debugState.eye,
        lid: rig.debugState.lid,
        halo: Number(halo.getAttribute("opacity")),
        haloHue: fillHue('[data-fx="halo"]'),
        thought: shown(root.querySelector('[data-fx="thought"]')),
        thoughtHue: fillHue('[data-fx="thought"] ellipse'),
      };
      rig.remove();
      return cues;
    };
    const idle = await settled("idle");
    const attentive = await settled("attentive");
    const thinking = await settled("thinking");

    // Idle rests with a lowered gaze; attentive holds head and eyes turned back to the viewer.
    expect(idle.eye.y).toBeGreaterThan(0.5);
    expect(idle.lid).toBeGreaterThanOrEqual(0.25);
    expect(attentive.eye.x).toBeLessThanOrEqual(-0.8);
    expect(attentive.eye.x - idle.eye.x).toBeLessThanOrEqual(-1);
    expect(attentive.head - idle.head).toBeLessThanOrEqual(-3);
    expect(attentive.lid).toBe(0);

    // Only attentive lights the head, in gold; thinking's light is blue and sits at the item.
    expect(attentive.halo).toBeGreaterThanOrEqual(0.8);
    expect(idle.halo).toBe(0);
    expect(thinking.halo).toBe(0);
    expect(attentive.haloHue).toBeGreaterThanOrEqual(25);
    expect(attentive.haloHue).toBeLessThanOrEqual(55);
    expect(thinking.thought).toBe(true);
    expect(idle.thought || attentive.thought).toBe(false);
    expect(thinking.thoughtHue).toBeGreaterThanOrEqual(200);
    expect(thinking.thoughtHue).toBeLessThanOrEqual(235);
  });

  // The panel and hover bust flip the figure with scaleX(-1) and pass mirrored="on".
  it("follows the pointer on screen when the host mirrors the figure", async () => {
    const lookAt = async (mirrored: boolean, side: "left" | "right") => {
      const rig = await mountRig({ gaze: "pointer", ...(mirrored ? { mirrored: "on" } : {}) });
      if (mirrored) rig.style.transform = "scaleX(-1)";
      clock.advance(300);
      const rect = rig.getBoundingClientRect();
      const x = side === "left" ? rect.left + 4 : rect.right - 4;
      window.dispatchEvent(
        new PointerEvent("pointermove", { clientX: x, clientY: rect.top + rect.height * 0.3 }),
      );
      clock.advance(1500);
      // Figure-space gaze: positive looks the way the figure faces (screen-right unmirrored).
      const gaze = rig.debugState.pose!.gaze;
      rig.remove();
      return gaze;
    };
    // Unmirrored, screen-left is behind the figure; mirrored, screen-left is in front of it.
    expect(await lookAt(false, "left")).toBeLessThan(-0.3);
    expect(await lookAt(true, "left")).toBeGreaterThan(0.3);
    expect(await lookAt(true, "right")).toBeLessThan(-0.3);
  });

  // Lead onboarding: a greet played on a freshly mounted rig read as a fade-in (the entrance ran
  // under it). Gestures play at full opacity; only an ungreeted first appearance fades in.
  it("greets at full opacity on a figure already shown, and fades in only on first appearance", async () => {
    const bodyOpacity = (rig: SquireRigElement) => {
      let k = 1;
      const body = rig.shadowRoot!.querySelector("[data-bone=body]");
      for (let n: Element | null = body; n; n = n.parentElement)
        k *= Number(n.getAttribute("opacity") ?? 1);
      return k;
    };
    const greetMin = async (rig: SquireRigElement) => {
      const done = rig.play("greet");
      let min = bodyOpacity(rig);
      for (let i = 0; i < 60; i++) {
        clock.advance(1000 / 30);
        min = Math.min(min, bodyOpacity(rig));
      }
      await expect(done).resolves.toMatchObject({ name: "greet", played: true });
      return min;
    };

    // Remounted and greeted at once, as the onboarding view does when its proposal cards appear.
    const remounted = await mountRig({ transitions: "on" });
    await vi.waitFor(() => expect(remounted.debugState.paused).toBe(false));
    expect(await greetMin(remounted)).toBeGreaterThanOrEqual(0.95);
    remounted.remove();

    // Greeted again long after its entrance.
    const settled = await mountRig({ transitions: "on" });
    clock.advance(2000);
    expect(await greetMin(settled)).toBeGreaterThanOrEqual(0.95);
    settled.remove();

    // A genuine first appearance still fades in.
    const fresh = await mountRig({ transitions: "on" });
    clock.advance(100);
    expect(bodyOpacity(fresh)).toBeLessThan(0.5);
  });

  it("draws the Lead's gold palette and crest only when asked", async () => {
    const brass = await mountRig({ palette: "brass" });
    expect(brass.shadowRoot!.querySelector('[data-fx="crest"]')).toBeNull();
    const lead = await mountRig({ palette: "gold", crest: "on" });
    expect(lead.getConfiguration()).toMatchObject({ palette: "gold", crest: "on" });
    expect(lead.shadowRoot!.querySelector('[data-fx="crest"]')).not.toBeNull();
  });
});

function hueOf(color: string) {
  const probe = document.createElement("div");
  probe.style.color = color;
  document.body.append(probe);
  const [r = 0, g = 0, b = 0] = (getComputedStyle(probe).color.match(/\d+/g) ?? []).map(
    (v) => Number(v) / 255,
  );
  probe.remove();
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return Number.NaN;
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (hue * 60 + 360) % 360;
}
