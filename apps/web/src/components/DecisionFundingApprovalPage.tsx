import { UserButton, useAuth, useClerk, useUser } from "@clerk/react";
import type { DecisionFundingApprovalInfo } from "@lecturn/contracts";
import { useEffect, useState } from "react";
import { decisionFundingApprovalClient } from "../cloud/decisionFundingApproval";
import { openConnectSignIn } from "../cloud/connectAuthCompatibility";
import { resolveClerkSignInProps } from "./clerk/authRedirect";
import { AuthSurfaceShell } from "./auth/AuthSurfaceShell";
import { Button } from "./ui/button";

type ApprovalState = {
  readonly key: string;
  readonly info?: DecisionFundingApprovalInfo;
  readonly error?: string | undefined;
  readonly approving?: boolean;
  readonly approved?: boolean;
};

export function DecisionFundingApprovalPage({ challengeId }: { readonly challengeId: string }) {
  const { isLoaded, userId } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const key = `${userId ?? ""}:${challengeId}`;
  const [state, setState] = useState<ApprovalState>({ key });
  const [revision, setRevision] = useState(0);
  const visible = state.key === key ? state : { key };
  useEffect(() => {
    if (!userId || !challengeId) return;
    const controller = new AbortController();
    // A manual refresh starts a new request even when the account and challenge are unchanged.
    void revision;
    void decisionFundingApprovalClient()
      .info(userId, challengeId, controller.signal)
      .then(
        (info) => {
          if (!controller.signal.aborted) setState({ key, info, approved: info.approved });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({
              key,
              error: error instanceof Error ? error.message : "Could not load this request.",
            });
        },
      );
    return () => controller.abort();
  }, [userId, challengeId, key, revision]);
  const approve = async () => {
    if (!userId || !visible.info?.eligible || visible.approving || visible.approved) return;
    setState({ ...visible, approving: true, error: undefined });
    try {
      const result = await decisionFundingApprovalClient().approve(userId, challengeId);
      setState((current) =>
        current.key === key ? { ...visible, approved: result.approved } : current,
      );
    } catch (error) {
      setState((current) =>
        current.key === key
          ? {
              ...visible,
              error: error instanceof Error ? error.message : "Could not approve this request.",
            }
          : current,
      );
    }
  };
  return (
    <AuthSurfaceShell>
      <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Decisions
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Approve membership access</h1>
      {!challengeId ? (
        <p className="mt-4 text-sm">This link is incomplete. Start a new request in Lecturn.</p>
      ) : !isLoaded ? (
        <p className="mt-4 text-sm" role="status">
          Loading your account…
        </p>
      ) : !userId ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Sign in with the membership you want to use for Decisions.
          </p>
          <Button
            onClick={() =>
              openConnectSignIn(clerk, resolveClerkSignInProps(window.location.href, false))
            }
          >
            Sign in
          </Button>
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <UserButton />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Approving with</p>
              <p className="break-all text-sm font-medium">
                {user?.primaryEmailAddress?.emailAddress ??
                  user?.fullName ??
                  "Your signed-in account"}
              </p>
            </div>
          </div>
          {visible.approved ? (
            <p className="text-sm" role="status">
              Approved. Return to Lecturn to finish connecting.
            </p>
          ) : visible.info ? (
            <>
              <div>
                <p className="text-sm">
                  Allow <strong>{visible.info.environmentLabel || "this Lecturn host"}</strong> to
                  use your membership’s Decisions allowance.
                </p>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  Host: {visible.info.environmentId}
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                People with permission to operate this host can enable Decisions for its projects
                and use this allowance. Chat excerpts are sent through Lecturn to TypeSafe to find
                decisions. Each thread’s signed-in agent writes the notes. You can revoke this
                host’s access later.
              </p>
              {visible.info.eligible ? (
                <Button disabled={visible.approving} onClick={() => void approve()}>
                  {visible.approving ? "Approving…" : "Approve Decisions"}
                </Button>
              ) : (
                <p className="text-sm">
                  This account does not currently have Decisions access.{" "}
                  <a className="underline underline-offset-4" href="/account/billing">
                    Manage membership
                  </a>
                </p>
              )}
            </>
          ) : !visible.error ? (
            <p className="text-sm" role="status">
              Loading request…
            </p>
          ) : null}
          {visible.error ? (
            <div className="space-y-3">
              <p className="text-sm text-destructive" role="alert">
                {visible.error}
              </p>
              {!visible.approving ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setState({ key });
                    setRevision((value) => value + 1);
                  }}
                >
                  Reload request
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <a
        className="mt-6 inline-block text-sm text-muted-foreground underline underline-offset-4"
        href="/"
      >
        Back to Lecturn
      </a>
    </AuthSurfaceShell>
  );
}
