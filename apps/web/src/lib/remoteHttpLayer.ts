import { layerRemoteHttpClient } from "@lecturn/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/http";
import { hasPhoneConnectAccount } from "./androidHostAccess";

export function makeWebRemoteHttpClientLayer(fetchFn: typeof globalThis.fetch) {
  const baseLayer = layerRemoteHttpClient(fetchFn);
  if (!hasPhoneConnectAccount()) return baseLayer;

  // Native OriginPolicy recognizes JSON API fetches by Accept, including unauthenticated
  // descriptors and form-encoded token exchanges that carry DPoP without Authorization.
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.mapRequest((request) =>
        request.headers.accept === undefined ? HttpClientRequest.acceptJson(request) : request,
      ),
    ),
  ).pipe(Layer.provideMerge(baseLayer));
}
