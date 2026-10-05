import type {
  ExtensionFundingChallengeResult,
  ExtensionFundingObserveResult,
  ExtensionFundingStatusResult,
} from "@lecturn/contracts";

/** Observations refer to the challenge generation; redemption advances active funding once. */
export function matchesFundingChallenge(
  challenge: ExtensionFundingChallengeResult,
  result: ExtensionFundingObserveResult,
): boolean {
  return (
    result.featureId === challenge.featureId &&
    result.environmentId === challenge.environmentId &&
    result.challengeId === challenge.challengeId &&
    result.generation === challenge.generation &&
    result.expiresAt === challenge.expiresAt
  );
}
export function matchesFundingRedemption(
  challenge: ExtensionFundingChallengeResult,
  result: ExtensionFundingStatusResult,
): boolean {
  return (
    result.featureId === challenge.featureId &&
    result.environmentId === challenge.environmentId &&
    result.generation === challenge.generation + 1 &&
    result.state === "active"
  );
}
export const FUNDING_OBSERVATION_LIMIT = 60;
export const FUNDING_OBSERVATION_INTERVAL_MS = 3000;
