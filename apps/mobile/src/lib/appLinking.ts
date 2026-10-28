/**
 * The Expo dev client launches the app via
 * <scheme>://expo-development-client/?url=<packager> — that URL addresses
 * the launcher, not app navigation. Without this filter it falls through
 * to the NotFound wildcard route on every dev launch.
 */
export function shouldHandleAppLink(url: string): boolean {
  return (
    !url.includes("expo-development-client") &&
    !url.includes("://expo-sharing") &&
    !/^lecturn(-dev|-preview)?:\/*$/.test(url)
  );
}

/** Connected-app links; the thread-scoped MCP App route `threads/.../apps/:itemId` is unrelated. */
export const APP_LINKING_PATH = "apps/:appId";
export const APP_THREAD_LINKING_PATH = `${APP_LINKING_PATH}/threads/:environmentId/:threadId`;
