import type { useClerk } from "@clerk/expo";
import { runtime } from "../../lib/runtime";
import { accountTokenReader } from "./accountTokenReaders";
import { syncAccountPushProviders, unregisterAccountPush } from "./accountPushRegistration";
import {
  cancelConnectAccountRemoval,
  markConnectAccountRemoval,
  notifyConnectAccountRemoval,
} from "./knownAccountStorage";

type Clerk = ReturnType<typeof useClerk>;
/** Unregister while its credential still exists, then end only this account's sessions. */
export async function signOutMobileConnectAccount(
  clerk: Clerk,
  accountId: string,
): Promise<{ readonly unregisterFailed: boolean }> {
  let unregisterFailed = false;
  try {
    await runtime.runPromise(unregisterAccountPush(accountId, accountTokenReader(accountId)));
  } catch {
    unregisterFailed = true;
  }
  try {
    const targets =
      clerk.client?.signedInSessions.filter((session) => session.user?.id === accountId) ?? [];
    const remaining = clerk.client?.signedInSessions.find(
      (session) => session.user?.id !== accountId,
    );
    if (remaining && clerk.session?.user?.id === accountId)
      await clerk.setActive({ session: remaining.id });
    await markConnectAccountRemoval(accountId);
    for (const session of targets) await clerk.signOut({ sessionId: session.id });
    notifyConnectAccountRemoval();
  } catch (error) {
    await cancelConnectAccountRemoval(accountId);
    syncAccountPushProviders(
      new Map(
        (clerk.client?.signedInSessions ?? []).flatMap((session) =>
          session.user ? [[session.user.id, accountTokenReader(session.user.id)] as const] : [],
        ),
      ),
      clerk.session?.user?.id ?? null,
    );
    throw error;
  }
  return { unregisterFailed };
}
