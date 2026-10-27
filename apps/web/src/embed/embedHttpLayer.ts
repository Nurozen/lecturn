import { layerRemoteHttpClient } from "@lecturn/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { readEmbedBearerToken } from "./embedAuth";

const OMIT_CREDENTIALS: RequestInit = { credentials: "omit" };

/**
 * The embed shares the user's Lecturn origin, so a same-origin fetch would carry the user's
 * session cookie and could act as the user. FetchHttpClient reads `RequestInit` from the calling
 * fiber, and some consumers build a client from one layer and run it in a runtime that never saw
 * that layer's `RequestInit`, so the setting is pinned to the client itself.
 */
function withoutCookies(client: HttpClient.HttpClient): HttpClient.HttpClient {
  return HttpClient.transformResponse(
    client,
    Effect.provideService(FetchHttpClient.RequestInit, OMIT_CREDENTIALS),
  );
}

/** Re-read per request so a refreshed embed token applies without rebuilding the layer. */
function withEmbedBearer(client: HttpClient.HttpClient): HttpClient.HttpClient {
  return client.pipe(
    HttpClient.mapRequestEffect((request) =>
      Effect.promise(readEmbedBearerToken).pipe(
        Effect.map((token) => (token ? HttpClientRequest.bearerToken(request, token) : request)),
      ),
    ),
  );
}

/** Keeps a layer's HttpClient off cookies, for clients that set their own Authorization. */
export function layerWithoutCookies<E, R>(layer: Layer.Layer<HttpClient.HttpClient, E, R>) {
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, withoutCookies),
  ).pipe(Layer.provide(layer));
}

/**
 * Every primary HTTP request the embed page makes: the embed bearer, never cookies, so no request
 * can authenticate as the user's own session.
 */
export function makeEmbedHttpLayer() {
  return Layer.merge(
    Layer.effect(
      HttpClient.HttpClient,
      Effect.map(HttpClient.HttpClient, (client) => withoutCookies(withEmbedBearer(client))),
    ).pipe(Layer.provide(layerRemoteHttpClient(globalThis.fetch))),
    Layer.succeed(FetchHttpClient.RequestInit, OMIT_CREDENTIALS),
  );
}
