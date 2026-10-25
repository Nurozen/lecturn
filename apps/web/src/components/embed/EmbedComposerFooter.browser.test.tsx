import "~/index.css";
import "../../embed/embed.css";

import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EmbedPresentationContext } from "../../embed/EmbedPresentationContext";
import { measureRestingComposerControls } from "../chat/restingComposerControlsMeasurement";
import { EmbedComposerFooter } from "./EmbedComposerFooter";

const presentation = {
  projectRef: scopeProjectRef(EnvironmentId.make("env-1"), ProjectId.make("project-1")),
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.width = "360px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete document.documentElement.dataset.lecturnEmbed;
  vi.unstubAllGlobals();
});

// The footer's two children as ChatComposer passes them: the controls, then the actions.
const controlsChild = (
  <div
    data-chat-composer-controls="left"
    data-chat-composer-footer-controls="true"
    className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5"
  >
    <button type="button" data-chat-provider-model-picker className="w-28 shrink-0">
      Opus 5
    </button>
    <div data-resting-block="traits" className="flex w-max min-w-max shrink-0 items-center">
      <button type="button" className="w-24">
        High
      </button>
    </div>
    <div data-resting-block="mode" className="flex w-max min-w-max shrink-0 items-center">
      <button type="button" className="w-32">
        Supervised
      </button>
    </div>
  </div>
);
const actionsChild = (
  <div data-chat-composer-actions="right" className="flex shrink-0 items-center justify-end">
    <button type="button">Send</button>
  </div>
);

const footer = (stacked: boolean) => (
  <EmbedComposerFooter
    stacked={stacked}
    contextual={<button type="button">Contextual · Off</button>}
    data-chat-composer-footer="true"
    className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-3 pb-3"
  >
    {controlsChild}
    {actionsChild}
  </EmbedComposerFooter>
);

const render = (node: ReactNode, embedded: boolean) => {
  if (embedded) document.documentElement.dataset.lecturnEmbed = "";
  return act(async () =>
    root.render(
      embedded ? (
        <EmbedPresentationContext value={presentation}>{node}</EmbedPresentationContext>
      ) : (
        node
      ),
    ),
  );
};

const buttonTexts = (element: Element) =>
  Array.from(element.querySelectorAll("button"), (button) => button.textContent);

describe("EmbedComposerFooter", () => {
  it("puts model, effort and access on the first row and Contextual with the actions on the second", async () => {
    await render(footer(true), true);

    const rows = container.querySelectorAll(
      '[data-testid="embed-composer-footer"] [data-testid="embed-composer-footer-row"]',
    );
    expect(rows).toHaveLength(2);
    const [first, second] = rows as unknown as [HTMLElement, HTMLElement];
    expect(buttonTexts(first)).toEqual(["Opus 5", "High", "Supervised"]);
    expect(buttonTexts(second)).toEqual(["Contextual · Off", "Send"]);
    expect(second.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      first.getBoundingClientRect().bottom,
    );

    // The controls row wraps rather than overflows, so the measurement keeps every block visible.
    const controls = first.querySelector<HTMLElement>("[data-chat-composer-footer-controls]")!;
    expect(measureRestingComposerControls(controls)?.wraps).toBe(true);
  });

  it("keeps the controls mounted when the embed footer stops stacking", async () => {
    await render(footer(true), true);
    const controls = container.querySelector("[data-chat-composer-footer-controls]");

    await render(footer(false), true);

    expect(container.querySelector("[data-chat-composer-footer-controls]")).toBe(controls);
    expect(container.textContent).not.toContain("Contextual");
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="embed-composer-footer-row"]'),
    );
    expect(getComputedStyle(first!).display).toBe("contents");
    expect(getComputedStyle(second!).display).toBe("contents");
  });

  it("renders the plain footer div outside the embed", async () => {
    await render(
      <div
        data-chat-composer-footer="true"
        className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-3 pb-3"
      >
        {controlsChild}
        {actionsChild}
      </div>,
      false,
    );
    const plain = container.innerHTML;

    await render(footer(true), false);

    expect(container.innerHTML).toBe(plain);
  });
});
