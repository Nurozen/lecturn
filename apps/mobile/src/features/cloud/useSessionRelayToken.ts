import { accountTokenReader } from "./accountTokenReaders";

const readSignedOutToken = () => Promise.resolve(null);

/** Stable readers resolve only the requested account's current signed-in session. */
export function useSessionRelayToken(auth: {
  readonly userId: string | null | undefined;
  readonly sessionId: string | null | undefined;
  readonly isSignedIn: boolean | undefined;
}): () => Promise<string | null> {
  return auth.userId ? accountTokenReader(auth.userId) : readSignedOutToken;
}
