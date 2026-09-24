import { readAccountAppearance } from "@lecturn/shared/accountTint";
export interface MobileConnectAccount {
  readonly accountId: string;
  readonly email: string;
  readonly label: string;
  readonly preset: string;
  readonly signedIn: boolean;
}
export interface MobileAccountSession {
  readonly status: string;
  readonly user: {
    readonly id: string;
    readonly primaryEmailAddress?: { readonly emailAddress: string } | null;
    readonly unsafeMetadata?: unknown;
  } | null;
}
/** Missing and expired sessions keep their catalog and drafts. Only removal is destructive. */
export function reconcileMobileAccounts(
  known: ReadonlyArray<MobileConnectAccount>,
  sessions: ReadonlyArray<MobileAccountSession>,
): ReadonlyArray<MobileConnectAccount> {
  const active = sessions.filter((session) => session.status === "active" && session.user);
  const next = known.map((account) => ({ ...account, signedIn: false }));
  for (const session of active) {
    const user = session.user!;
    const old = next.findIndex((account) => account.accountId === user.id);
    const email = user.primaryEmailAddress?.emailAddress ?? (old >= 0 ? next[old]!.email : "");
    const metadata =
      user.unsafeMetadata &&
      typeof user.unsafeMetadata === "object" &&
      "lecturn" in user.unsafeMetadata
        ? user.unsafeMetadata
        : old >= 0
          ? { lecturn: { label: next[old]!.label, preset: next[old]!.preset } }
          : user.unsafeMetadata;
    const appearance = readAccountAppearance(
      metadata,
      email,
      next.map((account) => account.preset),
    );
    const account = { accountId: user.id, email, ...appearance, signedIn: true };
    if (old < 0) next.push(account);
    else next[old] = account;
  }
  return next;
}
