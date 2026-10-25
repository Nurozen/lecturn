/**
 * Raw routes for connected-app pairing (I3). The caller is an unauthenticated
 * local app, so every request first passes the loopback guard
 * (pairingGuard.ts); the poll secret then stands in for a session.
 */
import {
  APPS_PAIRING_REQUESTS_PATH,
  APPS_POLL_SECRET_HEADER,
  AppPairingRequestId,
  AppRegistration,
  AppsError,
  type AppsHttpErrorBody,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { type PairingRefusal, pairingPeerOf, pairingRefusal } from "./pairingGuard.ts";
import { AppRegistryService, type AppsFailure } from "./services.ts";

const POLL_SECRET_HEADER = APPS_POLL_SECRET_HEADER.toLowerCase();

// The poll answer can carry the credential, and no answer is worth caching.
const NO_STORE = { "cache-control": "no-store" };

const respond = (body: unknown, status: number) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const errorResponse = (error: AppsHttpErrorBody["error"], message: string, status: number) =>
  respond({ error, message } satisfies AppsHttpErrorBody, status);

const REFUSAL_MESSAGES: Record<PairingRefusal, string> = {
  origin: "Pairing requests cannot come from a web page.",
  forwarded: "Pairing requests must reach Lecturn directly, not through a proxy.",
  host: "Pairing requests must address Lecturn by a loopback host.",
  "remote-address": "Pairing requests must come from this machine.",
};

const failureResponse = (failure: AppsFailure) => {
  if (failure._tag === "AppsNotImplemented") {
    return errorResponse("unavailable", failure.message, 503);
  }
  switch (failure.code) {
    case "invalid":
      return errorResponse("invalid", failure.message, 400);
    // The wire body has no conflict code; the status tells the app apart.
    case "conflict":
      return errorResponse("invalid", failure.message, 409);
    case "forbidden":
      return errorResponse("forbidden", failure.message, 403);
    case "not-found":
      return errorResponse("not-found", failure.message, 404);
    case "unavailable":
      return errorResponse("unavailable", failure.message, 503);
  }
};

const guarded = <R>(
  handle: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, AppsFailure, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const refusal = pairingRefusal(pairingPeerOf(request));
    if (refusal !== null) {
      yield* Effect.logWarning("Refused a connected-app pairing request", { refusal });
      return errorResponse("forbidden", REFUSAL_MESSAGES[refusal], 403);
    }
    return yield* handle(request).pipe(
      Effect.catchTags({
        AppsError: (failure) => Effect.succeed(failureResponse(failure)),
        AppsNotImplemented: (failure) => Effect.succeed(failureResponse(failure)),
      }),
    );
  });

const invalidBody = new AppsError({
  code: "invalid",
  message: "The body is not a valid app registration.",
});

const createPairingRequest = (registry: AppRegistryService["Service"]) =>
  guarded(() =>
    Effect.gen(function* () {
      const registration = yield* HttpServerRequest.schemaBodyJson(AppRegistration).pipe(
        Effect.mapError(() => invalidBody),
      );
      return respond(yield* registry.createPairingRequest(registration), 201);
    }),
  );

const decodeRequestId = Schema.decodeUnknownOption(AppPairingRequestId);

const pollPairingRequest = (registry: AppRegistryService["Service"]) =>
  guarded((request) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const requestId = decodeRequestId(params["requestId"]);
      const pollSecret = request.headers[POLL_SECRET_HEADER];
      if (Option.isNone(requestId) || pollSecret === undefined || pollSecret.length === 0) {
        return yield* new AppsError({
          code: "invalid",
          message: `A request id and the ${APPS_POLL_SECRET_HEADER} header are required.`,
        });
      }
      return respond(
        yield* registry.pollPairingRequest({ requestId: requestId.value, pollSecret }),
        200,
      );
    }),
  );

// Routes see only request services, so the registry is taken when the layer is built.
export const layer = Layer.unwrap(
  Effect.map(Effect.service(AppRegistryService), (registry) =>
    Layer.mergeAll(
      HttpRouter.add("POST", APPS_PAIRING_REQUESTS_PATH, createPairingRequest(registry)),
      HttpRouter.add(
        "GET",
        `${APPS_PAIRING_REQUESTS_PATH}/:requestId`,
        pollPairingRequest(registry),
      ),
    ),
  ),
);
