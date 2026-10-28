import "../../index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { EmbedThreadSwitcher } from "./EmbedThreadSwitcher";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function fontSizes(viewportWidth: number) {
  await page.viewport(viewportWidth, 800);
  await act(async () =>
    root.render(
      <EmbedThreadSwitcher
        threads={[{ id: "t1", title: "Count to two, then flash the window" }]}
        activeThreadId="t1"
        creating={false}
        onSelect={() => undefined}
        onNewThread={() => undefined}
      />,
    ),
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
    const narrow = await fontSizes(440);
    const wide = await fontSizes(960);

    expect(narrow.title).toBeGreaterThan(narrow.newThread);
    expect(wide).toEqual(narrow);
  });
});
