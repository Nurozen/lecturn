import { UserButton, useAuth, useClerk, useUser } from "@clerk/react";
import type { ExtensionFeatureId, ExtensionFundingApprovalInfo } from "@lecturn/contracts";
import { CheckIcon, LaptopIcon, SparklesIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { decisionFundingApprovalClient } from "../cloud/decisionFundingApproval";
import { extensionFundingApprovalClient } from "../cloud/extensionsFundingApproval";
import { openConnectSignIn } from "../cloud/connectAuthCompatibility";
import { resolveClerkSignInProps } from "./clerk/authRedirect";
import { useConnectAccountPicker } from "./clerk/ConnectAccountPicker";
import { AuthSurfaceShell } from "./auth/AuthSurfaceShell";
import { Button } from "./ui/button";
import { decisionFundingDenial } from "./DecisionFundingApprovalPage.logic";

type ApprovalInfo = Pick<
  ExtensionFundingApprovalInfo,
  "environmentLabel" | "environmentId" | "expiresAt" | "eligible" | "state"
> & { readonly reason?: ExtensionFundingApprovalInfo["reason"] };
type ApprovalState = {
  readonly key: string;
  readonly info?: ApprovalInfo;
  readonly error?: string | undefined;
  readonly approving?: boolean;
};

/** Old approval links continue through the Decisions compatibility endpoints. */
export function DecisionFundingApprovalPage({ challengeId }: { readonly challengeId: string }) {
  return <ExtensionsFundingApprovalPage challengeId={challengeId} featureId="decisions" legacy />;
}

export function ExtensionsFundingApprovalPage({
  challengeId,
  featureId,
  legacy = false,
}: {
  readonly challengeId: string;
  readonly featureId: ExtensionFeatureId;
  readonly legacy?: boolean;
}) {
  const { isLoaded, userId: activeAccountId } = useAuth();
  const account = useConnectAccountPicker("funding-approval", { label: "Membership account" });
  const userId = account.accountId === undefined ? activeAccountId : account.accountId;
  const { user } = useUser();
  const clerk = useClerk();
  const featureName = featureId === "contextual" ? "Contextual" : "Decisions";
  const [revision, setRevision] = useState(0);
  const key = `${userId ?? ""}:${featureId}:${challengeId}:${legacy}:${revision}`;
  const currentKey = useRef(key);
  useLayoutEffect(() => {
    currentKey.current = key;
  }, [key]);
  const [state, setState] = useState<ApprovalState>({ key });
  const visible = state.key === key ? state : { key };
  const info = visible.info;
  const denial = decisionFundingDenial(info?.reason, featureName);
  const terminal = info && ["expired", "revoked", "canceled"].includes(info.state);
  const approved = info?.state === "approved-awaiting-host";
  const linked = info?.state === "linked";
  const refresh = () => {
    setState({ key });
    setRevision((value) => value + 1);
  };
  useEffect(() => {
    if (!userId || !challengeId) return;
    const controller = new AbortController();
    const load = async (): Promise<ApprovalInfo> => {
      if (!legacy)
        return extensionFundingApprovalClient(featureId).info(
          userId,
          challengeId,
          controller.signal,
        );
      const result = await decisionFundingApprovalClient().info(
        userId,
        challengeId,
        controller.signal,
      );
      return { ...result, state: result.approved ? "approved-awaiting-host" : "awaiting-approval" };
    };
    void load().then(
      (result) => {
        if (!controller.signal.aborted && currentKey.current === key)
          setState({ key, info: result });
      },
      (error: unknown) => {
        if (!controller.signal.aborted && currentKey.current === key)
          setState({
            key,
            error: error instanceof Error ? error.message : "Could not load this request.",
          });
      },
    );
    return () => controller.abort();
  }, [userId, challengeId, featureId, legacy, key]);
  const approve = async () => {
    if (!userId || !info?.eligible || info.state !== "awaiting-approval" || visible.approving)
      return;
    setState({ ...visible, approving: true, error: undefined });
    try {
      if (legacy) await decisionFundingApprovalClient().approve(userId, challengeId);
      else await extensionFundingApprovalClient(featureId).approve(userId, challengeId);
      if (currentKey.current === key)
        setState({ key, info: { ...info, state: "approved-awaiting-host" } });
    } catch (error) {
      if (currentKey.current === key)
        setState({
          key,
          info,
          error: error instanceof Error ? error.message : "Could not approve this request.",
        });
    }
  };
  return (
    <AuthSurfaceShell compact>
      <div className="mb-5 flex items-center gap-2 text-xs font-medium text-primary">
        <SparklesIcon className="size-3.5" aria-hidden /> Lecturn Extensions
        <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-muted-foreground">
          {featureName}
        </span>
      </div>
      <h1 className="break-words text-xl font-semibold tracking-tight">
        {linked
          ? "Host connected"
          : approved
            ? "Membership approved"
            : `Enable ${featureName}${info?.environmentLabel ? ` on ${info.environmentLabel}` : ""}`}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {linked
          ? `${featureName} can now use your membership on this host.`
          : approved
            ? "One last step: your host needs to finish linking."
            : "Choose the membership that will fund this host’s usage."}
      </p>
      {!challengeId ? (
        <p className="mt-5 text-sm" role="alert">
          This link is incomplete. Start a new request in Lecturn.
        </p>
      ) : !isLoaded ? (
        <p className="mt-5 text-sm" role="status">
          Loading your account…
        </p>
      ) : !userId ? (
        <div className="mt-5 space-y-4">
          {account.picker}
          <p className="text-sm text-muted-foreground">
            Sign in with the membership you want to use for {featureName}.
          </p>
          <Button
            className="w-full"
            onClick={() =>
              openConnectSignIn(clerk, resolveClerkSignInProps(window.location.href, false))
            }
          >
            Sign in
          </Button>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {account.picker}
          <div className="overflow-hidden rounded-xl border border-border/80 bg-background/40">
            <div className="flex items-center gap-3 p-3.5">
              {userId === activeAccountId ? <UserButton /> : null}
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground">Membership account</p>
                <p className="break-all text-sm font-medium">
                  {account.email ??
                    (userId === activeAccountId
                      ? (user?.primaryEmailAddress?.emailAddress ?? user?.fullName)
                      : null) ??
                    "Selected membership account"}
                </p>
              </div>
            </div>
            {info ? (
              <div className="flex items-start gap-3 border-t border-border/70 p-3.5">
                <LaptopIcon className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">Lecturn host</p>
                  <p className="break-words text-sm font-medium">
                    {info.environmentLabel || "This Lecturn host"}
                  </p>
                  <details className="mt-1 text-[11px] text-muted-foreground">
                    <summary className="cursor-pointer">Host details</summary>
                    <p className="mt-1 break-all">{info.environmentId}</p>
                    <p className="mt-1">
                      Request expires {new Date(info.expiresAt).toLocaleString()}.
                    </p>
                  </details>
                </div>
              </div>
            ) : null}
          </div>
          {linked || approved ? (
            <div className="space-y-3">
              <div
                className="flex gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm"
                role="status"
              >
                <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <p>
                  {linked
                    ? `Connected. Return to Lecturn to use ${featureName}.`
                    : "Approved. Return to Lecturn to finish connecting. Approval alone does not mean the host is linked."}
                </p>
              </div>
              {!legacy && approved ? (
                <Button variant="outline" className="w-full" onClick={refresh}>
                  Check connection
                </Button>
              ) : null}
            </div>
          ) : terminal ? (
            <p className="rounded-lg border p-3 text-sm" role="status">
              This request is {info.state}. Start a new request in Lecturn.
            </p>
          ) : info ? (
            <>
              <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">One shared allowance.</span>{" "}
                  Decisions and Contextual draw from the same monthly Extensions token pool. Usage
                  is tracked by feature.
                </p>
                <p>
                  {featureId === "contextual"
                    ? "Selected conversation excerpts and decision evidence are sent to Lecturn’s evaluation service to assess relevance and conflicts."
                    : "Chat excerpts are sent to Lecturn’s evaluation service to find decisions. Your thread’s signed-in agent writes the notes."}
                </p>
                <p className="text-xs">
                  People who can operate this host can use the allowance for {featureName}. This
                  approval covers {featureName} only. Revoke access in Account settings →
                  Membership. This uses your included allowance; it does not purchase a
                  subscription.
                </p>
              </div>
              {info.eligible ? (
                <Button
                  className="w-full"
                  disabled={visible.approving}
                  onClick={() => void approve()}
                >
                  {visible.approving ? "Approving…" : `Allow ${featureName}`}
                </Button>
              ) : (
                <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-sm" role="status">
                    {denial.message}
                  </p>
                  {denial.manageMembership ? (
                    <a
                      className="inline-block text-sm text-primary underline underline-offset-4"
                      href="/account/billing"
                    >
                      Manage membership
                    </a>
                  ) : null}
                  <Button variant="outline" className="w-full" onClick={refresh}>
                    Reload request
                  </Button>
                </div>
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
              <Button variant="outline" className="w-full" onClick={refresh}>
                Reload request
              </Button>
            </div>
          ) : null}
        </div>
      )}
      <a
        className="mt-5 block text-center text-xs text-muted-foreground underline underline-offset-4"
        href="/"
      >
        Back to Lecturn
      </a>
    </AuthSurfaceShell>
  );
}
