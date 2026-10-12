import { EnvironmentId } from "@lecturn/contracts";
import { RelayAccessTokenType, RelayEnvironmentConnectScope } from "@lecturn/contracts/relay";
import { ManagedRelay, createManagedRelaySession } from "@lecturn/client-runtime/relay";
import { remoteHttpClientLayer } from "@lecturn/client-runtime/rpc";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { phoneConnectAccount } from "./phoneConnectAccount";
import { phoneManagedRelayLayer } from "./phoneManagedRelay";

const endpoint = {
  httpBaseUrl: "https://desktop.example.test/",
  wsBaseUrl: "wss://desktop.example.test/ws",
  providerKind: "cloudflare_tunnel",
};
afterEach(() => vi.unstubAllGlobals());

describe("phone managed relay transport", () => {
  it.effect(
    "uses server account credentials and runtime configuration for discovery and remote bootstrap",
    () =>
      Effect.gen(function* () {
        let configured = false;
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>(async (input) => {
            if (String(input).endsWith("/token"))
              return Response.json({ token: "opaque-phone-test-credential" });
            return Response.json({
              configured,
              state: configured ? "signed-in" : "signed-out",
              account: configured ? { id: "phone-account" } : null,
              relayUrl: configured ? "https://phone-relay.example.test" : null,
            });
          }),
        );
        yield* Effect.promise(() => phoneConnectAccount.refresh());
        const requests: Array<{ host: string; path: string; authorized: boolean }> = [];
        const fetcher: typeof fetch = async (input, init) => {
          const url = new URL(String(input));
          const headers = new Headers(init?.headers);
          requests.push({
            host: url.host,
            path: url.pathname,
            authorized: headers.has("authorization"),
          });
          if (url.pathname.endsWith("/dpop-token")) {
            const payload = new URLSearchParams(await new Request(input, init).text());
            expect(payload.get("subject_token") === "opaque-phone-test-credential").toBe(true);
            expect(payload.get("subject_token_type")).toBe(RelayAccessTokenType);
            return Response.json({
              access_token: "test-dpop-access",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "DPoP",
              expires_in: 1800,
              scope: RelayEnvironmentConnectScope,
            });
          }
          if (url.pathname.endsWith("/connect"))
            return Response.json({
              environmentId: "remote-environment",
              endpoint,
              credential: "test-environment-credential",
              expiresAt: "2030-01-01T00:00:00.000Z",
            });
          return Response.json({
            environments: [
              {
                environmentId: "remote-environment",
                label: "Remote desktop",
                endpoint,
                linkedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
        };
        const layer = phoneManagedRelayLayer.pipe(
          Layer.provide(remoteHttpClientLayer(fetcher)),
          Layer.provide(
            Layer.succeed(
              ManagedRelay.ManagedRelayDpopSigner,
              ManagedRelay.ManagedRelayDpopSigner.of({
                thumbprint: Effect.succeed("test-thumbprint"),
                createProof: () => Effect.succeed("test-proof"),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const client = yield* ManagedRelay.ManagedRelayClient;
          // Acquired while disabled; server configuration arrives after pairing.
          configured = true;
          yield* Effect.promise(() => phoneConnectAccount.refresh());
          const session = createManagedRelaySession({
            accountId: "phone-account",
            readClerkToken: () => phoneConnectAccount.readToken("phone-account"),
          });
          const token = yield* session.readClerkToken();
          expect(token !== null).toBe(true);
          const environments = yield* client.listEnvironments({ clerkToken: token! });
          expect(environments.map((environment) => environment.environmentId)).toEqual([
            "remote-environment",
          ]);
          const connection = yield* client.connectEnvironment({
            clerkToken: token!,
            scopes: [RelayEnvironmentConnectScope],
            environmentId: EnvironmentId.make("remote-environment"),
          });
          expect(connection.environmentId).toBe(environments[0]?.environmentId);
          expect(connection.credential.length > 0).toBe(true);
          expect(requests.every((request) => request.host === "phone-relay.example.test")).toBe(
            true,
          );
          expect(
            requests.some((request) => request.path.endsWith("/connect") && request.authorized),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      }),
  );
});
