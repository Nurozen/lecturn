const REPO = "Nurozen/lecturn";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;

const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
// The latest endpoint excludes prereleases. Publication order can differ from
// creation order, so compare every page, just like stable promotion.
const LIST_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const CACHE_TTL_MS = 5 * 60_000;

export type ReleaseChannel = "stable" | "nightly";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

function isRelease(value: unknown): value is Release {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag_name" in value &&
    typeof value.tag_name === "string" &&
    value.tag_name.length > 0 &&
    "html_url" in value &&
    typeof value.html_url === "string" &&
    "published_at" in value &&
    typeof value.published_at === "string" &&
    Number.isFinite(Date.parse(value.published_at)) &&
    "assets" in value &&
    Array.isArray(value.assets) &&
    value.assets.every(
      (asset: unknown) =>
        typeof asset === "object" &&
        asset !== null &&
        "name" in asset &&
        typeof asset.name === "string" &&
        "browser_download_url" in asset &&
        typeof asset.browser_download_url === "string",
    )
  );
}

async function fetchReleaseData(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Release request failed (${response.status})`);
  return response.json();
}

function isNightly(release: Release) {
  return release.tag_name.includes("-nightly.");
}

function matchesChannel(release: Release, channel: ReleaseChannel) {
  return isNightly(release) === (channel === "nightly");
}

async function fetchRelease(channel: ReleaseChannel): Promise<Release> {
  if (channel === "stable") {
    const data = await fetchReleaseData(LATEST_API_URL);
    if (!isRelease(data) || !matchesChannel(data, channel)) {
      throw new Error("Invalid stable release response");
    }
    return data;
  }

  let latest: Release | undefined;
  for (let page = 1; ; page++) {
    const data = await fetchReleaseData(page === 1 ? LIST_API_URL : `${LIST_API_URL}&page=${page}`);
    if (!Array.isArray(data)) throw new Error("Invalid nightly release response");
    // GitHub orders by creation, which can differ from publication for draft releases.
    latest = data
      .filter(isRelease)
      .filter(isNightly)
      .reduce<Release | undefined>(
        (newest, release) =>
          !newest || Date.parse(release.published_at) > Date.parse(newest.published_at)
            ? release
            : newest,
        latest,
      );
    if (data.length < 100) break;
  }
  if (!latest) throw new Error("No nightly release found");
  return latest;
}

export function findReleaseAsset(assets: ReleaseAsset[], suffix: string) {
  // Include the separator and full extension so arm64, x64 and blockmaps cannot collide.
  return suffix ? assets.find((asset) => asset.name.endsWith(`-${suffix}`)) : undefined;
}

export async function fetchLatestRelease(channel: ReleaseChannel = "stable"): Promise<Release> {
  const key = `lecturn-${channel}-release`;
  try {
    const cached: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      typeof cached === "object" &&
      cached !== null &&
      "fetchedAt" in cached &&
      typeof cached.fetchedAt === "number" &&
      Date.now() >= cached.fetchedAt &&
      Date.now() - cached.fetchedAt < CACHE_TTL_MS &&
      "release" in cached &&
      isRelease(cached.release) &&
      matchesChannel(cached.release, channel)
    ) {
      return cached.release;
    }
  } catch {
    // Corrupt or unavailable browser storage must not prevent downloads.
  }

  const release = await fetchRelease(channel);
  try {
    sessionStorage.setItem(key, JSON.stringify({ fetchedAt: Date.now(), release }));
  } catch {
    // Private browsing and quota errors still allow the fetched release to be used.
  }
  return release;
}
