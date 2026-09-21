import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { LogOutIcon } from "lucide-react";

import type { SignedOutEnvironment } from "../../cloud/accountGone";
import { knownConnectAccountsAtom } from "../../cloud/knownAccounts";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { addAccountBlockedReason } from "./ConnectAccountMenu.logic";
import { useConnectSignIn } from "./useConnectSignIn";

/**
 * Stands in for a thread whose environment left with a signed-out Connect
 * account. Loaded lazily, so a client without Lecturn Connect never downloads
 * Clerk for it.
 */
export default function AccountGoneNotice({ account }: { readonly account: SignedOutEnvironment }) {
  const navigate = useNavigate();
  const { gate, authPrompt, addAccount } = useConnectSignIn();
  // The account is no longer known here, so signing in again adds it back.
  const known = useAtomValue(knownConnectAccountsAtom);
  const blocked = addAccountBlockedReason({ gate, knownAccountCount: known.accountIds.length });
  return (
    <Empty className="h-full">
      {authPrompt}
      <EmptyMedia variant="icon">
        <LogOutIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>This account was signed out</EmptyTitle>
        <EmptyDescription>
          {account.email ?? "The Lecturn Connect account"} was signed out, so this thread's
          environment is no longer connected here. Sign in again to reconnect it.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        {blocked === null ? (
          <Button onClick={addAccount}>Sign in again</Button>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                // Stays focusable and hoverable so the reason can be read.
                <Button aria-disabled="true" className="cursor-not-allowed opacity-64" />
              }
            >
              Sign in again
              <span className="sr-only">{blocked}</span>
            </TooltipTrigger>
            <TooltipPopup className="max-w-64">{blocked}</TooltipPopup>
          </Tooltip>
        )}
        <Button variant="outline" onClick={() => void navigate({ to: "/", replace: true })}>
          Go to threads
        </Button>
      </EmptyContent>
    </Empty>
  );
}
