import "../../index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render as renderUi, type Screen } from "../../../test/render";

import { EmbedThreadSwitcher } from "./EmbedThreadSwitcher";

let container: HTMLDivElement;

let testScreen: Screen;

async function setup(): Promise<AsyncDisposable> {
  container = document.createElement("div");
  document.body.append(container);
  testScreen = await renderUi(null, { container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await testScreen[Symbol.asyncDispose]();
      vi.unstubAllGlobals();
    },
  };
}

async function fontSizes(viewportWidth: number) {
  await page.viewport(viewportWidth, 800);
  await testScreen.rerender(
    <EmbedThreadSwitcher
      threads={[{ id: "t1", title: "Count to two, then flash the window" }]}
      activeThreadId="t1"
      creating={false}
      onSelect={() => undefined}
      onNewThread={() => undefined}
    />,
  );
  const size = (element: Element | null | undefined) =>
    Number.parseFloat(getComputedStyle(element!).fontSize);
  return {
    title: size(container.querySelector('[aria-label="Thread"]')),
    newThread: size(
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("New thread"),
      ),
    ),
  };
}

describe("EmbedThreadSwitcher", () => {
  // The pane is the embed's whole viewport, so a narrow one must not take the phone type scale.
  it("keeps the thread title above the New thread action at every pane width", async () => {
    await using _setup = await setup();
    const narrow = await fontSizes(440);
    const wide = await fontSizes(960);

    expect(narrow.title).toBeGreaterThan(narrow.newThread);
    expect(wide).toEqual(narrow);
  });
});
