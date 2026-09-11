import { useAuth, useClerk } from "@clerk/react";
import { useRef, useState } from "react";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";

import { unpublishBeforeSignOut } from "../../cloud/linkEnvironmentAtoms";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";

export function useConnectSignOut(redirectUrl?: string) {
  const clerk = useClerk();
  const { getToken, userId } = useAuth();
  const link = usePrimaryCloudLinkState();
  const unpublish = useAtomCommand(unpublishBeforeSignOut, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  // A browser may be controlling someone else's remote server. Only the
  // desktop shell owns the local host that signing out should unpublish.
  const localHost = Boolean(window.desktopBridge);
  const confirm = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (localHost) {
        if (!link.target)
          throw new Error(
            "This computer is not ready for Connect cleanup. Retry before signing out.",
          );
        if (!userId) throw new Error("Your signed-in account is still loading. Please retry.");
        const clerkToken = await getToken(resolveRelayClerkTokenOptions()).catch(() => null);
        const result = await unpublish({ target: link.target, clerkToken, userId });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        link.refresh();
      }
      await clerk.signOut(redirectUrl ? { redirectUrl } : undefined);
      setOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not complete sign out. Please retry.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return {
    requestSignOut: () => {
      setError(null);
      setOpen(true);
    },
    signOutDialog: (
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy.current) setOpen(next);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of Lecturn?</AlertDialogTitle>
            <AlertDialogDescription>
              {localHost
                ? "Signing out will unpublish this computer from Connect and stop its notifications and Live Activities. Other devices will lose remote access. Your local projects and conversations stay on this computer."
                : "This signs out this client. Your published computers will stay available to your other devices."}
            </AlertDialogDescription>
            {localHost && link.data?.linked && link.data.cloudUserId !== userId ? (
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
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
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
