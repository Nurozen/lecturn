import { describe, expect, it } from "vite-plus/test";

import { formatStaveRepoStatus } from "./StaveProjectSection.logic";

describe("formatStaveRepoStatus", () => {
  it("renders ahead/behind counts and the dirty flag", () => {
    expect(formatStaveRepoStatus({ ahead: 2, behind: 1, dirty: true })).toBe("↑2 ↓1 · dirty");
    expect(formatStaveRepoStatus({ ahead: 0, behind: 0, dirty: false })).toBe("↑0 ↓0 · clean");
  });

  it("appends drift and reference warnings when present", () => {
    expect(
      formatStaveRepoStatus({ ahead: 0, behind: 0, dirty: false, driftError: "no upstream" }),
    ).toBe("↑0 ↓0 · clean · no upstream");
    expect(
      formatStaveRepoStatus({
        ahead: 1,
        behind: 0,
        dirty: true,
        driftError: "no upstream",
        referenceWarn: "reference checkout has local edits",
      }),
    ).toBe("↑1 ↓0 · dirty · no upstream · reference checkout has local edits");
  });
});
