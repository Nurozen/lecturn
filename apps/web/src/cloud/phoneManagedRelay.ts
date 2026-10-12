import { ManagedRelay } from "@lecturn/client-runtime/relay";
import { RelayWebClientId } from "@lecturn/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { phoneConnectAccount } from "./phoneConnectAccount";

/** Resolve native configuration at request time: the native session may initialize
 * after the connection runtime has started. Keep the existing DPoP client,
 * discovery, token exchange, and remote bootstrap protocols intact. */
export const phoneManagedRelayLayer = Layer.effect(
  ManagedRelay.ManagedRelayClient,
  Effect.gen(function* () {
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof ManagedRelay.make>>>();
    const permit = yield* Semaphore.make(1);
    let current: ManagedRelay.ManagedRelayClient["Service"] | undefined;
    const client = permit.withPermit(
      Effect.gen(function* () {
        const relayUrl = phoneConnectAccount.getSnapshot().status?.relayUrl ?? "";
        if (current?.relayUrl !== relayUrl) {
          current = yield* ManagedRelay.make({
            relayUrl,
            clientId: RelayWebClientId,
          }).pipe(Effect.provide(context));
        }
        return current;
      }),
    );
    return ManagedRelay.ManagedRelayClient.of({
      get relayUrl() {
        return phoneConnectAccount.getSnapshot().status?.relayUrl ?? "";
      },
      listEnvironments: (input) => Effect.flatMap(client, (relay) => relay.listEnvironments(input)),
      listDevices: (input) => Effect.flatMap(client, (relay) => relay.listDevices(input)),
      createEnvironmentLinkChallenge: (input) =>
        Effect.flatMap(client, (relay) => relay.createEnvironmentLinkChallenge(input)),
      linkEnvironment: (input) => Effect.flatMap(client, (relay) => relay.linkEnvironment(input)),
      unlinkEnvironment: (input) =>
        Effect.flatMap(client, (relay) => relay.unlinkEnvironment(input)),
      getEnvironmentStatus: (input) =>
        Effect.flatMap(client, (relay) => relay.getEnvironmentStatus(input)),
      connectEnvironment: (input) =>
        Effect.flatMap(client, (relay) => relay.connectEnvironment(input)),
      registerDevice: (input) => Effect.flatMap(client, (relay) => relay.registerDevice(input)),
      unregisterDevice: (input) => Effect.flatMap(client, (relay) => relay.unregisterDevice(input)),
      registerLiveActivity: (input) =>
        Effect.flatMap(client, (relay) => relay.registerLiveActivity(input)),
      getAgentActivitySnapshot: (input) =>
        Effect.flatMap(client, (relay) => relay.getAgentActivitySnapshot(input)),
      resetTokenCache: (accountId) =>
        Effect.flatMap(client, (relay) => relay.resetTokenCache(accountId)),
    });
  }),
);
