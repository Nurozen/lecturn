import { describe, expect, it } from "vite-plus/test";

import { enrichedStrongFontWeight } from "./enrichedStrongFontWeight";

describe("enrichedStrongFontWeight", () => {
  it("keeps a dedicated bold face at its own weight", () => {
    expect(
      enrichedStrongFontWeight({ fontFamily: "DMSans-Regular", boldFontFamily: "DMSans-Bold" }),
    ).toBe("normal");
  });

  it("bolds the iOS System family, which Lecturn uses for every weight", () => {
    expect(enrichedStrongFontWeight({ fontFamily: "System", boldFontFamily: "System" })).toBe(
      "bold",
    );
  });

  it("bolds when no bold family is given", () => {
    expect(enrichedStrongFontWeight({ fontFamily: "System", boldFontFamily: "" })).toBe("bold");
  });
});
