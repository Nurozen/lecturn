import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { isHostedStaticApp } from "../hostedPairing";
import { BillingSettingsDialog } from "../components/cloud/BillingSettingsDialog";

function BillingRoute() {
  const navigate = useNavigate();
  return (
    <main className="min-h-dvh bg-background">
      <div aria-hidden="true" className="p-8 font-heading text-xl text-muted-foreground">
        Lecturn
      </div>
      <BillingSettingsDialog
        open
        onConnections={() => void navigate({ to: "/settings/connections" })}
        onOpenChange={(open) => {
          if (!open) void navigate({ to: "/" });
        }}
      />
    </main>
  );
}

export const Route = createFileRoute("/account/billing")({
  beforeLoad: () => {
    if (!isHostedStaticApp() || !hasCloudPublicConfig()) throw redirect({ to: "/", replace: true });
  },
  component: BillingRoute,
});
