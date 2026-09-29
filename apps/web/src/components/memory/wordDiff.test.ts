import { describe, expect, it } from "vite-plus/test";
import { wordDiff, wordDiffChanged } from "./wordDiff";

const rebuild = (tokens: ReturnType<typeof wordDiff>, keep: "before" | "after") =>
  tokens
    .filter(
      (token) => token.type === "equal" || token.type === (keep === "before" ? "delete" : "insert"),
    )
    .map((token) => token.text)
    .join(" ");

describe("wordDiff", () => {
  it("marks a replaced word as delete then insert and merges equal runs", () => {
    expect(
      wordDiff(
        "Passwords are hashed with bcrypt in hashPassword.",
        "Passwords are hashed with argon2id in hashPassword.",
      ),
    ).toEqual([
      { type: "equal", text: "Passwords are hashed with" },
      { type: "delete", text: "bcrypt" },
      { type: "insert", text: "argon2id" },
      { type: "equal", text: "in hashPassword." },
    ]);
  });

  it("reports an appended sentence as one insert", () => {
    const tokens = wordDiff(
      "Each refresh revokes the old token.",
      "Each refresh revokes the old token. Reuse revokes the family.",
    );
    expect(tokens).toEqual([
      { type: "equal", text: "Each refresh revokes the old token." },
      { type: "insert", text: "Reuse revokes the family." },
    ]);
  });

  it("treats whitespace-only changes as equal", () => {
    const tokens = wordDiff("a  b\nc", " a b c ");
    expect(tokens).toEqual([{ type: "equal", text: "a b c" }]);
    expect(wordDiffChanged(tokens)).toBe(false);
  });

  it("handles empty sides", () => {
    expect(wordDiff("", "new node")).toEqual([{ type: "insert", text: "new node" }]);
    expect(wordDiff("old node", "")).toEqual([{ type: "delete", text: "old node" }]);
    expect(wordDiff("", "")).toEqual([]);
  });

  it("round-trips both texts", () => {
    const before = "Session cookies use SameSite=Strict with a 30 day fixed expiry.";
    const after =
      "Session cookies use SameSite=Lax with a 14 day sliding expiry. Lax is required for checkout.";
    const tokens = wordDiff(before, after);
    expect(rebuild(tokens, "before")).toBe(before);
    expect(rebuild(tokens, "after")).toBe(after);
    expect(wordDiffChanged(tokens)).toBe(true);
  });

  it("falls back to a whole replacement for very long texts", () => {
    const before = Array.from({ length: 700 }, (_, i) => `w${i}`).join(" ");
    const after = Array.from({ length: 700 }, (_, i) => `v${i}`).join(" ");
    const tokens = wordDiff(before, after);
    expect(tokens.map((token) => token.type)).toEqual(["delete", "insert"]);
  });
});
