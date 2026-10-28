import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { phoneAuthViewportRef } from "./usePhoneAuthViewport";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 24, width: 0, height: 0 }),
  );
  // Attached, so the input can take focus.
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function syntheticViewport() {
  const viewport = Object.assign(new EventTarget(), { height: 760, offsetTop: 0 });
  // [Replaceable] on window, so the real window takes the synthetic viewport.
  vi.stubGlobal("visualViewport", viewport);
  return viewport;
}

function focusInput() {
  const input = container.querySelector("input")!;
  input.focus();
  return input;
}

it("attaches after a portal delay and cleans up when only the viewport unmounts", async () => {
  const viewport = syntheticViewport();
  const subscribe = vi.spyOn(viewport, "addEventListener");
  const unsubscribe = vi.spyOn(viewport, "removeEventListener");
  const scrollIntoView = vi.spyOn(HTMLInputElement.prototype, "scrollIntoView");
  function Fixture({ show }: { show: boolean }) {
    const ref = phoneAuthViewportRef(true);
    return show ? (
      <div ref={ref}>
        <input />
      </div>
    ) : null;
  }
  await act(async () => root.render(<Fixture show={false} />));
  expect(subscribe).not.toHaveBeenCalled();
  await act(async () => root.render(<Fixture show />));
  let element = container.firstElementChild as HTMLDivElement;
  focusInput();
  expect(element.style.height).toBe("736px");
  expect(subscribe.mock.calls.map(([event]) => event)).toEqual(["resize", "scroll"]);
  viewport.height = 280;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.height).toBe("256px");
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

  await act(async () => root.render(<Fixture show />));
  expect(subscribe).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<Fixture show={false} />));
  expect(unsubscribe.mock.calls).toEqual(subscribe.mock.calls);
  expect(element.style.height).toBe("");
  scrollIntoView.mockClear();
  viewport.height = 450;
  viewport.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("scroll"));
  expect(element.style.height).toBe("");
  expect(scrollIntoView).not.toHaveBeenCalled();

  await act(async () => root.render(<Fixture show />));
  element = container.firstElementChild as HTMLDivElement;
  expect(element.style.height).toBe("426px");
  expect(subscribe).toHaveBeenCalledTimes(4);
  await act(async () => root.unmount());
  expect(unsubscribe.mock.calls).toEqual(subscribe.mock.calls);
  expect(element.style.height).toBe("");
});

it("reflows on keyboard resize, keeps the focused input visible and restores normal sizing on exit", async () => {
  const viewport = syntheticViewport();
  const scrollIntoView = vi.spyOn(HTMLInputElement.prototype, "scrollIntoView");
  function Fixture({ enabled }: { enabled: boolean }) {
    return (
      <div ref={phoneAuthViewportRef(enabled)}>
        <input />
      </div>
    );
  }
  await act(async () => root.render(<Fixture enabled />));
  const element = container.firstElementChild as HTMLDivElement;
  focusInput();
  expect(element.style.height).toBe("736px");
  viewport.height = 280;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.height).toBe("256px");
  viewport.offsetTop = 10;
  viewport.dispatchEvent(new Event("scroll"));
  expect(element.style.height).toBe("266px");
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  await act(async () => root.render(<Fixture enabled={false} />));
  expect(element.style.height).toBe("");
  viewport.height = 450;
  viewport.dispatchEvent(new Event("resize"));
  expect(element.style.height).toBe("");
});
