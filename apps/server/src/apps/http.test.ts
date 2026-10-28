import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { APPS_PAIRING_REQUESTS_PATH, APPS_POLL_SECRET_HEADER } from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/http";

import * as SessionStore from "../auth/SessionStore.ts";
import * as AppsHttp from "./http.ts";
import { type PairingPeer, pairingRefusal } from "./pairingGuard.ts";
import { AppRegistryService } from "./services.ts";
import { makeRegistryLayer, registrationInput } from "./testing/appRegistryTestLayer.ts";

const local: PairingPeer = {
  headers: { host: "127.0.0.1:3773", "content-type": "application/json" },
  remoteAddress: "127.0.0.1",
};

describe("pairingRefusal", () => {
  it("accepts a direct request from this machine by any loopback name", () => {
    expect(pairingRefusal(local)).toBeNull();
    expect(
      pairingRefusal({ headers: { host: "localhost:3773" }, remoteAddress: "::1" }),
    ).toBeNull();
    expect(
      pairingRefusal({ headers: { host: "[::1]:3773" }, remoteAddress: "127.0.0.2" }),
    ).toBeNull();
  });

  it("refuses requests a browser sent", () => {
    expect(
      pairingRefusal({ ...local, headers: { ...local.headers, origin: "http://127.0.0.1:5173" } }),
    ).toBe("origin");
  });

  it("refuses requests that came through a proxy or Tailscale", () => {
    for (const header of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-real-ip",
      "tailscale-user-login",
    ]) {
      expect(
        pairingRefusal({ ...local, headers: { ...local.headers, [header]: "x" } }),
        header,
      ).toBe("forwarded");
    }
  });

  it("refuses a host that is not loopback, including disguised ones", () => {
    for (const host of [
      "lecturn.example:3773",
      "192.168.1.5:3773",
      "evil@127.0.0.1",
      "127.0.0.1.nip.io",
    ]) {
      expect(pairingRefusal({ ...local, headers: { host } }), host).toBe("host");
    }
    expect(pairingRefusal({ ...local, headers: {} })).toBe("host");
  });

  it("refuses a peer that is not on this machine", () => {
    for (const remoteAddress of ["192.168.1.23", "100.64.0.7", "fe80::1", undefined]) {
      expect(pairingRefusal({ ...local, remoteAddress }), String(remoteAddress)).toBe(
        "remote-address",
      );
    }
  });
});

const withServer = <A, E>(
  body: (context: {
    readonly client: HttpClient.HttpClient;
    readonly registry: AppRegistryService["Service"];
    readonly sessions: SessionStore.SessionStore["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { layer: registryLayer } = makeRegistryLayer();
      const services = yield* Layer.build(
        HttpRouter.serve(AppsHttp.layer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.provideMerge(registryLayer),
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      );
      return yield* body({
        client: Context.get(services, HttpClient.HttpClient),
        registry: Context.get(services, AppRegistryService),
        sessions: Context.get(services, SessionStore.SessionStore),
      });
    }),
  );

const postRegistration = (client: HttpClient.HttpClient, headers: Record<string, string> = {}) =>
  client.execute(
    HttpClientRequest.post(APPS_PAIRING_REQUESTS_PATH).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyJsonUnsafe(registrationInput()),
    ),
  );

const pollRequest = (client: HttpClient.HttpClient, requestId: string, pollSecret?: string) =>
  client.execute(
    HttpClientRequest.get(`${APPS_PAIRING_REQUESTS_PATH}/${requestId}`).pipe(
      HttpClientRequest.setHeaders(
        pollSecret === undefined ? {} : { [APPS_POLL_SECRET_HEADER]: pollSecret },
      ),
    ),
  );

const json = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(Effect.map((body) => body as Record<string, unknown>));

it.layer(NodeServices.layer)("pairing routes", (it) => {
  it.effect("pairs an app through the prompt and hands its credential over once", () =>
    withServer(({ client, registry, sessions }) =>
      Effect.gen(function* () {
        const created = yield* postRegistration(client);
        expect(created.status).toBe(201);
        expect(created.headers["cache-control"]).toBe("no-store");
        const { requestId, pollSecret } = (yield* json(created)) as {
          requestId: string;
          pollSecret: string;
        };

        const waiting = yield* pollRequest(client, requestId, pollSecret);
        expect(yield* json(waiting)).toEqual({ state: "pairing-requested" });

        yield* registry.decidePairing({ requestId, decision: "grant" });
        const granted = yield* json(yield* pollRequest(client, requestId, pollSecret));
        const credential = granted["credential"] as { token: string; environmentId: string };
        expect(granted["state"]).toBe("granted");
        expect((yield* sessions.verify(credential.token)).subject).toBe("app:dev.example.app");

        expect(yield* json(yield* pollRequest(client, requestId, pollSecret))).toEqual({
          state: "granted",
        });
      }),
    ),
  );

  it.effect("refuses browser-sent requests before reading them", () =>
    withServer(({ client, registry }) =>
      Effect.gen(function* () {
        const refused = yield* postRegistration(client, { origin: "http://127.0.0.1:5173" });
        expect(refused.status).toBe(403);
        expect((yield* json(refused))["error"]).toBe("forbidden");
        expect(yield* registry.list).toEqual([]);

        const proxied = yield* postRegistration(client, { "x-forwarded-for": "203.0.113.9" });
        expect(proxied.status).toBe(403);
      }),
    ),
  );

  it.effect("answers bad input without revealing which request ids exist", () =>
    withServer(({ client }) =>
      Effect.gen(function* () {
        const badBody = yield* client.execute(
          HttpClientRequest.post(APPS_PAIRING_REQUESTS_PATH).pipe(
            HttpClientRequest.bodyJsonUnsafe({ appId: "Not An Id" }),
          ),
        );
        expect(badBody.status).toBe(400);
        const scriptUrl = yield* client.execute(
          HttpClientRequest.post(APPS_PAIRING_REQUESTS_PATH).pipe(
            HttpClientRequest.bodyJsonUnsafe(
              registrationInput({ openUrlTemplate: "javascript:alert(document.cookie)" }),
            ),
          ),
        );
        expect(scriptUrl.status).toBe(400);

        const created = (yield* json(yield* postRegistration(client))) as { requestId: string };
        expect((yield* pollRequest(client, created.requestId)).status).toBe(400);
        const wrongSecret = yield* pollRequest(client, created.requestId, "wrong");
        const unknownId = yield* pollRequest(client, "unknown-request", "wrong");
        expect(wrongSecret.status).toBe(404);
        expect(yield* json(wrongSecret)).toEqual(yield* json(unknownId));
      }),
    ),
  );
});
