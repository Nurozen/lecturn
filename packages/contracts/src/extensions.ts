import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const ExtensionFeatureId = Schema.Literals(["decisions", "contextual", "squires"]);
export type ExtensionFeatureId = typeof ExtensionFeatureId.Type;
export const ExtensionEligibilityReason = Schema.Literals([
  "eligible",
  "disabled",
  "not-paid",
  "trial",
  "stale-billing",
  "cohort",
  "unavailable",
]);
/**
 * Hosts send this header listing the features they can decode. The relay folds every other
 * feature out of allowances it returns, so a host released before a feature existed keeps working.
 */
export const EXTENSION_FEATURES_HEADER = "x-lecturn-extension-features";
const isKnownFeature = Schema.is(ExtensionFeatureId);
const MAX_WIRE_FEATURES = 16;
const featureUsage = <F extends Schema.Top>(featureId: F) =>
  Schema.Struct({ featureId, usedInputTokens: counter, reservedInputTokens: counter });
export const ExtensionFeatureUsage = featureUsage(ExtensionFeatureId);
type FeatureUsage<F extends string> = {
  readonly featureId: F;
  readonly usedInputTokens: number;
  readonly reservedInputTokens: number;
};
type FoldableAllowance<F extends string> = {
  readonly limitInputTokens: number;
  readonly usedInputTokens: number;
  readonly reservedInputTokens: number;
  readonly remainingInputTokens: number;
  readonly byFeature: ReadonlyArray<FeatureUsage<F>>;
};
/**
 * Drops features the reader cannot name and takes their usage out of the totals and the limit
 * alike, so the per-feature sums still match and `remainingInputTokens` stays exact.
 */
const foldExtensionAllowance = <A extends FoldableAllowance<F>, F extends string, K extends F>(
  allowance: A & FoldableAllowance<F>,
  keep: (featureId: F) => featureId is K,
): Omit<A, "byFeature"> & { readonly byFeature: ReadonlyArray<FeatureUsage<K>> } => {
  const byFeature: FeatureUsage<K>[] = [];
  let hiddenUsed = 0;
  let hiddenReserved = 0;
  for (const entry of allowance.byFeature) {
    const featureId = entry.featureId;
    if (keep(featureId)) byFeature.push({ ...entry, featureId });
    else {
      hiddenUsed += entry.usedInputTokens;
      hiddenReserved += entry.reservedInputTokens;
    }
  }
  return {
    ...allowance,
    limitInputTokens: Math.max(0, allowance.limitInputTokens - hiddenUsed - hiddenReserved),
    usedInputTokens: allowance.usedInputTokens - hiddenUsed,
    reservedInputTokens: allowance.reservedInputTokens - hiddenReserved,
    byFeature,
  };
};
/** Every host and client released before features were declared understood exactly these. */
export const LEGACY_EXTENSION_FEATURES: ReadonlyArray<string> = ["decisions", "contextual"];
/** The allowance as a reader that declared `features` can decode; undeclared means legacy. */
const extensionAllowanceFor = <A extends FoldableAllowance<ExtensionFeatureId>>(
  allowance: A,
  features: ReadonlyArray<string> | undefined,
) => {
  const readable = features ?? LEGACY_EXTENSION_FEATURES;
  return foldExtensionAllowance(allowance, (featureId): featureId is ExtensionFeatureId =>
    readable.includes(featureId),
  );
};
/** A funding response with its allowance, if any, reduced to what the reader can decode. */
export const extensionFundingFor = <A extends object>(
  value: A,
  features: ReadonlyArray<string> | undefined,
): A =>
  "allowance" in value && value.allowance
    ? {
        ...value,
        allowance: extensionAllowanceFor(value.allowance as ExtensionAllowance, features),
      }
    : value;
/** Optional request field: the features a client can decode. Unknown names are ignored. */
export const ExtensionReaderFeatures = Schema.optionalKey(
  Schema.Array(id).check(Schema.isMaxLength(MAX_WIRE_FEATURES)),
);
const allowanceFields = <F extends Schema.Top>(featureId: F, maxFeatures: number) => ({
  poolId: id,
  basis: Schema.Literals(["subscription", "grant"]),
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  limitInputTokens: counter,
  usedInputTokens: counter,
  reservedInputTokens: counter,
  remainingInputTokens: counter,
  byFeature: Schema.Array(featureUsage(featureId)).check(Schema.isMaxLength(maxFeatures)),
});
const consistentAllowance = Schema.makeFilter(
  (v: {
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly limitInputTokens: number;
    readonly usedInputTokens: number;
    readonly reservedInputTokens: number;
    readonly remainingInputTokens: number;
    readonly byFeature: ReadonlyArray<FeatureUsage<string>>;
  }) =>
    Date.parse(v.windowStart) < Date.parse(v.windowEnd) &&
    new Set(v.byFeature.map((entry) => entry.featureId)).size === v.byFeature.length &&
    v.byFeature.reduce((sum, entry) => sum + entry.usedInputTokens, 0) === v.usedInputTokens &&
    v.byFeature.reduce((sum, entry) => sum + entry.reservedInputTokens, 0) ===
      v.reservedInputTokens &&
    Number.isSafeInteger(v.usedInputTokens + v.reservedInputTokens) &&
    v.remainingInputTokens ===
      Math.max(0, v.limitInputTokens - v.usedInputTokens - v.reservedInputTokens),
);
/**
 * Every feature reports against this one payer/window descriptor, never separate balances.
 * A feature this build does not know decodes as folded-out usage instead of failing the payload.
 */
export const ExtensionAllowance = Schema.Struct(allowanceFields(id, MAX_WIRE_FEATURES))
  .check(consistentAllowance)
  .pipe(
    Schema.decodeTo(
      Schema.toType(
        Schema.Struct(
          allowanceFields(ExtensionFeatureId, ExtensionFeatureId.literals.length),
        ).check(consistentAllowance),
      ),
      SchemaTransformation.transform({
        decode: (wire) => foldExtensionAllowance(wire, isKnownFeature),
        encode: (allowance) => allowance,
      }),
    ),
  );
export type ExtensionAllowance = typeof ExtensionAllowance.Type;
const consistentAvailability = Schema.makeFilter(
  (v: { readonly eligible: boolean; readonly enabled: boolean; readonly reason: string }) =>
    v.eligible ? v.enabled && v.reason === "eligible" : v.reason !== "eligible",
);
const featureAvailability = <F extends Schema.Top>(featureId: F) =>
  Schema.Struct({
    featureId,
    available: Schema.Boolean,
    enabled: Schema.Boolean,
    eligible: Schema.Boolean,
    reason: ExtensionEligibilityReason,
  });
export const ExtensionFeatureAvailability =
  featureAvailability(ExtensionFeatureId).check(consistentAvailability);
type ExtensionFeatureAvailability = typeof ExtensionFeatureAvailability.Type;
const uniqueFeatures = Schema.makeFilter(
  (v: ReadonlyArray<{ readonly featureId: string }>) =>
    new Set(v.map((f) => f.featureId)).size === v.length,
);
const WireFeatureAvailability = featureAvailability(id).check(consistentAvailability);
export const ExtensionServiceStatus = Schema.Struct({
  // Unknown features are dropped: a newer relay never breaks this build's status view.
  features: Schema.Array(WireFeatureAvailability)
    .check(Schema.isMaxLength(MAX_WIRE_FEATURES), uniqueFeatures)
    .pipe(
      Schema.decodeTo(
        Schema.toType(
          Schema.Array(ExtensionFeatureAvailability).check(
            Schema.isMaxLength(ExtensionFeatureId.literals.length),
            uniqueFeatures,
          ),
        ),
        SchemaTransformation.transform<
          ReadonlyArray<ExtensionFeatureAvailability>,
          ReadonlyArray<typeof WireFeatureAvailability.Type>
        >({
          decode: (features) =>
            features.flatMap((feature) => {
              const featureId = feature.featureId;
              return isKnownFeature(featureId) ? [{ ...feature, featureId }] : [];
            }),
          encode: (features) => features,
        }),
      ),
    ),
  allowance: Schema.NullOr(ExtensionAllowance),
});
export type ExtensionServiceStatus = typeof ExtensionServiceStatus.Type;

const featureEnvironment = { featureId: ExtensionFeatureId, environmentId: EnvironmentId };
const challengeIdentity = { ...featureEnvironment, challengeId: id, generation: counter };
export const ExtensionFundingChallengeRequest = Schema.Struct({
  ...featureEnvironment,
  publicKey: id,
  expectedGeneration: counter,
});
export const ExtensionFundingChallengeResult = Schema.Struct({
  ...challengeIdentity,
  approvalUrl: Schema.String.check(
    Schema.isMaxLength(2000),
    Schema.isPattern(/^https?:\/\/[^\s]+$/),
  ),
  expiresAt: IsoDateTime,
});
export const ExtensionFundingChallengeState = Schema.Literals([
  "awaiting-approval",
  "approved-awaiting-host",
  "linked",
  "expired",
  "revoked",
  "canceled",
]);
export const ExtensionFundingApprovalInfo = Schema.Struct({
  ...challengeIdentity,
  environmentLabel: text(200),
  expiresAt: IsoDateTime,
  state: ExtensionFundingChallengeState,
  eligible: Schema.Boolean,
  reason: ExtensionEligibilityReason,
}).check(Schema.makeFilter((v) => v.eligible === (v.reason === "eligible")));
/** The selected payer is authenticated by middleware, never supplied in a request body. */
export const ExtensionFundingApprovalRequest = Schema.Struct({
  featureId: ExtensionFeatureId,
  challengeId: id,
});
export const ExtensionFundingApprovalResult = Schema.Struct({
  ...challengeIdentity,
  state: Schema.Literal("approved-awaiting-host"),
  expiresAt: IsoDateTime,
});
export const ExtensionFundingObserveRequest = Schema.Struct({
  ...featureEnvironment,
  challengeId: id,
  expectedGeneration: counter,
});
export const ExtensionFundingObserveResult = Schema.Struct({
  ...challengeIdentity,
  state: ExtensionFundingChallengeState,
  expiresAt: IsoDateTime,
  accountLabel: Schema.NullOr(text(200)),
}).check(Schema.makeFilter((v) => v.state !== "awaiting-approval" || v.accountLabel === null));
export const ExtensionFundingRedeemRequest = ExtensionFundingObserveRequest;
export const ExtensionFundingStatusRequest = Schema.Struct(featureEnvironment);
export const ExtensionFundingStatusResult = Schema.Struct({
  ...featureEnvironment,
  state: Schema.Literals(["unfunded", "pending", "active", "revoked", "unavailable"]),
  generation: counter,
  accountLabel: Schema.NullOr(text(200)),
  eligible: Schema.Boolean,
  reason: ExtensionEligibilityReason,
  allowance: Schema.NullOr(ExtensionAllowance),
  remoteRevocationPending: Schema.Boolean,
}).check(Schema.makeFilter((v) => v.eligible === (v.reason === "eligible")));
export const ExtensionFundingRedeemResult = ExtensionFundingStatusResult;
export const ExtensionFundingCancelRequest = ExtensionFundingObserveRequest;
export const ExtensionFundingCancelResult = ExtensionFundingObserveResult;
export const ExtensionFundingAccountListRequest = Schema.Struct({
  featureId: ExtensionFeatureId,
  cursor: Schema.optionalKey(id),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export const ExtensionFundedEnvironment = Schema.Struct({
  ...featureEnvironment,
  environmentLabel: text(200),
  generation: counter,
});
export const ExtensionFundingAccountListResult = Schema.Struct({
  featureId: ExtensionFeatureId,
  environments: Schema.Array(ExtensionFundedEnvironment).check(Schema.isMaxLength(50)),
  nextCursor: Schema.NullOr(id),
}).check(
  Schema.makeFilter(
    (v) =>
      v.environments.every((entry) => entry.featureId === v.featureId) &&
      new Set(v.environments.map((entry) => entry.environmentId)).size === v.environments.length,
  ),
);
export const ExtensionFundingRevokeRequest = Schema.Struct({
  ...featureEnvironment,
  expectedGeneration: counter,
});
export const ExtensionFundingRevokeResult = ExtensionFundingStatusResult;
export const ExtensionAttemptIdentity = Schema.Struct({
  featureId: ExtensionFeatureId,
  requestId: id,
  runId: id,
  fundingGeneration: counter,
});
export const ExtensionEvaluationStatusRequest = Schema.Struct({
  featureId: ExtensionFeatureId,
  requestId: id,
  fundingGeneration: counter,
});
export const ExtensionEvaluationStatusResult = Schema.Struct({
  featureId: ExtensionFeatureId,
  requestId: id,
  state: Schema.Literals(["pending", "succeeded", "unknown", "refused-before-dispatch", "expired"]),
  inputTokens: Schema.NullOr(counter),
  allowance: Schema.NullOr(ExtensionAllowance),
});
export class ExtensionEvaluationError extends Schema.TaggedError<ExtensionEvaluationError>()(
  "ExtensionEvaluationError",
  {
    code: Schema.Literals([
      "invalid",
      "forbidden",
      "unavailable",
      "conflict",
      "allowance-exhausted",
      "run-budget-exhausted",
      "rate-limited",
      "in-progress",
      "expired",
      "unsupported",
    ]),
    message: text(500),
  },
) {}

export type ExtensionFundingChallengeRequest = typeof ExtensionFundingChallengeRequest.Type;
export type ExtensionFundingChallengeResult = typeof ExtensionFundingChallengeResult.Type;
export type ExtensionFundingApprovalInfo = typeof ExtensionFundingApprovalInfo.Type;
export type ExtensionFundingApprovalRequest = typeof ExtensionFundingApprovalRequest.Type;
export type ExtensionFundingApprovalResult = typeof ExtensionFundingApprovalResult.Type;
export type ExtensionFundingObserveRequest = typeof ExtensionFundingObserveRequest.Type;
export type ExtensionFundingObserveResult = typeof ExtensionFundingObserveResult.Type;
export type ExtensionFundingRedeemRequest = typeof ExtensionFundingRedeemRequest.Type;
export type ExtensionFundingRedeemResult = typeof ExtensionFundingRedeemResult.Type;
export type ExtensionFundingCancelRequest = typeof ExtensionFundingCancelRequest.Type;
export type ExtensionFundingCancelResult = typeof ExtensionFundingCancelResult.Type;
export type ExtensionFundingStatusRequest = typeof ExtensionFundingStatusRequest.Type;
export type ExtensionFundingStatusResult = typeof ExtensionFundingStatusResult.Type;
export type ExtensionFundingAccountListRequest = typeof ExtensionFundingAccountListRequest.Type;
export type ExtensionFundingAccountListResult = typeof ExtensionFundingAccountListResult.Type;
export type ExtensionFundedEnvironment = typeof ExtensionFundedEnvironment.Type;
export type ExtensionFundingRevokeRequest = typeof ExtensionFundingRevokeRequest.Type;
export type ExtensionFundingRevokeResult = typeof ExtensionFundingRevokeResult.Type;
export type ExtensionAttemptIdentity = typeof ExtensionAttemptIdentity.Type;
export type ExtensionEvaluationStatusRequest = typeof ExtensionEvaluationStatusRequest.Type;
export type ExtensionEvaluationStatusResult = typeof ExtensionEvaluationStatusResult.Type;
