/** The slice of a Clerk instance that switching the active account needs. */
export interface ActiveAccountClerk {
  readonly user?: { readonly id: string } | null | undefined;
  readonly client?:
    | {
        readonly signedInSessions: ReadonlyArray<{
          readonly id: string;
          readonly user: { readonly id: string } | null;
        }>;
      }
    | undefined;
  readonly setActive: (params: { session: string }) => Promise<unknown>;
}

export class ActiveAccountError extends Error {
  override readonly name = "ActiveAccountError";
}

let clerk: ActiveAccountClerk | null = null;
let turn: Promise<void> = Promise.resolve();

/** The mounted auth provider binds its Clerk instance, and unbinds it with null. */
export function bindActiveAccountClerk(next: ActiveAccountClerk | null): void {
  clerk = next;
}

function assertActive(bound: ActiveAccountClerk, accountId: string, when: string): void {
  if (bound.user?.id !== accountId) {
    console.error("[lecturn-connect] Clerk's active account is not the requested one", {
      accountId,
      activeAccountId: bound.user?.id ?? null,
      when,
    });
    throw new ActiveAccountError("Could not switch to that Lecturn Connect account.");
  }
}

/** How long a caller waits, including earlier turns, before receiving a retryable error. */
export const ACTIVE_ACCOUNT_TIMEOUT_MS = 15_000;

/**
 * Serializes Clerk mutations. A timeout reports failure to the caller, but
 * cannot cancel a Clerk request already in flight, so its turn stays locked
 * until that request settles. Expired queued turns never start. Callers check
 * the signal after awaited work before starting any further side effects.
 */
export function withActiveSessionTurn<A>(
  fn: (signal: AbortSignal) => A | Promise<A>,
  timeoutMs: number = ACTIVE_ACCOUNT_TIMEOUT_MS,
): Promise<A> {
  const controller = new AbortController();
  const work = turn.then(() => {
    controller.signal.throwIfAborted();
    return fn(controller.signal);
  });
  turn = work.then(
    () => undefined,
    () => undefined,
  );
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new ActiveAccountError("Lecturn Connect took too long. Try again.");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Runs `fn` while `accountId` is Clerk's active account, for the few places
 * where Clerk itself has to act as that account: the CLI authorize redirect
 * and Clerk's profile pages. It is the only caller of `setActive` for choosing
 * an account. Relay reads never need it: they take the account's own token
 * from `readToken(accountId)`.
 *
 * Calls take turns through `withActiveSessionTurn`, with its timeout and its
 * rule against re-entry. The account is made active only when it is not
 * already, checked before and after `fn`, and left active afterwards.
 */
export function withActiveAccount<A>(
  accountId: string,
  fn: () => A | Promise<A>,
  timeoutMs?: number,
): Promise<A> {
  return withActiveSessionTurn(async (signal) => {
    const bound = clerk;
    if (bound === null) {
      throw new ActiveAccountError("Lecturn Connect is not ready yet.");
    }
    if (bound.user?.id !== accountId) {
      const session = bound.client?.signedInSessions.find((entry) => entry.user?.id === accountId);
      if (!session) {
        throw new ActiveAccountError("That Lecturn Connect account needs sign-in.");
      }
      await bound.setActive({ session: session.id });
    }
    signal.throwIfAborted();
    assertActive(bound, accountId, "before");
    const value = await fn();
    assertActive(bound, accountId, "after");
    return value;
  }, timeoutMs);
}
