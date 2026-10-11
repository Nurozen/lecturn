import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { usePhoneAuthViewport } from "./usePhoneAuthViewport";

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("reflows on keyboard resize, keeps the focused input visible and restores normal sizing on exit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const viewport = Object.assign(new EventTarget(), { height: 760 });
  class Input {
    scrollIntoView = vi.fn();
  }
  const input = new Input();
  const element = {
    style: { height: "", removeProperty: vi.fn() },
    contains: (node: unknown) => node === input,
  };
  vi.stubGlobal("window", { visualViewport: viewport });
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("document", { activeElement: input });
  function Fixture({ enabled }: { enabled: boolean }) {
    return <div ref={usePhoneAuthViewport(enabled)} />;
  }
  await act(async () => {
    renderer = create(<Fixture enabled />, { createNodeMock: () => element });
  });
  expect(element.style.height).toBe("760px");
  viewport.height = 280;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.height).toBe("280px");
  expect(input.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  await act(async () => renderer.update(<Fixture enabled={false} />));
  expect(element.style.removeProperty).toHaveBeenCalledWith("height");
  viewport.height = 450;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.height).toBe("280px");
});
