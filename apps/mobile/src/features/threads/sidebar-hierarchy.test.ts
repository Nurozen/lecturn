import { describe, expect, it } from "vite-plus/test";
import { buildSidebarHierarchy } from "./sidebar-hierarchy";

function guides(depths: number[]) {
  return [
    ...buildSidebarHierarchy(depths.map((depth, index) => ({ key: `${index}`, depth }))).values(),
  ];
}

describe("sidebar hierarchy guides", () => {
  it("ends ordinary project conversations at their last sibling", () => {
    expect(guides([0, 1, 1, 0, 1])).toEqual([
      [],
      [{ level: 0, continues: true }],
      [{ level: 0, continues: false }],
      [],
      [{ level: 0, continues: false }],
    ]);
  });

  it("continues ancestors through descendants only when another sibling follows", () => {
    expect(guides([0, 1, 2, 1, 2, 3])).toEqual([
      [],
      [{ level: 0, continues: true }],
      [
        { level: 0, continues: true },
        { level: 1, continues: false },
      ],
      [{ level: 0, continues: false }],
      [{ level: 1, continues: false }],
      [{ level: 2, continues: false }],
    ]);
  });

  it("ends the outer branch at a collapsed or filtered final child", () => {
    expect(guides([0, 1, 2, 1, 0])).toEqual([
      [],
      [{ level: 0, continues: true }],
      [
        { level: 0, continues: true },
        { level: 1, continues: false },
      ],
      [{ level: 0, continues: false }],
      [],
    ]);
    expect(guides([0, 1, 2])[2]).toEqual([{ level: 1, continues: false }]);
  });

  it("leaves flat shelves and pending rows without hierarchy guides", () => {
    expect([...buildSidebarHierarchy([{ key: "pending" }, { key: "shelf" }]).values()]).toEqual([
      [],
      [],
    ]);
    expect(guides([])).toEqual([]);
  });
});
