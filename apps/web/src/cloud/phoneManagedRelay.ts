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
    // Forwarders retain the resolved relay client's own spans.
    return ManagedRelay.ManagedRelayClient.of({
      get relayUrl() {
        return phoneConnectAccount.getSnapshot().status?.relayUrl ?? "";
      },
      listEnvironments: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.listEnvironments(input);
      }),
      listDevices: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.listDevices(input);
      }),
      createEnvironmentLinkChallenge: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.createEnvironmentLinkChallenge(input);
      }),
      linkEnvironment: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.linkEnvironment(input);
      }),
      unlinkEnvironment: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.unlinkEnvironment(input);
      }),
      getEnvironmentStatus: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.getEnvironmentStatus(input);
      }),
      connectEnvironment: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.connectEnvironment(input);
      }),
      registerDevice: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.registerDevice(input);
      }),
      unregisterDevice: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.unregisterDevice(input);
      }),
      registerLiveActivity: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.registerLiveActivity(input);
      }),
      getAgentActivitySnapshot: Effect.fnUntraced(function* (input) {
        const relay = yield* client;
        return yield* relay.getAgentActivitySnapshot(input);
      }),
      resetTokenCache: Effect.fnUntraced(function* (accountId) {
        const relay = yield* client;
        return yield* relay.resetTokenCache(accountId);
      }),
    });
  }),
);
