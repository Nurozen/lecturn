import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveRestingComposerControlsLayout } from "../composerFooterLayout";
import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";

function measurePicker(input: {
  clientWidth: number;
  flexGrow: string;
  maxWidth?: string;
  embedFooterStacked?: boolean;
}) {
  const label = { clientWidth: input.clientWidth, scrollWidth: 160 };
  const picker = {
    getBoundingClientRect: () => ({ width: 52 }),
    querySelector: () => label,
  };
  const controls = {
    closest: (selector: string) =>
      input.embedFooterStacked && selector === "[data-embed-composer-footer-stacked]" ? {} : null,
    querySelector: (selector: string) => {
      if (selector === "[data-chat-provider-model-picker]") return picker;
      if (selector === "[data-resting-controls-overflow]") {
        return { getBoundingClientRect: () => ({ width: 24 }) };
      }
      return null;
    },
    querySelectorAll: () => [
      {
        dataset: {},
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 140 }),
      },
    ],
  };
  vi.stubGlobal("getComputedStyle", (element: unknown) => {
    if (element === label) return { flexGrow: input.flexGrow };
    if (element === picker) return { minWidth: "52px", maxWidth: input.maxWidth ?? "none" };
    return { columnGap: "4px" };
  });
  return measureRestingComposerControls(controls as unknown as HTMLElement)!;
}

afterEach(() => vi.unstubAllGlobals());

describe("measureRestingComposerControls", () => {
  it("keeps every block in the narrow embed footer, which has no overflow menu", () => {
    const measurement = measurePicker({ clientWidth: 20, flexGrow: "1", embedFooterStacked: true });

    expect(resolveRestingComposerControlsLayout({ ...measurement, hostWidth: 200 })).toEqual({
      hiddenCount: 0,
      iconOnlyCount: 1,
      visible: true,
    });
  });
});
