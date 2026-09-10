import { useAuth, useClerk, useUser } from "@clerk/react";
import { createBillingClient } from "@t3tools/client-runtime/relay";
import type { RelayBillingStatus } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { configuredHostedAppUrl, isHostedStaticApp } from "../../hostedPairing";
import { CreditCardIcon, RadioTowerIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { createBillingStatusLoader } from "./billingStatusLoader";

export function BillingAccount({ embedded = false }: { embedded?: boolean }) {
  return <HostedBillingAccount embedded={embedded} hosted={isHostedStaticApp()} />;
}

function HostedBillingAccount({ embedded, hosted }: { embedded: boolean; hosted: boolean }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  if (!isLoaded)
    return (
      <div className="p-8" role="status">
        Loading account…
      </div>
    );
  return (
    <SignedBillingAccount
      key={userId ?? "signed-out"}
      signedIn={Boolean(isSignedIn)}
      embedded={embedded}
      hosted={hosted}
    />
  );
}

function SignedBillingAccount({
  signedIn,
  embedded,
  hosted,
}: {
  signedIn: boolean;
  embedded: boolean;
  hosted: boolean;
}) {
  const { getToken } = useAuth();
  const clerk = useClerk();
  const { authPrompt, openAuthPrompt } = useT3ConnectAuthPrompt();
  const { user } = useUser();
  const [status, setStatus] = useState<RelayBillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  const statusLoader = useRef<ReturnType<typeof createBillingStatusLoader> | null>(null);
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
    const loader = createBillingStatusLoader(client, {
      status: (value) => {
        setStatus(value);
        setError(null);
      },
      error: () => setError("Your subscription could not be checked. Refresh to try again."),
    });
    statusLoader.current = loader;
    const refresh = () => {
      if (signedIn) void loader.refresh();
    };
    if (signedIn) {
      const sessionId = hosted
        ? new URL(window.location.href).searchParams.get("session_id")
        : null;
      void loader.refresh(sessionId ?? undefined);
    }
    if (!hosted) window.addEventListener("focus", refresh);
    return () => {
      loader.dispose();
      statusLoader.current = null;
      window.removeEventListener("focus", refresh);
      mounted.current = false;
    };
  }, [client, signedIn, hosted]);

  async function run(action: () => Promise<RelayBillingStatus | string | void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (!mounted.current) return;
      if (typeof result === "string") window.location.assign(result);
      else if (result) setStatus(result);
    } catch {
      if (mounted.current)
        setError("The billing request could not be completed. Refresh your status and try again.");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <section className="mx-auto w-full max-w-2xl space-y-7 px-6 py-8 sm:px-8">
      {authPrompt}
      <header>
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
          <RadioTowerIcon className="size-5" />
        </div>
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Lecturn Connect
        </p>
        <h2 className="mt-2 font-heading text-2xl font-semibold">Your connection, everywhere.</h2>
      </header>
      <p className="text-sm text-muted-foreground">
        Local connections, direct pairing, SSH and Tailscale remain free.
      </p>
      {!signedIn ? (
        <Button
          onClick={() =>
            hosted
              ? void clerk.openSignIn({
                  forceRedirectUrl: `${window.location.origin}/account/billing`,
                })
              : openAuthPrompt()
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
            <section className="space-y-5 rounded-xl border border-primary/20 bg-primary/5 p-5">
              <p className="flex items-center gap-2 font-medium">
                <CreditCardIcon aria-hidden="true" className="size-4 text-primary" />
                {status.state === "disabled"
                  ? "Subscription billing is not enabled"
                  : status.state === "unavailable"
                    ? "Subscription status unavailable"
                    : `Subscription: ${status.state.replaceAll("_", " ")}`}
              </p>
              {status.state !== "disabled" && (
                <p className="text-sm" role="status">
                  {status.accessReason === "suspended"
                    ? "Managed access is suspended while a payment issue is reviewed."
                    : status.accessReason === "grant" || status.accessReason === "paid_and_grant"
                      ? "Complimentary Connect access is active."
                      : status.hasAccess
                        ? "Managed Connect access is active."
                        : "Managed Connect access is not active."}
                  {status.accessUntil &&
                    status.hasAccess &&
                    ` Available through ${new Date(status.accessUntil).toLocaleDateString()}.`}
                </p>
              )}
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
              {hosted &&
                status.state === "free" &&
                !status.hasAccess &&
                !status.checkoutEnabled && (
                  <p className="text-sm text-muted-foreground">
                    Connect subscriptions are being opened to invited accounts. Checkout is not
                    enabled for this account yet. If you were invited, refresh your status after
                    your account has been approved.
                  </p>
                )}
              {hosted && status.checkoutEnabled && (
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
                  <p className="text-xs text-muted-foreground">
                    Available in the United States. Prices are in USD; applicable taxes are
                    calculated at Checkout.
                  </p>
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
              {hosted && status.portalEnabled && (
                <Button disabled={pending} onClick={() => void run(client.portal)}>
                  Manage payment and cancellation
                </Button>
              )}
            </section>
          )}
          <div className="flex gap-3">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void run(() => statusLoader.current?.refresh() ?? Promise.resolve())}
            >
              Refresh status
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void clerk.signOut(
                  hosted ? { redirectUrl: `${window.location.origin}/account/billing` } : undefined,
                )
              }
            >
              Sign out
            </Button>
          </div>
          {!hosted && (
            <div className="space-y-3">
              <a
                className="inline-flex rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-foreground"
                href={new URL("/account/billing", configuredHostedAppUrl()).href}
                target="_blank"
                rel="noopener noreferrer"
              >
                Manage billing in browser
              </a>
              <p className="text-sm text-muted-foreground">
                Use the same Lecturn account in your browser. Your subscription status refreshes
                when you return.
              </p>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            If you just completed Checkout, refresh status while confirmation arrives. Returning
            from Checkout alone does not activate access.
          </p>
        </>
      )}
      <details className="border-t pt-4 text-sm text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">Subscription terms</summary>
        <div className="mt-3 space-y-3">
          <p>
            Subscriptions renew automatically. Cancel in the payment portal to stop the next
            renewal; access continues through the current paid or trial term.
          </p>
          <p>
            A failed renewal after a paid term has a three-day grace period. A trial does not
            receive extra grace after its first payment fails.
          </p>
          <p>
            For refunds or billing help, contact{" "}
            <a className="underline" href="mailto:accounts@cloudgatherer.net">
              accounts@cloudgatherer.net
            </a>
            . A full refund of the current term ends that term’s access. Partial refunds and refunds
            for earlier terms do not end a newer paid term. Disputed payments may suspend the
            affected term while reviewed.
          </p>
          <p>
            Existing users receive a 30-day transition without automatic enrollment or charges.
            Local, direct, SSH and Tailscale connections remain free.
          </p>
          <p>
            <a
              className="underline"
              href={new URL("/terms-of-service/", configuredHostedAppUrl()).href}
              target="_blank"
              rel="noreferrer"
            >
              Service terms
            </a>{" "}
            and{" "}
            <a
              className="underline"
              href={new URL("/privacy-policy/", configuredHostedAppUrl()).href}
              target="_blank"
              rel="noreferrer"
            >
              privacy notice
            </a>
          </p>
        </div>
      </details>
      {!embedded && hosted && (
        <a href="/" className="text-sm underline">
          Back to Lecturn
        </a>
      )}
    </section>
  );
}
