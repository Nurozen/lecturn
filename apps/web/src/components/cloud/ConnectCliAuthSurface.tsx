import { useAuth, useClerk, useUser } from "@clerk/react";
import { encodeConnectAuthCode, readConnectAuthorizeRequest } from "@lecturn/shared/connectAuth";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
  decideConnectCliAuthorizeStep,
  forgetConnectCliAuthAccount,
  leaveForConnectCliAuthorize,
  nameConnectCliAuthorizedAccount,
  readConnectCliAuthAccount,
  readConnectCliAuthState,
  readConnectCliCallbackResult,
  rememberConnectCliAuthState,
} from "../../cloud/connectCliAuth";
import { withActiveAccount } from "../../cloud/withActiveAccount";
import { openConnectSignIn } from "../../cloud/connectAuthCompatibility";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
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
 * /connect: the URL the CLI prints for both flows. Waits for a Clerk session,
 * then forwards the CLI's PKCE request to Clerk's authorize endpoint — with a
 * loopback redirect URI when the request carries a port, so the code returns
 * straight to the waiting CLI, and the hosted callback page otherwise.
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
    // Clerk redirects to the authorize endpoint itself once sign-in completes,
    // so the callback's state check has to be armed before handing off.
    rememberConnectCliAuthState(request.state);
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
      state: request.state,
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
        eyebrow={
          request.loopbackPort === undefined
            ? "Step 1 of 2 · Browser authorization"
            : "Browser authorization"
        }
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

/**
 * /connect/callback: Clerk's redirect target. Shows the one-time code the
 * user enters in the waiting terminal.
 */
export function ConnectCliCallbackSurface() {
  const [result] = useState(readConnectCliCallbackResult);
  const [expectedState] = useState(readConnectCliAuthState);
  const [chosenAccountId] = useState(() =>
    result ? readConnectCliAuthAccount(result.state) : null,
  );
  useEffect(() => {
    forgetConnectCliAuthAccount();
  }, []);
  const { user } = useUser();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "authentication code" });

  if (!result) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage
          eyebrow="Step 2 of 2 · Terminal handoff"
          title="Authorization did not complete"
          description="No authorization code was returned. Re-run `lecturn connect` in your terminal and try again."
        />
      </AuthSurfaceShell>
    );
  }

  // Fail closed: the legitimate callback always lands in the same browser
  // that visited /connect (which recorded the state), so a missing or
  // mismatched state means this page was reached some other way — the CSRF
  // shape the state parameter exists to stop. Refuse to display a code.
  if (expectedState === null || expectedState !== result.state) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage
          eyebrow="Step 2 of 2 · Terminal handoff"
          title="This code belongs to a different request"
          description="This authorization response does not match a connect request started in this browser. Re-run `lecturn connect` in your terminal and open the freshly printed URL in this browser."
        />
      </AuthSurfaceShell>
    );
  }

  const authorized = nameConnectCliAuthorizedAccount({
    chosenAccountId,
    user: user
      ? { id: user.id, label: user.primaryEmailAddress?.emailAddress ?? user.username ?? null }
      : null,
  });
  const accountLabel = authorized.label;
  const authCode = encodeConnectAuthCode(result);

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow="Step 2 of 2 · Terminal handoff"
        title="Almost connected"
        description={
          accountLabel
            ? `Enter this code in your waiting terminal to connect it as ${accountLabel}.`
            : "Enter this code in your waiting terminal to finish connecting."
        }
      />

      {authorized.differsFromChoice ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          This is not the account you chose. Re-run `lecturn connect` to use another account.
        </p>
      ) : null}

      <div className="mt-6 overflow-hidden rounded-xl border border-border/80 bg-background/65">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            One-time authorization code
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">expires shortly</span>
        </div>
        <code
          className="block p-4 font-mono text-sm leading-relaxed break-all select-all"
          data-testid="connect-auth-code"
        >
          {authCode}
        </code>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button type="button" onClick={() => copyToClipboard(authCode)}>
          {isCopied ? "Copied!" : "Copy authorization code"}
        </Button>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        Only enter this code in a terminal session you started yourself. Anyone holding it can link
        their machine to your Lecturn Connect account while it is valid.
      </p>
    </AuthSurfaceShell>
  );
}
