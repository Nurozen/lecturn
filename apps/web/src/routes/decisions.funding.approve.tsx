import { createFileRoute, redirect } from "@tanstack/react-router";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { DecisionFundingApprovalPage } from "../components/DecisionFundingApprovalPage";
import { isHostedStaticApp } from "../hostedPairing";

export const Route = createFileRoute("/decisions/funding/approve")({
  validateSearch: (search: Record<string, unknown>): { challengeId: string } => ({
    challengeId:
      typeof search.challengeId === "string" && search.challengeId.length <= 256
        ? search.challengeId.trim()
        : "",
  }),
  beforeLoad: () => {
    if (!isHostedStaticApp() || !hasCloudPublicConfig()) throw redirect({ to: "/", replace: true });
  },
  component: () => <DecisionFundingApprovalPage challengeId={Route.useSearch().challengeId} />,
});
