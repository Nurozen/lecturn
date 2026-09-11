import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { makeManagedGatewayHttpClient } from "./ManagedGatewayHttpClient.ts";

class GatewayUnavailable extends Data.TaggedError("GatewayUnavailable") {}

const hostname = "0123456789abcdef-g-prod.example.com";
const hostnameSuffix = "-g-prod.example.com";

describe("managed environment internal HTTP transport", () => {
  it.effect("sends mint requests through the gateway binding with body and headers intact", () =>
    Effect.gen(function* () {
      const client = makeManagedGatewayHttpClient({
        hostnameSuffix,
        fallback: HttpClient.make(() => Effect.die("Managed hostname must never use DNS fetch")),
        dispatch: (request) =>
          Effect.promise(async () => {
            expect(request.url).toBe(`https://${hostname}/api/lecturn-connect/mint-credential`);
            expect(request.method).toBe("POST");
            expect(request.headers.get("authorization")).toBe("Bearer test-token");
            expect(await request.json()).toEqual({ proof: "signed-environment-proof" });
            return Response.json({ credential: "minted" });
          }),
      });
      const response = yield* client.execute(
        HttpClientRequest.post(`https://${hostname}/api/lecturn-connect/mint-credential`).pipe(
          HttpClientRequest.setHeader("authorization", "Bearer test-token"),
          HttpClientRequest.bodyJsonUnsafe({ proof: "signed-environment-proof" }),
        ),
      );
      expect(yield* response.json).toEqual({ credential: "minted" });
    }),
  );

  it.effect("preserves direct and external environment transports", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const client = makeManagedGatewayHttpClient({
        hostnameSuffix,
        fallback: HttpClient.make((request) => {
          seen.push(request.url);
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("direct")));
        }),
        dispatch: () => Effect.die("Direct endpoint must not enter gateway"),
      });
      for (const url of [
        "https://prod-123.example.com/health",
        "https://remote.other.example/health",
        "http://localhost:3773/health",
      ]) {
        expect(yield* (yield* client.get(url)).text).toBe("direct");
      }
      expect(seen).toHaveLength(3);
    }),
  );

  it.effect("preserves gateway access denial without falling back to the direct tunnel", () =>
    Effect.gen(function* () {
      const client = makeManagedGatewayHttpClient({
        hostnameSuffix,
        fallback: HttpClient.make(() => Effect.die("No direct bypass")),
        dispatch: () => Effect.succeed(new Response("Connect access expired", { status: 402 })),
      });
      const response = yield* client.get(`https://${hostname}/health`);
      expect(response.status).toBe(402);
      expect(yield* response.text).toBe("Connect access expired");
    }),
  );

  it.effect("fails closed on gateway dispatch failure and malformed managed hosts", () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = makeManagedGatewayHttpClient({
        hostnameSuffix,
        fallback: HttpClient.make(() => Effect.die("No direct bypass")),
        dispatch: () => {
          calls++;
          return Effect.fail(new GatewayUnavailable());
        },
      });
      const result = yield* client.get(`https://${hostname}/health`).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      for (const url of [
        `http://${hostname}/health`,
        "https://wrong-g-prod.example.com/health",
        `https://${hostname}:8443/health`,
      ]) {
        expect((yield* client.get(url)).status).toBe(404);
      }
      expect(calls).toBe(1);
    }),
  );
});
