import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { OtlpTracer } from "effect/unstable/observability";

import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import { reportBillingHealth, traceBillingMaintenance } from "./billing/BillingHealthTelemetry.ts";
import { makeRelayTraceLayer } from "./observability.ts";

interface ExportedRequest {
  readonly authorization: string | undefined;
  readonly body: string;
  readonly dataset: string | undefined;
}

const otlpAttributeValue = (value: {
  readonly stringValue?: string | null;
  readonly boolValue?: boolean | null;
  readonly intValue?: string | number | null;
  readonly doubleValue?: number | null;
}) => value.stringValue ?? value.boolValue ?? value.intValue ?? value.doubleValue;

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("exports schema error fields as span attributes", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* Deferred.make<ExportedRequest>();
    yield* HttpServer.serveEffect(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* Deferred.succeed(exportedRequest, {
          authorization: request.headers.authorization,
          body: yield* request.text,
          dataset: request.headers["x-axiom-dataset"],
        });
        return HttpServerResponse.empty({ status: 204 });
      }),
    );

    yield* Effect.fail(
      new EnvironmentConnector.EnvironmentConnectNotAuthorized({
        environmentId: "environment-1",
        operation: "connect",
        reason: "managed_endpoint_allocation_not_ready",
      }),
    ).pipe(
      Effect.withSpan("relay.test.schema_error"),
      Effect.exit,
      Effect.provide(
        makeRelayTraceLayer({
          tracesEndpoint: "/v1/traces",
          tracesDatasetName: "relay-test-traces",
          ingestToken: Redacted.make("test-token"),
        }),
      ),
    );

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const payload = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = payload.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.schema_error");
    const attributes = Object.fromEntries(
      (span?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    expect(request.authorization).toBe("Bearer test-token");
    expect(request.dataset).toBe("relay-test-traces");
    expect(attributes).toMatchObject({
      "error.type": "EnvironmentConnectNotAuthorized",
      "error.environmentId": "environment-1",
      "error.operation": "connect",
      "error.reason": "managed_endpoint_allocation_not_ready",
    });
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("flushes scheduled billing health with numeric attributes before returning", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    yield* HttpServer.serveEffect(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        requests.push(yield* request.text);
        return HttpServerResponse.empty({ status: 204 });
      }),
    );
    yield* traceBillingMaintenance(
      reportBillingHealth(
        Effect.succeed({
          pending_events: 3,
          pending_payment_reviews: 0,
          oldest_pending_seconds: 61,
          quarantined_events: 0,
          stale_accounts: 0,
          deleted_renewals: 0,
          pending_suspensions: 0,
          oldest_suspension_seconds: 0,
          identity_checks_overdue: 0,
          identity_check_failures: 0,
        }),
      ),
      makeRelayTraceLayer({
        tracesEndpoint: "/v1/traces",
        tracesDatasetName: "relay-test-traces",
        ingestToken: Redacted.make("test-token"),
      }),
    );
    // No sleep or explicit flush: scheduled handler completion must drain its exporter.
    expect(requests.length).toBeGreaterThan(0);
    const spans = requests.flatMap((body) =>
      (JSON.parse(body) as OtlpTracer.TraceData).resourceSpans.flatMap((r) =>
        r.scopeSpans.flatMap((s) => s.spans),
      ),
    );
    const health = spans.find((span) => span.name === "relay.billing.health");
    const parent = spans.find((span) => span.name === "relay.billing.reconcile_pending");
    expect(health?.parentSpanId).toBe(parent?.spanId);
    const attributes = Object.fromEntries(
      (health?.attributes ?? []).map((a) => [a.key, otlpAttributeValue(a.value)]),
    );
    expect(Number(attributes["billing.health.pending_events"])).toBe(3);
    expect(Number(attributes["billing.health.oldest_pending_seconds"])).toBe(61);
    expect(Number(attributes["billing.health.deleted_renewals"])).toBe(0);
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);
