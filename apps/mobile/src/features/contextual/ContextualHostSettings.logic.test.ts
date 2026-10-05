import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type ContextualSource,
  type ContextualSourcePolicy,
  type ExtensionFundingChallengeResult,
  type ExtensionFundingObserveResult,
} from "@lecturn/contracts";
import {
  matchesFundingChallenge,
  matchesFundingRedemption,
  updateSourceSelection,
} from "./ContextualHostSettings.logic";
const policy: ContextualSourcePolicy = {
  allowedSourceIds: ["off-page"],
  allowDirectMessages: false,
  allowGroupDirectMessages: false,
  unknownConversationPolicy: "exclude",
  draftsPolicy: "exclude",
  revision: 4,
};
const source: ContextualSource = {
  id: "visible",
  sourceKind: "slack",
  label: "Synthetic source",
  hostName: "Synthetic host",
  workspaceId: "workspace",
  channelId: "channel",
  conversationType: "channel",
  available: true,
  selected: false,
};
const challenge: ExtensionFundingChallengeResult = {
  environmentId: EnvironmentId.make("host-a"),
  featureId: "contextual",
  challengeId: "request-a",
  generation: 4,
  expiresAt: "2026-09-27T12:00:00.000Z",
  approvalUrl: "https://example.test/approve",
};
const observed: ExtensionFundingObserveResult = {
  ...challenge,
  state: "approved-awaiting-host",
  accountLabel: "Synthetic payer",
};
describe("mobile host source selection", () => {
  it("preserves selections from other pages and only changes the selected conversation", () => {
    const selected = updateSourceSelection(policy, source, true);
    expect(selected.allowedSourceIds).toEqual(["off-page", "visible"]);
    expect(updateSourceSelection(selected, source, false).allowedSourceIds).toEqual(["off-page"]);
  });
  it.each(["dm", "group-dm"] as const)("requires explicit %s selection", (conversationType) => {
    const unselected = updateSourceSelection(policy, { ...source, conversationType }, false);
    expect(unselected.allowDirectMessages).toBe(false);
    expect(unselected.allowGroupDirectMessages).toBe(false);
    const selected = updateSourceSelection(policy, { ...source, conversationType }, true);
    expect(selected.allowDirectMessages).toBe(conversationType === "dm");
    expect(selected.allowGroupDirectMessages).toBe(conversationType === "group-dm");
  });
  it("rejects unclassified, unavailable, and over-limit additions but permits removal", () => {
    expect(updateSourceSelection(policy, { ...source, conversationType: "unknown" }, true)).toEqual(
      policy,
    );
    expect(updateSourceSelection(policy, { ...source, available: false }, true)).toEqual(policy);
    expect(
      updateSourceSelection(policy, { ...source, id: "off-page", available: false }, false)
        .allowedSourceIds,
    ).toEqual([]);
    const full = {
      ...policy,
      allowedSourceIds: Array.from({ length: 256 }, (_, index) => String(index)),
    };
    expect(updateSourceSelection(full, source, true)).toEqual(full);
  });
});
describe("mobile funding identity fences", () => {
  it("accepts only observations from the original challenge and host", () => {
    expect(matchesFundingChallenge(challenge, observed)).toBe(true);
    for (const changed of [
      { featureId: "decisions" as const },
      { environmentId: EnvironmentId.make("host-b") },
      { challengeId: "request-b" },
      { generation: 5 },
      { expiresAt: "2026-09-28T12:00:00.000Z" },
    ])
      expect(matchesFundingChallenge(challenge, { ...observed, ...changed })).toBe(false);
  });
  it("does not mistake an old active grant or another feature for this redemption", () => {
    const result = {
      environmentId: challenge.environmentId,
      featureId: challenge.featureId,
      generation: 5,
      state: "active" as const,
      accountLabel: "Synthetic payer",
      eligible: true,
      reason: "eligible" as const,
      allowance: null,
      remoteRevocationPending: false,
    };
    expect(matchesFundingRedemption(challenge, result)).toBe(true);
    expect(matchesFundingRedemption(challenge, { ...result, generation: 4 })).toBe(false);
    expect(matchesFundingRedemption(challenge, { ...result, featureId: "decisions" })).toBe(false);
    expect(
      matchesFundingRedemption(challenge, {
        ...result,
        environmentId: EnvironmentId.make("host-b"),
      }),
    ).toBe(false);
    expect(matchesFundingRedemption(challenge, { ...result, state: "pending" })).toBe(false);
  });
});
