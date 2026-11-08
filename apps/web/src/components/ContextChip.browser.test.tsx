import { FileIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { ContextChip, ContextChipLabel } from "./ContextChip";

// An empty inline-block's bottom edge sits on the baseline of the line it is in.
function BaselineMarker(props: { id: string }) {
  return <span data-baseline={props.id} className="inline-block size-0" />;
}

// The inline chip is the Beta "New design" look; the Lecturn default keeps the pill.
function withRedesignLook() {
  document.documentElement.setAttribute("data-redesign", "");
  return { [Symbol.dispose]: () => document.documentElement.removeAttribute("data-redesign") };
}

describe("ContextChip", () => {
  it("keeps the Lecturn pill's label centered and tight, without a hover underline", async () => {
    await using screen = await render(
      <p className="w-[60ch] text-sm leading-relaxed">
        Open the{" "}
        <ContextChip kind="mention" render={<button type="button" />}>
          <FileIcon />
          <ContextChipLabel>src/Typography.tsx</ContextChipLabel>
        </ContextChip>{" "}
        file
      </p>,
    );
    const chip = screen.container.querySelector<HTMLElement>('[data-slot="context-chip"]')!;
    const label = screen.container.querySelector<HTMLElement>('[data-slot="context-chip-label"]')!;
    const labelStyle = getComputedStyle(label);
    const chipBox = chip.getBoundingClientRect();
    const labelBox = label.getBoundingClientRect();

    expect(Number.parseFloat(labelStyle.lineHeight)).toBeCloseTo(
      Number.parseFloat(labelStyle.fontSize) * 1.25,
      1,
    );
    expect(labelStyle.overflow).toBe("hidden");
    expect(labelStyle.textDecorationLine).toBe("none");
    expect(
      Math.abs(labelBox.top + labelBox.height / 2 - (chipBox.top + chipBox.height / 2)),
    ).toBeLessThanOrEqual(0.5);
  });

  it("sets its label on the sentence baseline at the sentence size without growing the line", async () => {
    using _redesign = withRedesignLook();
    await using screen = await render(
      <p className="w-[60ch] text-sm leading-relaxed">
        Open
        <BaselineMarker id="text" /> the{" "}
        <ContextChip kind="mention" render={<button type="button" />}>
          <FileIcon />
          <ContextChipLabel>
            src/
            <BaselineMarker id="chip" />
            Typography.tsx
          </ContextChipLabel>
        </ContextChip>{" "}
        file
      </p>,
    );
    const paragraph = screen.container.querySelector("p")!;
    const label = screen.container.querySelector<HTMLElement>('[data-slot="context-chip-label"]')!;
    const baseline = (id: string) =>
      screen.container.querySelector(`[data-baseline="${id}"]`)!.getBoundingClientRect().bottom;

    expect(getComputedStyle(label).fontSize).toBe(getComputedStyle(paragraph).fontSize);
    expect(Math.abs(baseline("chip") - baseline("text"))).toBeLessThanOrEqual(0.5);
    expect(paragraph.getBoundingClientRect().height).toBeCloseTo(
      Number.parseFloat(getComputedStyle(paragraph).lineHeight),
      0,
    );
  });
});
