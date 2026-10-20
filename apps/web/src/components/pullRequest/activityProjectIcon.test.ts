import { expect, it } from "vite-plus/test";
import { deriveProjectIdentity } from "../../projectIdentity";
import { activityProjectIcon, loadActivityProjectIcon } from "./activityProjectIcon";

it("keeps configured identity and falls back to the sidebar's generated monogram", () => {
  const configured = { kind: "emoji", emoji: "🧪" } as const;
  expect(activityProjectIcon("test", configured)).toEqual(configured);
  const identity = deriveProjectIdentity("lecturn-test-pr-track");
  expect(activityProjectIcon("lecturn-test-pr-track")).toEqual({
    kind: "monogram",
    text: identity.monogram,
    color: identity.color,
  });
});
it("renders generated monograms as escaped inert SVG text", async () => {
  const icon = await loadActivityProjectIcon({ kind: "monogram", text: "LT", color: "blue" });
  expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
  const svg = atob(icon!.split(",")[1]!);
  expect(svg).toContain(">LT</text>");
  expect(svg).not.toMatch(/(?:<script|<foreignObject|href=|onload=)/);
});
it("publishes bounded inert local icon geometry and rejects missing catalog entries", async () => {
  const icon = await loadActivityProjectIcon({
    kind: "lucide",
    name: "flask-conical",
    color: "yellow",
  });
  expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
  const svg = atob(icon!.split(",")[1]!);
  expect(svg).toContain("<path");
  expect(svg).not.toMatch(/(?:<script|<foreignObject|href=|onload=)/);
  expect(icon!.length).toBeLessThan(16384);
  expect(
    await loadActivityProjectIcon({ kind: "lucide", name: "constructor", color: "yellow" }),
  ).toBeUndefined();
});
