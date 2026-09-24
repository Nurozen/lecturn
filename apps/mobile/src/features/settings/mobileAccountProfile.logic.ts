export interface MobileProfileClerk {
  readonly session?: { readonly id: string; readonly user: { readonly id: string } | null } | null;
  readonly client?: {
    readonly signedInSessions: ReadonlyArray<{
      readonly id: string;
      readonly user: { readonly id: string } | null;
    }>;
  };
  readonly setActive: (input: { session: string }) => Promise<unknown>;
}
/** Native Clerk profile writes target the active session, so verify it before opening. */
export async function selectMobileProfileAccount(
  clerk: MobileProfileClerk,
  accountId: string,
): Promise<void> {
  const session = clerk.client?.signedInSessions.find((entry) => entry.user?.id === accountId);
  if (!session) throw new Error("Sign in to this account before managing its profile.");
  if (clerk.session?.id !== session.id) await clerk.setActive({ session: session.id });
  if (clerk.session?.id !== session.id || clerk.session.user?.id !== accountId)
    throw new Error("Could not switch to the selected account. Try again.");
}
export function mobileProfileOwnerMatches(
  accountId: string,
  renderedAccountId: string | null | undefined,
  sessionAccountId: string | null | undefined,
): boolean {
  return renderedAccountId === accountId && sessionAccountId === accountId;
}
