import {
  exchangeRemoteDpopAccessToken,
  issueRemoteDpopWebSocketTicket,
} from "@lecturn/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@lecturn/client-runtime/environment";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Headers, HttpClient } from "effect/unstable/http";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { makeWebRemoteHttpClientLayer } from "./remoteHttpLayer";

afterEach(() => vi.unstubAllGlobals());

describe("web remote HTTP transport", () => {
  it.effect("preserves proof and gateway header redaction in the phone runtime", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", { symbaHost: { protocolVersion: 2 } });
      const names = yield* Headers.CurrentRedactedNames.pipe(
        Effect.provide(makeWebRemoteHttpClientLayer(fetch)),
      );
      expect(names).toEqual(
        expect.arrayContaining(["dpop", "x-lecturn-gateway-auth", "x-lecturn-gateway-path"]),
      );
    }),
  );
  it.effect("sends native JSON Accept through generated descriptor, OAuth and ticket clients", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", { symbaHost: { protocolVersion: 2 } });
      const descriptor = {
        environmentId: "synthetic-environment",
        label: "Synthetic environment",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      };
      const responses = [
        descriptor,
        {
          access_token: "synthetic-access",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 3600,
          scope: "orchestration:read",
        },
        { ticket: "synthetic-ticket", expiresAt: "2030-01-01T00:00:00.000Z" },
      ];
      const requests: Array<Request> = [];
      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        // These requests need the existing native policy's JSON-fetch classification.
        expect(new URL(request.url).protocol).toBe("https:");
        expect(request.headers.get("accept")).toBe("application/json");
        const response = responses.shift();
        if (!response) throw new Error("Unexpected request");
        return Response.json(response);
      };
      const httpBaseUrl = "https://environment.example.test/";
      yield* Effect.gen(function* () {
        expect(yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl })).toEqual(descriptor);
        const token = yield* exchangeRemoteDpopAccessToken({
          httpBaseUrl,
          credential: "synthetic-bootstrap",
          dpopProof: "synthetic-token-proof",
          scopes: ["orchestration:read"],
        });
        const auth = {
          httpBaseUrl,
          accessToken: token.access_token,
          dpopProof: "synthetic-resource-proof",
        };
        expect((yield* issueRemoteDpopWebSocketTicket(auth)).ticket).toBe("synthetic-ticket");
      }).pipe(Effect.provide(makeWebRemoteHttpClientLayer(fetcher)));

      expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
        { method: "GET", url: `${httpBaseUrl}.well-known/lecturn/environment` },
        { method: "POST", url: `${httpBaseUrl}oauth/token` },
        { method: "POST", url: `${httpBaseUrl}api/auth/websocket-ticket` },
      ]);
      const [discovery, exchange, ...authenticated] = requests;
      expect(discovery!.headers.has("authorization")).toBe(false);
      expect(discovery!.headers.has("dpop")).toBe(false);
      expect(exchange!.headers.has("authorization")).toBe(false);
      expect(exchange!.headers.get("dpop")).toBe("synthetic-token-proof");
      expect(exchange!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(yield* Effect.promise(() => exchange!.text())).toBe(
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=synthetic-bootstrap&subject_token_type=urn%3Alecturn%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&scope=orchestration%3Aread",
      );
      for (const request of authenticated) {
        expect(request.headers.get("authorization")).toBe("DPoP synthetic-access");
        expect(request.headers.get("dpop")).toBe("synthetic-resource-proof");
      }
    }),
  );

  for (const surface of ["phone", "web", "desktop"] as const) {
    it.effect(
      `preserves explicit Accept and ${surface === "phone" ? "defaults JSON on phone" : `leaves ${surface} defaults unchanged`}`,
      () =>
        Effect.gen(function* () {
          vi.stubGlobal(
            "window",
            surface === "phone"
              ? { symbaHost: {} }
              : surface === "desktop"
                ? { desktopBridge: {} }
                : {},
          );
          const requests: Array<Request> = [];
          const fetcher: typeof fetch = async (input, init) => {
            requests.push(new Request(input, init));
            return Response.json({});
          };
          yield* Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            yield* client.get("https://api.example.test/default");
            yield* client.get("https://api.example.test/explicit", {
              headers: { Accept: "text/plain" },
            });
            yield* client.get("https://api.example.test/wildcard", { headers: { ACCEPT: "*/*" } });
          }).pipe(Effect.provide(makeWebRemoteHttpClientLayer(fetcher)));
          expect(requests.map((request) => request.headers.get("accept"))).toEqual([
            surface === "phone" ? "application/json" : null,
            "text/plain",
            "*/*",
          ]);
        }),
    );
  }
});
