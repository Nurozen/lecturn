import { describe, expect, it } from "vite-plus/test";

import {
  STAVE_NAME_PATTERN,
  STAVE_PLATFORM_KEYS,
  isPathSegmentDescendant,
  isStavePlatformKey,
  isValidStaveSpaceId,
  parseStaveBaseRef,
  parseStaveVersionOutput,
  staveAssetName,
  staveAssetTarget,
  stripStaveVersionPrefix,
} from "./stave.ts";

describe("isValidStaveSpaceId", () => {
  it("accepts names that start alphanumeric and continue with [A-Za-z0-9._-]", () => {
    expect(isValidStaveSpaceId("t3code-threads")).toBe(true);
    expect(isValidStaveSpaceId("Space_1.2")).toBe(true);
    expect(isValidStaveSpaceId("0")).toBe(true);
    expect(STAVE_NAME_PATTERN.test("a")).toBe(true);
  });

  it("rejects empty, leading punctuation, whitespace and path characters", () => {
    expect(isValidStaveSpaceId("")).toBe(false);
    expect(isValidStaveSpaceId("-leading")).toBe(false);
    expect(isValidStaveSpaceId(".hidden")).toBe(false);
    expect(isValidStaveSpaceId("has space")).toBe(false);
    expect(isValidStaveSpaceId("a/b")).toBe(false);
    expect(isValidStaveSpaceId("space:id")).toBe(false);
    expect(isValidStaveSpaceId("tab\tname")).toBe(false);
  });
});

describe("parseStaveBaseRef", () => {
  it("recognizes the space: sugar and returns the id unvalidated", () => {
    expect(parseStaveBaseRef("space:t3code-threads")).toEqual({
      kind: "space",
      spaceId: "t3code-threads",
    });
    expect(parseStaveBaseRef("  space: padded ")).toEqual({ kind: "space", spaceId: "padded" });
    expect(parseStaveBaseRef("space:")).toEqual({ kind: "space", spaceId: "" });
    expect(parseStaveBaseRef("space:bad/id")).toEqual({ kind: "space", spaceId: "bad/id" });
  });

  it("passes anything else through as a plain git ref", () => {
    expect(parseStaveBaseRef("main")).toEqual({ kind: "ref", ref: "main" });
    expect(parseStaveBaseRef("origin/main")).toEqual({ kind: "ref", ref: "origin/main" });
    expect(parseStaveBaseRef("refs/heads/space:weird")).toEqual({
      kind: "ref",
      ref: "refs/heads/space:weird",
    });
    expect(parseStaveBaseRef("Space:upper")).toEqual({ kind: "ref", ref: "Space:upper" });
    expect(parseStaveBaseRef("")).toEqual({ kind: "ref", ref: "" });
  });
});

describe("stave release assets", () => {
  it("maps every platform key onto goreleaser os/arch and archive format", () => {
    expect(staveAssetTarget("darwin-arm64")).toEqual({ os: "darwin", arch: "arm64", ext: "zip" });
    expect(staveAssetTarget("darwin-x64")).toEqual({ os: "darwin", arch: "amd64", ext: "zip" });
    expect(staveAssetTarget("linux-x64")).toEqual({ os: "linux", arch: "amd64", ext: "tar.gz" });
    expect(staveAssetTarget("linux-arm64")).toEqual({ os: "linux", arch: "arm64", ext: "tar.gz" });
    expect(staveAssetTarget("win32-x64")).toEqual({ os: "windows", arch: "amd64", ext: "zip" });
    expect(staveAssetTarget("win32-arm64")).toEqual({ os: "windows", arch: "arm64", ext: "zip" });
  });

  it("lists exactly the six supported platform keys", () => {
    expect([...STAVE_PLATFORM_KEYS]).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
      "win32-x64",
      "win32-arm64",
    ]);
    expect(isStavePlatformKey("linux-arm64")).toBe(true);
    expect(isStavePlatformKey("freebsd-x64")).toBe(false);
  });

  it("builds asset names without a leading v", () => {
    expect(staveAssetName("0.4.0", "darwin-arm64")).toBe("stave_0.4.0_darwin_arm64.zip");
    expect(staveAssetName("v0.4.0", "darwin-arm64")).toBe("stave_0.4.0_darwin_arm64.zip");
    expect(staveAssetName(" v0.4.0 ", "linux-x64")).toBe("stave_0.4.0_linux_amd64.tar.gz");
    expect(staveAssetName("0.4.0", "linux-arm64")).toBe("stave_0.4.0_linux_arm64.tar.gz");
    expect(staveAssetName("0.4.0", "win32-x64")).toBe("stave_0.4.0_windows_amd64.zip");
    expect(staveAssetName("0.4.0", "win32-arm64")).toBe("stave_0.4.0_windows_arm64.zip");
    expect(staveAssetName("0.4.0", "darwin-x64")).toBe("stave_0.4.0_darwin_amd64.zip");
    expect(stripStaveVersionPrefix("v1.2.3")).toBe("1.2.3");
    expect(stripStaveVersionPrefix("dev")).toBe("dev");
  });
});

describe("parseStaveVersionOutput", () => {
  it("parses the three-line release output and drops the v prefix", () => {
    expect(
      parseStaveVersionOutput("stave v0.4.0\ncommit: 1a2b3c4\ndate: 2026-08-30T12:00:00Z\n"),
    ).toEqual({ version: "0.4.0", commit: "1a2b3c4", date: "2026-08-30T12:00:00Z" });
  });

  it("accepts versions without v, dev builds, CRLF and surrounding whitespace", () => {
    expect(parseStaveVersionOutput("stave 0.2.0\r\ncommit: abc\r\ndate: 2026-01-01\r\n")).toEqual({
      version: "0.2.0",
      commit: "abc",
      date: "2026-01-01",
    });
    expect(parseStaveVersionOutput("\n  stave dev  \n")).toEqual({ version: "dev" });
    expect(parseStaveVersionOutput("stave v0.4.0")).toEqual({ version: "0.4.0" });
  });

  it("omits unknown or empty commit/date and ignores unrelated lines", () => {
    expect(
      parseStaveVersionOutput("stave v0.4.0\ncommit: unknown\ndate: \nextra: thing\nno colon"),
    ).toEqual({ version: "0.4.0" });
  });

  it("returns null when the header is missing or malformed", () => {
    expect(parseStaveVersionOutput("")).toBeNull();
    expect(parseStaveVersionOutput("   \n\n")).toBeNull();
    expect(parseStaveVersionOutput("commit: abc\nstave v0.4.0")).toBeNull();
    expect(parseStaveVersionOutput("stave")).toBeNull();
    expect(parseStaveVersionOutput("stave v0.4.0 extra")).toBeNull();
    expect(parseStaveVersionOutput("staves v0.4.0")).toBeNull();
    expect(parseStaveVersionOutput("command not found: stave")).toBeNull();
  });
});

describe("isPathSegmentDescendant", () => {
  it("matches only on whole segment boundaries", () => {
    expect(isPathSegmentDescendant("/a/b", "/a/b/c")).toBe(true);
    expect(isPathSegmentDescendant("/a/b", "/a/b/c/d")).toBe(true);
    expect(isPathSegmentDescendant("/a/b", "/a/bc")).toBe(false);
    expect(isPathSegmentDescendant("/a/b", "/a/bc/d")).toBe(false);
    expect(isPathSegmentDescendant("/a/b", "/a")).toBe(false);
    expect(isPathSegmentDescendant("/a/b", "/x/a/b/c")).toBe(false);
  });

  it("never treats a path as its own descendant, regardless of trailing separators", () => {
    expect(isPathSegmentDescendant("/a/b", "/a/b")).toBe(false);
    expect(isPathSegmentDescendant("/a/b/", "/a/b")).toBe(false);
    expect(isPathSegmentDescendant("/a/b", "/a/b/")).toBe(false);
    expect(isPathSegmentDescendant("/a/b/", "/a/b/c")).toBe(true);
  });

  it("handles Windows separators and mixed separators", () => {
    expect(isPathSegmentDescendant("C:\\work\\space", "C:\\work\\space\\repo")).toBe(true);
    expect(isPathSegmentDescendant("C:\\work\\space", "C:\\work\\spacey")).toBe(false);
    expect(isPathSegmentDescendant("C:\\work\\space", "C:/work/space/repo")).toBe(true);
    expect(isPathSegmentDescendant("C:\\work\\space", "C:\\work\\space")).toBe(false);
    expect(isPathSegmentDescendant("D:\\work", "C:\\work\\repo")).toBe(false);
  });

  it("compares segments case-sensitively", () => {
    expect(isPathSegmentDescendant("/a/b", "/A/b/c")).toBe(false);
  });
});
