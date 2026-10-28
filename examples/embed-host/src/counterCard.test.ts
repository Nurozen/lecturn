// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { counterCardResource } from "./counterCard.ts";

interface CardDom {
  readonly window: Window & typeof globalThis;
}
interface CardDomOptions {
  readonly runScripts: "dangerously";
  readonly pretendToBeVisual: boolean;
  readonly beforeParse: (window: Window & typeof globalThis) => void;
}
// jsdom is not a dependency of this package; Vitest's jsdom environment exposes its instance.
const JSDOM = (
  globalThis as unknown as {
    jsdom: { constructor: new (html: string, options: CardDomOptions) => CardDom };
  }
).jsdom.constructor;

function renderCard(initialWidth: number) {
  let width = initialWidth;
  const listeners = new Set<() => void>();
  const { window } = new JSDOM(counterCardResource().text, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse: (target) => {
      // jsdom does no layout, so viewport queries are answered from the width under test.
      const matchMedia = (query: string) => {
        const min = Number(/min-width:\s*(\d+)px/u.exec(query)?.[1] ?? 0);
        return {
          get matches() {
            return width >= min;
          },
          addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        };
      };
      target.matchMedia = matchMedia as unknown as Window["matchMedia"];
    },
  });
  return {
    document: window.document,
    resize: (next: number) => {
      width = next;
      for (const listener of listeners) listener();
    },
    sendToolResult: (structuredContent: Record<string, unknown>) =>
      window.dispatchEvent(
        new window.MessageEvent("message", {
          source: window,
          data: {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: { structuredContent },
          },
        }),
      ),
  };
}

const forms = [
  { width: 760, layout: "wide" },
  { width: 380, layout: "narrow" },
] as const;

describe("counter card structure hooks", () => {
  it.each(forms)("draws the $layout form's icon, saved state and curve at $width px", (form) => {
    const card = renderCard(form.width);
    card.sendToolResult({ count: 5, by: 2, history: [1, 3, 5] });
    const doc = card.document;
    const points = (doc.querySelector("[data-card-chart] polyline")?.getAttribute("points") ?? "")
      .trim()
      .split(/\s+/u);

    expect(doc.querySelector("[data-card-layout]")?.getAttribute("data-card-layout")).toBe(
      form.layout,
    );
    expect(doc.querySelectorAll("[data-card-title] [data-card-icon]")).toHaveLength(1);
    expect(doc.querySelector("[data-card-chip]")?.textContent).toBe("Saved");
    expect(doc.querySelector("[data-card-subtitle]")?.textContent).toBe("Saved result");
    expect(points.length).toBeGreaterThanOrEqual(3);
  });

  it.each(forms)("pairs each stat's label with its value at $width px", (form) => {
    const card = renderCard(form.width);
    card.sendToolResult({ count: 5, by: 2, history: [1, 3, 5] });
    const rows = Array.from(card.document.querySelectorAll("[data-card-stat]"), (stat) =>
      Array.from(stat.children, (child) => child.textContent),
    );
    expect(rows).toEqual([
      ["Count", "5"],
      ["Change", "+2"],
      ["Calls", "3"],
    ]);
  });

  it.each(forms)("draws an unfilled curve on labelled axes at $width px", (form) => {
    const card = renderCard(form.width);
    card.sendToolResult({ count: 5, by: 2, history: [1, 3, 5] });
    const chart = card.document.querySelector("[data-card-chart]");
    if (!chart) throw new Error("no chart");
    const ticks = (axis: "x" | "y") =>
      Array.from(chart.querySelectorAll(`[data-card-tick="${axis}"]`), (tick) => ({
        label: Number(tick.textContent),
        x: Number(tick.getAttribute("x")),
        y: Number(tick.getAttribute("y")),
      }));
    const curve = (chart.querySelector("polyline")?.getAttribute("points") ?? "")
      .split(" ")
      .map((pair) => pair.split(",").map(Number));

    expect(chart.querySelectorAll('[data-card-axis="x"], [data-card-axis="y"]')).toHaveLength(2);
    expect(chart.querySelectorAll("line.grid").length).toBeGreaterThan(0);
    expect(chart.querySelectorAll("path, polygon")).toHaveLength(0);
    // One x tick per call, each under its point.
    expect(ticks("x").map((tick) => tick.label)).toEqual([1, 2, 3]);
    curve.forEach(([x], index) => expect(x).toBeCloseTo(ticks("x")[index]!.x, 0));
    // The y ticks span the history from zero, and the first point sits between 0 and 2.
    const y = ticks("y");
    expect(y[0]!.label).toBe(0);
    expect(y.at(-1)!.label).toBeGreaterThanOrEqual(5);
    const zero = y.find((tick) => tick.label === 0)!.y;
    const two = y.find((tick) => tick.label === 2)!.y;
    expect(curve[0]![1]).toBeCloseTo((zero + two) / 2, 0);
  });

  it.each(forms)("draws a single call as a dot inside the plot at $width px", (form) => {
    const card = renderCard(form.width);
    card.sendToolResult({ count: 1, by: 1, history: [1] });
    const chart = card.document.querySelector("[data-card-chart]");
    if (!chart) throw new Error("no chart");
    const ticks = (axis: "x" | "y") =>
      Array.from(chart.querySelectorAll(`[data-card-tick="${axis}"]`), (tick) => ({
        label: Number(tick.textContent),
        x: Number(tick.getAttribute("x")),
        y: Number(tick.getAttribute("y")),
      }));
    const dots = chart.querySelectorAll("[data-card-point]");

    expect(ticks("x").map((tick) => tick.label)).toEqual([1]);
    expect(dots).toHaveLength(1);
    const dot = { x: Number(dots[0]!.getAttribute("cx")), y: Number(dots[0]!.getAttribute("cy")) };
    expect(dot.x).toBeCloseTo(ticks("x")[0]!.x, 0);
    const y = ticks("y");
    expect(y.map((tick) => tick.label)).toEqual([0, 1, 2]);
    expect(dot.y).toBeCloseTo(y[1]!.y, 0);
  });

  it("drops the dot once the counter has a history", () => {
    const card = renderCard(380);
    card.sendToolResult({ count: 1, by: 1, history: [1] });
    card.sendToolResult({ count: 2, by: 1, history: [1, 2] });
    expect(card.document.querySelectorAll("[data-card-point]")).toHaveLength(0);
  });

  it("renames its layout when the frame crosses 560 px", () => {
    const card = renderCard(760);
    const layout = () =>
      card.document.querySelector("[data-card-layout]")?.getAttribute("data-card-layout");
    expect(layout()).toBe("wide");
    card.resize(380);
    expect(layout()).toBe("narrow");
    card.resize(560);
    expect(layout()).toBe("wide");
  });
});
