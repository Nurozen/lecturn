import { AccountSurface } from "../components/AccountSurface";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { isHostedStaticApp } from "../hostedPairing";
import { BillingSettingsDialog } from "../components/cloud/BillingSettingsDialog";

function BillingRoute() {
  const navigate = useNavigate();
  const { tab } = Route.useSearch();
  return (
    <main className="min-h-dvh">
      <AccountSurface seam={false} className="lecturn-settings-surface min-h-dvh">
        <div aria-hidden="true" className="p-8 font-heading text-xl text-muted-foreground">
          Lecturn
        </div>
        <BillingSettingsDialog
          open
          initialTab={tab}
          onConnections={() => void navigate({ to: "/settings/connections" })}
          onOpenChange={(open) => {
            if (!open) void navigate({ to: "/" });
          }}
        />
      </AccountSurface>
    </main>
  );
}

export const Route = createFileRoute("/account/billing")({
  validateSearch: (search: Record<string, unknown>): { tab: "teams" | "billing" } => ({
    tab: search.tab === "teams" ? "teams" : "billing",
  }),
  beforeLoad: () => {
    if (!isHostedStaticApp() || !hasCloudPublicConfig()) throw redirect({ to: "/", replace: true });
  },
  component: BillingRoute,
});
