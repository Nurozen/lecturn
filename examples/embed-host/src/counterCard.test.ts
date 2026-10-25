// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import {
  type ChecklistName,
  evaluateProbe,
  loadChecklist,
  type ProbeLocator,
  type ProbeRoot,
  playwrightProbeRoot,
} from "../../../scripts/bar/probe-dom.ts";
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

function domLocator(elements: () => Array<Element>, frame: Document): ProbeLocator {
  return {
    locator: (selector) =>
      domLocator(
        () => elements().flatMap((element) => Array.from(element.querySelectorAll(selector))),
        frame,
      ),
    count: async () => elements().length,
    allInnerTexts: async () => elements().map((element) => element.textContent ?? ""),
    all: async () => elements().map((element) => domLocator(() => [element], frame)),
    first: () => domLocator(() => elements().slice(0, 1), frame),
    contentFrame: () => documentHost(frame, frame),
    evaluateAll: async (fn) => fn(elements()),
  };
}

function documentHost(document: Document, frame: Document) {
  return {
    locator: (selector: string) =>
      domLocator(() => Array.from(document.querySelectorAll(selector)), frame),
  };
}

/** The card as Lecturn's timeline mounts it: an iframe inside an `mcp-app-card` row. */
function hostPageRoot(card: Document): ProbeRoot {
  const page = card.implementation.createHTMLDocument("host");
  page.body.innerHTML = `<div data-testid="mcp-app-card"><iframe></iframe></div>`;
  return playwrightProbeRoot(documentHost(page, card));
}

async function rowProbe(name: ChecklistName, id: string) {
  const probe = (await loadChecklist(name)).rows.find((row) => row.id === id)?.probe;
  if (!probe) throw new Error(`${name} checklist has no probe for ${id}`);
  return probe;
}

const wide = {
  width: 760,
  layout: "wide",
  checklist: "desktop",
  row: "desktop.main.card-wide",
} as const;
const narrow = {
  width: 380,
  layout: "narrow",
  checklist: "embed",
  row: "embed.timeline.card-narrow",
} as const;
const forms = [
  { ...wide, other: narrow },
  { ...narrow, other: wide },
];

describe("counter card structure hooks", () => {
  it.each(forms)("passes the $row probe at $width px and not the other form's", async (form) => {
    const card = renderCard(form.width);
    card.sendToolResult({ count: 5, by: 2, history: [1, 3, 5] });
    const root = hostPageRoot(card.document);

    expect(await evaluateProbe(await rowProbe(form.checklist, form.row), root)).toEqual({
      passed: true,
    });
    expect(
      await evaluateProbe(await rowProbe(form.other.checklist, form.other.row), root),
    ).toMatchObject({
      passed: false,
      reason: expect.stringContaining(`[data-card-layout="${form.other.layout}"]`),
    });
  });

  it.each(forms)("exposes the icon, saved state and curve at $width px", async (form) => {
    const card = renderCard(form.width);
    card.sendToolResult({ count: 5, by: 2, history: [1, 3, 5] });
    const root = playwrightProbeRoot(documentHost(card.document, card.document));

    expect(
      await evaluateProbe(
        {
          kind: "all",
          probes: [
            { kind: "count", selector: "[data-card-title] [data-card-icon]", min: 1, max: 1 },
            { kind: "text", selector: "[data-card-chip]", equals: "Saved" },
            { kind: "text", selector: "[data-card-subtitle]", equals: "Saved result" },
            // The icon is itself an svg path, so the curve is checked on its own.
            { kind: "chart-points", selector: "[data-card-chart] polyline", min: 3 },
          ],
        },
        root,
      ),
    ).toEqual({ passed: true });
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
