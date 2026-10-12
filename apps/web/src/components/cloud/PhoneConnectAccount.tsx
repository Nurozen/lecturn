import { Link } from "@tanstack/react-router";
import { RadioTowerIcon } from "lucide-react";
import { useId, useState } from "react";
import { phoneConnectAccount, type PhoneConnectSnapshot } from "../../cloud/phoneConnectAccount";
import { usePhoneConnectAccount } from "../../cloud/useConnectAccountAuth";
import { hasPhoneConnectAccount } from "../../lib/androidHostAccess";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export function phoneConnectLabel({ status, error }: PhoneConnectSnapshot): string {
  if (!status) return error ? "Status unavailable" : "Checking account…";
  if (!status.configured) return "Not configured on this phone";
  if (status.state === "signed-in") return status.account?.email ?? "Signed in";
  if (status.state === "authorizing") return "Waiting for return code";
  if (status.state === "error") return "Sign-in needs attention";
  return "Signed out";
}

export function PhoneConnectSidebarEntry() {
  const snapshot = usePhoneConnectAccount();
  const { setOpenMobile } = useSidebar();
  if (!hasPhoneConnectAccount()) return null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="h-auto min-h-11"
          render={<Link to="/settings/connections" onClick={() => setOpenMobile(false)} />}
        >
          <RadioTowerIcon />
          <span className="min-w-0">
            <span className="block">Lecturn Connect</span>
            <span className="block truncate text-xs text-muted-foreground">
              {phoneConnectLabel(snapshot)}
            </span>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function PhoneConnectAccountSection() {
  const snapshot = usePhoneConnectAccount();
  if (!hasPhoneConnectAccount()) return null;
  return (
    <PhoneConnectAccountContent
      key={snapshot.authorization?.requestId ?? snapshot.status?.state ?? "loading"}
      snapshot={snapshot}
    />
  );
}

function PhoneConnectAccountContent({ snapshot }: { readonly snapshot: PhoneConnectSnapshot }) {
  const { status, authorization, busy, error } = snapshot;
  const [code, setCode] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const id = useId();
  const authorizing = status?.state === "authorizing" || authorization !== null;
  const hasAccount = status?.account != null;
  const needsReset = status?.state === "error" && !hasAccount;
  return (
    <section
      aria-labelledby={id}
      style={{ maxHeight: "max(10rem, calc(var(--workspace-viewport-height, 100dvh) - 5rem))" }}
      className="min-w-0 overflow-y-auto overscroll-contain space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4"
    >
      <h2 id={id} className="flex items-center gap-2 font-semibold">
        <RadioTowerIcon className="size-4" />
        Lecturn Connect
      </h2>
      <p role="status" className="break-words text-sm">
        {phoneConnectLabel({ status, authorization, busy, error })}
      </p>
      {status && !status.configured ? (
        <p className="text-sm text-muted-foreground">
          Connect is not configured on this phone. The phone service needs its Connect configuration
          before you can sign in.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Sign in to discover your environments. Signing in does not publish this phone or change
          your plan.
        </p>
      )}
      {error || status?.state === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {error ??
            (hasAccount
              ? "Connect session needs attention. Sign out and sign in again."
              : "Sign-in could not be completed. Reset sign-in and try again.")}
        </p>
      ) : null}
      {authorizing ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Finish signing in in your browser, then paste the entire return code here.
          </p>
          {authorization ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    // A direct user gesture reaches Android's external-browser handler.
                    window.open(authorization.authorizationUrl, "_blank", "noopener,noreferrer");
                    setFeedback(
                      "If the browser did not open, copy the sign-in link and open it in your browser.",
                    );
                  }}
                >
                  Open browser
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    void Promise.resolve()
                      .then(() => navigator.clipboard.writeText(authorization.authorizationUrl))
                      .then(
                        () => setFeedback("Sign-in link copied."),
                        () => setFeedback("Could not copy the link. Use Open browser to continue."),
                      );
                  }}
                >
                  Copy sign-in link
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                This sign-in expires at {new Date(authorization.expiresAt).toLocaleTimeString()}.
              </p>
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const submitted = code;
                  setCode("");
                  void phoneConnectAccount.complete(submitted);
                }}
              >
                <label htmlFor={`${id}-code`} className="text-sm">
                  Return code
                </label>
                <Input
                  id={`${id}-code`}
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="Paste the entire return code"
                />
                <Button type="submit" disabled={busy || !code.trim()}>
                  Complete sign-in
                </Button>
              </form>
            </>
          ) : (
            <p className="text-sm">
              This page was reopened during sign-in. Cancel and start again to get a new sign-in
              link.
            </p>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setCode("");
              void phoneConnectAccount.cancel();
            }}
          >
            Cancel sign-in
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!hasAccount && !needsReset && !authorizing ? (
          <Button
            disabled={busy || !status?.configured}
            onClick={() => void phoneConnectAccount.begin()}
          >
            Sign in to Lecturn Connect
          </Button>
        ) : null}
        {hasAccount || needsReset ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void phoneConnectAccount.logout()}
          >
            {hasAccount ? "Sign out" : "Reset sign-in"}
          </Button>
        ) : null}
        <Button variant="ghost" disabled={busy} onClick={() => void phoneConnectAccount.refresh()}>
          Refresh status
        </Button>
      </div>
      {busy ? (
        <p role="status" className="text-xs text-muted-foreground">
          Updating account…
        </p>
      ) : null}
      {feedback ? (
        <p role="status" className="text-xs text-muted-foreground">
          {feedback}
        </p>
      ) : null}
    </section>
  );
}
