import type {
  ExtensionFundingChallengeResult,
  ExtensionFundingObserveResult,
  ExtensionFundingStatusResult,
  ContextualSource,
  ContextualSourcePolicy,
} from "@lecturn/contracts";

export function updateSourceSelection(
  policy: ContextualSourcePolicy,
  source: ContextualSource,
  selected: boolean,
): ContextualSourcePolicy {
  if (selected && (source.conversationType === "unknown" || !source.available)) return policy;
  const ids = new Set(policy.allowedSourceIds);
  if (selected) ids.add(source.id);
  else ids.delete(source.id);
  if (ids.size > 256) return policy;
  return {
    ...policy,
    allowedSourceIds: [...ids],
    allowDirectMessages:
      policy.allowDirectMessages || (selected && source.conversationType === "dm"),
    allowGroupDirectMessages:
      policy.allowGroupDirectMessages || (selected && source.conversationType === "group-dm"),
    unknownConversationPolicy: "exclude",
    draftsPolicy: "exclude",
  };
}

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
