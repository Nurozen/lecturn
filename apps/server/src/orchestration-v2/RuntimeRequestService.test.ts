import { assert, it, vi } from "@effect/vitest";
import {
  AppId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as AppToolApprovalRegistry from "../apps/AppToolApprovalRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";

function projectionWithRuntimeRequest(
  runtimeRequest?: OrchestrationV2RuntimeRequest,
): OrchestrationV2ThreadProjection {
  return {
    runtimeRequests: runtimeRequest === undefined ? [] : [runtimeRequest],
  } as unknown as OrchestrationV2ThreadProjection;
}

function resolvedRuntimeRequest(
  requestId: RuntimeRequestId,
  providerSessionId: ProviderSessionId,
): OrchestrationV2RuntimeRequest {
  return {
    id: requestId,
    nodeId: NodeId.make(`node-${requestId}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "resolved",
    responseCapability: {
      type: "live",
      providerSessionId,
    },
    createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
    resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
  };
}

function layerRuntimeRequestTest(
  projection: OrchestrationV2ThreadProjection,
  getSession: ProviderSessionManager.ProviderSessionManagerV2Shape["get"],
) {
  return RuntimeRequestService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        AppToolApprovalRegistry.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: (_threadId, requestId) =>
            Effect.succeed(projection.runtimeRequests.find((request) => request.id === requestId)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );
}

it.effect.each(["expired", "resolved"] as const)(
  "responds only to resolved requests and preserves feedback (%s)",
  (status) => {
    const threadId = ThreadId.make("thread-runtime-request-expired");
    const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-expired");
    const requestId = RuntimeRequestId.make("request-expired");
    const respondToRuntimeRequest = vi.fn(
      (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
    );
    const getSession = vi.fn(() =>
      Effect.succeedSome({
        respondToRuntimeRequest,
      } as never),
    );
    const projection = {
      runtimeRequests: [
        {
          id: requestId,
          nodeId: NodeId.make("node-runtime-request-expired"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status,
          responseCapability: {
            type: "live",
            providerSessionId,
          },
          createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
          resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layerTest = RuntimeRequestService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          AppToolApprovalRegistry.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRuntimeRequest: (_threadId, requestId) =>
              Effect.succeed(
                projection.runtimeRequests.find((request) => request.id === requestId),
              ),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: getSession,
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      const response = service.respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "decline",
        feedback: "Use an explicit path.",
      });
      if (status === "resolved") {
        yield* response;
        assert.deepEqual(respondToRuntimeRequest.mock.calls, [
          [
            {
              requestId,
              decision: "decline",
              feedback: "Use an explicit path.",
            },
          ],
        ]);
        return;
      }
      const error = yield* response.pipe(Effect.flip);

      assert.equal(error.reason, "request-not-ready");
      assert.equal(
        error.message,
        `Runtime request ${requestId} on thread ${threadId} is not ready for response execution.`,
      );
      assert.isUndefined(error.cause);
      assert.equal(getSession.mock.calls.length, 0);
      assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "never routes a connected-app approval to the provider, even with no waiting call",
  () => {
    const threadId = ThreadId.make("thread-runtime-request-app-tool");
    const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-app-tool");
    const requestId = RuntimeRequestId.make("request-app-tool");
    const getSession = vi.fn(() => Effect.succeedNone);
    const layerTest = layerRuntimeRequestTest(
      projectionWithRuntimeRequest({
        ...resolvedRuntimeRequest(requestId, providerSessionId),
        kind: "permission",
        connectedAppTool: {
          appId: AppId.make("dev.example.counter"),
          appName: "Counter",
          toolName: "ex_counter_increment",
          reason: null,
          source: "static",
        },
      }),
      getSession,
    );

    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      yield* service.respond({ threadId, providerSessionId, requestId, decision: "accept" });
      assert.equal(getSession.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "answers a claimed request to the waiting call while its provider session is live",
  () => {
    const threadId = ThreadId.make("thread-runtime-request-app-claimed");
    const providerSessionId = ProviderSessionId.make(
      "provider-session-runtime-request-app-claimed",
    );
    const requestId = RuntimeRequestId.make("request-app-claimed");
    const respondToRuntimeRequest = vi.fn(
      (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
    );
    const getSession = vi.fn(() => Effect.succeedSome({ respondToRuntimeRequest } as never));
    const layerTest = layerRuntimeRequestTest(
      projectionWithRuntimeRequest({
        ...resolvedRuntimeRequest(requestId, providerSessionId),
        kind: "permission",
      }),
      getSession,
    );

    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      const registry = yield* AppToolApprovalRegistry.AppToolApprovalRegistry;
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* registry.register(requestId);
          yield* service.respond({ threadId, providerSessionId, requestId, decision: "accept" });
          return yield* registry.awaitDecision(requestId);
        }),
      );
      assert.equal(outcome, "approved");
      assert.equal(getSession.mock.calls.length, 0);
      assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  },
);
