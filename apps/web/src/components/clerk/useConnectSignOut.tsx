import { useAuth, useClerk } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";

import { unpublishBeforeSignOut } from "../../cloud/linkEnvironmentAtoms";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { readToken } from "../../cloud/accountTokens";
import { connectAccountProfilesAtom } from "../../cloud/connectAccounts";
import { knownConnectAccountsAtom, removeSignedOutKnownAccount } from "../../cloud/knownAccounts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { withActiveSessionTurn } from "../../cloud/withActiveAccount";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  SIGN_OUT_HOST_NOT_READY_MESSAGE,
  canSignOutAllAccounts,
  planConnectSignOut,
  readSignOutSessions,
  runConnectSignOut,
  signOutDialogCopy,
  type SignOutHost,
  type SignOutTargets,
} from "./useConnectSignOut.logic";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";

export function useConnectSignOut(redirectUrl?: string, accountId?: string) {
  const clerk = useClerk();
  const { userId } = useAuth();
  const link = usePrimaryCloudLinkState();
  const unpublish = useAtomCommand(unpublishBeforeSignOut, { reportFailure: false });
  // Set while the dialog is open: the accounts it signs out.
  const [targets, setTargets] = useState<SignOutTargets | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const close = () => setTargets(null);
  const request = (next: SignOutTargets | null) => {
    setError(null);
    setTargets(next);
  };
  const targetAccountId = accountId ?? userId ?? null;
  // A browser may be controlling someone else's remote server. Only the
  // desktop shell owns the local host that signing out should unpublish.
  const localHost = Boolean(window.desktopBridge);
  const host: SignOutHost = !localHost
    ? { _tag: "none" }
    : link.data
      ? { _tag: "known", publishingAccountId: link.data.linked ? link.data.cloudUserId : null }
      : { _tag: "unknown" };
  const signedInUsers = (clerk.client?.signedInSessions ?? []).flatMap((session) =>
    session.user ? [session.user] : [],
  );
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const known = useAtomValue(knownConnectAccountsAtom);
  // An account that needs sign-in has no session for Clerk to end.
  const sessionless =
    targets !== null
      ? known.needsSignIn.filter((id) => targets === "all" || targets.includes(id))
      : [];
  const emailOf = (id: string | null | undefined) =>
    signedInUsers.find((user) => user.id === id)?.primaryEmailAddress?.emailAddress ??
    (id ? profiles.get(id)?.email : undefined) ??
    null;
  const plan =
    targets === null
      ? null
      : planConnectSignOut({
          sessions: readSignOutSessions(clerk),
          activeSessionId: clerk.session?.id ?? null,
          targets,
          host,
          sessionless,
        });
  const unpublishStep =
    plan?._tag === "ready" ? plan.steps.find((step) => step._tag === "unpublish") : undefined;
  const copy = signOutDialogCopy({
    knownAccountCount: known.accountIds.length,
    targets: targets ?? "all",
    email: targets === null || targets === "all" ? null : emailOf(targets[0]),
    localHost,
    unpublishes: unpublishStep !== undefined || plan?._tag !== "ready",
  });
  const confirm = async () => {
    if (busy.current || targets === null) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await runConnectSignOut({
        clerk,
        targets,
        host,
        sessionless,
        removeSessionless: (id) => removeSignedOutKnownAccount(appAtomRegistry, id),
        unpublish: async (leavingAccountId) => {
          if (!link.target) throw new Error(SIGN_OUT_HOST_NOT_READY_MESSAGE);
          const clerkToken = await readToken(leavingAccountId).catch(() => null);
          const result = await unpublish({
            target: link.target,
            clerkToken,
            userId: leavingAccountId,
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          link.refresh();
        },
        stayUrl: window.location.href,
        signedOutUrl: redirectUrl,
        // A sign-out ends sessions over the network, so its turn gets longer than a switch.
        clerkTurn: (steps: () => Promise<void>) => withActiveSessionTurn(steps, 60_000),
      });
      setTargets(null);
    } catch (cause) {
      if (plan?._tag === "blocked") link.refresh();
      setError(
        cause instanceof Error ? cause.message : "Could not complete sign out. Please retry.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return {
    requestSignOut: () => request(targetAccountId === null ? "all" : [targetAccountId]),
    /** Asks to sign out one account, whichever this hook was made for. */
    requestSignOutAccount: (id: string) => request([id]),
    requestSignOutAll: () => request("all"),
    /** True with two or more accounts signed in, when signing out of all of them is a second action. */
    canSignOutAll: canSignOutAllAccounts({
      signedInAccountIds: signedInUsers.map((user) => user.id),
    }),
    signOutDialog: (
      <AlertDialog
        open={targets !== null}
        onOpenChange={(next) => {
          if (busy.current || next) return;
          close();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.description}</AlertDialogDescription>
            {unpublishStep && sessionless.includes(unpublishStep.accountId) ? (
              <p className="text-sm text-muted-foreground">
                This account needs sign-in, so Lecturn cannot remove its registration. Other devices
                may still list this computer as offline.
              </p>
            ) : unpublishStep &&
              link.data?.linked &&
              link.data.cloudUserId !== unpublishStep.accountId ? (
              <p className="text-sm text-muted-foreground">
                This computer is published to another account. Signing out will stop its local
                relay; the previous account may still list it as offline until its owner removes the
                registration.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void confirm()}>
              {pending ? "Signing out…" : error ? "Retry sign out" : "Sign out"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    ),
  };
}
