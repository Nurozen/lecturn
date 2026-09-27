import { describe, expect, it } from "vite-plus/test";
import {
  contextualCollectionPresentation,
  contextualPreparationOutcome,
  contextualStateLabel,
  contextualTranscriptOutcome,
  fundingSupersedesChallenge,
} from "./contextual.ts";
import {
  EnvironmentId,
  type ExtensionFundingChallengeResult,
  type ExtensionFundingStatusResult,
} from "@lecturn/contracts";
const paused = { state: "paused", reason: "requested" } as const;
const active = { state: "active", reason: "eligible", eligible: true } as const;
it("only retires approvals superseded by confirmed funding for the same feature and host", () => {
  const challenge: ExtensionFundingChallengeResult = {
    environmentId: EnvironmentId.make("host"),
    featureId: "contextual",
    challengeId: "pending",
    generation: 3,
    expiresAt: "2026-09-27T12:00:00.000Z",
    approvalUrl: "https://example.test/approve",
  };
  const status: ExtensionFundingStatusResult = {
    environmentId: challenge.environmentId,
    featureId: challenge.featureId,
    generation: 4,
    state: "active",
    reason: "eligible",
    eligible: true,
    accountLabel: "Current payer",
    allowance: null,
    remoteRevocationPending: false,
  };
  expect(fundingSupersedesChallenge(challenge, status)).toBe(true);
  expect(
    fundingSupersedesChallenge(challenge, { ...status, state: "revoked", eligible: false }),
  ).toBe(true);
  for (const changed of [
    { generation: 3 },
    { generation: 2 },
    { state: "unavailable" as const },
    { environmentId: EnvironmentId.make("other") },
    { featureId: "decisions" as const },
  ])
    expect(fundingSupersedesChallenge(challenge, { ...status, ...changed })).toBe(false);
  expect(fundingSupersedesChallenge(challenge, null)).toBe(false);
});
describe("Contextual collection explanations", () => {
  it("explains unavailable funding instead of attributing the pause to the user", () => {
    const status = contextualCollectionPresentation({
      capture: paused,
      funding: { state: "unavailable", reason: "unavailable", eligible: false },
    });
    expect(status.canStart).toBe(false);
    expect(status.message).toContain("could not be verified");
    expect(status.message).toContain("refresh status");
    expect(status.message).not.toContain("your request");
  });
  it("does not trust cached eligible funding after a query failure", () => {
    expect(
      contextualCollectionPresentation({ capture: paused, funding: active, fundingFailed: true })
        .canStart,
    ).toBe(false);
    expect(
      contextualCollectionPresentation({ capture: paused, funding: null, fundingFailed: true })
        .message,
    ).toContain("could not be verified");
  });
  it("distinguishes checking, approval, missing membership and unavailable sources", () => {
    expect(contextualCollectionPresentation({ capture: paused, funding: null }).message).toContain(
      "Checking membership",
    );
    expect(
      contextualCollectionPresentation({
        capture: paused,
        funding: { state: "pending", reason: "not-paid", eligible: false },
      }).message,
    ).toContain("approval");
    expect(
      contextualCollectionPresentation({
        capture: paused,
        funding: { state: "unfunded", reason: "not-paid", eligible: false },
      }).message,
    ).toContain("Link an eligible membership");
    expect(
      contextualCollectionPresentation({
        capture: { state: "unavailable", reason: "source-unavailable" },
        funding: active,
      }).canStart,
    ).toBe(false);
    expect(contextualCollectionPresentation({ capture: paused, funding: active }).canStart).toBe(
      true,
    );
  });
  it("keeps pausing a running collector available during a funding outage", () => {
    expect(
      contextualCollectionPresentation({
        capture: { state: "running", reason: "ready" },
        funding: null,
        fundingFailed: true,
      }).canStart,
    ).toBe(true);
  });
});
describe("Contextual recorded outcomes", () => {
  it("distinguishes unavailable, user skip and no useful evidence without inventing legacy causes", () => {
    expect(contextualPreparationOutcome({ state: "skipped", skipReason: "unavailable" })).toContain(
      "was unavailable",
    );
    expect(
      contextualPreparationOutcome({ state: "skipped", skipReason: "user-requested" }),
    ).toContain("at your request");
    expect(contextualPreparationOutcome({ state: "no-useful-context" })).toContain(
      "No useful context found",
    );
    expect(contextualPreparationOutcome({ state: "skipped" })).toContain("reason was not recorded");
    expect(contextualPreparationOutcome({ state: "prepared" })).toBeNull();
    expect(
      contextualStateLabel({
        enabled: false,
        effective: false,
        reason: "off",
        slackAvailable: false,
        decisionsAvailable: false,
        collectionState: "paused",
      }),
    ).toBe("Off for this thread");
  });
});

it("keeps routine empty results out of the transcript without hiding actionable outcomes", () => {
  expect(contextualTranscriptOutcome({ state: "no-useful-context" })).toBeNull();
  expect(contextualTranscriptOutcome({ state: "already-supplied" })).toBeNull();
  expect(
    contextualTranscriptOutcome({ state: "skipped", skipReason: "evaluation-incomplete" }),
  ).toBe(
    "Contextual could not finish checking this context within the message’s limit. Your message was sent without it.",
  );
  expect(contextualTranscriptOutcome({ state: "skipped", skipReason: "unavailable" })).toContain(
    "unavailable",
  );
});
