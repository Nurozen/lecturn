import { useEffect, type ReactElement } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render as renderUi, type Screen } from "../../../test/render";
import { PhoneAuthTerminal } from "./PhoneAuthTerminal";

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
const render = (element: ReactElement) => testScreen.rerender(element);

it("keeps output mounted while collapsed and requires explicit input opt-in each time", async () => {
  await using _setup = await setup();
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
  await using _setup = await setup();
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
