import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

export const KNOWN_ACCOUNTS_STORAGE_KEY = "lecturn:accounts:v1";

/** A sign-out that has not ended its session by then is taken not to have happened. */
export const SIGN_OUT_MARK_MAX_AGE_MS = 5 * 60 * 1_000;

/** One Clerk session that a sign-out started in Lecturn is ending. */
const SignOutMark = Schema.Struct({
  accountId: Schema.String,
  sessionId: Schema.String,
  startedAt: Schema.Number,
});
type SignOutMark = typeof SignOutMark.Type;

export const KnownAccountsDocument = Schema.Struct({
  accountIds: Schema.Array(Schema.String),
  signingOut: Schema.optional(Schema.Array(SignOutMark)),
});
export type KnownAccountsDocument = typeof KnownAccountsDocument.Type;

export interface KnownConnectAccounts {
  readonly accountIds: ReadonlyArray<string>;
  /** Known accounts without a signed-in session. Their relay targets stay disconnected. */
  readonly needsSignIn: ReadonlyArray<string>;
  /** False until Clerk's sessions were first applied, so restored sessions are not news. */
  readonly synced: boolean;
}

// Marks also live here, so they hold for this page when storage does not.
const marksThisPage = new Map<string, SignOutMark>();
// Accounts whose sign-out was seen to finish. They keep leaving while cleanup is retried.
const leavingThisPage = new Set<string>();

function readDocument(): KnownAccountsDocument | null {
  try {
    return getLocalStorageItem(KNOWN_ACCOUNTS_STORAGE_KEY, KnownAccountsDocument);
  } catch {
    return null;
  }
}

/**
 * Writes against the document as it is now, never an earlier read, so another
 * tab's marks and accounts are not written over. Without a list another tab can
 * see there is nothing to add marks to.
 */
function store(change: {
  readonly accountIds?: ReadonlyArray<string>;
  readonly marks?: (marks: ReadonlyArray<SignOutMark>) => ReadonlyArray<SignOutMark>;
}): void {
  const current = readDocument();
  const accountIds = change.accountIds ?? current?.accountIds;
  if (accountIds === undefined) {
    return;
  }
  const marks = current?.signingOut ?? [];
  try {
    setLocalStorageItem(
      KNOWN_ACCOUNTS_STORAGE_KEY,
      { accountIds, signingOut: change.marks ? change.marks(marks) : marks },
      KnownAccountsDocument,
    );
  } catch {
    // Without storage the list lasts for this page only.
  }
}

/**
 * Connect accounts this client holds data for. An account is known from its
 * first sign-in until a sign-out started in Lecturn. A known account without a
 * signed-in session needs sign-in, and keeps its environments and local data
 * meanwhile.
 */
export const knownConnectAccountsAtom = Atom.make<KnownConnectAccounts>({
  accountIds: readDocument()?.accountIds ?? [],
  needsSignIn: [],
  synced: false,
}).pipe(Atom.keepAlive, Atom.withLabel("connect:known-accounts"));

export interface ObservedClerkSession {
  readonly accountId: string;
  readonly sessionId: string;
}

/**
 * Applies the signed-in accounts to the known list. Only a sign-out started in
 * Lecturn makes an account leave: a session that merely disappeared (expiry,
 * cookie loss, an empty client, a 401 refetch) keeps it known. Leaving accounts
 * stay in `known` until their cleanup succeeds and `forgetKnownAccount` drops them.
 *
 * A single-account client passes the account it is about to serve as
 * `soleAccountId`. Every other account then leaves, and a new sole account only
 * becomes known once they are gone, so the last of them takes the untagged
 * environments along as it did before accounts were kept.
 */
export function reconcileKnownAccounts(input: {
  readonly known: ReadonlyArray<string>;
  readonly signedIn: ReadonlyArray<string>;
  readonly signingOut: ReadonlyArray<string>;
  readonly soleAccountId?: string | null | undefined;
}): { readonly known: ReadonlyArray<string>; readonly leaving: ReadonlyArray<string> } {
  const sole = input.soleAccountId ?? null;
  const known = [...new Set([...input.known, ...input.signedIn])];
  const leaving = known.filter(
    (accountId) =>
      !input.signedIn.includes(accountId) &&
      (input.signingOut.includes(accountId) || (sole !== null && accountId !== sole)),
  );
  return {
    known:
      leaving.length > 0 && sole !== null && !input.known.includes(sole)
        ? known.filter((accountId) => accountId !== sole)
        : known,
    leaving,
  };
}

/** Records Clerk's signed-in sessions and returns the accounts that have to be cleaned up. */
export function observeClerkSessions(
  registry: AtomRegistry.AtomRegistry,
  sessions: ReadonlyArray<ObservedClerkSession>,
  options: {
    readonly soleAccountId?: string | null | undefined;
    /** Account served before this list existed. It is known even though no list says so. */
    readonly previouslyServed?: string | null | undefined;
  } = {},
): { readonly known: ReadonlyArray<string>; readonly leaving: ReadonlyArray<string> } {
  const inMemory = registry.get(knownConnectAccountsAtom);
  const document = readDocument();
  const signedIn = [...new Set(sessions.map((session) => session.accountId))];
  const now = Date.now();
  const marks = [
    ...new Map(
      [...(document?.signingOut ?? []), ...marksThisPage.values()].map((mark) => [
        mark.sessionId,
        mark,
      ]),
    ).values(),
  ];
  // A mark counts while its own session is what the sign-out is ending. It is
  // void once it is old, once the account signed in again under another
  // session, or when a reload finds the account still signed in.
  const voided = marks.filter(
    (mark) =>
      now - mark.startedAt >= SIGN_OUT_MARK_MAX_AGE_MS ||
      (signedIn.includes(mark.accountId) &&
        (!inMemory.synced || !sessions.some((session) => session.sessionId === mark.sessionId))),
  );
  if (voided.length > 0) {
    clearConnectSignOutStarted(voided.map((mark) => mark.sessionId));
  }
  for (const accountId of signedIn) {
    leavingThisPage.delete(accountId);
  }
  for (const mark of marks) {
    if (!voided.includes(mark) && !signedIn.includes(mark.accountId)) {
      leavingThisPage.add(mark.accountId);
    }
  }
  const result = reconcileKnownAccounts({
    known: [
      ...inMemory.accountIds,
      ...(document?.accountIds ?? []),
      ...(document === null && options.previouslyServed ? [options.previouslyServed] : []),
    ],
    signedIn,
    signingOut: [
      ...leavingThisPage,
      // Another tab that finished a sign-out has already dropped the account.
      ...(document === null
        ? []
        : inMemory.accountIds.filter((accountId) => !document.accountIds.includes(accountId))),
    ],
    soleAccountId: options.soleAccountId,
  });
  commit(registry, result.known, signedIn);
  return result;
}

const sameList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => right[index] === value);

function commit(
  registry: AtomRegistry.AtomRegistry,
  accountIds: ReadonlyArray<string>,
  signedIn: ReadonlyArray<string>,
): void {
  const current = registry.get(knownConnectAccountsAtom);
  const needsSignIn = accountIds.filter((accountId) => !signedIn.includes(accountId));
  if (
    !current.synced ||
    !sameList(current.accountIds, accountIds) ||
    !sameList(current.needsSignIn, needsSignIn)
  ) {
    registry.set(knownConnectAccountsAtom, { accountIds, needsSignIn, synced: true });
  }
  store({ accountIds });
}

/** Drops an account whose data was removed. */
export function forgetKnownAccount(registry: AtomRegistry.AtomRegistry, accountId: string): void {
  const current = registry.get(knownConnectAccountsAtom);
  leavingThisPage.delete(accountId);
  for (const mark of marksThisPage.values()) {
    if (mark.accountId === accountId) marksThisPage.delete(mark.sessionId);
  }
  registry.set(knownConnectAccountsAtom, {
    ...current,
    accountIds: current.accountIds.filter((id) => id !== accountId),
    needsSignIn: current.needsSignIn.filter((id) => id !== accountId),
  });
  store({
    accountIds: (readDocument()?.accountIds ?? current.accountIds).filter((id) => id !== accountId),
    marks: (marks) => marks.filter((mark) => mark.accountId !== accountId),
  });
}

/** Call with the sessions a sign-out is about to end, so their accounts' data is removed afterwards. */
export function markConnectSignOutStarted(sessions: ReadonlyArray<ObservedClerkSession>): void {
  const startedAt = Date.now();
  const added = sessions.map((session) => ({ ...session, startedAt }));
  for (const mark of added) {
    marksThisPage.set(mark.sessionId, mark);
  }
  store({
    marks: (marks) => [
      ...marks.filter((mark) => !added.some((next) => next.sessionId === mark.sessionId)),
      ...added,
    ],
  });
}

/** The sign-out of these sessions did not happen. */
export function clearConnectSignOutStarted(sessionIds: ReadonlyArray<string>): void {
  for (const sessionId of sessionIds) {
    marksThisPage.delete(sessionId);
  }
  store({ marks: (marks) => marks.filter((mark) => !sessionIds.includes(mark.sessionId)) });
}

/** Accounts that became known since `previous`. Restored sessions on a cold load are not new. */
export function newlyKnownAccounts(
  previous: KnownConnectAccounts,
  next: KnownConnectAccounts,
): ReadonlyArray<string> {
  return previous.synced
    ? next.accountIds.filter((accountId) => !previous.accountIds.includes(accountId))
    : [];
}
