import { describe, expect, it, vi } from "vite-plus/test";
import { render as renderUi, type Screen } from "../../../test/render";

import { useFollowEndWhenDrawerDocks } from "./dockedDrawerFollow";

let container: HTMLDivElement;

let testScreen: Screen;

async function setup(): Promise<AsyncDisposable> {
  container = document.createElement("div");
  document.body.append(container);
  testScreen = await renderUi(null, { container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await testScreen[Symbol.asyncDispose]();
      for (const overlay of overlays) overlay.remove();
      overlays = [];
    },
  };
}
let overlays: Array<HTMLElement> = [];

function Harness(props: {
  overlay: HTMLElement;
  inset: number;
  following: boolean;
  scrollToEnd: () => void;
}) {
  useFollowEndWhenDrawerDocks({
    readOverlay: () => props.overlay,
    inset: props.inset,
    isFollowingEnd: () => props.following,
    scrollToEnd: props.scrollToEnd,
  });
  return null;
}

/** The composer overlay as ChatView measures it: a docked drawer (when given) above the input. */
function overlayWith(drawerHeight: number | null) {
  const overlay = document.createElement("div");
  if (drawerHeight !== null) {
    const drawer = document.createElement("div");
    drawer.dataset.chatComposerTopDrawer = "true";
    drawer.style.height = `${drawerHeight}px`;
    overlay.append(drawer);
  }
  const input = document.createElement("div");
  input.style.height = "120px";
  overlay.append(input);
  // Outside the React root, which clears its container on mount.
  document.body.append(overlay);
  overlays.push(overlay);
  return overlay;
}

describe("useFollowEndWhenDrawerDocks", () => {
  it("re-pins a following timeline when a drawer docks, and again only when it grows", async () => {
    await using _setup = await setup();
    const scrollToEnd = vi.fn();
    const overlay = overlayWith(null);
    const render = (inset: number) =>
      testScreen.rerender(
        <Harness overlay={overlay} inset={inset} following scrollToEnd={scrollToEnd} />,
      );
    await render(120);
    expect(scrollToEnd).not.toHaveBeenCalled();

    const drawer = document.createElement("div");
    drawer.dataset.chatComposerTopDrawer = "true";
    drawer.style.height = "64px";
    overlay.prepend(drawer);
    await render(184);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    // The composer growing under the same drawer is typing, not a new drawer.
    await render(204);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    drawer.style.height = "96px";
    await render(236);
    expect(scrollToEnd).toHaveBeenCalledTimes(2);

    drawer.remove();
    await render(140);
    overlay.prepend(drawer);
    await render(236);
    expect(scrollToEnd).toHaveBeenCalledTimes(3);
  });

  it("leaves a timeline the user scrolled away from where it is", async () => {
    await using _setup = await setup();
    const scrollToEnd = vi.fn();
    const overlay = overlayWith(64);
    await testScreen.rerender(
      <Harness overlay={overlay} inset={184} following={false} scrollToEnd={scrollToEnd} />,
    );
    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});
