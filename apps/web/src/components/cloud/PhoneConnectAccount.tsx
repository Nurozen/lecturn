import { Link } from "@tanstack/react-router";
import { RadioTowerIcon } from "lucide-react";
import { useId } from "react";
import { phoneConnectAccount, type PhoneConnectSnapshot } from "../../cloud/phoneConnectAccount";
import { usePhoneConnectAccount } from "../../cloud/useConnectAccountAuth";
import { hasPhoneConnectAccount } from "../../lib/androidHostAccess";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

function phoneConnectLabel({ status, error }: PhoneConnectSnapshot): string {
  if (!status) return error ? "Status unavailable" : "Checking account…";
  if (!status.configured) return "App update needed";
  if (status.state === "loading") return "Checking account…";
  if (status.state === "signed-in") return status.account?.email ?? "Signed in";
  if (status.state === "authorizing") return "Signing in…";
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
  return <PhoneConnectAccountContent snapshot={snapshot} />;
}

function PhoneConnectAccountContent({ snapshot }: { readonly snapshot: PhoneConnectSnapshot }) {
  const { status, busy, error } = snapshot;
  const id = useId();
  const authorizing = status?.state === "authorizing";
  const loading = status?.state === "loading";
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
        {phoneConnectLabel(snapshot)}
      </p>
      {status && !status.configured ? (
        <p className="text-sm text-muted-foreground">
          Update Lecturn on this phone to a build configured for native Connect sign-in.
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
        <p className="text-sm text-muted-foreground">
          Finish signing in in the native sign-in screen. Close that screen to cancel.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!hasAccount && !needsReset && !authorizing ? (
          <Button
            disabled={busy || loading || !status?.configured}
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
    </section>
  );
}
