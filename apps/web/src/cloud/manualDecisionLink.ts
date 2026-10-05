import { EnvironmentId, WS_METHODS } from "@lecturn/contracts";
import type { PreparedConnection } from "@lecturn/client-runtime/connection";
import { EnvironmentRegistry } from "@lecturn/client-runtime/connection";
import { request } from "@lecturn/client-runtime/rpc";
import { ManagedRelay } from "@lecturn/client-runtime/relay";
import * as Effect from "effect/Effect";
import { CloudEnvironmentLinkError } from "./linkEnvironment";

/** Registration proof/config travel only on this host's existing authenticated socket. */
export const linkPreparedEnvironmentForDecisions = Effect.fn(
  "web.cloud.linkPreparedEnvironmentForDecisions",
)(
  function* (input: {
    environmentId: EnvironmentId;
    prepared: PreparedConnection;
    clerkToken: string;
    relayUrl: string;
  }) {
    if (input.prepared.environmentId !== input.environmentId)
      return yield* new CloudEnvironmentLinkError({
        message: "The selected environment connection changed. Reconnect and try again.",
      });
    const endpoint = yield* Effect.try({
      try: () => {
        const http = new URL(input.prepared.httpBaseUrl),
          ws = new URL(input.prepared.socketUrl);
        http.search = "";
        http.hash = "";
        ws.search = "";
        ws.hash = "";
        if (
          http.username ||
          http.password ||
          ws.username ||
          ws.password ||
          http.host !== ws.host ||
          !["http:", "https:"].includes(http.protocol) ||
          ws.protocol !== (http.protocol === "https:" ? "wss:" : "ws:")
        )
          throw new Error("Invalid endpoint");
        return {
          httpBaseUrl: http.toString(),
          wsBaseUrl: ws.toString(),
          providerKind: "manual" as const,
        };
      },
      catch: () =>
        new CloudEnvironmentLinkError({
          message: "This environment's public endpoint cannot be used for manual linking.",
        }),
    });
    const relay = yield* ManagedRelay.ManagedRelayClient;
    const registry = yield* EnvironmentRegistry;
    const challenge = yield* relay.createEnvironmentLinkChallenge({
      clerkToken: input.clerkToken,
      payload: {
        notificationsEnabled: false,
        liveActivitiesEnabled: false,
        managedTunnelsEnabled: false,
      },
    });
    const proof = yield* registry.run(
      input.environmentId,
      request(WS_METHODS.cloudCreateManualLinkProof, {
        environmentId: input.environmentId,
        challenge: challenge.challenge,
        relayIssuer: input.relayUrl,
        endpoint,
      }),
    );
    if (proof.environmentId !== input.environmentId)
      return yield* new CloudEnvironmentLinkError({
        message: "The cloud link proof came from a different environment.",
      });
    if (proof.proof === null) return;
    const link = yield* relay.linkEnvironment({
      clerkToken: input.clerkToken,
      payload: {
        proof: proof.proof,
        notificationsEnabled: false,
        liveActivitiesEnabled: false,
        managedTunnelsEnabled: false,
      },
    });
    if (
      link.environmentId !== input.environmentId ||
      link.endpoint.providerKind !== "manual" ||
      link.endpointRuntime !== null
    )
      return yield* new CloudEnvironmentLinkError({
        message:
          "The cloud returned a different environment or a managed tunnel for this manual link.",
      });
    yield* registry.run(
      input.environmentId,
      request(WS_METHODS.cloudApplyManualRelayConfig, {
        environmentId: input.environmentId,
        relayUrl: input.relayUrl,
        relayIssuer: link.relayIssuer,
        cloudUserId: link.cloudUserId,
        environmentCredential: link.environmentCredential,
        cloudMintPublicKey: link.cloudMintPublicKey,
        endpointRuntime: null,
      }),
    );
  },
  Effect.mapError(
    () =>
      new CloudEnvironmentLinkError({
        message:
          "Could not register the selected remote environment. Confirm relay management permission and sign in, then retry.",
      }),
  ),
);
