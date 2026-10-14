import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchLatestRelease, findReleaseAsset, type Release } from "./releases";

const stable: Release = {
  tag_name: "v1.2.0",
  html_url: "https://github.com/Nurozen/lecturn/releases/tag/v1.2.0",
  published_at: "2026-10-13T10:00:00Z",
  assets: [
    { name: "Lecturn-1.2.0-arm64.dmg", browser_download_url: "https://example.com/stable.dmg" },
  ],
};
const nightly: Release = {
  ...stable,
  tag_name: "v1.2.1-nightly.20261013.1",
  html_url: "https://github.com/Nurozen/lecturn/releases/tag/v1.2.1-nightly.20261013.1",
  assets: [
    {
      name: "Lecturn-1.2.1-nightly.20261013.1-arm64.dmg",
      browser_download_url: "https://example.com/nightly.dmg",
    },
  ],
};
const fetchMock = vi.fn<typeof fetch>();
const values = new Map<string, string>();
const storage = {
  getItem: vi.fn((key: string) => values.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    values.set(key, value);
  }),
};

beforeEach(() => {
  vi.resetAllMocks();
  values.clear();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-13T12:00:00Z"));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("sessionStorage", storage);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(data: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(Response.json(data, { status }));
}

describe("release downloads", () => {
  it("keeps the default stable lookup and cache independent of nightly", async () => {
    respond(stable);
    respond([stable, nightly]);
    expect(await fetchLatestRelease()).toEqual(stable);
    expect(await fetchLatestRelease("nightly")).toEqual(nightly);
    expect(await fetchLatestRelease("stable")).toEqual(stable);
    expect(await fetchLatestRelease("nightly")).toEqual(nightly);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/Nurozen/lecturn/releases/latest",
      "https://api.github.com/repos/Nurozen/lecturn/releases?per_page=100",
    ]);
    expect([...values.keys()]).toEqual(["lecturn-stable-release", "lecturn-nightly-release"]);
  });

  it("selects the most recently published nightly even when creation order differs", async () => {
    const older = { ...nightly, published_at: "2026-10-12T10:00:00Z" };
    respond([stable, older, { message: "invalid" }, nightly]);
    expect(await fetchLatestRelease("nightly")).toEqual(nightly);
  });

  it("looks beyond a full stable-only page", async () => {
    respond(Array.from({ length: 100 }, () => stable));
    respond([nightly]);
    expect(await fetchLatestRelease("nightly")).toEqual(nightly);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/Nurozen/lecturn/releases?per_page=100",
      "https://api.github.com/repos/Nurozen/lecturn/releases?per_page=100&page=2",
    ]);
  });

  it("compares publication times across pages containing nightlies", async () => {
    const older = { ...nightly, published_at: "2026-10-12T10:00:00Z" };
    respond([older, ...Array.from({ length: 99 }, () => stable)]);
    respond([nightly]);
    expect(await fetchLatestRelease("nightly")).toEqual(nightly);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes a cached nightly after five minutes", async () => {
    respond([nightly]);
    await fetchLatestRelease("nightly");
    vi.mocked(Date.now).mockReturnValue(Date.now() + 5 * 60_000);
    const newer = { ...nightly, tag_name: "v1.2.1-nightly.20261013.2" };
    respond([newer]);
    expect(await fetchLatestRelease("nightly")).toEqual(newer);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["broken JSON", "{}", "null"])("ignores a corrupt cache: %s", async (cached) => {
    values.set("lecturn-stable-release", cached);
    respond(stable);
    expect(await fetchLatestRelease()).toEqual(stable);
  });

  it("rejects cached releases from the other channel", async () => {
    values.set(
      "lecturn-stable-release",
      JSON.stringify({ fetchedAt: Date.now(), release: nightly }),
    );
    respond(stable);
    expect(await fetchLatestRelease()).toEqual(stable);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads successfully when browser storage reads and writes fail", async () => {
    storage.getItem.mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    storage.setItem.mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    respond(stable);
    expect(await fetchLatestRelease()).toEqual(stable);
  });

  it("does not cache HTTP errors and retries the next request", async () => {
    respond(stable, 403);
    await expect(fetchLatestRelease()).rejects.toThrow("403");
    expect(values.size).toBe(0);
    respond(stable);
    expect(await fetchLatestRelease()).toEqual(stable);
  });

  it.each([
    { message: "API rate limit exceeded" },
    { ...stable, assets: [{}] },
    { ...stable, published_at: "invalid" },
    nightly,
  ])("rejects invalid stable release data without caching it", async (data) => {
    respond(data);
    await expect(fetchLatestRelease()).rejects.toThrow("Invalid stable release");
    expect(values.size).toBe(0);
  });

  it("does not substitute stable when the nightly page has no nightly", async () => {
    respond([stable]);
    await expect(fetchLatestRelease("nightly")).rejects.toThrow("No nightly release");
    expect(values.size).toBe(0);
  });

  it("matches exact architecture and format suffixes rather than blockmaps or partial names", () => {
    const assets = [
      "Lecturn-1.2.0-arm64.dmg.blockmap",
      "Lecturn-1.2.0-arm64.dmg",
      "Lecturn-1.2.0-x64.dmg",
      "Lecturn-1.2.0-arm64.exe",
      "Lecturn-1.2.0-x64.exe",
      "Lecturn-1.2.0-x86_64.AppImage",
    ].map((name) => ({ name, browser_download_url: `https://example.com/${name}` }));
    expect(findReleaseAsset(assets, "arm64.dmg")?.name).toBe("Lecturn-1.2.0-arm64.dmg");
    expect(findReleaseAsset(assets, "x64.dmg")?.name).toBe("Lecturn-1.2.0-x64.dmg");
    expect(findReleaseAsset(assets, "x64.exe")?.name).toBe("Lecturn-1.2.0-x64.exe");
    expect(findReleaseAsset(assets, "x86_64.AppImage")?.name).toBe("Lecturn-1.2.0-x86_64.AppImage");
    expect(findReleaseAsset(assets, "arm64.AppImage")).toBeUndefined();
    expect(findReleaseAsset(assets, "")).toBeUndefined();
  });
});
