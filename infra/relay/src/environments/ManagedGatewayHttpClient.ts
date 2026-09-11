import { Context, Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/** Internal Worker requests must use the gateway binding, not same-zone DNS fetches. */
export class ManagedGatewayHttpClient extends Context.Service<
  ManagedGatewayHttpClient,
  HttpClient.HttpClient
>()("lecturn-relay/environments/ManagedGatewayHttpClient") {}

export function makeManagedGatewayHttpClient<E>(options: {
  readonly fallback: HttpClient.HttpClient;
  readonly hostnameSuffix: string;
  readonly dispatch: (request: Request) => Effect.Effect<Response, E>;
}) {
  return HttpClient.make((request, url, signal) => {
    if (!url.hostname.endsWith(options.hostnameSuffix)) return options.fallback.execute(request);
    return Effect.gen(function* () {
      // Never fall back to the direct tunnel when gateway lookup or entitlement checks fail.
      if (
        url.protocol !== "https:" ||
        url.port ||
        !/^[a-f0-9]{16}$/.test(url.hostname.slice(0, -options.hostnameSuffix.length))
      ) {
        return HttpClientResponse.fromWeb(
          request,
          new Response("Unknown managed environment", { status: 404 }),
        );
      }
      const webRequest = yield* HttpClientRequest.toWeb(request, { signal });
      const response = yield* options.dispatch(webRequest);
      return HttpClientResponse.fromWeb(request, response);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
      ),
    );
  });
}
