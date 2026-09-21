/**
 * Shared-storage key a build with multi-account enabled writes on hosted web,
 * where every tab shares one Clerk client. Nothing writes it yet: the value is
 * `String(Date.now())`, rewritten at least hourly while such a tab is open and
 * never removed, so a rollback lets it go stale within two heartbeats.
 */
export const MULTI_ACCOUNT_ENABLED_MARKER_KEY = "lecturn:multi-account-enabled";

/** Twice the writer's hourly heartbeat. An older marker has no running writer. */
export const MULTI_ACCOUNT_MARKER_MAX_AGE_MS = 2 * 60 * 60 * 1_000;

export function isMultiAccountMarkerFresh(value: string | null, now: number): boolean {
  if (value === null || value.trim() === "") {
    return false;
  }
  const writtenAt = Number(value);
  return Number.isFinite(writtenAt) && Math.abs(now - writtenAt) < MULTI_ACCOUNT_MARKER_MAX_AGE_MS;
}

export const SINGLE_ACCOUNT_REJECTED_MESSAGE =
  "Multiple accounts are not supported in this version yet. The extra account was signed out.";

export const SINGLE_ACCOUNT_STAND_DOWN_MESSAGE =
  "Another tab is running a newer version with multiple accounts. Reload to continue.";

export const SINGLE_ACCOUNT_EXHAUSTED_MESSAGE =
  "Lecturn could not return to a single signed-in account. Sign out of all accounts, then sign in again.";

const MAX_REJECTION_ATTEMPTS_PER_SESSION = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const TRANSIENT_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Offline, a dropped tunnel, or a struggling server. Anything Clerk answered
 * with another status is a refusal that retrying will not change.
 */
function isTransientFailure(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  const { status, code } = cause as { readonly status?: unknown; readonly code?: unknown };
  if (typeof status === "number") {
    return status >= 500 || status === 408 || status === 429;
  }
  return code === "network_error" || cause instanceof TypeError;
}

export interface SingleAccountGuardSession {
  readonly id: string;
  readonly accountId: string;
  readonly createdAt: number;
}

export interface SingleAccountGuardInput {
  readonly multiAccountEnabled: boolean;
  readonly markerPresent: boolean;
  readonly sessions: ReadonlyArray<SingleAccountGuardSession>;
  readonly activeSessionId: string | null;
  /** Account the app is serving: undefined before the first observation. */
  readonly observedAccountId: string | null | undefined;
  /** Persisted last served account: undefined while it is still loading. */
  readonly persistedAccountId: string | null | undefined;
}

export type SingleAccountGuardDecision =
  /** Nothing to enforce. The caller runs its normal account handling. */
  | { readonly _tag: "Proceed" }
  /** Change nothing until more is known. */
  | { readonly _tag: "Hold" }
  /** A newer tab owns the extra sessions. Ask for a reload instead. */
  | { readonly _tag: "StandDown" }
  /** Make the accepted session active, then sign the extras out. */
  | {
      readonly _tag: "Reject";
      readonly acceptedSessionId: string;
      readonly extraSessionIds: ReadonlyArray<string>;
    };

const byOldest = (left: SingleAccountGuardSession, right: SingleAccountGuardSession) =>
  left.createdAt - right.createdAt;

/**
 * Decides what to do with the signed-in Clerk sessions while multi-account is
 * off. Runs before any account-transition handling, so every result other than
 * Proceed means "this is not an account change, run no cleanup".
 *
 * While the served account still has a signed-in session, Clerk showing any
 * other active user (or none) is never an account change: Clerk adds an account
 * in two steps, and signing out the current session leaves none active, so the
 * session count alone cannot tell a real sign-out from a rejected add.
 */
export function decideSingleAccountGuard(
  input: SingleAccountGuardInput,
): SingleAccountGuardDecision {
  if (input.multiAccountEnabled) {
    return { _tag: "Proceed" };
  }
  const multiple = input.sessions.length > 1;
  if (multiple && input.markerPresent) {
    return { _tag: "StandDown" };
  }
  // An observed null is a real sign-out and outranks a stale persisted account.
  const servedAccountId =
    input.observedAccountId !== undefined ? input.observedAccountId : input.persistedAccountId;
  if (servedAccountId === undefined) {
    return multiple ? { _tag: "Hold" } : { _tag: "Proceed" };
  }
  const oldestFirst = [...input.sessions].sort(byOldest);
  const active = oldestFirst.find((session) => session.id === input.activeSessionId);
  // With no served account the local data belongs to whichever session is
  // active, so that one is kept ahead of the oldest.
  const accepted =
    servedAccountId === null
      ? multiple
        ? (active ?? oldestFirst[0])
        : undefined
      : active?.accountId === servedAccountId
        ? active
        : oldestFirst.find((session) => session.accountId === servedAccountId);
  if (accepted === undefined) {
    // The served account really signed out. That is a normal account change.
    return { _tag: "Proceed" };
  }
  const extraSessionIds = oldestFirst
    .filter((session) => session.id !== accepted.id)
    .map((session) => session.id);
  if (extraSessionIds.length === 0 && active?.id === accepted.id) {
    return { _tag: "Proceed" };
  }
  return { _tag: "Reject", acceptedSessionId: accepted.id, extraSessionIds };
}

/** The slice of a Clerk instance the enforcer reads and drives. */
export interface SingleAccountGuardClerk {
  readonly session?:
    | { readonly id: string; readonly user?: { readonly id: string } | null }
    | null
    | undefined;
  readonly client?:
    | {
        readonly signedInSessions: ReadonlyArray<{
          readonly id: string;
          readonly createdAt: Date;
          readonly user: { readonly id: string } | null;
        }>;
      }
    | undefined;
  readonly setActive: (params: { session: string }) => Promise<unknown>;
  readonly signOut: (options?: { sessionId: string }) => Promise<unknown>;
  readonly addListener?: (listener: () => void) => () => void;
}

export interface SingleAccountEnforcerOptions {
  readonly multiAccountEnabled: boolean;
  readonly readMarkerPresent: () => boolean;
  /** An extra account was signed out. Fires after the sign-out succeeded. */
  readonly onRejected: () => void;
  readonly onStandDown: () => void;
  /**
   * Retries ran out. The message must stay up and offer the full sign-out. It
   * is announced again if that sign-out fails.
   */
  readonly onExhausted: (signOutEverywhere: () => Promise<void>) => void;
  /** The platform's own full sign-out flow, with whatever it does beforehand. */
  readonly signOutEverywhere: (clerk: SingleAccountGuardClerk) => Promise<unknown>;
  readonly onError: (cause: unknown) => void;
  /** Runs a retry after its delay and returns its cancel. */
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  /** Calls wake when the network returns or the app regains the foreground. */
  readonly subscribeWake: (wake: () => void) => () => void;
}

export interface SingleAccountEnforcer {
  /**
   * Returns true when the caller may run its account handling. False means the
   * observed Clerk state is not an account change and must not be acted on;
   * onSettled then asks the caller to evaluate Clerk's new state.
   */
  readonly evaluate: (input: {
    readonly clerk: SingleAccountGuardClerk;
    /** Active account in the state the caller rendered and is about to act on. */
    readonly renderedAccountId: string | null;
    readonly observedAccountId: string | null | undefined;
    readonly persistedAccountId: string | null | undefined;
    readonly onSettled: () => void;
  }) => boolean;
  /** Resolves once no rejection is running. */
  readonly settled: () => Promise<void>;
  /** Drops timers and subscriptions on unmount. The enforcer stays usable. */
  readonly dispose: () => void;
}

/**
 * Effectful half of the guard. One rejection runs at a time, each extra session
 * is announced once it is gone, and a failure is retried with backoff. A
 * transient failure is retried for as long as it lasts, and right away on wake.
 * A session that keeps being refused or coming back stops being retried so a
 * native session sync cannot drive a loop.
 */
export function makeSingleAccountEnforcer(
  options: SingleAccountEnforcerOptions,
): SingleAccountEnforcer {
  let inFlight: Promise<void> | null = null;
  let standDownAnnounced = false;
  let exhaustedAnnounced = false;
  const attemptsBySessionId = new Map<string, number>();
  const announcedSessionIds = new Set<string>();
  let transientFailures = 0;
  let pendingRetry: { readonly run: () => void; readonly cancel: () => void } | null = null;
  let unsubscribeWake: (() => void) | null = null;
  let unsubscribeHold: (() => void) | null = null;

  const retryAfter = (run: () => void, delayMs: number) => {
    const fire = () => {
      pendingRetry = null;
      inFlight = null;
      run();
    };
    pendingRetry = { run: fire, cancel: options.schedule(fire, delayMs) };
    unsubscribeWake ??= options.subscribeWake(() => {
      const retry = pendingRetry;
      retry?.cancel();
      retry?.run();
    });
  };

  // React can batch Clerk's emits into no render at all, so a hold waits for
  // Clerk itself. addListener emits once on subscribing, which is not news.
  const holdUntilClerkSettles = (clerk: SingleAccountGuardClerk, onSettled: () => void) => {
    if (unsubscribeHold !== null || clerk.addListener === undefined) {
      return;
    }
    let subscribing = true;
    unsubscribeHold = clerk.addListener(() => {
      if (subscribing || clerk.session === undefined) {
        return;
      }
      unsubscribeHold?.();
      unsubscribeHold = null;
      onSettled();
    });
    subscribing = false;
  };

  const reject = async (
    clerk: SingleAccountGuardClerk,
    acceptedSessionId: string,
    extraSessionIds: ReadonlyArray<string>,
  ) => {
    // Signing out the current session clears the active session and navigates,
    // and Clerk's own sign-in flow can make the extra session current at any
    // moment, so re-read the active session before every step.
    const signedInIds = () => (clerk.client?.signedInSessions ?? []).map((session) => session.id);
    const activateAccepted = async () => {
      if (clerk.session?.id !== acceptedSessionId && signedInIds().includes(acceptedSessionId)) {
        await clerk.setActive({ session: acceptedSessionId });
      }
    };
    for (const sessionId of extraSessionIds) {
      await activateAccepted();
      // With one session left clerk-js signs out all of them whatever id it is
      // given, so an extra that someone else already removed is never named.
      const remaining = signedInIds();
      if (remaining.length <= 1) {
        break;
      }
      if (remaining.includes(sessionId)) {
        await clerk.signOut({ sessionId });
      }
    }
    await activateAccepted();
  };

  return {
    evaluate: ({ clerk, renderedAccountId, observedAccountId, persistedAccountId, onSettled }) => {
      if (
        !options.multiAccountEnabled &&
        (clerk.session === undefined || (clerk.session?.user?.id ?? null) !== renderedAccountId)
      ) {
        // Clerk is mid sign-out or mid switch, or the caller rendered an older
        // state than the one decided on here. Clerk's next emit re-runs it.
        holdUntilClerkSettles(clerk, onSettled);
        return false;
      }
      const sessions = (clerk.client?.signedInSessions ?? []).flatMap((session) =>
        session.user
          ? [
              {
                id: session.id,
                accountId: session.user.id,
                createdAt: session.createdAt.getTime(),
              },
            ]
          : [],
      );
      // A capped session that went away may be rejected again if it returns.
      for (const [sessionId, attempts] of attemptsBySessionId) {
        if (
          attempts >= MAX_REJECTION_ATTEMPTS_PER_SESSION &&
          !sessions.some((session) => session.id === sessionId)
        ) {
          attemptsBySessionId.delete(sessionId);
          exhaustedAnnounced = false;
        }
      }
      const decision = decideSingleAccountGuard({
        multiAccountEnabled: options.multiAccountEnabled,
        markerPresent: sessions.length > 1 && options.readMarkerPresent(),
        sessions,
        activeSessionId: clerk.session?.id ?? null,
        observedAccountId,
        persistedAccountId,
      });
      switch (decision._tag) {
        case "Proceed":
          return true;
        case "Hold":
          return false;
        case "StandDown":
          if (!standDownAnnounced) {
            standDownAnnounced = true;
            options.onStandDown();
          }
          return false;
        case "Reject": {
          if (inFlight !== null) {
            return false;
          }
          const { acceptedSessionId, extraSessionIds } = decision;
          // A bare reactivation is counted against the accepted session.
          const attemptIds = extraSessionIds.length > 0 ? extraSessionIds : [acceptedSessionId];
          const pendingIds = attemptIds.filter(
            (sessionId) =>
              (attemptsBySessionId.get(sessionId) ?? 0) < MAX_REJECTION_ATTEMPTS_PER_SESSION,
          );
          if (pendingIds.length === 0) {
            if (!exhaustedAnnounced) {
              exhaustedAnnounced = true;
              options.onExhausted(async () => {
                try {
                  await options.signOutEverywhere(clerk);
                } catch (cause) {
                  options.onError(cause);
                  exhaustedAnnounced = false;
                  onSettled();
                }
              });
            }
            return false;
          }
          let attempt = 0;
          for (const sessionId of pendingIds) {
            attempt = (attemptsBySessionId.get(sessionId) ?? 0) + 1;
            attemptsBySessionId.set(sessionId, attempt);
          }
          const signOutIds = extraSessionIds.filter((sessionId) => pendingIds.includes(sessionId));
          inFlight = reject(clerk, acceptedSessionId, signOutIds)
            .then(() => {
              attemptsBySessionId.delete(acceptedSessionId);
              transientFailures = 0;
              const announce = signOutIds.some((sessionId) => !announcedSessionIds.has(sessionId));
              for (const sessionId of signOutIds) {
                announcedSessionIds.add(sessionId);
              }
              if (announce) {
                options.onRejected();
              }
              inFlight = null;
              onSettled();
            })
            .catch((cause: unknown) => {
              options.onError(cause);
              if (!isTransientFailure(cause)) {
                retryAfter(onSettled, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
                return;
              }
              // Being offline says nothing about the session, so it is not counted.
              for (const sessionId of pendingIds) {
                attemptsBySessionId.set(sessionId, (attemptsBySessionId.get(sessionId) ?? 1) - 1);
              }
              transientFailures += 1;
              retryAfter(
                onSettled,
                Math.min(
                  RETRY_BASE_DELAY_MS * 2 ** (transientFailures - 1),
                  TRANSIENT_RETRY_MAX_DELAY_MS,
                ),
              );
            });
          return false;
        }
      }
    },
    settled: () => inFlight ?? Promise.resolve(),
    dispose: () => {
      if (pendingRetry !== null) {
        pendingRetry.cancel();
        pendingRetry = null;
        inFlight = null;
      }
      unsubscribeWake?.();
      unsubscribeWake = null;
      unsubscribeHold?.();
      unsubscribeHold = null;
    },
  };
}
