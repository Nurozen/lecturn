import { useAuth, useClerk, useUser } from "@clerk/react";
import { createBillingClient } from "@t3tools/client-runtime/relay";
import type { RelayBillingStatus } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { Button } from "../ui/button";

export function BillingAccount() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  if (!isLoaded)
    return (
      <main className="p-8" role="status">
        Loading account…
      </main>
    );
  return <SignedBillingAccount key={userId ?? "signed-out"} signedIn={Boolean(isSignedIn)} />;
}

function SignedBillingAccount({ signedIn }: { signedIn: boolean }) {
  const { getToken } = useAuth();
  const clerk = useClerk();
  const { user } = useUser();
  const [status, setStatus] = useState<RelayBillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  const client = useMemo(
    () =>
      createBillingClient({
        relayUrl: resolveCloudPublicConfig().relayUrl ?? "",
        getToken: () => getToken(resolveRelayClerkTokenOptions()),
      }),
    [getToken],
  );

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    if (signedIn) {
      const sessionId = new URL(window.location.href).searchParams.get("session_id");
      const request = sessionId ? client.reconcile(sessionId) : client.getStatus();
      void request.then(
        (value) => {
          if (!cancelled) setStatus(value);
        },
        () => {
          if (!cancelled) setError("Your subscription could not be checked. Refresh to try again.");
        },
      );
    }
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [client, signedIn]);

  async function run(action: () => Promise<RelayBillingStatus | string>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (!mounted.current) return;
      if (typeof result === "string") window.location.assign(result);
      else setStatus(result);
    } catch {
      if (mounted.current)
        setError("The billing request could not be completed. Refresh your status and try again.");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <main className="mx-auto max-w-xl space-y-6 px-6 py-12">
      <header>
        <p className="text-sm text-muted-foreground">Lecturn account</p>
        <h1 className="mt-2 text-3xl font-semibold">Connect subscription</h1>
      </header>
      <p className="text-sm text-muted-foreground">
        Local connections, direct pairing, SSH and Tailscale remain free.
      </p>
      {!signedIn ? (
        <Button
          onClick={() =>
            void clerk.openSignIn({ forceRedirectUrl: `${window.location.origin}/account/billing` })
          }
        >
          Sign in
        </Button>
      ) : (
        <>
          <p className="text-sm">
            Signed in as {user?.primaryEmailAddress?.emailAddress ?? "your Lecturn account"}
          </p>
          {error && <p role="alert">{error}</p>}
          {!status && !error && <p role="status">Checking subscription…</p>}
          {status && (
            <section className="space-y-4 rounded-xl border p-5">
              <p className="font-medium">
                {status.state === "disabled"
                  ? "Subscription billing is not enabled"
                  : status.state === "unavailable"
                    ? "Subscription status unavailable"
                    : `Subscription: ${status.state.replaceAll("_", " ")}`}
              </p>
              {status.state !== "disabled" && status.state !== "unavailable" && (
                <>
                  <p className="text-sm">
                    Managed environments: {status.quota.used} / {status.quota.limit}
                  </p>
                  {status.currentPeriodEnd && (
                    <p className="text-sm">
                      Current term ends {new Date(status.currentPeriodEnd).toLocaleDateString()}.
                    </p>
                  )}
                  {(status.cancelAt || status.cancelAtPeriodEnd) && (
                    <p className="text-sm">
                      Cancellation is scheduled
                      {status.cancelAt
                        ? ` for ${new Date(status.cancelAt).toLocaleDateString()}`
                        : " at the end of this term"}
                      .
                    </p>
                  )}
                  {status.state === "trialing" && status.trialEnd && (
                    <p className="text-sm">
                      Trial ends {new Date(status.trialEnd).toLocaleDateString()}.
                    </p>
                  )}
                </>
              )}
              {status.checkoutEnabled && (
                <>
                  <p className="text-sm">
                    Connect includes three managed environments, push notifications and Live
                    Activities.
                  </p>
                  {status.trialEligible && (
                    <p className="text-sm">
                      14-day trial. A card is required; your selected subscription renews
                      automatically after the trial. Cancel before the trial ends to avoid a charge.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <Button
                      disabled={pending}
                      onClick={() => void run(() => client.checkout("month"))}
                    >
                      Continue with $10/month
                    </Button>
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => void run(() => client.checkout("year"))}
                    >
                      Continue with $100/year
                    </Button>
                  </div>
                </>
              )}
              {status.portalEnabled && (
                <Button disabled={pending} onClick={() => void run(client.portal)}>
                  Manage payment and cancellation
                </Button>
              )}
            </section>
          )}
          <div className="flex gap-3">
            <Button variant="outline" disabled={pending} onClick={() => void run(client.getStatus)}>
              Refresh status
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void clerk.signOut({ redirectUrl: `${window.location.origin}/account/billing` })
              }
            >
              Sign out
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            If you just completed Checkout, refresh status while confirmation arrives. Returning
            from Checkout alone does not activate access.
          </p>
        </>
      )}
      <a href="/" className="text-sm underline">
        Back to Lecturn
      </a>
    </main>
  );
}
