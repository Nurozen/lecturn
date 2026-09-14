import { describe, expect, it } from "vite-plus/test";
import type { DesktopActivityRow } from "@lecturn/contracts";
import { activityPeekRows, nextActivityMode, reconcilePeekRows } from "./interaction.ts";
const row = (
  id: string,
  status: string,
  checks?: DesktopActivityRow["checks"],
): DesktopActivityRow => ({
  id,
  title: id,
  subtitle: "",
  status,
  environmentId: "env",
  projectId: "project",
  actions: [],
  ...(checks ? { checks } : {}),
});
describe("notch peek", () => {
  it("keeps explicit expansion immune to automatic micro notifications", () => {
    expect(nextActivityMode("collapsed", "micro-open")).toBe("micro");
    expect(nextActivityMode("peek", "micro-open")).toBe("micro");
    expect(nextActivityMode("expanded", "micro-open")).toBe("expanded");
    expect(nextActivityMode("micro", "micro-interact")).toBe("micro");
    expect(nextActivityMode("micro", "hover-enter")).toBe("micro");
    expect(nextActivityMode("micro", "hover-leave")).toBe("collapsed");
    expect(nextActivityMode("micro", "toggle")).toBe("expanded");
  });
  it("freezes hovered targets while updating content and removes vanished rows immediately", () => {
    const initial = [row("one", "Idle"), row("two", "Working")];
    const newer = [row("new-attention", "Needs approval"), row("one", "Working")];
    expect(
      reconcilePeekRows(
        newer,
        initial.map((row) => row.id),
        true,
      ).map((row) => [row.id, row.status]),
    ).toEqual([["one", "Working"]]);
    expect(reconcilePeekRows(newer, ["one"], false).map((row) => row.id)).toEqual([
      "new-attention",
      "one",
    ]);
    expect(reconcilePeekRows(newer, [], true)).toEqual([]);
  });
  it("opens temporarily on hover and stays open only after explicit expansion", () => {
    expect(nextActivityMode("collapsed", "hover-enter")).toBe("peek");
    expect(nextActivityMode("peek", "hover-leave")).toBe("collapsed");
    expect(nextActivityMode("peek", "toggle")).toBe("expanded");
    expect(nextActivityMode("expanded", "hover-leave")).toBe("expanded");
    expect(nextActivityMode("expanded", "hover-enter")).toBe("expanded");
    expect(nextActivityMode("expanded", "dismiss")).toBe("collapsed");
  });
  it("surfaces attention and CI failures before running jobs and quiet recent threads, bounded to three", () => {
    const rows = [
      row("idle", "Idle"),
      row("working", "Working"),
      row("pending", "watching", [{ name: "Test", status: "pending" }]),
      row("failed", "watching", [{ name: "Build", status: "failure" }]),
      row("approval", "Needs approval"),
    ];
    expect(activityPeekRows(rows).map((item) => item.id)).toEqual([
      "approval",
      "failed",
      "pending",
    ]);
    expect(rows[0]!.id).toBe("idle");
    expect(
      activityPeekRows([row("new", "Idle"), row("older", "Idle")]).map((item) => item.id),
    ).toEqual(["new", "older"]);
  });
});
