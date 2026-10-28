import "../../index.css";

import { WrenchIcon } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppToolWorkRow } from "./AppToolWorkRow";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.className = "dark";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function centerY(testId: string) {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  expect(element).not.toBeNull();
  const rect = element!.getBoundingClientRect();
  expect(rect.height).toBeGreaterThan(0);
  return rect.top + rect.height / 2;
}

describe("AppToolWorkRow", () => {
  it("sets the chevron, tool icon, label and outcome mark on one line", async () => {
    await page.viewport(1440, 900);
    // The icon and label mirror what the timeline hands the row for a tool entry.
    await act(async () =>
      root.render(
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
      ),
    );

    const label = centerY("tool-label");
    for (const part of ["app-tool-row-chevron", "tool-icon", "app-tool-row-status"]) {
      expect(Math.abs(centerY(part) - label), part).toBeLessThanOrEqual(1);
    }
  });
});
