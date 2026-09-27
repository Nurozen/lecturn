import { createFileRoute, redirect } from "@tanstack/react-router";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { ExtensionsFundingApprovalPage } from "../components/DecisionFundingApprovalPage";
import { isHostedStaticApp } from "../hostedPairing";

export const Route = createFileRoute("/extensions/funding/approve")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { challengeId: string; featureId: "decisions" | "contextual" } => ({
    featureId: search.featureId === "contextual" ? "contextual" : "decisions",
    challengeId:
      typeof search.challengeId === "string" && search.challengeId.length <= 256
        ? search.challengeId.trim()
        : "",
  }),
  beforeLoad: () => {
    if (!isHostedStaticApp() || !hasCloudPublicConfig()) throw redirect({ to: "/", replace: true });
  },
  component: () => <ExtensionsFundingApprovalPage {...Route.useSearch()} />,
});
