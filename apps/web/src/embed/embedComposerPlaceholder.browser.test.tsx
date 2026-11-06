import "~/index.css";
import "./embed.css";

import type { EmbedHostContext } from "@lecturn/contracts/embedBridge";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../test/render";
import { idleComposerPlaceholder } from "../composerPlaceholder";
import {
  installEmbedComposerPlaceholder,
  useEmbedComposerPlaceholder,
} from "./embedComposerPlaceholder";

const LECTURN_PLACEHOLDER = "Ask anything, @tag files/folders, $use skills, or / for commands";

/** ChatComposer's idle states: an empty thread, a follow-up, resting with and without attach. */
type IdleState = Omit<Parameters<typeof idleComposerPlaceholder>[0], "hostPlaceholder">;
const EXPANDED: IdleState = { hasSession: true, resting: false, canAttach: true };
const IDLE_STATES: ReadonlyArray<readonly [string, IdleState, string]> = [
  [
    "a copied thread with no session yet",
    { hasSession: false, resting: true, canAttach: true },
    "Ask for changes, send follow-ups, or attach images",
  ],
  [
    "a resting follow-up",
    { hasSession: true, resting: true, canAttach: true },
    "Ask for changes, send follow-ups, or attach files",
  ],
  [
    "a resting follow-up without attach",
    { hasSession: true, resting: true, canAttach: false },
    "Ask for changes or send a follow-up",
  ],
  ["an expanded composer", EXPANDED, LECTURN_PLACEHOLDER],
];

// Marks the document as the embed and owns the installed placeholder bridge for one test.
// The container is handed to render(), which removes it on dispose.
function setup(width?: number) {
  document.documentElement.dataset.lecturnEmbed = "";
  const container = document.createElement("div");
  if (width !== undefined) container.style.width = `${width}px`;
  let uninstall: () => void = () => undefined;
  return {
    container,
    install(bridge: Parameters<typeof installEmbedComposerPlaceholder>[0]) {
      uninstall = installEmbedComposerPlaceholder(bridge);
    },
    uninstall: () =>
      act(() => {
        uninstall();
        uninstall = () => undefined;
      }),
    [Symbol.dispose]() {
      uninstall();
      delete document.documentElement.dataset.lecturnEmbed;
    },
  };
}

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
function Composer({ state = EXPANDED }: { readonly state?: IdleState }) {
  const placeholder = idleComposerPlaceholder({
    ...state,
    hostPlaceholder: useEmbedComposerPlaceholder(),
  });
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
              {placeholder}
            </div>
          </div>
        </div>
      </div>
      <div data-embed-composer-footer-stacked="true" />
    </div>
  );
}

const placeholderElement = () =>
  document.querySelector<HTMLElement>("[data-composer-placeholder]")!;

describe.each([352, 320])("the host's composer placeholder in a %i px pane", (width) => {
  it("shows the host's wording whole on the input line", async () => {
    using env = setup(width);
    env.install(fakeBridge({ ...base, composerPlaceholder: "Ask for changes…" }));
    await using _screen = await render(<Composer />, { container: env.container });

    const placeholder = placeholderElement();
    expect(placeholder.textContent).toBe("Ask for changes…");
    expect(placeholder.scrollWidth).toBeLessThanOrEqual(placeholder.clientWidth);
    const lineHeight = Number.parseFloat(getComputedStyle(placeholder).lineHeight);
    expect(placeholder.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight + 1);
  });
});

describe.each([352, 320])("every idle prompt in a %i px pane", (width) => {
  it.each(IDLE_STATES)("gives %s the host's placeholder", async (_name, state, lecturn) => {
    using env = setup(width);
    const bridge = fakeBridge(base);
    env.install(bridge);
    await using _screen = await render(<Composer state={state} />, { container: env.container });
    expect(placeholderElement().textContent).toBe(lecturn);

    await act(async () =>
      bridge.change({ ...base, composerPlaceholder: "Ask about this design…" }),
    );
    expect(placeholderElement().textContent).toBe("Ask about this design…");
  });
});

describe("installEmbedComposerPlaceholder", () => {
  it("follows the host's changes and gives the prompt back when cleared or uninstalled", async () => {
    using env = setup();
    const bridge = fakeBridge(base);
    env.install(bridge);
    await using _screen = await render(<Composer />, { container: env.container });
    expect(placeholderElement().textContent).toBe(LECTURN_PLACEHOLDER);

    await act(async () => bridge.change({ ...base, composerPlaceholder: "Describe the change…" }));
    expect(placeholderElement().textContent).toBe("Describe the change…");

    await act(async () => bridge.change(base));
    expect(placeholderElement().textContent).toBe(LECTURN_PLACEHOLDER);

    await act(async () => bridge.change({ ...base, composerPlaceholder: "Ask for changes…" }));
    await env.uninstall();
    expect(placeholderElement().textContent).toBe(LECTURN_PLACEHOLDER);
  });

  it("leaves Lecturn's prompt alone without a bridge", async () => {
    using env = setup();
    env.install(null);
    await using _screen = await render(<Composer />, { container: env.container });
    expect(placeholderElement().textContent).toBe(LECTURN_PLACEHOLDER);
  });
});
