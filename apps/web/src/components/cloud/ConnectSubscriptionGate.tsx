import { useUser } from "@clerk/react";
import { ExternalLinkIcon, RadioTowerIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { Button } from "../ui/button";

export function ConnectSubscriptionGate({
  onRefresh,
  preserveChoices = true,
}: {
  readonly onRefresh: () => Promise<boolean>;
  readonly preserveChoices?: boolean;
}) {
  const titleId = useId();
  const { user } = useUser();
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const billingUrl = new URL("/account/billing", configuredHostedAppUrl()).href;

  useEffect(() => {
    const refresh = () => {
      setActionError(null);
      void onRefresh().catch(() =>
        setActionError("Your access could not be checked. Refresh to try again."),
      );
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [onRefresh]);

  return (
    <section
      className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4"
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="flex items-center gap-2 font-medium">
        <RadioTowerIcon className="size-4 text-primary" aria-hidden /> Connect your devices
      </h3>
      <p className="text-sm text-muted-foreground">
        Your account needs Connect access before publishing.{" "}
        {preserveChoices
          ? "Your choices above are saved while you set up your plan."
          : "After setting up your plan, enable the Connect features you want below."}
      </p>
      <p className="text-lg font-semibold">
        $10/month{" "}
        <span className="text-sm font-normal text-muted-foreground">or $100/year · USD</span>
      </p>
      <p className="text-xs text-muted-foreground">
        Three managed environments, push notifications, and Live Activities. Eligible accounts
        receive a 14-day trial with a card required. After the trial, your chosen plan renews
        automatically until canceled.
      </p>
      <p className="text-xs">
        Use {user?.primaryEmailAddress?.emailAddress ?? "the same Lecturn account"} in your browser.
        You can choose or manage your plan there.
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          href={billingUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (!window.desktopBridge) return;
            event.preventDefault();
            setActionError(null);
            void window.desktopBridge
              .openExternal(billingUrl)
              .then((opened) => {
                if (!opened) setActionError("The browser could not be opened. Please try again.");
              })
              .catch(() => setActionError("The browser could not be opened. Please try again."));
          }}
        >
          Choose or manage plan <ExternalLinkIcon className="size-3.5" aria-hidden />
        </a>
        <Button
          variant="outline"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            setActionError(null);
            try {
              await onRefresh();
            } catch {
              setActionError("Your access could not be checked. Refresh to try again.");
            } finally {
              setRefreshing(false);
            }
          }}
        >
          {refreshing ? "Checking…" : "Refresh access"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        After subscribing, return here and continue. Opening billing does not start a subscription
        or charge your card. Local and direct connections remain free.
      </p>
      {actionError ? (
        <p className="text-xs text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}
    </section>
  );
}
