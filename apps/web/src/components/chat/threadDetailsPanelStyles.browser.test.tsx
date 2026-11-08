import "../../index.css";

import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

function redesign(enabled: boolean): Disposable {
  document.documentElement.toggleAttribute("data-redesign", enabled);
  return { [Symbol.dispose]: () => document.documentElement.removeAttribute("data-redesign") };
}

const separatorColor = (container: HTMLElement) =>
  getComputedStyle(container.querySelector("[data-testid=separator]")!).backgroundColor;

const transparent = "rgba(0, 0, 0, 0)";

it("keeps the split hairline at rest by default and hides it only in the new design", async () => {
  await using screen = await render(
    <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
      <span data-testid="separator" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
    </div>,
  );
  expect(separatorColor(screen.container)).not.toBe(transparent);
  using _redesign = redesign(true);
  expect(separatorColor(screen.container)).toBe(transparent);
});

it("places the panel workspace icon before the label by default and after it in the new design", async () => {
  // The same wrappers BranchToolbar's RunContextSelector uses in the details panel.
  await using screen = await render(
    <div>
      <span data-testid="leading" className="contents redesign:hidden">
        <i />
      </span>
      <span data-testid="trailing" className="hidden redesign:contents">
        <i />
      </span>
    </div>,
  );
  const display = (id: string) =>
    getComputedStyle(screen.container.querySelector(`[data-testid=${id}]`)!).display;
  expect([display("leading"), display("trailing")]).toEqual(["contents", "none"]);
  using _redesign = redesign(true);
  expect([display("leading"), display("trailing")]).toEqual(["none", "contents"]);
});
