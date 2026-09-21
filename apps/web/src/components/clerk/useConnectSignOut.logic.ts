import {
  clearConnectSignOutStarted,
  markConnectSignOutStarted,
  type ObservedClerkSession,
} from "../../cloud/knownAccounts";

export interface SignOutSession extends ObservedClerkSession {
  readonly lastActiveAt: number;
}

/** Accounts a sign-out ends. "all" is every signed-in account. */
export type SignOutTargets = ReadonlyArray<string> | "all";

/**
 * The local host this client owns. A browser owns none. "unknown" is a desktop
 * host whose Connect link state has not loaded.
 */
export type SignOutHost =
  | { readonly _tag: "none" }
  | { readonly _tag: "unknown" }
  | { readonly _tag: "known"; readonly publishingAccountId: string | null };

export type SignOutStep =
  | { readonly _tag: "unpublish"; readonly accountId: string }
  | { readonly _tag: "setActive"; readonly sessionId: string }
  | {
      readonly _tag: "signOut";
      /** null is Clerk's sign-out of every session. */
      readonly sessionId: string | null;
      readonly ending: ReadonlyArray<ObservedClerkSession>;
      /** "stay" keeps the app where it is. "signedOut" is the normal signed-out destination. */
      readonly redirect: "stay" | "signedOut";
    };

export type ConnectSignOutPlan =
  | { readonly _tag: "blocked" }
  | { readonly _tag: "ready"; readonly steps: ReadonlyArray<SignOutStep> };

/**
 * Orders a sign-out around two clerk-js rules: `signOut({ sessionId })` ends
 * every session once one is left, and ending the current session clears the
 * active session and navigates. So while an account stays, it is made active
 * first and the leaving sessions end through the non-current path.
 */
export function planConnectSignOut(input: {
  readonly sessions: ReadonlyArray<SignOutSession>;
  readonly activeSessionId: string | null;
  readonly targets: SignOutTargets;
  readonly host: SignOutHost;
  /** Leaving accounts that need sign-in, so Clerk has no session to end for them. */
  readonly sessionless?: ReadonlyArray<string> | undefined;
  /** The host was already unpublished by this sign-out. */
  readonly unpublished?: boolean | undefined;
}): ConnectSignOutPlan {
  const { sessions, activeSessionId, targets, host } = input;
  const sessionless = input.sessionless ?? [];
  const unpublishes = host._tag !== "none" && input.unpublished !== true;
  const ending = sessions.filter(
    (session) => targets === "all" || targets.includes(session.accountId),
  );

  if (ending.length === 0 && sessionless.length === 0) {
    return { _tag: "ready", steps: [] };
  }
  const remaining = sessions
    .filter((session) => !ending.includes(session))
    .toSorted((left, right) => right.lastActiveAt - left.lastActiveAt);
  const observed = (session: SignOutSession): ObservedClerkSession => ({
    accountId: session.accountId,
    sessionId: session.sessionId,
  });
  const steps: SignOutStep[] = [];

  if (unpublishes) {
    const publisher = host._tag === "known" ? host.publishingAccountId : null;
    const publisherLeaves =
      publisher !== null &&
      (sessionless.includes(publisher) ||
        ending.some((session) => session.accountId === publisher));
    if (remaining.length === 0 && ending.length > 0) {
      // Nobody is left to own the host, so it is unpublished as it always was.
      const active = ending.find((session) => session.sessionId === activeSessionId) ?? ending[0]!;
      steps.push({ _tag: "unpublish", accountId: publisherLeaves ? publisher! : active.accountId });
    } else if (host._tag === "unknown") {
      return { _tag: "blocked" };
    } else if (publisherLeaves) {
      steps.push({ _tag: "unpublish", accountId: publisher! });
    }
  }

  if (ending.length === 0) {
    return { _tag: "ready", steps };
  }
  if (remaining.length === 0) {
    steps.push({
      _tag: "signOut",
      sessionId: ending.length === 1 ? ending[0]!.sessionId : null,
      ending: ending.map(observed),
      redirect: "signedOut",
    });
    return { _tag: "ready", steps };
  }
  if (!remaining.some((session) => session.sessionId === activeSessionId)) {
    steps.push({ _tag: "setActive", sessionId: remaining[0]!.sessionId });
  }
  for (const session of ending) {
    steps.push({
      _tag: "signOut",
      sessionId: session.sessionId,
      ending: [observed(session)],
      redirect: "stay",
    });
  }
  return { _tag: "ready", steps };
}

/** Signing out of all accounts is a second action only where several can be signed in. */
export function canSignOutAllAccounts(input: {
  readonly signedInAccountIds: ReadonlyArray<string>;
}): boolean {
  return new Set(input.signedInAccountIds).size > 1;
}

export interface SignOutClerk {
  readonly session?: { readonly id: string } | null | undefined;
  readonly client?:
    | {
        readonly signedInSessions: ReadonlyArray<{
          readonly id: string;
          readonly lastActiveAt?: Date | null;
          readonly user: { readonly id: string } | null;
        }>;
      }
    | null
    | undefined;
  readonly setActive: (params: { session: string }) => Promise<unknown>;
  readonly signOut: (options?: {
    readonly sessionId?: string;
    readonly redirectUrl?: string;
  }) => Promise<unknown>;
}

export function readSignOutSessions(clerk: SignOutClerk): ReadonlyArray<SignOutSession> {
  return (clerk.client?.signedInSessions ?? []).flatMap((session) =>
    session.user
      ? [
          {
            accountId: session.user.id,
            sessionId: session.id,
            lastActiveAt: session.lastActiveAt?.getTime() ?? 0,
          },
        ]
      : [],
  );
}

export const SIGN_OUT_HOST_NOT_READY_MESSAGE =
  "This computer is not ready for Connect cleanup. Retry before signing out.";
export const SIGN_OUT_ACCOUNT_LOADING_MESSAGE =
  "Your signed-in account is still loading. Please retry.";

/**
 * Runs the plan one Clerk step at a time and plans again after each, since
 * Clerk's own UI or another tab can change the sessions in between. Only the
 * sessions a step ends are marked, and a session that outlives its step, or a
 * step that fails, loses its mark again.
 */
export async function runConnectSignOut(input: {
  readonly clerk: SignOutClerk;
  readonly targets: SignOutTargets;
  readonly host: SignOutHost;
  readonly sessionless?: ReadonlyArray<string> | undefined;
  /** Rejects when the host could not be unpublished, which stops the sign-out. */
  readonly unpublish: (accountId: string) => Promise<void>;
  /** Called for each session-less account once the host no longer needs unpublishing. */
  readonly removeSessionless?: ((accountId: string) => void) | undefined;
  readonly stayUrl: string;
  readonly signedOutUrl?: string | undefined;
  /**
   * Runs the Clerk steps as one turn, so nothing else moves the active session
   * between making a staying account active and ending the leaving sessions.
   */
  readonly clerkTurn?: ((steps: () => Promise<void>) => Promise<void>) | undefined;
}): Promise<void> {
  const { clerk } = input;
  let unpublished = false;
  let sessionless = input.sessionless ?? [];
  let count = 0;
  const signedInIds = () => readSignOutSessions(clerk).map((session) => session.sessionId);
  // Every step ends a session or moves the active one, so this many always suffice.
  const maxSteps = readSignOutSessions(clerk).length * 2 + 2;
  /** Resolves false at the first Clerk step when `inTurn` is false, so the turn can start there. */
  const runSteps = async (inTurn: boolean): Promise<boolean> => {
    for (; count < maxSteps; count += 1) {
      const finished = await runStep(inTurn);
      if (finished !== null) return finished;
    }
    throw new Error("Could not complete sign out. Please retry.");
  };
  const runStep = async (inTurn: boolean): Promise<boolean | null> => {
    const plan = planConnectSignOut({
      sessions: readSignOutSessions(clerk),
      activeSessionId: clerk.session?.id ?? null,
      targets: input.targets,
      host: input.host,
      sessionless,
      unpublished,
    });
    if (plan._tag === "blocked") {
      throw new Error(SIGN_OUT_HOST_NOT_READY_MESSAGE);
    }
    const step = plan.steps[0];
    if (
      count === 0 &&
      step === undefined &&
      sessionless.length === 0 &&
      input.host._tag !== "none"
    ) {
      throw new Error(SIGN_OUT_ACCOUNT_LOADING_MESSAGE);
    }
    if (step?._tag === "unpublish") {
      await input.unpublish(step.accountId);
      unpublished = true;
      return null;
    }
    if (!inTurn) {
      return false;
    }
    // Their data goes only now, so a failed unpublish leaves them as they were.
    for (const accountId of sessionless) {
      input.removeSessionless?.(accountId);
    }
    sessionless = [];
    if (step === undefined) {
      return true;
    }
    if (step._tag === "setActive") {
      await clerk.setActive({ session: step.sessionId });
      return null;
    }
    const endingIds = step.ending.map((mark) => mark.sessionId);
    const redirectUrl = step.redirect === "stay" ? input.stayUrl : input.signedOutUrl;
    markConnectSignOutStarted(step.ending);
    try {
      await clerk.signOut({
        ...(step.sessionId === null ? {} : { sessionId: step.sessionId }),
        ...(redirectUrl ? { redirectUrl } : {}),
      });
    } catch (cause) {
      clearConnectSignOutStarted(endingIds);
      throw cause;
    }
    const outlived = signedInIds().filter((sessionId) => endingIds.includes(sessionId));
    if (outlived.length > 0) {
      clearConnectSignOutStarted(outlived);
      throw new Error("Could not complete sign out. Please retry.");
    }
    return null;
  };
  if (!(await runSteps(false))) {
    await (input.clerkTurn ?? ((steps) => steps()))(async () => {
      await runSteps(true);
    });
  }
}

const SIGN_OUT_BROWSER_COPY =
  "This signs out this client. Your published computers will stay available to your other devices.";
const SIGN_OUT_UNPUBLISH_COPY =
  "Signing out will unpublish this computer from Connect and stop its notifications and Live Activities. Other devices will lose remote access. Your local projects and conversations stay on this computer.";
const SIGN_OUT_STAYS_PUBLISHED_COPY =
  "This signs out this account on this computer. This computer stays published to Connect. Your local projects and conversations stay on this computer.";

/** The dialog names accounts only once more than one is known. */
export function signOutDialogCopy(input: {
  readonly knownAccountCount: number;
  readonly targets: SignOutTargets;
  readonly email: string | null;
  readonly localHost: boolean;
  /** The sign-out unpublishes this computer, or cannot tell yet. */
  readonly unpublishes: boolean;
}): { readonly title: string; readonly description: string } {
  const several = input.knownAccountCount > 1;
  return {
    title: !several
      ? "Sign out of Lecturn?"
      : input.targets === "all"
        ? "Sign out of all accounts?"
        : input.email
          ? `Sign out ${input.email}?`
          : "Sign out of Lecturn?",
    description: !input.localHost
      ? SIGN_OUT_BROWSER_COPY
      : !several || input.unpublishes
        ? SIGN_OUT_UNPUBLISH_COPY
        : SIGN_OUT_STAYS_PUBLISHED_COPY,
  };
}
