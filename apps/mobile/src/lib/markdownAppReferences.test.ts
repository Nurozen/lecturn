import { formatAppReferenceHref } from "@lecturn/shared/appReferences";
import { describe, expect, it } from "vite-plus/test";

import { markdownWithAppReferences } from "./markdownDocument";

const PREFIXES = ["rw:"];
const chip = (ref: string, text = ref) => `[${text}](${formatAppReferenceHref(ref)})`;

describe("markdownWithAppReferences", () => {
  it("links bare references and leaves the sentence around them", () => {
    expect(markdownWithAppReferences("Trim rw:c/fins, then rerun rw:sim/7.", PREFIXES)).toBe(
      `Trim ${chip("rw:c/fins")}, then rerun ${chip("rw:sim/7")}.`,
    );
    expect(markdownWithAppReferences("**rw:c/fins** (rw:c/nose)", PREFIXES)).toBe(
      `**${chip("rw:c/fins")}** (${chip("rw:c/nose")})`,
    );
  });

  it("links a code span that holds only a reference", () => {
    expect(markdownWithAppReferences("Open `rw:c/fins` and `rw:c/a rw:c/b`.", PREFIXES)).toBe(
      `Open ${chip("rw:c/fins")} and \`rw:c/a rw:c/b\`.`,
    );
    expect(markdownWithAppReferences("``` rw:c/fins ```", PREFIXES)).toBe(chip("rw:c/fins"));
  });

  it("keeps fenced code, links, HTML and words that only contain a prefix literal", () => {
    const literal = [
      "```",
      "rw:c/fins",
      "```",
      "",
      "[rw:c/fins](https://example.com) and <https://example.com/rw:c/fins>",
      "",
      "<div>rw:c/fins</div>",
      "",
      "draw:c/fins",
    ].join("\n");
    expect(markdownWithAppReferences(literal, PREFIXES)).toBe(literal);
  });

  it("finds references in nested blocks", () => {
    expect(
      markdownWithAppReferences("> see rw:c/a\n> and rw:c/b\n\n- rw:c/c\n  rw:c/d", PREFIXES),
    ).toBe(
      `> see ${chip("rw:c/a")}\n> and ${chip("rw:c/b")}\n\n- ${chip("rw:c/c")}\n  ${chip("rw:c/d")}`,
    );
    expect(markdownWithAppReferences("| part |\n| --- |\n| rw:c/fins |", PREFIXES)).toBe(
      `| part |\n| --- |\n| ${chip("rw:c/fins")} |`,
    );
  });

  it("escapes markdown in the link text and keeps escaped source as written", () => {
    expect(markdownWithAppReferences("`rw:c/*fins*`", PREFIXES)).toBe(
      chip("rw:c/*fins*", "rw:c/\\*fins\\*"),
    );
    expect(markdownWithAppReferences("rw:c/a\\_b", PREFIXES)).toBe("rw:c/a\\_b");
  });

  it("returns the text unchanged without prefixes or references", () => {
    expect(markdownWithAppReferences("rw:c/fins", [])).toBe("rw:c/fins");
    const text = "No references here.";
    expect(markdownWithAppReferences(text, PREFIXES)).toBe(text);
  });
});
