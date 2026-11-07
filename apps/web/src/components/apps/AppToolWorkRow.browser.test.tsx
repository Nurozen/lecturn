import "../../index.css";

import { WrenchIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render as renderUi, type Screen } from "../../../test/render";

import { AppToolWorkRow } from "./AppToolWorkRow";

let container: HTMLDivElement;

let testScreen: Screen;

async function setup(): Promise<AsyncDisposable> {
  container = document.createElement("div");
  container.className = "dark";
  document.body.append(container);
  testScreen = await renderUi(null, { container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await testScreen[Symbol.asyncDispose]();
    },
  };
}

function centerY(testId: string) {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  expect(element).not.toBeNull();
  const rect = element!.getBoundingClientRect();
  expect(rect.height).toBeGreaterThan(0);
  return rect.top + rect.height / 2;
}

describe("AppToolWorkRow", () => {
  it("sets the chevron, tool icon, label and outcome mark on one line", async () => {
    await using _setup = await setup();
    await page.viewport(1440, 900);
    // The icon and label mirror what the timeline hands the row for a tool entry.
    await testScreen.rerender(
      <div style={{ width: 640 }}>
        <AppToolWorkRow
          aria-expanded={false}
          onClick={() => undefined}
          data-app-tool-outcome="succeeded"
          icon={
            <span data-testid="tool-icon" className="flex size-4 items-center justify-center">
              <WrenchIcon className="block size-4 shrink-0 stroke-2" />
            </span>
          }
          label={
            <div className="min-w-0 flex-1 overflow-hidden">
              <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
                <span data-testid="tool-label" className="min-w-0 flex-1 truncate">
                  ex_counter_read
                </span>
              </p>
            </div>
          }
        />
      </div>,
    );

    const label = centerY("tool-label");
    for (const part of ["app-tool-row-chevron", "tool-icon", "app-tool-row-status"]) {
      expect(Math.abs(centerY(part) - label), part).toBeLessThanOrEqual(1);
    }
  });
});
