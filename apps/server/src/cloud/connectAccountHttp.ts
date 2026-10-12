import {
  AuthOrchestrationOperateScope,
  ConnectAccountError,
  EnvironmentHttpApi,
} from "@lecturn/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { requireEnvironmentScope } from "../auth/http.ts";
import { ConnectAccount } from "./ConnectAccount.ts";

const isLoopbackAddress = (address: string) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

/** Cookie + local transport + browser intent, independent of remotely delegated scopes.
 * Do not accept forwarded address/origin assertions from relay or reverse proxies.
 */
export const requireLocalConnectAccountOwner = Effect.fn("ConnectAccount.requireLocalOwner")(
  function* () {
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(
        HttpServerResponse.setHeaders(response, {
          "cache-control": "no-store",
          pragma: "no-cache",
        }),
      ),
    );
    const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const headers = request.headers;
    // Android forwards loopback through QEMU SLIRP. Only the dedicated guest
    // deployment may trust that fixed socket peer, on the phone's literal Host.
    const phoneVmConnect = yield* Config.string("LECTURN_PHONE_VM_CONNECT").pipe(
      Config.withDefault(""),
      Effect.map((value) => value === "1"),
      Effect.orElseSucceed(() => false),
    );
    const localTransport = Option.exists(
      request.remoteAddress,
      (address) =>
        isLoopbackAddress(address) ||
        (phoneVmConnect &&
          headers.host === "127.0.0.1:3773" &&
          (address === "10.0.2.2" || address === "::ffff:10.0.2.2")),
    );
    const referer = headers.referer;
    const origin =
      headers.origin ??
      (request.method === "GET" && referer && URL.canParse(referer)
        ? new URL(referer).origin
        : undefined);
    const url = origin && URL.canParse(origin) ? new URL(origin) : null;
    const localOrigin =
      url !== null &&
      url.origin === origin &&
      url.host === headers.host &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      principal.method !== "browser-session-cookie" ||
      principal.subject === "cloud-connect" ||
      !localTransport ||
      !localOrigin ||
      headers["x-lecturn-connect-account"] !== "local-ui" ||
      (headers["sec-fetch-site"] !== undefined && headers["sec-fetch-site"] !== "same-origin") ||
      Object.keys(headers).some(
        (name) => name === "forwarded" || name.startsWith("x-forwarded-") || name.startsWith("cf-"),
      )
    ) {
      return yield* new ConnectAccountError({
        reason: "local_ui_required",
        message: "Connect account access requires the authenticated local phone UI.",
      });
    }
    return { sessionId: principal.sessionId, subject: principal.subject };
  },
);

export const connectAccountHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connectAccount",
  Effect.fnUntraced(function* (handlers) {
    const account = yield* ConnectAccount;
    return handlers
      .handle("status", () => Effect.andThen(requireLocalConnectAccountOwner(), account.status))
      .handle("begin", () => requireLocalConnectAccountOwner().pipe(Effect.flatMap(account.begin)))
      .handle("complete", ({ payload }) =>
        requireLocalConnectAccountOwner().pipe(
          Effect.flatMap((owner) => account.complete(owner, payload.requestId, payload.code)),
        ),
      )
      .handle("cancel", ({ payload }) =>
        requireLocalConnectAccountOwner().pipe(
          Effect.flatMap((owner) => account.cancel(owner, payload.requestId)),
        ),
      )
      .handle("token", ({ payload }) =>
        Effect.andThen(requireLocalConnectAccountOwner(), account.token(payload.accountId)),
      )
      .handle("logout", () => Effect.andThen(requireLocalConnectAccountOwner(), account.logout));
  }),
);
