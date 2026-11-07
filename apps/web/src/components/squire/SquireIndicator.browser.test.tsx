import "../../index.css";

import type { SquireIndicatorStateName } from "@lecturn/client-runtime/state/squireIndicator";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, type Screen } from "../../../test/render";
import { Toggle } from "../ui/toggle";
import { COMPANION_PALETTES, type CompanionPalette } from "./companion/types";
import { SquireIndicator } from "./SquireIndicator";
import { SquireMark } from "./SquireMark";

let container: HTMLDivElement;
let screen: Screen | undefined;
let focused = true;

// One fixed container per test: renderIndicator mounts into it first and rerenders after.
// Disposing unmounts it and restores the focus spy.
function setup(): AsyncDisposable {
  focused = true;
  // The test page's focus depends on the runner, so the window's focus is driven by hand.
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  container = document.createElement("div");
  container.style.cssText = "position:fixed;top:0;left:0";
  document.body.append(container);
  screen = undefined;
  return {
    async [Symbol.asyncDispose]() {
      try {
        await screen?.[Symbol.asyncDispose]();
      } finally {
        screen = undefined;
        container.remove();
        vi.restoreAllMocks();
      }
    },
  };
}

const forms = {
  portrait: (state: SquireIndicatorStateName) => (
    <SquireIndicator
      state={state}
      palette="sage"
      appearance="female"
      hood="down"
      size={32}
      label="Research"
    />
  ),
  mark: (state: SquireIndicatorStateName) => (
    <SquireMark state={state} palette="sage" size={16} label="Research" />
  ),
};

async function renderIndicator(element: React.ReactElement) {
  if (screen) await screen.rerender(element);
  else screen = await render(element, { container });
  const indicator = container.querySelector<HTMLElement>('[role="img"]');
  if (indicator === null) throw new Error("indicator did not render");
  return indicator;
}

function animatedProperties(animation: Animation) {
  const effect = animation.effect;
  if (!(effect instanceof KeyframeEffect)) return [];
  const ignored = new Set(["offset", "computedOffset", "easing", "composite"]);
  return [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))].filter(
    (key) => !ignored.has(key),
  );
}

async function expectPlayState(indicator: HTMLElement, playState: AnimationPlayState) {
  await vi.waitFor(() => {
    const animations = indicator.getAnimations({ subtree: true });
    expect(animations).toHaveLength(1);
    expect(animations[0]!.playState).toBe(playState);
  });
}

describe.each(Object.entries(forms))("%s indicator", (form, render) => {
  it.each(["idle", "waiting"] as const)("runs no animation while %s", async (state) => {
    await using _env = setup();
    const indicator = await renderIndicator(render(state));
    expect(indicator.getAnimations({ subtree: true })).toEqual([]);
  });

  it("animates while working, only when focused and on screen", async () => {
    await using _env = setup();
    const indicator = await renderIndicator(render("working"));
    await expectPlayState(indicator, "running");
    const [animation] = indicator.getAnimations({ subtree: true });
    expect(animatedProperties(animation!)).toEqual(
      form === "portrait" ? ["transform"] : ["strokeDashoffset"],
    );

    focused = false;
    window.dispatchEvent(new Event("blur"));
    await expectPlayState(indicator, "paused");

    focused = true;
    window.dispatchEvent(new Event("focus"));
    await expectPlayState(indicator, "running");

    container.style.top = "200vh";
    await expectPlayState(indicator, "paused");
    container.style.top = "0";
    await expectPlayState(indicator, "running");
  });

  it("drops the animation when work ends", async () => {
    await using _env = setup();
    const indicator = await renderIndicator(render("working"));
    await expectPlayState(indicator, "running");
    await renderIndicator(render("waiting"));
    expect(indicator.getAnimations({ subtree: true })).toEqual([]);
  });
});

describe("portrait stills", () => {
  function stillFacts(indicator: HTMLElement) {
    const portrait = getComputedStyle(indicator.querySelector('[data-slot="squire-portrait"]')!);
    const ring = getComputedStyle(indicator.querySelector('[data-slot="squire-ring"]')!);
    return {
      grayscale: grayscaleAmount(portrait.filter),
      portraitOpacity: Number(portrait.opacity),
      ringOpacity: Number(ring.opacity),
      ringDashed: ring.strokeDasharray !== "none",
    };
  }

  it("tells idle, waiting, and working apart from a single still", async () => {
    await using _env = setup();
    // Muted, not disabled: idle keeps some cloth color and most of its brightness.
    const idle = stillFacts(await renderIndicator(forms.portrait("idle")));
    expect(idle.grayscale).toBeCloseTo(0.6);
    expect(idle.portraitOpacity).toBeCloseTo(0.8);
    expect(idle.ringOpacity).toBeLessThan(0.5);

    const waiting = stillFacts(await renderIndicator(forms.portrait("waiting")));
    expect(waiting).toEqual({
      grayscale: 0,
      portraitOpacity: 1,
      ringOpacity: 1,
      ringDashed: false,
    });

    const working = await renderIndicator(forms.portrait("working"));
    expect(stillFacts(working).grayscale).toBe(0);
    const arc = working.querySelector('[data-slot="squire-arc-head"]')!;
    expect(getComputedStyle(arc).strokeDasharray).not.toBe("none");
  });

  it("caps the working arc at half the ring, with a fainter, thinner tail behind its head", async () => {
    await using _env = setup();
    const working = await renderIndicator(forms.portrait("working"));
    // Where a stroke starts and ends along the ring's path; round caps extend it by half its width.
    const segment = (slot: string) => {
      const circle = working.querySelector<SVGCircleElement>(
        `[data-slot="squire-arc"] [data-slot="${slot}"]`,
      );
      if (circle === null) throw new Error(`${slot} did not render`);
      const style = getComputedStyle(circle);
      const [lit, gap] = style.strokeDasharray.split(/[\s,]+/).map(parseFloat);
      const pathLength = Number(circle.getAttribute("pathLength"));
      const circumference = 2 * Math.PI * circle.r.baseVal.value;
      const width = parseFloat(style.strokeWidth);
      const cap = style.strokeLinecap === "round" ? (width / 2 / circumference) * pathLength : 0;
      const start = -parseFloat(style.strokeDashoffset || "0");
      expect(lit! + gap!).toBe(pathLength);
      return {
        lit: lit! / pathLength,
        start: (start - cap) / pathLength,
        end: (start + lit! + cap) / pathLength,
        width,
        opacity: Number(style.opacity),
      };
    };
    const head = segment("squire-arc-head");
    const tail = segment("squire-arc-tail");
    const sweep = Math.max(head.end, tail.end) - Math.min(head.start, tail.start);
    expect(sweep).toBeLessThanOrEqual(0.5);
    // The path runs clockwise, the way the arc turns: the tail trails the head and meets it.
    expect(tail.start).toBeLessThan(head.start);
    expect(tail.end).toBeGreaterThanOrEqual(head.start);
    expect(tail.lit).toBeLessThan(head.lit);
    expect(tail.opacity).toBeLessThan(head.opacity);
    expect(tail.width).toBeLessThan(head.width);
  });

  it("gives each palette its own face, and the Lead the gold one", async () => {
    await using _env = setup();
    const source = async (palette: CompanionPalette, isLead = false) => {
      const indicator = await renderIndicator(
        <SquireIndicator
          state="waiting"
          palette={palette}
          isLead={isLead}
          appearance="male"
          hood="up"
          size={32}
          label="Squire"
        />,
      );
      const portrait = indicator.querySelector<HTMLImageElement>('[data-slot="squire-portrait"]')!;
      await vi.waitFor(() => expect(portrait.naturalWidth).toBeGreaterThan(0));
      return portrait.currentSrc;
    };
    const sources = [];
    for (const palette of COMPANION_PALETTES) sources.push(await source(palette));
    expect(new Set(sources).size).toBe(COMPANION_PALETTES.length);
    expect(await source("sage", true)).toBe(await source("gold"));
  });

  it("badges the Lead's smallest portrait with a star held apart from its thread", async () => {
    await using _env = setup();
    const indicator = await renderIndicator(
      <SquireIndicator
        state="waiting"
        palette="sage"
        isLead
        appearance="female"
        hood="down"
        size={22}
        label="Lead"
      />,
    );
    const crest = indicator.querySelector('[data-slot="squire-crest"]')!;
    expect(crest.getBoundingClientRect().width).toBeCloseTo(9.24, 1);
    const [star, thread] = [...crest.querySelectorAll("path")].map((path) =>
      path.getBoundingClientRect(),
    );
    expect(star!.bottom).toBeLessThan(thread!.top);
    expect(getComputedStyle(crest.querySelector("path")!).fill).toBe("rgb(246, 211, 101)");
  });

  it("dims the Lead's crest with the portrait only while idle", async () => {
    await using _env = setup();
    const crestFacts = async (state: SquireIndicatorStateName) => {
      const indicator = await renderIndicator(
        <SquireIndicator
          state={state}
          palette="sage"
          isLead
          appearance="female"
          hood="down"
          size={32}
          label="Lead"
        />,
      );
      const crest = getComputedStyle(indicator.querySelector('[data-slot="squire-crest"]')!);
      return { grayscale: grayscaleAmount(crest.filter), opacity: Number(crest.opacity) };
    };
    const idle = await crestFacts("idle");
    expect(idle.grayscale).toBeCloseTo(0.6);
    expect(idle.opacity).toBeCloseTo(0.8);
    for (const state of ["waiting", "working"] as const) {
      expect(await crestFacts(state)).toEqual({ grayscale: 0, opacity: 1 });
    }
  });

  it("keeps its own state look inside an unpressed team chip", async () => {
    await using _env = setup();
    // Toggle fades svgs that carry no opacity class; the chip shows selection, not the portrait.
    const indicator = await renderIndicator(
      <Toggle size="sm-label" variant="outline" pressed={false}>
        <SquireIndicator
          state="working"
          palette="sage"
          isLead
          appearance="female"
          hood="down"
          size={24}
          label="Lead"
        />
        Lead
      </Toggle>,
    );
    const opacities = [...indicator.querySelectorAll("svg, img")].map((element) =>
      Number(getComputedStyle(element).opacity),
    );
    expect(opacities.length).toBeGreaterThanOrEqual(4);
    expect(opacities.every((opacity) => opacity === 1)).toBe(true);
    const portrait = getComputedStyle(indicator.querySelector('[data-slot="squire-portrait"]')!);
    expect(grayscaleAmount(portrait.filter)).toBe(0);
  });

  it("switches to the mark below portrait size", async () => {
    await using _env = setup();
    const indicator = await renderIndicator(
      <SquireIndicator
        state="idle"
        palette="rose"
        appearance="male"
        hood="up"
        size={18}
        label="Release"
      />,
    );
    expect(indicator.querySelector('[data-slot="squire-portrait"]')).toBeNull();
    expect(getComputedStyle(indicator.querySelector("svg")!).filter).toContain("grayscale(1)");
  });
});

/** The computed `grayscale()` amount, 0 when the filter has none. */
function grayscaleAmount(filter: string) {
  const match = /grayscale\(([\d.]+)(%?)\)/.exec(filter);
  if (match === null) return 0;
  return Number(match[1]) / (match[2] === "%" ? 100 : 1);
}

function hex(rgb: string) {
  const channels = rgb.match(/\d+/g)!.slice(0, 3).map(Number);
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

describe("mark stills", () => {
  function strokes(indicator: HTMLElement) {
    const base = indicator.querySelector('[data-slot="squire-mark-base"]')!;
    const basePaths = [...base.querySelectorAll<SVGPathElement>("g[stroke-width] path")];
    const trace = indicator.querySelector<SVGPathElement>('[data-slot="squire-mark-trace"]');
    const baseColors = new Set(basePaths.map((path) => getComputedStyle(path).stroke));
    return {
      baseOpacity: Number(getComputedStyle(base).opacity),
      baseDashed: basePaths.some((path) => getComputedStyle(path).strokeDasharray !== "none"),
      baseTones: baseColors.size,
      trace:
        trace === null
          ? null
          : {
              opacity: Number(getComputedStyle(trace).opacity),
              // Of a 100-unit path, the lit segment covers more than half.
              segment: parseFloat(getComputedStyle(trace).strokeDasharray),
              weightRatio:
                parseFloat(getComputedStyle(trace).strokeWidth) /
                parseFloat(getComputedStyle(basePaths[0]!).strokeWidth),
              brighterTone: !baseColors.has(getComputedStyle(trace).stroke),
            },
    };
  }

  it("shows a faint base under a bold, long, full-color segment while working", async () => {
    await using _env = setup();
    const indicator = await renderIndicator(forms.mark("working"));
    const working = strokes(indicator);
    expect(working.baseOpacity).toBeLessThanOrEqual(0.3);
    expect(working.trace).toMatchObject({ opacity: 1, brighterTone: true });
    expect(working.trace!.weightRatio).toBeGreaterThanOrEqual(2);
    expect(working.trace!.segment).toBeGreaterThanOrEqual(60);
    // The saturated palette tone (light surfaces use the deepened trace tone), never grayscale.
    const trace = indicator.querySelector('[data-slot="squire-mark-trace"]')!;
    const tint = getComputedStyle(indicator);
    expect([
      tint.getPropertyValue("--squire-ring").trim(),
      tint.getPropertyValue("--squire-trace").trim(),
    ]).toContain(hex(getComputedStyle(trace).stroke));
    expect(getComputedStyle(indicator.querySelector("svg")!).filter).toBe("none");
  });

  it("shows one solid, full-strength stroke in one tone while waiting", async () => {
    await using _env = setup();
    expect(strokes(await renderIndicator(forms.mark("waiting")))).toEqual({
      baseOpacity: 1,
      baseDashed: false,
      baseTones: 1,
      trace: null,
    });
  });

  it("stays dimmed and still while idle", async () => {
    await using _env = setup();
    const indicator = await renderIndicator(forms.mark("idle"));
    const svg = getComputedStyle(indicator.querySelector("svg")!);
    expect(Number(svg.opacity)).toBeLessThan(1);
    expect(svg.filter).toContain("grayscale(1)");
    expect(strokes(indicator).trace).toBeNull();
  });
});
