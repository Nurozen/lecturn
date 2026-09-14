import { useLayoutEffect, useMemo } from "react";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

type ClerkTokenProvider = (
  options: ReturnType<typeof resolveRelayClerkTokenOptions>,
) => Promise<string | null>;

function createSessionTokenProvider(
  userId: string | null | undefined,
  signedIn: boolean | undefined,
) {
  let current: ClerkTokenProvider | null = null;
  return {
    update(provider: ClerkTokenProvider) {
      current = provider;
    },
    read() {
      return signedIn && userId && current
        ? current(resolveRelayClerkTokenOptions())
        : Promise.resolve(null);
    },
  };
}

/** Clerk Expo wraps getToken on every render. Keep relay effects tied to the session. */
export function useSessionRelayToken(auth: {
  readonly userId: string | null | undefined;
  readonly sessionId: string | null | undefined;
  readonly isSignedIn: boolean | undefined;
  readonly getToken: ClerkTokenProvider;
}): () => Promise<string | null> {
  const { userId, sessionId, isSignedIn, getToken } = auth;
  const session = useMemo(
    () => ({ sessionId, ...createSessionTokenProvider(userId, isSignedIn) }),
    [userId, sessionId, isSignedIn],
  );
  useLayoutEffect(() => {
    session.update(getToken);
  }, [session, getToken]);

  // Old-account cleanup retains its own holder; it must never read the next
  // account's token through a shared latest-value ref.
  return session.read;
}
