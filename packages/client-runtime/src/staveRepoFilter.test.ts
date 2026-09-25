import { describe, expect, it } from "vite-plus/test";

import { filterStaveRepoRows, staveRepoMatchesQuery } from "./staveRepoFilter.ts";

describe("staveRepoMatchesQuery", () => {
  it.each([
    ["", true],
    ["   ", true],
    ["lec", true],
    ["LECTURN", true],
    ["main", true],
    ["lec main", true],
    ["lec master", false],
    ["gbrain", false],
  ])("query %j matches lecturn@main: %s", (query, expected) => {
    expect(staveRepoMatchesQuery({ name: "lecturn", defaultBranch: "main" }, query)).toBe(expected);
  });

  it("matches on name alone when the default branch is unknown", () => {
    expect(staveRepoMatchesQuery({ name: "solus" }, "sol")).toBe(true);
    expect(staveRepoMatchesQuery({ name: "solus" }, "main")).toBe(false);
  });
});

describe("filterStaveRepoRows", () => {
  const rows = [
    { repo: "gbrain", mode: "none" },
    { repo: "lecturn", mode: "edit" },
    { repo: "stave", mode: "reference" },
  ] as const;
  const registry = [
    { name: "gbrain", defaultBranch: "master" },
    { name: "lecturn", defaultBranch: "main" },
    { name: "stave", defaultBranch: "weirwood" },
  ];

  it("returns every row, untouched, for a blank query", () => {
    expect(filterStaveRepoRows(rows, " ", registry)).toBe(rows);
  });

  it("keeps matching rows in order, with their selections intact", () => {
    expect(filterStaveRepoRows(rows, "weir", registry)).toEqual([rows[2]]);
    expect(filterStaveRepoRows(rows, "ma", registry)).toEqual([rows[0], rows[1]]);
  });

  it("falls back to names when the registry lacks a repo", () => {
    expect(filterStaveRepoRows(rows, "master")).toEqual([]);
    expect(filterStaveRepoRows(rows, "brain")).toEqual([rows[0]]);
  });
});
