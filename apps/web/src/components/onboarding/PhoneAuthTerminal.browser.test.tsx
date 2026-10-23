import { act, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PhoneAuthTerminal } from "./PhoneAuthTerminal";

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
const render = (element: ReactElement) => act(async () => root.render(element));

it("keeps output mounted while collapsed and requires explicit input opt-in each time", async () => {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Terminal() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return <textarea />;
  }
  await render(<PhoneAuthTerminal enabled>{() => <Terminal />}</PhoneAuthTerminal>);
  const region = () => container.querySelector<HTMLDivElement>("div[id]")!;
  const click = async (label: string) =>
    act(async () =>
      [...container.querySelectorAll("button")].find((node) => node.textContent === label)!.click(),
    );
  expect(region().hidden).toBe(true);
  expect(region().inert).toBe(true);
  await click("Show terminal details");
  expect(region().hidden).toBe(false);
  expect(region().inert).toBe(true);
  await click("Enable advanced terminal input");
  expect(region().inert).toBe(false);
  await click("Hide terminal details");
  await click("Show terminal details");
  expect(region().inert).toBe(true);
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});

it("leaves desktop and remote terminals visible and interactive", async () => {
  await render(
    <PhoneAuthTerminal enabled={false}>
      {(visible) => (visible ? <textarea /> : null)}
    </PhoneAuthTerminal>,
  );
  expect(container.querySelectorAll("button")).toHaveLength(0);
  const region = container.querySelector<HTMLDivElement>("div[id]")!;
  expect(region.hidden).toBe(false);
  expect(region.inert).toBe(false);
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
});
