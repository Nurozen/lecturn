import { describe, expect, it } from "vite-plus/test";
import { accountSectionFrames } from "./accountSectionFrames";

describe("virtualized account section frames", () => {
  it("closes the previous account before the next and wraps a collapsed account", () => {
    expect([
      ...accountSectionFrames([
        { key: "a", type: "account-header" },
        { key: "project", type: "header" },
        { key: "thread", type: "thread" },
        { key: "b", type: "account-header" },
        { key: "direct", type: "account-header" },
      ]),
    ]).toEqual([
      ["a", { first: true, last: false }],
      ["project", { first: false, last: false }],
      ["thread", { first: false, last: true }],
      ["b", { first: true, last: true }],
      ["direct", { first: true, last: true }],
    ]);
  });
  it("wraps a neutral list without introducing account labels", () => {
    expect([
      ...accountSectionFrames([
        { key: "p", type: "header" },
        { key: "t", type: "thread" },
      ]).values(),
    ]).toEqual([
      { first: true, last: false },
      { first: false, last: true },
    ]);
    expect(accountSectionFrames([]).size).toBe(0);
  });
});
