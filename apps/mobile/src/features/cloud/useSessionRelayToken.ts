import { useSession } from "@clerk/expo";
import { useLayoutEffect, useMemo } from "react";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

type ClerkSession = NonNullable<ReturnType<typeof useSession>["session"]>;

function createSessionTokenProvider() {
  let current: ClerkSession | null = null;
  return {
    update(session: ClerkSession) {
      current = session;
    },
    read() {
      return current ? current.getToken(resolveRelayClerkTokenOptions()) : Promise.resolve(null);
    },
  };
}

/** Keep relay effects stable and token reads bound to their original Clerk session. */
export function useSessionRelayToken(auth: {
  readonly userId: string | null | undefined;
  readonly sessionId: string | null | undefined;
  readonly isSignedIn: boolean | undefined;
}): () => Promise<string | null> {
  const { session } = useSession();
  const { userId, sessionId, isSignedIn } = auth;
  const ready = Boolean(isSignedIn && session?.id === sessionId && session?.user.id === userId);
  const provider = useMemo(
    () => ({ userId, sessionId, ready, ...createSessionTokenProvider() }),
    [userId, sessionId, ready],
  );
  useLayoutEffect(() => {
    if (ready && session) {
      provider.update(session);
    }
  }, [provider, session, ready]);

  // useAuth().getToken reads Clerk's mutable active session even through an old
  // closure. Retain the actual resource so delayed cleanup cannot use a new account.
  return provider.read;
}
