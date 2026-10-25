/**
 * Raw routes for connected apps (I3). Stub until A24: pairing answers
 * `unavailable` so a polling app backs off instead of seeing a 404 from the
 * static fallback.
 */
import { APPS_PAIRING_REQUESTS_PATH, type AppsHttpErrorBody } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";

const unavailable = Effect.sync(() =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "unavailable",
      message: "Connected apps are not available yet.",
    } satisfies AppsHttpErrorBody,
    { status: 503 },
  ),
);

export const layer = Layer.mergeAll(
  HttpRouter.add("POST", APPS_PAIRING_REQUESTS_PATH, unavailable),
  HttpRouter.add("GET", `${APPS_PAIRING_REQUESTS_PATH}/:requestId`, unavailable),
);
