import { describe, expect, it } from "vite-plus/test";

import {
  CLI_PUBLISHED_ARCHIVE_PLATFORM_KEYS,
  cliArchiveTarCommand,
  newestCliReleaseVersion,
  parseChecksums,
  publishedCliArchivePlatformKey,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("publishes archives only for the platforms the release workflow builds", () => {
    expect(CLI_PUBLISHED_ARCHIVE_PLATFORM_KEYS).toEqual(["darwin-arm64", "linux-x64", "win32-x64"]);
    expect(publishedCliArchivePlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(publishedCliArchivePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(publishedCliArchivePlatformKey("win32", "x64")).toBe("win32-x64");
    expect(publishedCliArchivePlatformKey("linux", "arm64")).toBeUndefined();
    expect(publishedCliArchivePlatformKey("win32", "arm64")).toBeUndefined();
    expect(publishedCliArchivePlatformKey("darwin", "x64")).toBeUndefined();
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  lecturn-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *lecturn-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("lecturn-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("lecturn-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
