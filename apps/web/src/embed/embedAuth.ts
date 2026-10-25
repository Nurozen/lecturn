/**
 * The embed credential. The host passes it in the URL hash, which never reaches the server or a
 * Referer, and it is kept in memory only: the embed shares the user's Lecturn origin, so storage
 * writes would leak it to (and clobber) the user's own tab. `#token=` is taken by pairing, hence
 * `#embedToken=`.
 */

const EMBED_PATH_PREFIX = "/embed/";
const EMBED_TOKEN_KEY = "embedToken";
const PARENT_ORIGIN_KEY = "parentOrigin";

export interface EmbedHashCredential {
  readonly token: string;
  readonly parentOrigin: string | null;
}

// Read from the pathname, not router state: the HTTP layer and connection platform are built
// before any route renders.
export function isEmbedLocation(
  location: { readonly pathname: string } | undefined = globalThis.window?.location,
): boolean {
  return location !== undefined && location.pathname.startsWith(EMBED_PATH_PREFIX);
}

function hashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === value ? origin : null;
  } catch {
    return null;
  }
}

export function parseEmbedHash(hash: string): EmbedHashCredential | null {
  const params = hashParams(hash);
  const token = params.get(EMBED_TOKEN_KEY)?.trim();
  if (!token) return null;
  return { token, parentOrigin: normalizeOrigin(params.get(PARENT_ORIGIN_KEY)) };
}

/** Removes only the embed keys, so any other hash content survives. */
export function stripEmbedHash(href: string): string {
  const url = new URL(href);
  const params = hashParams(url.hash);
  if (!params.has(EMBED_TOKEN_KEY) && !params.has(PARENT_ORIGIN_KEY)) return href;
  params.delete(EMBED_TOKEN_KEY);
  params.delete(PARENT_ORIGIN_KEY);
  const rest = params.toString();
  url.hash = rest.length > 0 ? `#${rest}` : "";
  return url.toString();
}

let hashConsumed = false;
let embedToken: string | null = null;
let embedTokenExpiresAtMs: number | null = null;
let embedParentOrigin: string | null = null;
const tokenListeners = new Set<() => void>();

/** Takes the credential out of the address bar once; later calls return what was taken. */
export function consumeEmbedHash(): EmbedHashCredential | null {
  if (!hashConsumed && typeof window !== "undefined") {
    hashConsumed = true;
    const credential = parseEmbedHash(window.location.hash);
    if (credential) {
      embedToken = credential.token;
      embedParentOrigin = credential.parentOrigin;
      window.history.replaceState(window.history.state, "", stripEmbedHash(window.location.href));
    }
  }
  return embedToken === null ? null : { token: embedToken, parentOrigin: embedParentOrigin };
}

/**
 * Swapped in on `lecturn/token.refresh`. HTTP picks it up because the bearer is re-read per
 * request; listeners reconnect the socket, whose session is still the old token's.
 */
export function setEmbedToken(token: string, expiresAtMs: number | null = null): void {
  hashConsumed = true;
  embedToken = token;
  embedTokenExpiresAtMs = expiresAtMs;
  for (const listener of tokenListeners) listener();
}

export function subscribeEmbedToken(listener: () => void): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

/** The hash carries no expiry, so the first token's is learned from the server later. */
export function readEmbedTokenExpiresAt(): number | null {
  consumeEmbedHash();
  return embedTokenExpiresAtMs;
}

export function rememberEmbedTokenExpiry(token: string, expiresAtMs: number): void {
  if (embedToken === token) embedTokenExpiresAtMs = expiresAtMs;
}

export function readEmbedToken(): string | null {
  return consumeEmbedHash()?.token ?? null;
}

export function readEmbedBearerToken(): Promise<string | null> {
  return Promise.resolve(readEmbedToken());
}

export function readEmbedParentOrigin(): string | null {
  return consumeEmbedHash()?.parentOrigin ?? null;
}

export function __resetEmbedAuthForTests(): void {
  hashConsumed = false;
  embedToken = null;
  embedTokenExpiresAtMs = null;
  embedParentOrigin = null;
  tokenListeners.clear();
}
