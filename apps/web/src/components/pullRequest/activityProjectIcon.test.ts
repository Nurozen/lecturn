import { expect, it } from "vite-plus/test";
import { activityProjectIcon, loadActivityProjectIcon } from "./activityProjectIcon";

it("keeps configured identity and resolves the same automatic test-project icon", () => {
  const configured = { kind: "emoji", emoji: "🧪" } as const;
  expect(activityProjectIcon("test", "/work/test", configured)).toEqual(configured);
  expect(activityProjectIcon("lecturn-test-pr-track", "/work/test")).toEqual({
    kind: "lucide",
    name: "flask-conical",
    color: "yellow",
  });
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
