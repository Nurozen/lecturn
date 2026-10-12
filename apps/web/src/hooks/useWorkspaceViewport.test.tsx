import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useWorkspaceViewport } from "./useWorkspaceViewport";

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function mount({ top = 0, visual = true, enabled = true } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const viewport = Object.assign(new EventTarget(), { height: 806.56, offsetTop: 0, scale: 1 });
  const windowTarget = Object.assign(new EventTarget(), {
    visualViewport: visual ? viewport : undefined,
    innerHeight: 806,
  });
  const properties = new Map<string, string>();
  const element = {
    getBoundingClientRect: () => ({ top }),
    style: {
      setProperty: (key: string, value: string) => properties.set(key, value),
      removeProperty: (key: string) => properties.delete(key),
    },
  };
  vi.stubGlobal("window", windowTarget);
  function Fixture({ enabled }: { enabled: boolean }) {
    return <div ref={useWorkspaceViewport(enabled)} />;
  }
  await act(async () => {
    renderer = create(<Fixture enabled={enabled} />, { createNodeMock: () => element });
  });
  return {
    viewport,
    windowTarget,
    height: () => properties.get("--workspace-viewport-height"),
    disable: () => act(async () => renderer.update(<Fixture enabled={false} />)),
  };
}

describe("mobile workspace viewport", () => {
  it("reserves existing top chrome once and follows native banner resize in both directions", async () => {
    const { height, viewport } = await mount({ top: 67 });
    expect(height()).toBe("739.56px");
    viewport.height -= 33;
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBe("706.56px");
    viewport.height += 33;
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBe("739.56px");
  });

  it("tracks a short keyboard viewport and its pan, then restores the available space", async () => {
    const { height, viewport } = await mount({ top: 24 });
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
    const { height, viewport, disable } = await mount();
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
    const { height, windowTarget } = await mount({ top: 67, visual: false });
    expect(height()).toBe("739px");
    windowTarget.innerHeight = 60;
    windowTarget.dispatchEvent(new Event("resize"));
    expect(height()).toBe("0px");
  });

  it("does not override desktop sizing", async () => {
    const { height, viewport } = await mount({ enabled: false });
    viewport.dispatchEvent(new Event("resize"));
    expect(height()).toBeUndefined();
  });
});
