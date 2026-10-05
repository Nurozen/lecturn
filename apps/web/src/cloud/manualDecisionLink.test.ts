import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, SubscriptionRef, Schema } from "effect";
import { EnvironmentId, WS_METHODS } from "@lecturn/contracts";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@lecturn/client-runtime/connection";
import { ManagedRelay } from "@lecturn/client-runtime/relay";
import type { RpcSession } from "@lecturn/client-runtime/rpc";
import { linkPreparedEnvironmentForDecisions } from "./manualDecisionLink";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const environmentId = EnvironmentId.make("remote-host");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Remote",
  httpBaseUrl: "https://remote.test",
  wsBaseUrl: "wss://remote.test/ws",
});
const prepared: PreparedConnection = {
  environmentId,
  label: "Remote",
  httpBaseUrl: "https://remote.test/",
  socketUrl: "wss://remote.test/ws?ticket=PRIVATE-TICKET",
  httpAuthorization: { _tag: "Bearer", token: "PRIVATE-REMOTE-AUTH" },
  target,
};
const harness = Effect.fn(function* (
  options: { alreadyLinked?: boolean; returnedEnvironmentId?: EnvironmentId } = {},
) {
  const hostCalls: { environmentId: EnvironmentId; operation: string; input: unknown }[] = [];
  const cloudCalls: { operation: string; input: unknown }[] = [];
  const supervisor = EnvironmentSupervisor.of({
    target,
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [WS_METHODS.cloudCreateManualLinkProof]: (input: unknown) =>
            Effect.sync(() => {
              hostCalls.push({ environmentId, operation: "proof", input });
              return { environmentId, proof: options.alreadyLinked ? null : "signed-proof" };
            }),
          [WS_METHODS.cloudApplyManualRelayConfig]: (input: unknown) =>
            Effect.sync(() => {
              hostCalls.push({ environmentId, operation: "configure", input });
              return { ok: true, endpointRuntimeStatus: { status: "disabled" } };
            }),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor["Service"]);
  const registry = EnvironmentRegistry.of({
    run: (selected, operation) => {
      expect(selected).toBe(environmentId);
      return operation.pipe(Effect.provideService(EnvironmentSupervisor, supervisor));
    },
  } as EnvironmentRegistry["Service"]);
  const relay = ManagedRelay.ManagedRelayClient.of({
    createEnvironmentLinkChallenge: (input: unknown) =>
      Effect.sync(() => {
        cloudCalls.push({ operation: "challenge", input });
        return { challenge: "challenge", expiresAt: "2026-09-23T00:00:00Z" };
      }),
    linkEnvironment: (input: unknown) =>
      Effect.sync(() => {
        cloudCalls.push({ operation: "link", input });
        return {
          ok: true,
          environmentId: options.returnedEnvironmentId ?? environmentId,
          cloudUserId: "signed-in-account",
          endpoint: {
            httpBaseUrl: "https://remote.test/",
            wsBaseUrl: "wss://remote.test/ws",
            providerKind: "manual",
          },
          endpointRuntime: null,
          relayIssuer: "https://relay.test",
          environmentCredential: "PRIVATE-CLOUD-CREDENTIAL",
          cloudMintPublicKey: "public-key",
        };
      }),
  } as unknown as ManagedRelay.ManagedRelayClient["Service"]);
  return {
    hostCalls,
    cloudCalls,
    run: (connection = prepared) =>
      linkPreparedEnvironmentForDecisions({
        environmentId,
        prepared: connection,
        clerkToken: "PRIVATE-CLERK",
        relayUrl: "https://relay.test",
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(ManagedRelay.ManagedRelayClient, relay),
      ),
  };
});
describe("remote manual Decisions cloud link", () => {
  it.effect(
    "uses only the selected host socket, strips connection tickets and requests no publishing/tunnel",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.run();
        expect(h.hostCalls.map((c) => c.operation)).toEqual(["proof", "configure"]);
        expect(h.cloudCalls).toHaveLength(2);
        for (const c of h.cloudCalls)
          expect(c.input).toMatchObject({
            payload: {
              notificationsEnabled: false,
              liveActivitiesEnabled: false,
              managedTunnelsEnabled: false,
            },
          });
        expect(h.hostCalls[0]?.input).toMatchObject({
          environmentId,
          endpoint: {
            httpBaseUrl: "https://remote.test/",
            wsBaseUrl: "wss://remote.test/ws",
            providerKind: "manual",
          },
        });
        expect(serialize(h.hostCalls)).not.toMatch(
          /PRIVATE-TICKET|PRIVATE-REMOTE-AUTH|PRIVATE-CLERK/,
        );
        expect(h.hostCalls[1]?.input).toMatchObject({ environmentId, endpointRuntime: null });
      }),
  );
  it.effect("does not relink an existing remote registration", () =>
    Effect.gen(function* () {
      const h = yield* harness({ alreadyLinked: true });
      yield* h.run();
      expect(h.cloudCalls.map((c) => c.operation)).toEqual(["challenge"]);
      expect(h.hostCalls.map((c) => c.operation)).toEqual(["proof"]);
    }),
  );
  it.effect("rejects a changed prepared host before using cloud or host credentials", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.flip(h.run({ ...prepared, environmentId: EnvironmentId.make("primary-host") }));
      expect(h.cloudCalls).toEqual([]);
      expect(h.hostCalls).toEqual([]);
    }),
  );
  it.effect("never writes credentials returned for a different environment", () =>
    Effect.gen(function* () {
      const h = yield* harness({ returnedEnvironmentId: EnvironmentId.make("other") });
      const error = yield* Effect.flip(h.run());
      expect(h.hostCalls.map((c) => c.operation)).toEqual(["proof"]);
      expect(error.message).not.toContain("PRIVATE-");
    }),
  );
});
