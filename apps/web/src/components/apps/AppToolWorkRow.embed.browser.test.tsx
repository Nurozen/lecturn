import "../../index.css";
import "../../embed/embed.css";

import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render as renderUi, type Screen } from "../../../test/render";

import { applyEmbedThemeToRoot } from "../../embed/embedTheme";
import { AppToolWorkRow } from "./AppToolWorkRow";

const HOST_TEAL = "rgb(97, 181, 173)";

let container: HTMLDivElement;

let testScreen: Screen;

async function setup(): Promise<AsyncDisposable> {
  container = document.createElement("div");
  document.body.append(container);
  testScreen = await renderUi(null, { container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await testScreen[Symbol.asyncDispose]();
      const rootElement = document.documentElement;
      delete rootElement.dataset.lecturnEmbed;
      rootElement.classList.remove("dark");
      rootElement.style.removeProperty("--success");
      rootElement.style.removeProperty("--success-foreground");
      rootElement.style.removeProperty("color-scheme");
    },
  };
}

async function renderSucceededRow(width: number) {
  await page.viewport(width, 800);
  await testScreen.rerender(
    <AppToolWorkRow
      aria-expanded={false}
      onClick={() => undefined}
      data-app-tool-outcome="succeeded"
      icon={<span className="size-4" />}
      label={<span className="truncate text-sm">rw_design_check</span>}
    />,
  );
  return container.querySelector<SVGElement>('[data-testid="app-tool-row-status"]')!;
}

describe.each([352, 320])("a finished app tool row in a %i px embed pane", (width) => {
  it("draws its success check in the host's success colour", async () => {
    await using _setup = await setup();
    applyEmbedThemeToRoot(document.documentElement, {
      appearance: "dark",
      variables: { "--success": HOST_TEAL, "--success-foreground": HOST_TEAL },
    });
    const check = await renderSucceededRow(width);
    expect(getComputedStyle(check).color).toBe(HOST_TEAL);
  });
});

it("keeps Lecturn's own success colour outside the embed", async () => {
  await using _setup = await setup();
  document.documentElement.classList.add("dark");
  const check = await renderSucceededRow(352);
  const lecturn = getComputedStyle(check).color;
  expect(lecturn).not.toBe(HOST_TEAL);
  // The same token Lecturn's other success marks read.
  const probe = document.createElement("span");
  probe.className = "text-success-foreground";
  container.append(probe);
  expect(lecturn).toBe(getComputedStyle(probe).color);
});
