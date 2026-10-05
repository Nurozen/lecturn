import { EnvironmentId } from "@lecturn/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@lecturn/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ManagedRelay from "./managedRelay.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as Connectivity from "../connection/connectivity.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { ConnectionBlockedError, type NetworkStatus } from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as RelayEnvironmentDiscovery from "./discovery.ts";

const environments = [
  {
    environmentId: EnvironmentId.make("environment-1"),
    label: "Environment One",
    endpoint: {
      httpBaseUrl: "https://one.example.test",
      wsBaseUrl: "wss://one.example.test",
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-06-01T00:00:00.000Z",
  },
  {
    environmentId: EnvironmentId.make("environment-2"),
    label: "Environment Two",
    endpoint: {
      httpBaseUrl: "https://two.example.test",
      wsBaseUrl: "wss://two.example.test",
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-06-01T00:00:00.000Z",
  },
] satisfies ReadonlyArray<RelayClientEnvironmentRecord>;

// A Clerk-shaped token naming its account, which is what lets a listing count
// as evidence of ownership.
function accountToken(accountId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "none" })}.${encode({ sub: accountId })}.signature`;
}

type ListGate = Deferred.Deferred<
  ReadonlyArray<RelayClientEnvironmentRecord>,
  ManagedRelay.ManagedRelayClientError
>;

interface Reconcile {
  readonly accountId: string;
  readonly environmentIds: ReadonlyArray<string>;
}

function registryLayer(reconciles: Ref.Ref<ReadonlyArray<Reconcile>>) {
  return Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      return EnvironmentRegistry.EnvironmentRegistry.of({
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map(),
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        start: Effect.die("unused"),
        register: () => Effect.die("unused"),
        registerPlatform: () => Effect.die("unused"),
        reconcilePlatform: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
        removeRelayEnvironments: () => Effect.die("unused"),
        reconcileRelayEnvironments: (accountId, environmentIds) =>
          Ref.update(reconciles, (current) => [...current, { accountId, environmentIds }]),
        unlistedRelayEnvironmentIds: yield* SubscriptionRef.make<ReadonlySet<EnvironmentId>>(
          new Set(),
        ),
        retryNow: () => Effect.die("unused"),
        state: () => Effect.die("unused"),
        stateChanges: () => Stream.die("unused"),
        run: () => Effect.die("unused"),
        runStream: () => Stream.die("unused"),
        followStream: () => Stream.die("unused"),
      });
    }),
  );
}

function status(
  environment: RelayClientEnvironmentRecord,
  value: "online" | "offline",
): RelayEnvironmentStatusResponse {
  return {
    environmentId: environment.environmentId,
    endpoint: environment.endpoint,
    status: value,
    checkedAt: "2026-06-01T00:00:00.000Z",
  };
}

const makeHarness = Effect.fn("RelayDiscoveryTest.makeHarness")(function* () {
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
  const listCalls = yield* Ref.make(0);
  const listFailure = yield* Ref.make<ManagedRelay.ManagedRelayClientError | null>(null);
  const secondListCall = yield* Deferred.make<void>();
  const clerkToken = yield* Ref.make<string | null>("clerk-token");
  const accountIds = yield* Ref.make<ReadonlyArray<string>>(["account-1"]);
  // Per-account tokens, and listings held open per token, for the tests that
  // run more than one account. Anything absent falls back to the defaults.
  const accountTokens = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const listGates = yield* Ref.make<ReadonlyMap<string, ListGate>>(new Map());
  const reconciles = yield* Ref.make<ReadonlyArray<Reconcile>>([]);
  const wakeups = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly reason: ConnectionWakeups.ConnectionWakeup;
  }>({
    sequence: 0,
    reason: "application-active",
  });
  const statusRequests = yield* Ref.make(
    new Map<
      string,
      Deferred.Deferred<RelayEnvironmentStatusResponse, ManagedRelay.ManagedRelayClientError>
    >(),
  );
  for (const environment of environments) {
    const request = yield* Deferred.make<
      RelayEnvironmentStatusResponse,
      ManagedRelay.ManagedRelayClientError
    >();
    yield* Ref.update(statusRequests, (current) => {
      const next = new Map(current);
      next.set(environment.environmentId, request);
      return next;
    });
  }

  const client = ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.example.test",
    listEnvironments: ({ clerkToken }) =>
      Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(listCalls, (current) => current + 1);
        if (count >= 2) {
          yield* Deferred.succeed(secondListCall, undefined);
        }
        const gate = (yield* Ref.get(listGates)).get(clerkToken);
        if (gate !== undefined) {
          return yield* Deferred.await(gate);
        }
        const failure = yield* Ref.get(listFailure);
        if (failure) {
          return yield* failure;
        }
        return environments;
      }),
    getEnvironmentStatus: ({ environmentId }) =>
      Ref.get(statusRequests).pipe(
        Effect.flatMap((requests) => Deferred.await(requests.get(environmentId)!)),
      ),
    listDevices: () => Effect.die("unused"),
    createEnvironmentLinkChallenge: () => Effect.die("unused"),
    linkEnvironment: () => Effect.die("unused"),
    unlinkEnvironment: () => Effect.die("unused"),
    connectEnvironment: () => Effect.die("unused"),
    registerDevice: () => Effect.die("unused"),
    unregisterDevice: () => Effect.die("unused"),
    registerLiveActivity: () => Effect.die("unused"),
    getAgentActivitySnapshot: () => Effect.die("unused"),
    resetTokenCache: () => Effect.void,
  } satisfies ManagedRelay.ManagedRelayClient["Service"]);
  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });
  const layer = RelayEnvironmentDiscovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ManagedRelay.ManagedRelayClient, client),
        Layer.succeed(
          ClientCapabilities.CloudSession,
          ClientCapabilities.CloudSession.of({
            accountIds: Ref.get(accountIds),
            clerkToken: (accountId) =>
              Effect.all([Ref.get(accountTokens), Ref.get(clerkToken)]).pipe(
                Effect.map(([tokens, fallback]) => tokens.get(accountId) ?? fallback),
                Effect.flatMap((token) =>
                  token === null
                    ? Effect.fail(
                        new ConnectionBlockedError({
                          reason: "authentication",
                          detail: "Signed out.",
                        }),
                      )
                    : Effect.succeed(token),
                ),
              ),
          }),
        ),
        Layer.succeed(Connectivity.Connectivity, connectivity),
        registryLayer(reconciles),
        Layer.succeed(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({
            changes: SubscriptionRef.changes(wakeups).pipe(
              Stream.drop(1),
              Stream.map((event) => event.reason),
            ),
          }),
        ),
      ),
    ),
  );

  return {
    layer,
    listCalls,
    listFailure,
    clerkToken,
    accountIds,
    reconciles,
    networkStatus,
    secondListCall,
    statusRequests,
    // Signs the accounts in with their own tokens and holds each listing open
    // until the test answers it.
    signInWithGatedListings: Effect.fn(function* (ids: ReadonlyArray<string>) {
      const gates = new Map<string, ListGate>();
      for (const accountId of ids) {
        gates.set(
          accountId,
          yield* Deferred.make<
            ReadonlyArray<RelayClientEnvironmentRecord>,
            ManagedRelay.ManagedRelayClientError
          >(),
        );
      }
      yield* Ref.set(accountIds, ids);
      yield* Ref.set(
        accountTokens,
        new Map(ids.map((accountId) => [accountId, accountToken(accountId)])),
      );
      yield* Ref.set(
        listGates,
        new Map(ids.map((accountId) => [accountToken(accountId), gates.get(accountId)!])),
      );
      const requests = yield* Ref.get(statusRequests);
      for (const environment of environments) {
        yield* Deferred.succeed(
          requests.get(environment.environmentId)!,
          status(environment, "online"),
        );
      }
      return gates;
    }),
    accountTokens,
    wake: (reason: ConnectionWakeups.ConnectionWakeup) =>
      SubscriptionRef.update(wakeups, (event) => ({
        sequence: event.sequence + 1,
        reason,
      })),
  };
});

describe("RelayEnvironmentDiscovery", () => {
  it.effect("publishes each environment status as soon as that lookup completes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        const refreshFiber = yield* Effect.forkChild(discovery.refresh);

        const checking = yield* SubscriptionRef.changes(discovery.state).pipe(
          Stream.filter((state) => state.environments.size === 2),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(
          [...checking.environments.values()].every((entry) => entry.availability === "checking"),
        ).toBe(true);

        const requests = yield* Ref.get(harness.statusRequests);
        yield* Deferred.succeed(
          requests.get(environments[1]!.environmentId)!,
          status(environments[1]!, "online"),
        );

        const partiallyResolved = yield* SubscriptionRef.changes(discovery.state).pipe(
          Stream.filter(
            (state) =>
              state.environments.get(environments[1]!.environmentId)?.availability === "online",
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(
          partiallyResolved.environments.get(environments[0]!.environmentId)?.availability,
        ).toBe("checking");

        yield* Deferred.succeed(
          requests.get(environments[0]!.environmentId)!,
          status(environments[0]!, "offline"),
        );
        yield* Fiber.join(refreshFiber);

        const complete = yield* SubscriptionRef.get(discovery.state);
        expect(complete.environments.get(environments[0]!.environmentId)?.availability).toBe(
          "offline",
        );
        expect(complete.refreshing).toBe(false);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "preserves discovered rows while offline and refreshes after connectivity returns",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
          const requests = yield* Ref.get(harness.statusRequests);
          for (const environment of environments) {
            yield* Deferred.succeed(
              requests.get(environment.environmentId)!,
              status(environment, "online"),
            );
          }
          yield* discovery.refresh;

          const offlineFiber = yield* SubscriptionRef.changes(discovery.state).pipe(
            Stream.filter((state) => state.offline),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* SubscriptionRef.set(harness.networkStatus, "offline");
          yield* Fiber.join(offlineFiber);
          expect((yield* SubscriptionRef.get(discovery.state)).environments.size).toBe(2);

          yield* SubscriptionRef.set(harness.networkStatus, "online");
          yield* Deferred.await(harness.secondListCall);
          expect(yield* Ref.get(harness.listCalls)).toBe(2);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("publishes listing failures without rejecting the refresh command", () =>
    Effect.gen(function* () {
      const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
      const client = ManagedRelay.ManagedRelayClient.of({
        relayUrl: "https://relay.example.test",
        listEnvironments: () =>
          Effect.fail(
            new ManagedRelay.ManagedRelayRequestTimeoutError({
              activity: "Relay environment listing",
              timeoutMs: ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS,
              traceId: null,
            }),
          ),
        getEnvironmentStatus: () => Effect.die("unused"),
        listDevices: () => Effect.die("unused"),
        createEnvironmentLinkChallenge: () => Effect.die("unused"),
        linkEnvironment: () => Effect.die("unused"),
        unlinkEnvironment: () => Effect.die("unused"),
        connectEnvironment: () => Effect.die("unused"),
        registerDevice: () => Effect.die("unused"),
        unregisterDevice: () => Effect.die("unused"),
        registerLiveActivity: () => Effect.die("unused"),
        getAgentActivitySnapshot: () => Effect.die("unused"),
        resetTokenCache: () => Effect.void,
      } satisfies ManagedRelay.ManagedRelayClient["Service"]);
      const layer = RelayEnvironmentDiscovery.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ManagedRelay.ManagedRelayClient, client),
            Layer.succeed(ClientCapabilities.CloudSession, {
              accountIds: Effect.succeed(["account-1"]),
              clerkToken: () => Effect.succeed("clerk-token"),
            }),
            Layer.succeed(Connectivity.Connectivity, {
              status: SubscriptionRef.get(networkStatus),
              changes: SubscriptionRef.changes(networkStatus),
            }),
            registryLayer(yield* Ref.make<ReadonlyArray<Reconcile>>([])),
            Layer.succeed(
              ConnectionWakeups.ConnectionWakeups,
              ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
            ),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        yield* discovery.refresh;

        const state = yield* SubscriptionRef.get(discovery.state);
        expect(state.refreshing).toBe(false);
        expect(Option.getOrThrow(state.error)).toMatchObject({
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Relay environment listing timed out.",
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("clears previously discovered rows when a refresh fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        const requests = yield* Ref.get(harness.statusRequests);
        for (const environment of environments) {
          yield* Deferred.succeed(
            requests.get(environment.environmentId)!,
            status(environment, "online"),
          );
        }
        yield* discovery.refresh;
        expect((yield* SubscriptionRef.get(discovery.state)).environments.size).toBe(2);

        yield* Ref.set(
          harness.listFailure,
          new ManagedRelay.ManagedRelayRequestFailedError({
            action: "list relay-managed environments",
            cause: new Error("Relay request failed."),
          }),
        );
        yield* discovery.refresh;

        const failed = yield* SubscriptionRef.get(discovery.state);
        expect(failed.environments.size).toBe(0);
        expect(Option.isSome(failed.error)).toBe(true);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refreshes proactively when credentials change before any manual refresh", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        const requests = yield* Ref.get(harness.statusRequests);
        for (const environment of environments) {
          yield* Deferred.succeed(
            requests.get(environment.environmentId)!,
            status(environment, "online"),
          );
        }

        // Let the scoped wakeup subscription start before emitting, mirroring
        // a real sign-in which always happens long after service start.
        yield* Effect.yieldNow;

        // Sign-in activates the session and emits credentials-changed; the
        // list must populate without any screen having asked for a refresh.
        yield* harness.wake("credentials-changed");
        const populated = yield* SubscriptionRef.changes(discovery.state).pipe(
          Stream.filter(
            (state) => state.environments.size === environments.length && !state.refreshing,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(Option.isNone(populated.error)).toBe(true);
        expect(yield* Ref.get(harness.listCalls)).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("settles to a clean empty state when refreshed while signed out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        yield* Ref.set(harness.clerkToken, null);
        yield* discovery.refresh;

        const state = yield* SubscriptionRef.get(discovery.state);
        expect(state.environments.size).toBe(0);
        expect(state.refreshing).toBe(false);
        expect(Option.isNone(state.error)).toBe(true);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("settles to a clean empty state when refreshed with no account at all", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        yield* Ref.set(harness.accountIds, []);
        yield* discovery.refresh;

        const state = yield* SubscriptionRef.get(discovery.state);
        expect(state.environments.size).toBe(0);
        expect(state.refreshing).toBe(false);
        expect(Option.isNone(state.error)).toBe(true);
        expect(yield* Ref.get(harness.listCalls)).toBe(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not republish stale rows after sign-out invalidates an in-flight refresh", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        const refreshFiber = yield* Effect.forkChild(discovery.refresh);
        yield* SubscriptionRef.changes(discovery.state).pipe(
          Stream.filter((state) => state.environments.size === environments.length),
          Stream.runHead,
        );

        yield* Ref.set(harness.clerkToken, null);
        yield* harness.wake("credentials-changed");
        yield* SubscriptionRef.changes(discovery.state).pipe(
          Stream.filter((state) => state.environments.size === 0),
          Stream.runHead,
        );

        const requests = yield* Ref.get(harness.statusRequests);
        for (const environment of environments) {
          yield* Deferred.succeed(
            requests.get(environment.environmentId)!,
            status(environment, "online"),
          );
        }
        yield* Fiber.join(refreshFiber);
        yield* Effect.yieldNow;

        expect((yield* SubscriptionRef.get(discovery.state)).environments.size).toBe(0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps interleaved listings in their own account and reconciles each", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        const gates = yield* harness.signInWithGatedListings(["account-a", "account-b"]);
        const refreshFiber = yield* Effect.forkChild(discovery.refresh);

        // The second account answers first.
        yield* Deferred.succeed(gates.get("account-b")!, [environments[1]!]);
        yield* SubscriptionRef.changes(discovery.accountStates).pipe(
          Stream.filter((accounts) => accounts.get("account-b")?.environments.size === 1),
          Stream.runHead,
        );
        expect(
          (yield* SubscriptionRef.get(discovery.accountStates)).get("account-a")?.environments.size,
        ).toBe(0);

        yield* Deferred.succeed(gates.get("account-a")!, [environments[0]!]);
        yield* Fiber.join(refreshFiber);

        const accounts = yield* SubscriptionRef.get(discovery.accountStates);
        expect([...accounts.get("account-a")!.environments.keys()]).toEqual(["environment-1"]);
        expect([...accounts.get("account-b")!.environments.keys()]).toEqual(["environment-2"]);
        expect(yield* Ref.get(harness.reconciles)).toEqual([
          { accountId: "account-b", environmentIds: ["environment-2"] },
          { accountId: "account-a", environmentIds: ["environment-1"] },
        ]);

        // Single-account readers see one list, primary account first.
        const merged = yield* SubscriptionRef.get(discovery.state);
        expect([...merged.environments.keys()]).toEqual(["environment-1", "environment-2"]);
        expect(merged.refreshing).toBe(false);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps a failed listing to its own account and reconciles nothing for it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        const gates = yield* harness.signInWithGatedListings(["account-a", "account-b"]);
        yield* Deferred.fail(
          gates.get("account-a")!,
          new ManagedRelay.ManagedRelayRequestFailedError({
            action: "list relay-managed environments",
            cause: new Error("Relay request failed."),
          }),
        );
        yield* Deferred.succeed(gates.get("account-b")!, [environments[1]!]);
        yield* discovery.refresh;

        const accounts = yield* SubscriptionRef.get(discovery.accountStates);
        expect(Option.isSome(accounts.get("account-a")!.error)).toBe(true);
        expect(Option.isNone(accounts.get("account-b")!.error)).toBe(true);
        expect([...accounts.get("account-b")!.environments.keys()]).toEqual(["environment-2"]);
        expect(yield* Ref.get(harness.reconciles)).toEqual([
          { accountId: "account-b", environmentIds: ["environment-2"] },
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("drops a listing that outlived its account and leaves the other account alone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        const gates = yield* harness.signInWithGatedListings(["account-a", "account-b"]);
        const refreshFiber = yield* Effect.forkChild(discovery.refresh);
        yield* SubscriptionRef.changes(discovery.accountStates).pipe(
          Stream.filter((accounts) => accounts.get("account-b")?.refreshing === true),
          Stream.runHead,
        );

        // Account B signs out while both listings are still out.
        yield* Ref.set(harness.accountIds, ["account-a"]);
        yield* harness.wake(
          ConnectionWakeups.accountCredentialsChanged({
            added: new Set(),
            removed: new Set(["account-b"]),
          }),
        );
        yield* SubscriptionRef.changes(discovery.accountStates).pipe(
          Stream.filter((accounts) => !accounts.has("account-b")),
          Stream.runHead,
        );

        yield* Deferred.succeed(gates.get("account-b")!, [environments[1]!]);
        yield* Deferred.succeed(gates.get("account-a")!, [environments[0]!]);
        yield* Fiber.join(refreshFiber);

        // A's refresh was never restarted, and B's late answer went nowhere.
        const accounts = yield* SubscriptionRef.get(discovery.accountStates);
        expect(accounts.has("account-b")).toBe(false);
        expect([...accounts.get("account-a")!.environments.keys()]).toEqual(["environment-1"]);
        expect(yield* Ref.get(harness.reconciles)).toEqual([
          { accountId: "account-a", environmentIds: ["environment-1"] },
        ]);
        expect(yield* Ref.get(harness.listCalls)).toBe(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("reports an error instead of listing with a token that names another account", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        yield* harness.signInWithGatedListings(["account-a"]);
        yield* Ref.set(harness.accountTokens, new Map([["account-a", accountToken("account-b")]]));
        yield* discovery.refresh;

        const state = yield* SubscriptionRef.get(discovery.state);
        expect(state.environments.size).toBe(0);
        expect(state.refreshing).toBe(false);
        expect(Option.getOrThrow(state.error)).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "authentication",
        });
        expect(
          Option.isSome(
            (yield* SubscriptionRef.get(discovery.accountStates)).get("account-a")!.error,
          ),
        ).toBe(true);
        expect(yield* Ref.get(harness.listCalls)).toBe(0);
        expect(yield* Ref.get(harness.reconciles)).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("shows a listing whose token names no account without reconciling from it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        const requests = yield* Ref.get(harness.statusRequests);
        for (const environment of environments) {
          yield* Deferred.succeed(
            requests.get(environment.environmentId)!,
            status(environment, "online"),
          );
        }
        yield* discovery.refresh;

        expect((yield* SubscriptionRef.get(discovery.state)).environments.size).toBe(2);
        expect(yield* Ref.get(harness.reconciles)).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
