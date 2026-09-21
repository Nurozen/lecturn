import { describe, expect, it } from "vite-plus/test";
import { partitionShelfRows } from "./sidebarShelfRows";

describe("partitionShelfRows", () => {
  it.each([0, 1, 2])("preserves the current row at index %s as its neighbors collapse", (index) => {
    const rows = ["first", "middle", "last"];
    const result = partitionShelfRows(rows, (row) => row === rows[index]);
    expect([...result.before, result.current, ...result.after]).toEqual(rows);
    expect(result.current).toBe(rows[index]);
    expect([...result.before, ...result.after]).not.toContain(result.current);
  });
  it("collapses the whole shelf when its current conversation is elsewhere", () => {
    const rows = ["first", "last"];
    expect(partitionShelfRows(rows, (row) => row === "other")).toEqual({
      before: rows,
      current: undefined,
      after: [],
    });
  });
  it("handles an empty shelf", () => {
    expect(partitionShelfRows([], () => true)).toEqual({
      before: [],
      current: undefined,
      after: [],
    });
  });
});
