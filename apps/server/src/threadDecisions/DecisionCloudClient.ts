import {
  DecisionEvaluationRequest,
  DecisionEvaluationResult,
  DecisionEvaluationError,
  DecisionFundingStatusResult,
  DecisionFundingChallengeResult,
  ThreadDecisionError,
  type ThreadDecisionFundingInput,
  type ThreadDecisionFundingResult,
} from "@lecturn/contracts";
import { Context, Effect, Layer, Option, PubSub, Schema, Semaphore, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { RELAY_URL_SECRET, RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "../cloud/config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";

const FUNDING_STATUS = "decisions-funding-status";
const FUNDING_REVOKED = "decisions-funding-revoked";
const unavailable = () =>
  new ThreadDecisionError({
    code: "unavailable",
    message: "Decisions funding could not be reached. Saved decisions remain available.",
  });
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(DecisionFundingStatusResult));
const encodeStatus = Schema.encodeEffect(Schema.fromJsonString(DecisionFundingStatusResult));

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const environment = yield* ServerEnvironmentIdentity;
  const http = yield* HttpClient.HttpClient;
  const environmentId = yield* environment.getEnvironmentId;
  const fundingMutex = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<DecisionFundingStatusResult>({ capacity: 16 });
  let observed: DecisionFundingStatusResult | undefined;
  const observe = (status: DecisionFundingStatusResult) =>
    Effect.gen(function* () {
      const previous = observed;
      observed = status;
      if (
        status.state === "active" &&
        status.eligible &&
        (!previous ||
          previous.state !== "active" ||
          !previous.eligible ||
          previous.generation !== status.generation ||
          previous.allowance?.windowStart !== status.allowance?.windowStart ||
          (status.allowance?.remainingInputTokens ?? 0) >
            (previous.allowance?.remainingInputTokens ?? 0))
      )
        yield* PubSub.publish(changes, status);
    });
  const empty: DecisionFundingStatusResult = {
    environmentId,
    state: "unfunded",
    generation: 0,
    accountLabel: null,
    eligible: false,
    allowance: null,
    remoteRevocationPending: false,
  };
  const read = (key: string) =>
    secrets
      .get(key)
      .pipe(
        Effect.map((value) =>
          Option.isSome(value) ? new TextDecoder().decode(value.value) : null,
        ),
      );
  const stored = read(FUNDING_STATUS).pipe(
    Effect.flatMap((value) => (value ? decodeStatus(value) : Effect.succeed(empty))),
    Effect.orElseSucceed(() => empty),
  );
  const save = (status: DecisionFundingStatusResult) =>
    encodeStatus(status).pipe(
      Effect.flatMap((value) => secrets.set(FUNDING_STATUS, new TextEncoder().encode(value))),
      Effect.mapError(unavailable),
    );
  const request = Effect.fn("Decisions.cloud.request")(function* (path: string, body?: unknown) {
    const [url, credential] = yield* Effect.all([
      read(RELAY_URL_SECRET),
      read(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]).pipe(Effect.mapError(unavailable));
    if (!url || !credential)
      return yield* new ThreadDecisionError({
        code: "forbidden",
        message: "Link this environment to a Lecturn account to fund Decisions.",
      });
    const target = `${url.replace(/\/$/, "")}/v1/decisions/${path}`;
    const req =
      body === undefined
        ? Effect.succeed(HttpClientRequest.get(target))
        : HttpClientRequest.bodyJson(HttpClientRequest.post(target), body);
    return yield* req.pipe(
      Effect.map(HttpClientRequest.bearerToken(credential)),
      Effect.flatMap(http.execute),
      Effect.timeout("35 seconds"),
      Effect.mapError(unavailable),
    );
  });
  const fetchStatus = request(
    `funding/status?environmentId=${encodeURIComponent(environmentId)}`,
  ).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DecisionFundingStatusResult)),
    Effect.mapError(unavailable),
  );
  const fundingStatusUnsafe = Effect.gen(function* () {
    const local = yield* stored;
    const revoked = yield* read(FUNDING_REVOKED).pipe(Effect.orElseSucceed(() => "true"));
    if (revoked === "true") return { ...local, state: "revoked" as const, eligible: false };
    return yield* fetchStatus.pipe(
      Effect.tap(save),
      Effect.catch(() =>
        Effect.succeed({
          ...local,
          state: local.state === "unfunded" ? ("unfunded" as const) : ("unavailable" as const),
          eligible: false,
        }),
      ),
    );
  });
  const fundingStatus = fundingStatusUnsafe.pipe(Effect.tap(observe), fundingMutex.withPermits(1));
  const fundingUnsafe = Effect.fn("Decisions.cloud.funding")(function* (
    input: ThreadDecisionFundingInput,
  ): Effect.fn.Return<ThreadDecisionFundingResult, ThreadDecisionError> {
    if (input.operation === "challenge") {
      const key = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets).pipe(
        Effect.mapError(unavailable),
      );
      const challenge = yield* request("funding/challenge", {
        environmentId,
        publicKey: key.publicKey.replace(/\r\n/g, "\n").trim(),
        expectedGeneration: input.expectedGeneration,
      }).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(DecisionFundingChallengeResult)),
        Effect.mapError(unavailable),
      );
      return {
        status: {
          ...(yield* stored),
          state: "pending",
          eligible: false,
          generation: challenge.generation,
        },
        challenge,
      };
    }
    if (input.operation === "revoke") {
      // The local stop is durable before the network call. A failed remote revoke
      // is visible and retryable; stale cloud reads cannot silently re-enable work.
      yield* secrets
        .set(FUNDING_REVOKED, new TextEncoder().encode("true"))
        .pipe(Effect.mapError(unavailable));
      const stopped = {
        ...(yield* stored),
        state: "revoked" as const,
        eligible: false,
        remoteRevocationPending: true,
      };
      yield* save(stopped);
      const status = yield* request("funding/revoke", {
        environmentId,
        expectedGeneration: input.expectedGeneration,
      }).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(DecisionFundingStatusResult)),
        Effect.filterOrFail(
          (status) => status.state === "revoked" && !status.eligible,
          unavailable,
        ),
        Effect.catch(() => Effect.succeed(stopped)),
      );
      yield* save(status);
      return { status, challenge: null };
    }
    const status = yield* request("funding/redeem", {
      environmentId,
      challengeId: input.challengeId,
      expectedGeneration: input.expectedGeneration,
    }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DecisionFundingStatusResult)),
      Effect.mapError(unavailable),
    );
    yield* save(status);
    yield* secrets.remove(FUNDING_REVOKED).pipe(Effect.mapError(unavailable));
    return { status, challenge: null };
  });
  const funding = (input: ThreadDecisionFundingInput) =>
    fundingUnsafe(input).pipe(
      Effect.tap((result) =>
        input.operation === "challenge" ? Effect.void : observe(result.status),
      ),
      fundingMutex.withPermits(1),
    );
  const retryPendingRevocation = Effect.gen(function* () {
    const local = yield* stored;
    if (!local.remoteRevocationPending || (yield* read(FUNDING_REVOKED)) !== "true") return;
    const current = yield* fetchStatus;
    if (current.state === "revoked" || current.state === "unfunded") {
      yield* save({
        ...current,
        state: "revoked",
        eligible: false,
        remoteRevocationPending: false,
      });
      return;
    }
    yield* fundingUnsafe({ operation: "revoke", expectedGeneration: current.generation });
  }).pipe(
    fundingMutex.withPermits(1),
    Effect.catch(() => Effect.void),
  );
  const evaluate = Effect.fn("Decisions.cloud.evaluate")(function* (
    input: DecisionEvaluationRequest,
  ) {
    const status = yield* fundingStatus;
    if (
      !status.eligible ||
      status.state !== "active" ||
      status.generation !== input.fundingGeneration
    )
      return yield* new DecisionEvaluationError({
        code: "forbidden",
        message: "Decisions funding is not active for this work.",
      });
    const response = yield* request("evaluate", input).pipe(
      Effect.mapError(
        () =>
          new DecisionEvaluationError({
            code: "unavailable",
            message: "Decisions evaluation is unavailable.",
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const error = yield* HttpClientResponse.schemaBodyJson(DecisionEvaluationError)(
        response,
      ).pipe(
        Effect.orElseSucceed(
          () =>
            new DecisionEvaluationError({
              code: "unavailable",
              message: "Decision evaluation could not complete.",
            }),
        ),
      );
      // Preserve only an allowlisted code, never upstream text or nested causes.
      return yield* new DecisionEvaluationError({
        code: error.code,
        message: "Decision evaluation could not complete.",
      });
    }
    return yield* HttpClientResponse.schemaBodyJson(DecisionEvaluationResult)(response).pipe(
      Effect.mapError(
        () =>
          new DecisionEvaluationError({
            code: "unavailable",
            message: "Decision evaluation returned an invalid response.",
          }),
      ),
    );
  });
  return {
    fundingStatus,
    funding,
    evaluate,
    retryPendingRevocation,
    refreshFunding: retryPendingRevocation.pipe(Effect.andThen(fundingStatus), Effect.asVoid),
    subscribeFundingChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
  };
});
export class DecisionCloudClient extends Context.Service<
  DecisionCloudClient,
  Effect.Success<typeof make>
>()("lecturn/threadDecisions/DecisionCloudClient") {}
export const layer = Layer.effect(DecisionCloudClient, make);
