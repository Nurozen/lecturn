import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useWorkspaceViewport } from "./useWorkspaceViewport";

function restoreGlobals() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

async function mount({ top = 0, visual = true, enabled = true } = {}) {
  const viewport = Object.assign(new EventTarget(), { height: 806.56, offsetTop: 0, scale: 1 });
  // Both are [Replaceable] on window, so the real window takes the synthetic viewport.
  vi.stubGlobal("visualViewport", visual ? viewport : null);
  vi.stubGlobal("innerHeight", 806);
  vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: top, width: 0, height: 0 }),
  );
  function Fixture({ enabled }: { enabled: boolean }) {
    return <div ref={useWorkspaceViewport(enabled)} />;
  }
  const screen = await render(<Fixture enabled={enabled} />, { router: false }).catch(
    (error: unknown) => {
      restoreGlobals();
      throw error;
    },
  );
  const element = () => screen.container.firstElementChild as HTMLDivElement;
  return {
    viewport,
    setInnerHeight: (height: number) => vi.stubGlobal("innerHeight", height),
    height: () => element().style.getPropertyValue("--workspace-viewport-height") || undefined,
    disable: () => screen.rerender(<Fixture enabled={false} />),
    async [Symbol.asyncDispose]() {
      try {
        await screen[Symbol.asyncDispose]();
      } finally {
        restoreGlobals();
      }
    },
  };
}

describe("mobile workspace viewport", () => {
  it("reserves existing top chrome once and follows native banner resize in both directions", async () => {
    await using fixture = await mount({ top: 67 });
    const { height, viewport } = fixture;
    expect(height()).toBe("739.56px");
    viewport.height -= 33;
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBe("706.56px");
    viewport.height += 33;
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBe("739.56px");
  });

  it("tracks a short keyboard viewport and its pan, then restores the available space", async () => {
    await using fixture = await mount({ top: 24 });
    const { height, viewport } = fixture;
    viewport.height = 280;
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBe("256px");
    viewport.offsetTop = 20;
    viewport.dispatchEvent(new Event("scroll"));
    expect(height()).toBe("276px");
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event("scroll"));
    expect(height()).toBe("280px");
    viewport.height = 806.56;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBe("782.56px");
  });

  it("leaves pinch zoom alone and removes sizing/listeners on desktop or unmount", async () => {
    await using fixture = await mount();
    const { height, viewport, disable } = fixture;
    viewport.scale = 2;
    viewport.height = 200;
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBe("806.56px");
    await disable();
    expect(height()).toBeUndefined();
    viewport.scale = 1;
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBeUndefined();
  });

  it("supports WebViews without VisualViewport and clamps exhausted space", async () => {
    await using fixture = await mount({ top: 67, visual: false });
    const { height, setInnerHeight } = fixture;
    expect(height()).toBe("739px");
    setInnerHeight(60);
    window.dispatchEvent(new Event("resize"));
    expect(height()).toBe("0px");
  });

  it("does not override desktop sizing", async () => {
    await using fixture = await mount({ enabled: false });
    const { height, viewport } = fixture;
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBeUndefined();
  });
});
