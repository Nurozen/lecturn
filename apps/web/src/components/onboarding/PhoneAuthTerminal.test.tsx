import { useEffect, type ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PhoneAuthTerminal } from "./PhoneAuthTerminal";

vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

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
  await act(async () => {
    renderer = create(<PhoneAuthTerminal enabled>{() => <Terminal />}</PhoneAuthTerminal>);
  });
  const region = () => renderer.root.findAllByType("div").find((node) => node.props.id)!;
  const click = async (label: string) =>
    act(async () =>
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.join("") === label)!
        .props.onClick(),
    );
  expect(region().props.hidden).toBe(true);
  expect(region().props.inert).toBe(true);
  await click("Show terminal details");
  expect(region().props.hidden).toBe(false);
  expect(region().props.inert).toBe(true);
  await click("Enable advanced terminal input");
  expect(region().props.inert).toBe(false);
  await click("Hide terminal details");
  await click("Show terminal details");
  expect(region().props.inert).toBe(true);
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});

it("leaves desktop and remote terminals visible and interactive", async () => {
  await act(async () => {
    renderer = create(
      <PhoneAuthTerminal enabled={false}>
        {(visible) => (visible ? <textarea /> : null)}
      </PhoneAuthTerminal>,
    );
  });
  expect(renderer.root.findAllByType("button")).toHaveLength(0);
  expect(renderer.root.findByType("div").props.hidden).toBe(false);
  expect(renderer.root.findByType("div").props.inert).toBe(false);
  expect(renderer.root.findAllByType("textarea")).toHaveLength(1);
});
