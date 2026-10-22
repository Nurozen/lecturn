import { EnvironmentId, WS_METHODS, type HostResourcesSnapshot } from "@lecturn/contracts";
import { expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Layer, Option, Stream, SubscriptionRef } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

it.effect("cancels unmounted host resource reads and only requests again on remount", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      let requests = 0;
      const client = {
        [WS_METHODS.serverGetHostResources]: () =>
          Effect.gen(function* () {
            requests += 1;
            if (requests === 1) {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never.pipe(
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              );
            }
            return {
              sampledAt: requests,
              cpuUtilization: 0.25,
              cpuCount: 8,
              availableMemoryBytes: 8_000,
              totalMemoryBytes: 16_000,
            } satisfies HostResourcesSnapshot;
          }),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const environmentId = EnvironmentId.make("host-resources-environment");
      const supervisor = EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Host resources",
          httpBaseUrl: "https://environment.example.test",
          wsBaseUrl: "wss://environment.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environments = EnvironmentRegistry.of({
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]);
      const cache = EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry, environments),
          Layer.succeed(EnvironmentCacheStore, cache),
          Layer.succeed(Clock.Clock, yield* Clock.Clock),
        ),
      );
      const atoms = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make(null),
      });
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
        Effect.sync(() => value.dispose()),
      );
      const resources = atoms.hostResources({ environmentId, input: {} });
      let removed = yield* Deferred.make<void>();
      registry.onNodeRemoved = (node) => {
        if (node.atom === resources) Deferred.doneUnsafe(removed, Effect.void);
      };

      const unmountPending = registry.mount(resources);
      yield* Deferred.await(started);
      unmountPending();
      yield* Deferred.await(removed);
      yield* Deferred.await(interrupted);
      yield* TestClock.adjust("1 minute");
      expect(requests).toBe(1);

      removed = yield* Deferred.make<void>();
      const unmount = registry.mount(resources);
      expect(
        (yield* AtomRegistry.getResult(registry, resources, { suspendOnWaiting: true })).sampledAt,
      ).toBe(2);
      unmount();
      yield* Deferred.await(removed);
      // Reconnecting while idle must not revive a discarded resource query.
      yield* SubscriptionRef.set(supervisor.session, Option.some({ ...session }));
      yield* TestClock.adjust("1 minute");
      expect(requests).toBe(2);

      const unmountRemounted = registry.mount(resources);
      expect(
        (yield* AtomRegistry.getResult(registry, resources, { suspendOnWaiting: true })).sampledAt,
      ).toBe(3);
      expect(requests).toBe(3);
      unmountRemounted();
    }),
  ),
);
