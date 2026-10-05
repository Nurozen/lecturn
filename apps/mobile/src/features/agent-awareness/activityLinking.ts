/** Live Activity URLs use the same ownership-aware deferred path as notification taps. */
const pending = new Map<string, unknown>();
const listeners = new Set<() => void>();
let nextId = 0;

export function queueLiveActivityLink(url: string): boolean {
  const match =
    /^(?:lecturn|lecturn-dev|lecturn-preview):\/\/(threads\/[^/?#]+\/[^/?#]+)(?:\?([^#]*))?$/.exec(
      url,
    );
  if (!match) return false;
  const params = new URLSearchParams(match[2] ?? "");
  const accountId = params.get("accountId");
  if (!accountId || [...params.keys()].some((key) => key !== "accountId")) return false;
  // A newer explicit tap supersedes an older destination still hydrating.
  pending.clear();
  const id = `live-activity:${++nextId}`;
  pending.set(id, {
    notification: {
      request: { identifier: id, content: { data: { deepLink: `/${match[1]}`, accountId } } },
    },
  });
  for (const listener of listeners) listener();
  return true;
}

/** Let standard app routes win over any older destination still waiting for sync. */
export function handleIncomingAppLink(url: string, prefixes: readonly string[]): boolean {
  if (queueLiveActivityLink(url)) return true;
  const accepted =
    prefixes.some((prefix) => url.startsWith(prefix)) &&
    !url.includes("expo-development-client") &&
    !url.includes("://expo-sharing") &&
    !/\/(?:oauth-native-callback|sso-callback)(?:[/?#]|$)/.test(url);
  if (accepted) {
    pending.clear();
    nextId++;
    for (const listener of listeners) listener();
  }
  return false;
}

export const liveActivityLinkRevision = () => nextId;
export const pendingLiveActivityResponses = () => [...pending.entries()];
export const acknowledgeLiveActivityResponse = (id: string) => {
  pending.delete(id);
};
export function subscribeLiveActivityLinks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
