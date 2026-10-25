import { describe, expect, it } from "vite-plus/test";

import { findAppReferences, splitAppReferences } from "./appReferences.ts";

const refs = (text: string, prefixes: ReadonlyArray<string> = ["rw:"]) =>
  findAppReferences(text, prefixes).map((match) => match.ref);

describe("findAppReferences", () => {
  it("finds references at text start, after whitespace and inside brackets or quotes", () => {
    expect(refs("rw:c/fins")).toEqual(["rw:c/fins"]);
    expect(refs("look at rw:c/fins and rw:c/nose\nrw:sim/run-1")).toEqual([
      "rw:c/fins",
      "rw:c/nose",
      "rw:sim/run-1",
    ]);
    expect(refs('(rw:c/fins) [rw:c/nose] "rw:c/tube" `rw:c/motor`')).toEqual([
      "rw:c/fins",
      "rw:c/nose",
      "rw:c/tube",
      "rw:c/motor",
    ]);
  });

  it("leaves closing punctuation outside the reference", () => {
    expect(refs("Updated rw:c/fins.")).toEqual(["rw:c/fins"]);
    expect(refs("rw:c/fins, rw:c/nose; rw:c/tube?! rw:c/motor:")).toEqual([
      "rw:c/fins",
      "rw:c/nose",
      "rw:c/tube",
      "rw:c/motor",
    ]);
    expect(refs("rw:c/fins:span.3 here")).toEqual(["rw:c/fins:span.3"]);
  });

  it("ignores prefixes inside words, paths and URLs, and bare prefixes", () => {
    expect(refs("xrw:c/fins")).toEqual([]);
    expect(refs("https://example.test/rw:c/fins")).toEqual([]);
    expect(refs("rw: nothing")).toEqual([]);
    expect(refs("rw:.")).toEqual([]);
  });

  it("is case sensitive and only uses the given prefixes", () => {
    expect(refs("RW:c/fins")).toEqual([]);
    expect(refs("rw:c/fins", [])).toEqual([]);
    expect(refs("rw:c/fins", [""])).toEqual([]);
    expect(refs("ok:a rw:b", ["ok:", "rw:"])).toEqual(["ok:a", "rw:b"]);
  });

  it("prefers the longest prefix and treats prefixes literally", () => {
    expect(findAppReferences("rw:c:fins", ["rw:", "rw:c:"])).toEqual([
      { ref: "rw:c:fins", prefix: "rw:c:", start: 0, end: 9 },
    ]);
    expect(refs("a.b:x aXb:y", ["a.b:"])).toEqual(["a.b:x"]);
  });

  it("reports offsets into the original text", () => {
    expect(findAppReferences("see rw:c/fins.", ["rw:"])).toEqual([
      { ref: "rw:c/fins", prefix: "rw:", start: 4, end: 13 },
    ]);
  });
});

describe("splitAppReferences", () => {
  it("covers the whole text with text and ref segments in order", () => {
    const text = "Set rw:c/fins to 4, then rw:sim/run.";
    const segments = splitAppReferences(text, ["rw:"]);
    expect(
      segments.map((segment) => (segment.type === "text" ? segment.text : segment.ref)),
    ).toEqual(["Set ", "rw:c/fins", " to 4, then ", "rw:sim/run", "."]);
    expect(
      segments.map((segment) => (segment.type === "text" ? segment.text : segment.ref)).join(""),
    ).toBe(text);
  });

  it("returns one text segment without references and none for empty text", () => {
    expect(splitAppReferences("plain", ["rw:"])).toEqual([{ type: "text", text: "plain" }]);
    expect(splitAppReferences("", ["rw:"])).toEqual([]);
  });
});
