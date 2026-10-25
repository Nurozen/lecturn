/**
 * Deep links into a connected app: `lecturn://apps/<appId>` opens the app in
 * the Apps sidebar, and `lecturn://apps/<appId>/threads/<env>/<thread>` opens
 * one of its threads with the sidebar in Apps mode. The thread route keeps the
 * app id in the query so the link can be rebuilt from the path.
 */

export interface AppLinkTarget {
  readonly appId: string;
  readonly thread?: { readonly environmentId: string; readonly threadId: string };
}

// Mirrors `AppId` in contracts `apps.ts`; a deep link is untrusted input.
const APP_ID = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/;
const APP_ID_MAX_LENGTH = 128;
const APP_LINK_PATH = /^\/([^/]+)(?:\/threads\/([^/]+)\/([^/]+))?\/?$/;
const APP_ROUTE_PATH = /^\/apps\/([^/]+)\/?$/;
const THREAD_ROUTE_PATH = /^\/([^/]+)\/([^/]+)\/?$/;

export const APPS_SIDEBAR_PARAM = "sidebar";
export const APPS_SIDEBAR_VALUE = "apps";
export const APP_ID_PARAM = "app";

const isAppId = (value: string) => value.length <= APP_ID_MAX_LENGTH && APP_ID.test(value);

/** The target of a parsed `lecturn://apps/...` URL, or null when it is not one. */
export function parseAppDeepLink(url: URL): AppLinkTarget | null {
  if (url.host !== "apps") return null;
  const match = APP_LINK_PATH.exec(url.pathname);
  const appId = match?.[1];
  if (appId === undefined || !isAppId(appId)) return null;
  const environmentId = match?.[2];
  const threadId = match?.[3];
  return environmentId !== undefined && threadId !== undefined
    ? { appId, thread: { environmentId, threadId } }
    : { appId };
}

/** The app path for a target; `search` (a `URL.search`) carries the deep link's own query through. */
export function appLinkPath(target: AppLinkTarget, search = ""): string {
  if (target.thread === undefined) return `/apps/${target.appId}${search}`;
  const params = new URLSearchParams(search);
  params.set(APPS_SIDEBAR_PARAM, APPS_SIDEBAR_VALUE);
  params.set(APP_ID_PARAM, target.appId);
  return `/${target.thread.environmentId}/${target.thread.threadId}?${params.toString()}`;
}

/** The app path a `lecturn://apps/...` URL opens, or null when it is not a valid app link. */
export function appLinkPathFromUrl(url: URL): string | null {
  const target = parseAppDeepLink(url);
  return target === null ? null : appLinkPath(target, url.search);
}

/** The deep link for an app path built by `appLinkPath`, or null for any other path. */
export function appLinkFromPath(appPath: string, scheme = "lecturn"): string | null {
  const url = new URL(appPath, "https://app.invalid");
  const appRoute = APP_ROUTE_PATH.exec(url.pathname);
  if (appRoute?.[1] !== undefined) {
    return isAppId(appRoute[1]) ? `${scheme}://apps/${appRoute[1]}${url.search}` : null;
  }
  const thread = THREAD_ROUTE_PATH.exec(url.pathname);
  const appId = url.searchParams.get(APP_ID_PARAM);
  if (
    thread === null ||
    appId === null ||
    !isAppId(appId) ||
    url.searchParams.get(APPS_SIDEBAR_PARAM) !== APPS_SIDEBAR_VALUE
  ) {
    return null;
  }
  url.searchParams.delete(APP_ID_PARAM);
  url.searchParams.delete(APPS_SIDEBAR_PARAM);
  return `${scheme}://apps/${appId}/threads/${thread[1]}/${thread[2]}${url.search}`;
}
