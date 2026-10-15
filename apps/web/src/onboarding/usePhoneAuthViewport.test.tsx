import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { usePhoneAuthViewport } from "./usePhoneAuthViewport";

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("attaches after a portal delay and cleans up when only the viewport unmounts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const viewport = Object.assign(new EventTarget(), { height: 760, offsetTop: 0 });
  const subscribe = vi.spyOn(viewport, "addEventListener");
  const unsubscribe = vi.spyOn(viewport, "removeEventListener");
  class Input {
    scrollIntoView = vi.fn();
  }
  const input = new Input();
  const element = {
    getBoundingClientRect: () => ({ top: 24 }),
    style: {
      height: "",
      removeProperty: vi.fn(() => {
        element.style.height = "";
      }),
    },
    contains: (node: unknown) => node === input,
  };
  vi.stubGlobal("window", { visualViewport: viewport });
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("HTMLTextAreaElement", Input);
  vi.stubGlobal("document", { activeElement: input });
  function Fixture({ show }: { show: boolean }) {
    const ref = usePhoneAuthViewport(true);
    return show ? <div ref={ref} /> : null;
  }
  await act(async () => {
    renderer = create(<Fixture show={false} />, { createNodeMock: () => element });
  });
  expect(subscribe).not.toHaveBeenCalled();
  await act(async () => renderer.update(<Fixture show />));
  expect(element.style.height).toBe("736px");
  expect(subscribe.mock.calls.map(([event]) => event)).toEqual(["resize", "scroll"]);
  viewport.height = 280;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.height).toBe("256px");
  expect(input.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

  await act(async () => renderer.update(<Fixture show />));
  expect(subscribe).toHaveBeenCalledTimes(2);
  await act(async () => renderer.update(<Fixture show={false} />));
  expect(unsubscribe.mock.calls).toEqual(subscribe.mock.calls);
  expect(element.style.height).toBe("");
  input.scrollIntoView.mockClear();
  viewport.height = 450;
  viewport.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("scroll"));
  expect(element.style.height).toBe("");
  expect(input.scrollIntoView).not.toHaveBeenCalled();

  await act(async () => renderer.update(<Fixture show />));
  expect(element.style.height).toBe("426px");
  expect(subscribe).toHaveBeenCalledTimes(4);
  await act(async () => renderer.unmount());
  expect(unsubscribe.mock.calls).toEqual(subscribe.mock.calls);
  expect(element.style.height).toBe("");
});
it("reflows on keyboard resize, keeps the focused input visible and restores normal sizing on exit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const viewport = Object.assign(new EventTarget(), { height: 760, offsetTop: 0 });
  class Input {
    scrollIntoView = vi.fn();
  }
  const input = new Input();
  const element = {
    getBoundingClientRect: () => ({ top: 24 }),
    style: { height: "", removeProperty: vi.fn() },
    contains: (node: unknown) => node === input,
  };
  vi.stubGlobal("window", { visualViewport: viewport });
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("HTMLTextAreaElement", Input);
  vi.stubGlobal("document", { activeElement: input });
  function Fixture({ enabled }: { enabled: boolean }) {
    return <div ref={usePhoneAuthViewport(enabled)} />;
  }
  await act(async () => {
    renderer = create(<Fixture enabled />, { createNodeMock: () => element });
  });
  expect(element.style.height).toBe("736px");
  viewport.height = 280;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.height).toBe("256px");
  viewport.offsetTop = 10;
  viewport.dispatchEvent(new Event("scroll"));
  expect(element.style.height).toBe("266px");
  expect(input.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  await act(async () => renderer.update(<Fixture enabled={false} />));
  expect(element.style.removeProperty).toHaveBeenCalledWith("height");
  viewport.height = 450;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.height).toBe("266px");
});
