import * as Alchemy from "alchemy";
import type { HttpEffect } from "alchemy/Http";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Redacted } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RelayDeploymentConfig } from "../zone.ts";
import { createManagedGateway, type GatewaySnapshot } from "../billing/ManagedGateway.ts";

export const ManagedGatewaySecret = Alchemy.makeRandom("ManagedGatewaySecret", { bytes: 32 });

/** Raw responses preserve Cloudflare's WebSocket upgrade and streaming body ownership. */
export const gatewayHttpResponse = (response: Response) =>
  HttpServerResponse.setBody(
    HttpServerResponse.empty({ status: response.status }),
    // Effect adds tracing headers when converting raw responses back to the platform.
    HttpBody.raw(new Response(response.body, response)),
  );

/** Binding fetch adapters return WebSocket upgrades as raw platform responses. */
export const mutableGatewayBindingResponse = (response: HttpServerResponse.HttpServerResponse) =>
  response.body._tag === "Raw" && response.body.body instanceof Response
    ? HttpServerResponse.setBody(
        response,
        HttpBody.raw(new Response(response.body.body.body, response.body.body)),
      )
    : response;

export class ManagedGateway extends Cloudflare.DurableObject<
  ManagedGateway,
  {
    update(snapshot: GatewaySnapshot): Effect.Effect<"applied" | "unchanged" | "stale">;
    alarm(): Effect.Effect<void>;
    fetch: HttpEffect;
  }
>()("ManagedGateway") {}

export const ManagedGatewayLive = ManagedGateway.make(
  Effect.gen(function* () {
    const { relayPublicOrigin } = yield* RelayDeploymentConfig.pipe(Effect.orDie);
    const secretResource = yield* ManagedGatewaySecret;
    const secret = yield* secretResource;
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const gateway = createManagedGateway({
        secret: Redacted.value(yield* secret),
        hopOrigin: relayPublicOrigin,
        fetch: globalThis.fetch,
        storage: {
          load: async () => (await state.raw.storage.get<GatewaySnapshot>("snapshot")) ?? null,
          commit: async (snapshot, alarm) => {
            await state.raw.storage.transaction(async (transaction) => {
              await transaction.put("snapshot", snapshot);
              if (alarm === null) await transaction.deleteAlarm();
              else await transaction.setAlarm(alarm);
            });
          },
        },
      });
      yield* Effect.promise(() => state.raw.blockConcurrencyWhile(() => gateway.ready));
      return {
        // Service-binding RPC only. The public fetch handler cannot mutate entitlement snapshots.
        update: (snapshot: GatewaySnapshot) => Effect.promise(() => gateway.update(snapshot)),
        alarm: () => Effect.promise(() => gateway.alarm()),
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const webRequest = yield* HttpServerRequest.toWeb(request);
          return gatewayHttpResponse(yield* Effect.promise(() => gateway.fetch(webRequest)));
        }).pipe(
          Effect.catch(() =>
            Effect.succeed(HttpServerResponse.text("Invalid request", { status: 400 })),
          ),
        ),
      };
    });
  }),
);
