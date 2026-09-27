import type { RelayDecisionsStatus } from "@lecturn/contracts";

export function decisionFundingDenial(
  reason: RelayDecisionsStatus["reason"] | undefined,
  featureName = "Decisions",
) {
  switch (reason) {
    case "disabled":
      return {
        message: `${featureName} is currently disabled for this service. Membership changes will not enable it.`,
        manageMembership: false,
      };
    case "cohort":
      return {
        message: `${featureName} is not enabled for this account during the current rollout.`,
        manageMembership: false,
      };
    case "stale-billing":
      return {
        message:
          "We could not verify your current billing status. Reload this request to check again.",
        manageMembership: false,
      };
    case "trial":
      return {
        message: `${featureName} requires an eligible paid membership and is not available during a trial.`,
        manageMembership: true,
      };
    case "not-paid":
      return {
        message: `This account does not have an eligible paid membership for ${featureName}.`,
        manageMembership: true,
      };
    default:
      return {
        message: `${featureName} access could not be confirmed for this request. Reload this request to try again.`,
        manageMembership: false,
      };
  }
}
