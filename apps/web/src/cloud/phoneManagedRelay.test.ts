import { EnvironmentId } from "@lecturn/contracts";
import { RelayJwtSubjectTokenType, RelayEnvironmentConnectScope } from "@lecturn/contracts/relay";
import { ManagedRelay, createManagedRelaySession } from "@lecturn/client-runtime/relay";
import { makeWebRemoteHttpClientLayer } from "../lib/remoteHttpLayer";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { phoneConnectAccount } from "./phoneConnectAccount";
import { phoneManagedRelayLayer } from "./phoneManagedRelay";

const nativeToken = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: "phone-account" }))}.synthetic`;

const endpoint = {
  httpBaseUrl: "https://desktop.example.test/",
  wsBaseUrl: "wss://desktop.example.test/ws",
  providerKind: "cloudflare_tunnel",
};
afterEach(() => vi.unstubAllGlobals());

describe("phone managed relay transport", () => {
  it.effect(
    "uses native SDK JWT credentials and runtime configuration for discovery and remote bootstrap",
    () =>
      Effect.gen(function* () {
        let configured = false;
        vi.stubGlobal("window", {
          symbaHost: {
            protocolVersion: 2,
            connectAccount: true,
            nativeConnect: true,
            getConnectState: async () => ({
              configured,
              state: configured ? "signed-in" : "signed-out",
              account: configured ? { id: "phone-account" } : null,
              relayUrl: configured ? "https://phone-relay.example.test" : null,
            }),
            getConnectToken: async () => ({ token: nativeToken }),
            openConnectSignIn: vi.fn(),
            signOutConnect: vi.fn(),
          },
        });
        yield* Effect.promise(() => phoneConnectAccount.refresh());
        const requests: Array<{ host: string; path: string; authorized: boolean }> = [];
        const proofTargets: Array<{ method: string; url: string }> = [];
        const fetcher: typeof fetch = async (input, init) => {
          const url = new URL(String(input));
          const headers = new Headers(init?.headers);
          expect(url.protocol).toBe("https:");
          expect(headers.get("accept")).toBe("application/json");
          requests.push({
            host: url.host,
            path: url.pathname,
            authorized: headers.has("authorization"),
          });
          if (url.pathname.endsWith("/dpop-token")) {
            expect(String(input)).toBe("https://phone-relay.example.test/v1/client/dpop-token");
            expect(init?.method).toBe("POST");
            expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
            expect(headers.get("dpop")).toBe("test-proof");
            expect(headers.has("authorization")).toBe(false);
            const payload = new URLSearchParams(await new Request(input, init).text());
            expect(Object.fromEntries(payload)).toEqual({
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              subject_token: nativeToken,
              subject_token_type: RelayJwtSubjectTokenType,
              requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
              resource: "https://phone-relay.example.test",
              scope: RelayEnvironmentConnectScope,
              client_id: "lecturn-web",
            });
            expect(proofTargets).toContainEqual({ method: "POST", url: String(input) });
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
          Layer.provide(makeWebRemoteHttpClientLayer(fetcher)),
          Layer.provide(
            Layer.succeed(
              ManagedRelay.ManagedRelayDpopSigner,
              ManagedRelay.ManagedRelayDpopSigner.of({
                thumbprint: Effect.succeed("test-thumbprint"),
                createProof: (input) =>
                  Effect.sync(() => {
                    proofTargets.push({ method: input.method, url: input.url });
                    return "test-proof";
                  }),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const client = yield* ManagedRelay.ManagedRelayClient;
          // Acquired while disabled; native configuration arrives after initialization.
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
