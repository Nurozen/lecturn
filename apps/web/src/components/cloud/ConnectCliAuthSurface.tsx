import { useAuth, useClerk } from "@clerk/react";
import { readConnectAuthorizeRequest } from "@lecturn/shared/connectAuth";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
  decideConnectCliAuthorizeStep,
  leaveForConnectCliAuthorize,
} from "../../cloud/connectCliAuth";
import { withActiveAccount } from "../../cloud/withActiveAccount";
import { openConnectSignIn } from "../../cloud/connectAuthCompatibility";
import { isElectron } from "../../env";
import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import {
  useConnectAccountPicker,
  useKnownAccountsToChooseFrom,
} from "../clerk/ConnectAccountPicker";
import { Button } from "../ui/button";

function ConnectCliAuthMessage({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <>
      {eyebrow ? (
        <p className="text-[10px] font-semibold tracking-[0.18em] text-blue-600 uppercase dark:text-blue-400">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

const invalidLinkMessage = {
  eyebrow: "Authorization request",
  title: "This connect link is incomplete",
  description:
    "The link is missing its authorization request. Re-run `lecturn connect` in your terminal and open the freshly printed URL.",
} as const;

/**
 * /connect: the URL the CLI prints for the loopback flow. Waits for a Clerk
 * session, then forwards the CLI's PKCE request to Clerk's authorize endpoint
 * with the loopback redirect URI so the code returns straight to the waiting
 * CLI. Headless hosts use Clerk's device authorization page instead.
 */
export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const signInOpened = useRef(false);
  const redirecting = useRef(false);
  const known = useKnownAccountsToChooseFrom();
  const account = useConnectAccountPicker("cli-authorize", { label: "Authorize as" });
  const [confirmedAccountId, setConfirmedAccountId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const step = decideConnectCliAuthorizeStep({
    isLoaded,
    isSignedIn: Boolean(isSignedIn),
    knownAccountIds: known.accountIds,
    knownAccountsSynced: known.synced,
    confirmedAccountId,
  });
  const stepTag = step._tag;
  const redirectAccountId = step._tag === "redirect" ? step.accountId : null;

  const openSignIn = useCallback(() => {
    if (!request) {
      return;
    }
    openConnectSignIn(
      clerk,
      resolveClerkSignInProps(
        connectCliSignInRedirectUrl(request, window.location.href),
        isElectron,
      ),
    );
  }, [clerk, request]);

  useEffect(() => {
    if (!request || redirecting.current) {
      return;
    }
    if (stepTag === "sign-in") {
      if (!signInOpened.current) {
        signInOpened.current = true;
        openSignIn();
      }
      return;
    }
    if (stepTag !== "redirect") {
      return;
    }
    const authorizeUrl = buildConnectCliClerkAuthorizeUrl(request);
    if (!authorizeUrl) {
      return;
    }
    redirecting.current = true;
    // Clerk authorizes its active account, so the chosen one is made active first.
    void leaveForConnectCliAuthorize({
      accountId: redirectAccountId,
      asAccount: withActiveAccount,
      navigate: () => window.location.assign(authorizeUrl),
    }).catch((cause: unknown) => {
      redirecting.current = false;
      setConfirmedAccountId(null);
      setSwitchError(cause instanceof Error ? cause.message : "Could not switch accounts.");
    });
  }, [openSignIn, redirectAccountId, request, stepTag]);

  if (!request) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage {...invalidLinkMessage} />
      </AuthSurfaceShell>
    );
  }

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow="Browser authorization"
        title="Connecting your terminal"
        description={
          stepTag === "choose"
            ? "Choose the Lecturn Connect account your terminal connects as."
            : isSignedIn
              ? "Redirecting to authorize Lecturn Connect for your CLI…"
              : "Sign in to continue authorizing Lecturn Connect for your CLI."
        }
      />
      {stepTag === "choose" ? (
        <div className="mt-6 space-y-4">
          {account.picker}
          {switchError ? (
            <p role="alert" className="text-sm text-destructive">
              {switchError}
            </p>
          ) : null}
          <Button
            type="button"
            disabled={account.accountId == null}
            onClick={() => {
              setSwitchError(null);
              setConfirmedAccountId(account.accountId ?? null);
            }}
          >
            {account.email ? `Continue as ${account.email}` : "Continue"}
          </Button>
        </div>
      ) : null}
      {isLoaded && !isSignedIn ? (
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
            Sign in
          </Button>
        </div>
      ) : null}
    </AuthSurfaceShell>
  );
}
