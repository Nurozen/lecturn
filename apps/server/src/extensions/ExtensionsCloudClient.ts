import {
  ContextualError,
  DecisionFundingStatusResult,
  ExtensionFundingStatusResult,
  ExtensionFundingChallengeResult,
  ExtensionFundingObserveResult,
  ContextualEvaluationResult,
  ContextualConflictCheckResult,
  ContextualEquivalenceCheckResult,
  type ExtensionFeatureId,
  type ExtensionHostFundingRequest,
  type ExtensionHostFundingResult,
  type ContextualEvaluationRequest,
  type ContextualConflictCheckRequest,
  type ContextualEquivalenceCheckRequest,
} from "@lecturn/contracts";
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { RELAY_URL_SECRET, RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "../cloud/config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import { contextualBoundary } from "../contextual/ContextualSettings.ts";

import {
  decisionFundingState,
  DECISION_FUNDING_STATUS,
  DECISION_FUNDING_REVOKED,
} from "../threadDecisions/DecisionFundingState.ts";

const Pending = Schema.Struct({
  challenge: ExtensionFundingChallengeResult,
  intent: Schema.Literals(["awaiting", "cancel"]),
});
const decodePending = Schema.decodeUnknownEffect(Schema.fromJsonString(Pending));
const encodePending = Schema.encodeEffect(Schema.fromJsonString(Pending));
const decodeStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ExtensionFundingStatusResult),
);
const encodeStatus = Schema.encodeEffect(Schema.fromJsonString(ExtensionFundingStatusResult));
const statusBody = HttpClientResponse.schemaBodyJson(ExtensionFundingStatusResult);
const challengeBody = HttpClientResponse.schemaBodyJson(ExtensionFundingChallengeResult);
const observeBody = HttpClientResponse.schemaBodyJson(ExtensionFundingObserveResult);
const evaluationBody = HttpClientResponse.schemaBodyJson(ContextualEvaluationResult);
const conflictBody = HttpClientResponse.schemaBodyJson(ContextualConflictCheckResult);
const equivalenceBody = HttpClientResponse.schemaBodyJson(ContextualEquivalenceCheckResult);
const errorBody = HttpClientResponse.schemaBodyJson(
  Schema.Struct({
    code: Schema.String.check(Schema.isMaxLength(100)),
    message: Schema.String.check(Schema.isMaxLength(2000)),
  }),
);
const unavailable = () =>
  new ContextualError({
    code: "unavailable",
    message: "Extension funding is unavailable. Saved context remains available.",
  });
const stale = () =>
  new ContextualError({
    code: "stale-revision",
    message: "This approval changed or expired. Start a new approval.",
  });
const key = (feature: ExtensionFeatureId, suffix: string) =>
  feature === "decisions" && suffix === "status"
    ? DECISION_FUNDING_STATUS
    : feature === "decisions" && suffix === "revoked"
      ? DECISION_FUNDING_REVOKED
      : `extensions-${feature}-${suffix}`;
const decodeDecisionStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DecisionFundingStatusResult),
);

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const environment = yield* ServerEnvironmentIdentity;
  const http = yield* HttpClient.HttpClient;
  const environmentId = yield* environment.getEnvironmentId;
  const sharedFunding = decisionFundingState(secrets);
  const contextualMutex = yield* Semaphore.make(1);
  const mutex = (feature: ExtensionFeatureId) =>
    feature === "decisions" ? sharedFunding.mutex : contextualMutex;
  const read = (name: string) =>
    secrets.get(name).pipe(
      Effect.map((v) => (Option.isSome(v) ? new TextDecoder().decode(v.value) : null)),
      Effect.mapError(unavailable),
    );
  const write = (name: string, value: string) =>
    secrets.set(name, new TextEncoder().encode(value)).pipe(Effect.mapError(unavailable));
  const empty = (featureId: ExtensionFeatureId): ExtensionFundingStatusResult => ({
    featureId,
    environmentId,
    state: "unfunded",
    generation: 0,
    accountLabel: null,
    eligible: false,
    reason: "unavailable",
    allowance: null,
    remoteRevocationPending: false,
  });
  const stored = (feature: ExtensionFeatureId) =>
    (feature === "decisions"
      ? sharedFunding.status.pipe(Effect.mapError(unavailable))
      : read(key(feature, "status"))
    ).pipe(
      Effect.flatMap((value) =>
        !value
          ? Effect.succeed(empty(feature))
          : feature === "decisions"
            ? decodeStatus(value).pipe(
                Effect.catch(() =>
                  decodeDecisionStatus(value).pipe(
                    Effect.map((status): ExtensionFundingStatusResult => ({
                      ...status,
                      featureId: feature,
                      allowance: null,
                      reason: status.eligible ? "eligible" : "unavailable",
                    })),
                  ),
                ),
              )
            : decodeStatus(value),
      ),
      Effect.mapError(unavailable),
    );
  const pending = (feature: ExtensionFeatureId) =>
    read(key(feature, "pending")).pipe(
      Effect.flatMap((value) => (value ? decodePending(value) : Effect.succeed(null))),
      Effect.mapError(unavailable),
    );
  const save = (value: ExtensionFundingStatusResult) =>
    encodeStatus(value).pipe(
      Effect.flatMap((encoded) => write(key(value.featureId, "status"), encoded)),
      Effect.mapError(unavailable),
    );
  const savePending = (value: typeof Pending.Type) =>
    encodePending(value).pipe(
      Effect.flatMap((encoded) => write(key(value.challenge.featureId, "pending"), encoded)),
      Effect.mapError(unavailable),
    );
  const request = Effect.fn("Extensions.cloud.request")(function* (path: string, body?: unknown) {
    const [url, credential] = yield* Effect.all([
      read(RELAY_URL_SECRET),
      read(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    if (!url || !credential)
      return yield* new ContextualError({
        code: "forbidden",
        message: "Link this host to a Lecturn account before funding extensions.",
      });
    const target = `${url.replace(/\/$/, "")}/v1/extensions/${path}`;
    const req =
      body === undefined
        ? Effect.succeed(HttpClientRequest.get(target))
        : HttpClientRequest.bodyJson(HttpClientRequest.post(target), body);
    const response = yield* req.pipe(
      Effect.map(HttpClientRequest.bearerToken(credential)),
      Effect.flatMap(http.execute),
      Effect.timeout("90 seconds"),
      Effect.mapError(unavailable),
    );
    if (response.status >= 200 && response.status < 300) return response;
    const error = yield* errorBody(response).pipe(Effect.timeout("90 seconds"), Effect.option);
    const code = Option.isSome(error) ? error.value.code : "unavailable";
    if (code === "allowance-exhausted")
      return yield* new ContextualError({
        code,
        message: "Your shared extensions allowance is exhausted.",
      });
    if (code === "forbidden" || response.status === 401 || response.status === 403)
      return yield* new ContextualError({
        code: "forbidden",
        message:
          "This host is not authorized for this feature. Check the account and membership approval.",
      });
    if (code === "expired" || code === "conflict") return yield* stale();
    if (code === "run-budget-exhausted")
      return yield* new ContextualError({
        code,
        message: "This preparation reached its evaluation limit.",
      });
    return yield* unavailable();
  }, Effect.withTracerEnabled(false));
  const checkedStatus = Effect.fn("Extensions.cloud.checkedStatus")(function* (
    feature: ExtensionFeatureId,
    response: HttpClientResponse.HttpClientResponse,
  ) {
    const value = yield* statusBody(response).pipe(
      Effect.timeout("90 seconds"),
      Effect.mapError(unavailable),
    );
    if (value.environmentId !== environmentId || value.featureId !== feature)
      return yield* unavailable();
    return value;
  });
  const fetchStatus = (feature: ExtensionFeatureId) =>
    request(
      `funding/status?environmentId=${encodeURIComponent(environmentId)}&featureId=${feature}`,
    ).pipe(
      Effect.flatMap((r) => checkedStatus(feature, r)),
      Effect.timeout("90 seconds"),
      Effect.mapError(unavailable),
    );
  const revoked = (feature: ExtensionFeatureId) =>
    feature === "decisions"
      ? sharedFunding.revoked.pipe(Effect.mapError(unavailable))
      : read(key(feature, "revoked")).pipe(Effect.map((value) => value === "true"));
  const statusUnsafe = Effect.fn("Extensions.cloud.status")(function* (
    feature: ExtensionFeatureId,
  ) {
    const local = yield* stored(feature);
    if (yield* revoked(feature))
      return {
        ...local,
        state: "revoked" as const,
        eligible: false,
        reason: "unavailable" as const,
      };
    return yield* fetchStatus(feature).pipe(
      Effect.tap(save),
      Effect.orElseSucceed(() => ({
        ...local,
        state: local.state === "unfunded" ? ("unfunded" as const) : ("unavailable" as const),
        eligible: false,
        reason: "unavailable" as const,
      })),
    );
  });
  const status = (feature: ExtensionFeatureId) =>
    statusUnsafe(feature).pipe(mutex(feature).withPermits(1));
  const fundingUnsafe = Effect.fn("Extensions.cloud.funding")(
    function* (
      input: ExtensionHostFundingRequest,
    ): Effect.fn.Return<ExtensionHostFundingResult, ContextualError> {
      const feature = input.featureId;
      if (input.operation === "create") {
        const pair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets).pipe(
          Effect.mapError(unavailable),
        );
        const challenge = yield* request("funding/challenge", {
          featureId: feature,
          environmentId,
          publicKey: pair.publicKey.replace(/\r\n/g, "\n").trim(),
          expectedGeneration: input.expectedGeneration,
        }).pipe(Effect.flatMap(challengeBody), Effect.mapError(contextualBoundary));
        if (challenge.featureId !== feature || challenge.environmentId !== environmentId)
          return yield* unavailable();
        yield* savePending({ challenge, intent: "awaiting" });
        return challenge;
      }
      if (input.operation === "revoke") {
        yield* write(key(feature, "revoked"), "true");
        yield* secrets.remove(key(feature, "pending")).pipe(Effect.mapError(unavailable));
        const stopped = {
          ...(yield* stored(feature)),
          state: "revoked" as const,
          eligible: false,
          reason: "unavailable" as const,
          remoteRevocationPending: true,
        };
        yield* save(stopped);
        const result = yield* request("funding/revoke", {
          featureId: feature,
          environmentId,
          expectedGeneration: input.expectedGeneration,
        }).pipe(
          Effect.flatMap((r) => checkedStatus(feature, r)),
          Effect.filterOrFail((s) => s.state === "revoked" && !s.eligible, unavailable),
          Effect.orElseSucceed(() => stopped),
        );
        yield* save(result);
        return result;
      }
      const p = yield* pending(feature);
      if (
        !p ||
        p.challenge.challengeId !== input.challengeId ||
        p.challenge.generation !== input.expectedGeneration ||
        p.challenge.environmentId !== environmentId
      )
        return yield* stale();
      const payload = {
        featureId: feature,
        environmentId,
        challengeId: input.challengeId,
        expectedGeneration: input.expectedGeneration,
      };
      const cancel = input.operation === "cancel" || p.intent === "cancel";
      if (cancel) yield* savePending({ ...p, intent: "cancel" });
      const observed = yield* (
        cancel
          ? request("funding/cancel", payload)
          : request(
              `funding/observe?featureId=${feature}&environmentId=${encodeURIComponent(environmentId)}&challengeId=${encodeURIComponent(input.challengeId)}&expectedGeneration=${input.expectedGeneration}`,
            )
      ).pipe(Effect.flatMap(observeBody), Effect.mapError(contextualBoundary));
      if (
        observed.featureId !== feature ||
        observed.environmentId !== environmentId ||
        observed.challengeId !== input.challengeId ||
        observed.generation !== input.expectedGeneration
      )
        return yield* stale();
      if (
        observed.state === "expired" ||
        observed.state === "revoked" ||
        observed.state === "canceled"
      ) {
        yield* secrets.remove(key(feature, "pending")).pipe(Effect.mapError(unavailable));
        return observed;
      }
      if (cancel || (observed.state !== "approved-awaiting-host" && observed.state !== "linked"))
        return observed;
      // Observation cannot approve. Redeem only this host's exact durably pending browser-approved challenge.
      const linked = yield* request("funding/redeem", payload).pipe(
        Effect.flatMap((r) => checkedStatus(feature, r)),
      );
      if (linked.state !== "active" || linked.generation !== observed.generation + 1)
        return yield* stale();
      yield* save(linked);
      yield* (
        feature === "decisions"
          ? sharedFunding.clearRevoked
          : secrets.remove(key(feature, "revoked"))
      ).pipe(Effect.mapError(unavailable));
      yield* secrets.remove(key(feature, "pending")).pipe(Effect.mapError(unavailable));
      return linked;
    },
    Effect.timeout("90 seconds"),
    Effect.mapError(contextualBoundary),
  );
  const funding = (input: ExtensionHostFundingRequest) =>
    fundingUnsafe(input).pipe(mutex(input.featureId).withPermits(1));
  const reconcilePending = Effect.gen(function* () {
    for (const featureId of ["decisions", "contextual"] as const) {
      yield* Effect.gen(function* () {
        const saved = yield* stored(featureId);
        if (saved.remoteRevocationPending && (yield* revoked(featureId)))
          yield* fundingUnsafe({
            operation: "revoke",
            featureId,
            expectedGeneration: saved.generation,
          });
        const active = yield* pending(featureId);
        if (!active) return;
        yield* fundingUnsafe({
          operation: active.intent === "cancel" ? "cancel" : "observe",
          featureId,
          challengeId: active.challenge.challengeId,
          expectedGeneration: active.challenge.generation,
        });
      }).pipe(mutex(featureId).withPermits(1), Effect.ignore);
    }
  });
  const authorize = Effect.fn("Extensions.cloud.authorize")(function* (
    feature: ExtensionFeatureId,
    generation: number,
  ) {
    const value = yield* status(feature);
    if (value.state !== "active" || !value.eligible || value.generation !== generation)
      return yield* new ContextualError({
        code: "forbidden",
        message: "Approve this feature's membership access before evaluation.",
      });
  });
  const evaluate = Effect.fn("Extensions.cloud.evaluate")(function* (
    input: ContextualEvaluationRequest,
  ) {
    yield* authorize("contextual", input.fundingGeneration);
    return yield* request("evaluate", input).pipe(
      Effect.flatMap(evaluationBody),
      Effect.timeout("90 seconds"),
      Effect.mapError(contextualBoundary),
    );
  }, Effect.withTracerEnabled(false));
  const conflicts = Effect.fn("Extensions.cloud.conflicts")(function* (
    input: ContextualConflictCheckRequest,
  ) {
    yield* authorize(input.featureId, input.fundingGeneration);
    return yield* request("conflicts", input).pipe(
      Effect.flatMap(conflictBody),
      Effect.timeout("90 seconds"),
      Effect.mapError(contextualBoundary),
    );
  }, Effect.withTracerEnabled(false));
  const equivalence = Effect.fn("Extensions.cloud.equivalence")(function* (
    input: ContextualEquivalenceCheckRequest,
  ) {
    yield* authorize("decisions", input.fundingGeneration);
    return yield* request("equivalence", input).pipe(
      Effect.flatMap(equivalenceBody),
      Effect.timeout("90 seconds"),
      Effect.mapError(contextualBoundary),
    );
  }, Effect.withTracerEnabled(false));
  return { status, funding, reconcilePending, evaluate, conflicts, equivalence, pending };
});
export class ExtensionsCloudClient extends Context.Service<
  ExtensionsCloudClient,
  Effect.Success<typeof make>
>()("lecturn/extensions/ExtensionsCloudClient") {}
export const layer = Layer.effect(ExtensionsCloudClient, make);
