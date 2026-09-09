import { createFileRoute, redirect } from "@tanstack/react-router";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { isHostedStaticApp } from "../hostedPairing";
import { BillingAccount } from "../components/cloud/BillingAccount";

export const Route = createFileRoute("/account/billing")({
  beforeLoad: () => {
    if (!isHostedStaticApp() || !hasCloudPublicConfig()) throw redirect({ to: "/", replace: true });
  },
  component: BillingAccount,
});
