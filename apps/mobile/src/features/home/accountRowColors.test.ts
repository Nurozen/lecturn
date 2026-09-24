import { describe, expect, it } from "vite-plus/test";
import { accountRowColors } from "./accountRowColors";

describe("native hierarchy account ownership", () => {
  const owner = (id: string) => ({ a: "#14b8a6", b: "#a78bfa" })[id];
  it("colors owned thread and queued rows without requiring visible account sections", () => {
    const colors = accountRowColors(
      [
        { key: "thread", type: "thread", thread: { environmentId: "a" } },
        { key: "queued", type: "v2-pending", pendingTask: { message: { environmentId: "b" } } },
        { key: "local", type: "thread", thread: { environmentId: "local" } },
      ],
      owner,
    );
    expect([...colors]).toEqual([
      ["thread", "#14b8a6"],
      ["queued", "#a78bfa"],
    ]);
  });
  it("keeps headers, hierarchy and cards neutral when account colors are disabled", () => {
    const colors = accountRowColors(
      [
        { key: "account", type: "account-header", account: { preset: "jade" } },
        { key: "group", type: "header", group: { projects: [{ environmentId: "a" }] } },
        { key: "thread", type: "thread", thread: { environmentId: "a" } },
        { key: "shelf", type: "v2-settled-shelf" },
      ],
      owner,
      false,
    );
    expect(colors.size).toBe(0);
  });
  it("keeps aggregate groups neutral and clears inherited tint for direct connections", () => {
    const colors = accountRowColors(
      [
        { key: "group", type: "header", group: { projects: [{ environmentId: "a" }] } },
        { key: "settled", type: "v2-settled-shelf" },
        {
          key: "mixed",
          type: "header",
          group: { projects: [{ environmentId: "a" }, { environmentId: "b" }] },
        },
        { key: "mixed-settled", type: "v2-settled-shelf" },
        { key: "account", type: "account-header", account: { preset: "jade" } },
        { key: "direct", type: "account-header", account: null },
        { key: "direct-settled", type: "v2-settled-shelf" },
      ],
      owner,
    );
    expect(colors.get("settled")).toBe("#14b8a6");
    expect(colors.has("mixed")).toBe(false);
    expect(colors.has("mixed-settled")).toBe(false);
    expect(colors.has("direct-settled")).toBe(false);
  });
});
