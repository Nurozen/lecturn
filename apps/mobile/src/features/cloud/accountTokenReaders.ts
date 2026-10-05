import { resolveRelayClerkTokenOptions } from "./publicConfig";

/** The slice of a Clerk instance that relay tokens are read from. */
export interface AccountTokenClerk {
  readonly client?:
    | {
        readonly signedInSessions: ReadonlyArray<{
          readonly user: { readonly id: string } | null;
          readonly getToken: (
            options: ReturnType<typeof resolveRelayClerkTokenOptions>,
          ) => Promise<string | null>;
        }>;
      }
    | undefined;
}

const PERMIT_TIMEOUT_MS = 30_000;
const STUCK_READ_ABANDON_MS = 5 * 60_000;
const PERMIT_TIMEOUT_MESSAGE = "A Lecturn Connect token read is taking too long.";

let clerk: AccountTokenClerk | null = null;
let permit: Promise<void> = Promise.resolve();
let stuck = false;
let mismatchLogged = false;

/** The mounted native auth provider binds its Clerk instance, and unbinds it with null. */
export function bindAccountTokenClerk(next: AccountTokenClerk | null): void {
  clerk = next;
}

const waiting = new Set<() => void>();

// A read has taken too long. Everyone waiting fails now, and new readers fail
// at once instead of queueing, until the reads that did start have settled.
function giveUp(): void {
  if (!stuck) {
    stuck = true;
    const held = permit;
    const release = () => {
      clearTimeout(abandon);
      if (permit === held) {
        permit = Promise.resolve();
      }
      stuck = false;
    };
    // clerk-js gives up on a failing read within minutes. A read that outlives
    // that never will, so stop waiting for it rather than block until reload.
    const abandon = setTimeout(release, STUCK_READ_ABANDON_MS);
    void held.then(release);
  }
  for (const fail of waiting) {
    fail();
  }
}

function expire<A>(pending: Promise<A>): Promise<A> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      waiting.delete(fail);
    };
    const fail = () => {
      done();
      reject(new Error(PERMIT_TIMEOUT_MESSAGE));
    };
    const timer = setTimeout(giveUp, PERMIT_TIMEOUT_MS);
    waiting.add(fail);
    void pending.then(resolve, reject).finally(done);
  });
}

// Every Clerk token read shares one permit. Each response can rotate
// the one stored client JWT and the last write wins, so reads must not overlap.
// clerk-js retries a failing read for minutes. Such a read keeps the permit
// until it settles: its caller and the readers behind it time out instead.
function withTokenPermit<A>(read: () => Promise<A>): Promise<A> {
  if (stuck) {
    return Promise.reject(new Error(PERMIT_TIMEOUT_MESSAGE));
  }
  const turn = permit;
  const result = expire(turn).then(read);
  permit = turn.then(() =>
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return expire(result);
}

function tokenSubject(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const sub: unknown = JSON.parse(json).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Reads one account's relay token from that account's own Clerk session, found
 * at call time because Clerk re-creates its session objects. Resolves null when
 * the account has no signed-in session, as a signed-out reader always has, and
 * when Clerk hands back a token for anyone else.
 *
 * Template tokens only: a template read leaves the active session and its
 * cookie alone, which a bare `getToken()` on a non-active session would not.
 */
export function readToken(accountId: string): Promise<string | null> {
  return withTokenPermit(async () => {
    const session = clerk?.client?.signedInSessions.find((entry) => entry.user?.id === accountId);
    const token = (await session?.getToken(resolveRelayClerkTokenOptions())) ?? null;
    if (token !== null && tokenSubject(token) !== accountId) {
      if (!mismatchLogged) {
        mismatchLogged = true;
        console.error("[lecturn-connect] Clerk returned a token for another account", {
          accountId,
        });
      }
      return null;
    }
    return token;
  });
}

const readers = new Map<string, () => Promise<string | null>>();
export function accountTokenReader(accountId: string): () => Promise<string | null> {
  let reader = readers.get(accountId);
  if (!reader) {
    reader = () => readToken(accountId);
    readers.set(accountId, reader);
  }
  return reader;
}
