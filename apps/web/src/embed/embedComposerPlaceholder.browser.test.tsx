import "~/index.css";
import "./embed.css";

import type { EmbedHostContext } from "@lecturn/contracts/embedBridge";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  installEmbedComposerPlaceholder,
  useEmbedComposerPlaceholder,
} from "./embedComposerPlaceholder";

const LECTURN_PLACEHOLDER = "Ask anything, @tag files/folders, $use skills, or / for commands";

let root: Root;
let container: HTMLDivElement;
let uninstall: () => void = () => undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.lecturnEmbed = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  uninstall();
  container.remove();
  delete document.documentElement.dataset.lecturnEmbed;
  vi.unstubAllGlobals();
});

function fakeBridge(initial: EmbedHostContext) {
  let context = initial;
  const listeners = new Set<(context: EmbedHostContext) => void>();
  return {
    hostContext: () => context,
    subscribeHostContext: (listener: (context: EmbedHostContext) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    change(next: EmbedHostContext) {
      context = next;
      for (const listener of listeners) listener(next);
    },
  };
}

const base: EmbedHostContext = { theme: "dark", displayMode: "inline", locale: "en-US" };

// The idle prompt as ChatComposer chooses it, inside the embed's one-line input (embed.css).
function Composer() {
  const placeholder = useEmbedComposerPlaceholder();
  return (
    <div data-slot="composer-shell" className="relative">
      <div data-chat-composer-body="true" className="relative px-3 pt-3.5 pb-2">
        <div className="relative" style={{ paddingRight: "calc(5rem + 1rem)" }}>
          <div className="relative flow-root text-sm">
            <div className="composer-tiptap -m-1 block min-h-19.5 p-1 leading-relaxed">
              <p>
                <br />
              </p>
            </div>
            <div
              data-composer-placeholder
              className="pointer-events-none absolute inset-0 leading-relaxed"
            >
              {placeholder ?? LECTURN_PLACEHOLDER}
            </div>
          </div>
        </div>
      </div>
      <div data-embed-composer-footer-stacked="true" />
    </div>
  );
}

const placeholderElement = () =>
  container.querySelector<HTMLElement>("[data-composer-placeholder]")!;

describe.each([352, 320])("the host's composer placeholder in a %i px pane", (width) => {
  it("shows the host's wording whole on the input line", async () => {
    container.style.width = `${width}px`;
    const bridge = fakeBridge({ ...base, composerPlaceholder: "Ask for changes…" });
    uninstall = installEmbedComposerPlaceholder(bridge);
    await act(async () => root.render(<Composer />));

    const placeholder = placeholderElement();
    expect(placeholder.textContent).toBe("Ask for changes…");
    expect(placeholder.scrollWidth).toBeLessThanOrEqual(placeholder.clientWidth);
    const lineHeight = Number.parseFloat(getComputedStyle(placeholder).lineHeight);
    expect(placeholder.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight + 1);
  });
});

describe("installEmbedComposerPlaceholder", () => {
  it("follows the host's changes and gives the prompt back when cleared or uninstalled", async () => {
    const bridge = fakeBridge(base);
    uninstall = installEmbedComposerPlaceholder(bridge);
    await act(async () => root.render(<Composer />));
    expect(placeholderElement().textContent).toBe(LECTURN_PLACEHOLDER);

    await act(async () => bridge.change({ ...base, composerPlaceholder: "Describe the change…" }));
    expect(placeholderElement().textContent).toBe("Describe the change…");

    await act(async () => bridge.change(base));
    expect(placeholderElement().textContent).toBe(LECTURN_PLACEHOLDER);

    await act(async () => bridge.change({ ...base, composerPlaceholder: "Ask for changes…" }));
    await act(async () => uninstall());
    uninstall = () => undefined;
    expect(placeholderElement().textContent).toBe(LECTURN_PLACEHOLDER);
  });

  it("leaves Lecturn's prompt alone without a bridge", async () => {
    uninstall = installEmbedComposerPlaceholder(null);
    await act(async () => root.render(<Composer />));
    expect(placeholderElement().textContent).toBe(LECTURN_PLACEHOLDER);
  });
});
