/**
 * Squire raw HTTP routes: the dev fixture route, the action-log export, and
 * the webhook trigger route. Each resolves its
 * service once at build time, because the Squire services exist only with
 * the switch on (and the fixture seam only with test providers on).
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  SquireActionLogEntry,
  SquireEvent,
  SquireFakeScript,
  SquireFixtureSetup,
  SquireFixtureTimelineAction,
  SquireId,
} from "@lecturn/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import type * as HttpServerError from "effect/http/HttpServerError";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";

import { authenticateRawRouteWithScope } from "../http.ts";
import * as SquireDevFixtures from "./SquireDevFixtures.ts";
import * as SquireReadModel from "./SquireReadModel.ts";
import * as SquireTriggers from "./SquireTriggers.ts";

export const SQUIRE_DEV_FIXTURE_ROUTE = "/api/dev/squire/fixture";
export const SQUIRE_WEBHOOK_ROUTE_PREFIX = "/api/squire/hooks";
/** SquireTriggers enforces the same cap; the route caps its reader so a chunked body cannot grow past it. */
export const SQUIRE_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const ACTION_LOG_PAGE = 200;

const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe(body, { status, ...(headers === undefined ? {} : { headers }) });

const authFailures = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

// ── Dev fixture route ─────────────────────────────────────────

/** One request per `SquireDevFixtures` method; `squire load-fixture` sequences them. */
export const SquireDevFixtureRequest = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("loadSetup"),
    setup: SquireFixtureSetup,
    /** `--set` paths relative to `setup`, applied by the loader so it knows what they name. */
    set: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    fake: Schema.optionalKey(SquireFakeScript),
  }),
  Schema.Struct({
    op: Schema.Literal("inject"),
    event: SquireEvent,
    squire: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ op: Schema.Literal("drainThrough"), sequence: Schema.Int }),
  Schema.Struct({ op: Schema.Literal("timeline"), action: SquireFixtureTimelineAction }),
  Schema.Struct({ op: Schema.Literal("reset"), name: Schema.String }),
]);
export type SquireDevFixtureRequest = typeof SquireDevFixtureRequest.Type;

const runFixtureRequest = (
  fixtures: SquireDevFixtures.SquireDevFixtures["Service"],
  request: SquireDevFixtureRequest,
) => {
  switch (request.op) {
    case "loadSetup":
      return fixtures.loadSetup(request.setup, {
        ...(request.set === undefined ? {} : { set: request.set }),
        ...(request.fake === undefined ? {} : { fake: request.fake }),
      });
    case "inject":
      return fixtures
        .inject(request.event, request.squire === undefined ? {} : { squire: request.squire })
        .pipe(Effect.map((sequence) => ({ sequence })));
    case "drainThrough":
      return fixtures.drainThrough(request.sequence).pipe(Effect.as({}));
    case "timeline":
      return fixtures.timeline(request.action).pipe(Effect.as({}));
    case "reset":
      return fixtures.reset(request.name).pipe(Effect.as({}));
  }
};

const fixtureFailure = (
  error: SquireDevFixtures.SquireDevFixturesFailure,
): HttpServerResponse.HttpServerResponse =>
  json(422, { error: error._tag, message: error.message });

// Absent, so a 404, unless SquireDevFixtures is provided (switch on and LECTURN_TEST_PROVIDERS=1).
const layerDevFixtureRoute = Layer.unwrap(
  Effect.map(Effect.serviceOption(SquireDevFixtures.SquireDevFixtures), (fixtures) =>
    Option.match(fixtures, {
      onNone: () => Layer.empty,
      onSome: (service) =>
        HttpRouter.add(
          "POST",
          SQUIRE_DEV_FIXTURE_ROUTE,
          Effect.gen(function* () {
            // Before the body: `load-fixture` probes the gate with an unauthenticated request.
            yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
            const request = yield* HttpServerRequest.schemaBodyJson(SquireDevFixtureRequest).pipe(
              Effect.option,
            );
            if (Option.isNone(request)) {
              return json(400, { error: "invalid_request" });
            }
            return yield* runFixtureRequest(service, request.value).pipe(
              Effect.map((result) => json(200, result)),
              Effect.catchTags({
                SquireDevFixturesError: (error) => Effect.succeed(fixtureFailure(error)),
                SquireFixtureActionUnavailable: (error) => Effect.succeed(fixtureFailure(error)),
              }),
            );
          }).pipe(Effect.catchTags(authFailures)),
        ),
    }),
  ),
);

// ── Action-log export ─────────────────────────────────────────

const encodeLogLine = Schema.encodeSync(Schema.fromJsonString(SquireActionLogEntry));
const decodeSquireId = Schema.decodeUnknownOption(SquireId);

/** Newest first, as `squire.actionLog.list` pages; read-scoped like the RPC. */
const layerActionLogExportRoute = Layer.unwrap(
  Effect.map(Effect.serviceOption(SquireReadModel.SquireReadModel), (readModel) =>
    HttpRouter.add(
      "GET",
      "/api/squire/:squireId/action-log",
      Effect.gen(function* () {
        yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
        if (Option.isNone(readModel)) return json(404, { error: "not_found" });
        const squireId = decodeSquireId((yield* HttpRouter.params).squireId);
        if (Option.isNone(squireId)) return json(400, { error: "invalid_request" });
        const page = (before: number | undefined) =>
          readModel.value.actionLogList({
            squireId: squireId.value,
            limit: ACTION_LOG_PAGE,
            ...(before === undefined ? {} : { before }),
          });
        // The first page answers not-found before the 200 is committed.
        const first = yield* page(undefined).pipe(Effect.result);
        if (first._tag === "Failure") {
          const notFound =
            first.failure.code === "not_found" || first.failure.code === "disabled_by_server";
          return json(notFound ? 404 : 500, { error: notFound ? "not_found" : "internal_error" });
        }
        const rest =
          first.success.nextBefore === null
            ? Stream.empty
            : Stream.paginate(first.success.nextBefore, (before) =>
                page(before).pipe(
                  Effect.map(
                    (next) => [next.entries, Option.fromNullishOr(next.nextBefore)] as const,
                  ),
                ),
              );
        const lines = Stream.concat(Stream.fromIterable(first.success.entries), rest).pipe(
          Stream.map((entry) => `${encodeLogLine(entry)}\n`),
          Stream.encodeText,
        );
        return HttpServerResponse.stream(lines, {
          contentType: "application/x-ndjson",
          headers: {
            "content-disposition": `attachment; filename="squire-${squireId.value}-log.ndjson"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }).pipe(Effect.catchTags(authFailures)),
    ),
  ),
);

// ── Webhook route ─────────────────────────────────────────────

class SquireWebhookBodyTooLarge extends Schema.TaggedError<SquireWebhookBodyTooLarge>()(
  "SquireWebhookBodyTooLarge",
  {},
) {}

/**
 * Outside session auth, like the scheduled-task webhook: the per-trigger
 * secret is the only gate. Always registered, so with the switch off
 * it answers 404 instead of falling through to the static route.
 */
const layerWebhookRoute = Layer.unwrap(
  Effect.map(Effect.serviceOption(SquireTriggers.SquireTriggers), (triggers) =>
    HttpRouter.add(
      "POST",
      `${SQUIRE_WEBHOOK_ROUTE_PREFIX}/:triggerId`,
      Effect.gen(function* () {
        if (Option.isNone(triggers)) return json(404, { error: "hook_not_found" });
        const request = yield* HttpServerRequest.HttpServerRequest;
        const triggerId = (yield* HttpRouter.params).triggerId ?? "";
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
        }
        // Read only if the service asks, so an unknown or paused trigger never pulls the body.
        const contentLength = Number(request.headers["content-length"] ?? "0");
        const body: Effect.Effect<
          Uint8Array,
          SquireWebhookBodyTooLarge | HttpServerError.HttpServerError
        > =
          !Number.isFinite(contentLength) || contentLength > SQUIRE_WEBHOOK_MAX_BODY_BYTES
            ? Effect.fail(new SquireWebhookBodyTooLarge())
            : request.arrayBuffer.pipe(
                Effect.map((buffer) => new Uint8Array(buffer)),
                Effect.provideService(
                  HttpIncomingMessage.MaxBodySize,
                  ByteSize.bytes(SQUIRE_WEBHOOK_MAX_BODY_BYTES),
                ),
              );
        const receipt = yield* triggers.value.receive(triggerId, headers, body).pipe(
          Effect.catchTags({
            SquireError: (error) =>
              Effect.logWarning("Squire webhook receipt failed").pipe(
                Effect.annotateLogs({ triggerId, code: error.code }),
                Effect.as({ outcome: "error" as const }),
              ),
          }),
        );
        switch (receipt.outcome) {
          case "queued":
          case "duplicate":
            return json(202, { status: receipt.outcome });
          case "not_found":
            return json(404, { error: "hook_not_found" });
          case "unauthorized":
            return json(401, { error: "invalid_signature" });
          case "too_large":
            return json(413, { error: "body_too_large" });
          case "rate_limited": {
            const now = yield* Clock.currentTimeMillis;
            const seconds = Math.max(1, Math.ceil((Date.parse(receipt.retryAt) - now) / 1000));
            return json(
              429,
              { error: "rate_limited", retryAt: receipt.retryAt },
              { "retry-after": String(seconds) },
            );
          }
          case "error":
            return json(500, { error: "internal_error" });
        }
      }),
    ),
  ),
);

export const layer = Layer.mergeAll(
  layerDevFixtureRoute,
  layerActionLogExportRoute,
  layerWebhookRoute,
);
