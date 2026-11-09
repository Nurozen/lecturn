import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import * as Connectivity from "../connection/connectivity.ts";
import * as ConnectionDriver from "../connection/driver.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionTarget,
  ConnectionTransientError,
  RelayConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Persistence from "../platform/persistence.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createEnvironmentCatalogAtoms } from "./connections.ts";

const ACCOUNT_A_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-a"),
  label: "Account A environment",
  accountId: "account-a",
});
const ACCOUNT_B_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-b"),
  label: "Account B environment",
  accountId: "account-b",
});

// A real registry over an in-memory catalog that never connects.
function makeCatalog(initialTargets: ReadonlyArray<ConnectionTarget>) {
  const storedTargets = new Map(initialTargets.map((target) => [target.environmentId, target]));
  const clearedOwnedData: Array<EnvironmentId> = [];
  const layer = EnvironmentRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Persistence.ConnectionTargetStore, {
          list: Effect.sync(() => [...storedTargets.values()]),
          listDisabled: Effect.succeed([]),
        }),
        Layer.succeed(Persistence.ConnectionRegistrationStore, {
          setEnabled: () => Effect.void,
          register: (registration) =>
            Effect.sync(() => {
              storedTargets.set(registration.target.environmentId, registration.target);
            }),
          setRoutes: () => Effect.void,
          remove: (environmentId) =>
            Effect.sync(() => {
              storedTargets.delete(environmentId);
            }),
        }),
        Layer.succeed(Persistence.EnvironmentCacheStore, {
          loadShell: () => Effect.succeedNone,
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeedNone,
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
        Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, {
          clear: (environmentId) =>
            Effect.sync(() => {
              clearedOwnedData.push(environmentId);
            }),
        }),
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, {
          get: () => Effect.succeedNone,
          put: () => Effect.void,
          remove: () => Effect.void,
        }),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, {
          get: () => Effect.succeedNone,
          put: () => Effect.void,
          remove: () => Effect.void,
        }),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
          provision: () => Effect.die(new Error("SSH is not used.")),
          prepare: () => Effect.die(new Error("SSH is not used.")),
          disconnect: () => Effect.void,
        }),
        Layer.succeed(ClientCapabilities.CloudSession, {
          accountIds: Effect.succeed(["account-a", "account-b"]),
          identity: (accountId) => Effect.succeedSome({ accountId }),
          clerkToken: () => Effect.die(new Error("Clerk tokens are not used.")),
        }),
        Layer.succeed(Connectivity.Connectivity, {
          status: Effect.succeed("online" as const),
          changes: Stream.never,
        }),
        Layer.succeed(ConnectionWakeups.ConnectionWakeups, { changes: Stream.never }),
        Layer.succeed(ConnectionDriver.ConnectionDriver, {
          connect: () => Effect.never,
          preflight: () => Effect.succeed<ConnectionDriver.RoutePreflight>("unprepared"),
          checkHost: () => Effect.succeed<ConnectionDriver.RouteCheck>("unchecked"),
        }),
      ),
    ),
  );
  return { storedTargets, clearedOwnedData, layer };
}

const ENVIRONMENT_ID = EnvironmentId.make("catalog-environment");

const connectionState = (
  overrides: Partial<SupervisorConnectionState>,
): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  ...overrides,
});

const makeCatalogHarness = Effect.fn("TestCatalog.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make(
    connectionState({ phase: "connected", attempt: 1, generation: 1 }),
  );
  const session = yield* SubscriptionRef.make(Option.some({} as RpcSession.RpcSession));
  const supervisor = {
    state,
    session,
  } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const catalog = createEnvironmentCatalogAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
  );
  const atom = catalog.sessionGenerationAtom(ENVIRONMENT_ID);
  const atoms = AtomRegistry.make();
  const unmount = atoms.mount(atom);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unmount();
      atoms.dispose();
    }),
  );
  yield* Effect.yieldNow;
  /** Moves the supervisor to `next`, with a new session object when one is established. */
  const generationAfter = (
    next: SupervisorConnectionState,
    nextSession: Option.Option<RpcSession.RpcSession> = Option.none(),
  ) =>
    SubscriptionRef.set(session, nextSession).pipe(
      Effect.andThen(SubscriptionRef.set(state, next)),
      Effect.andThen(Effect.yieldNow),
      Effect.map(() => atoms.get(atom)),
    );
  return { generation: () => atoms.get(atom), generationAfter };
});

const lastFailure = new ConnectionTransientError({ reason: "transport", detail: "Down." });
const newSession = () => Option.some({} as RpcSession.RpcSession);

describe("environment catalog commands", () => {
  it("removes one account's relay environments and keeps the other account's", async () => {
    const catalog = makeCatalog([ACCOUNT_A_TARGET, ACCOUNT_B_TARGET]);
    const commands = createEnvironmentCatalogAtoms(Atom.runtime(catalog.layer));
    const registry = AtomRegistry.make();

    const result = await commands.removeRelayEnvironments.run(registry, {
      accountId: "account-b",
    });

    expect(result._tag === "Success" ? result.value : null).toEqual([
      ACCOUNT_B_TARGET.environmentId,
    ]);
    expect([...catalog.storedTargets.values()]).toEqual([ACCOUNT_A_TARGET]);
    expect(catalog.clearedOwnedData).toEqual([ACCOUNT_B_TARGET.environmentId]);
    registry.dispose();
  });

  it("removes every relay environment when no account is given", async () => {
    const catalog = makeCatalog([ACCOUNT_A_TARGET, ACCOUNT_B_TARGET]);
    const commands = createEnvironmentCatalogAtoms(Atom.runtime(catalog.layer));
    const registry = AtomRegistry.make();

    await commands.removeRelayEnvironments.run(registry, undefined);

    expect(catalog.storedTargets.size).toBe(0);
    registry.dispose();
  });
});

describe("environment catalog atoms", () => {
  it.effect("changes the session generation only when a new session comes up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { generation, generationAfter } = yield* makeCatalogHarness();
        const first = generation();
        // A retry reports the generation it is attempting before it is established.
        expect(
          yield* generationAfter(
            connectionState({ phase: "connecting", stage: "opening", generation: 2, lastFailure }),
          ),
        ).toBe(first);
        expect(
          yield* generationAfter(
            connectionState({ phase: "backoff", generation: 1, lastFailure, retryAt: 1 }),
          ),
        ).toBe(first);
        expect(
          yield* generationAfter(
            connectionState({ phase: "connected", attempt: 2, generation: 2 }),
            newSession(),
          ),
        ).not.toBe(first);
      }),
    ),
  );

  it.effect("changes when a replaced supervisor's first session reuses an old generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { generation, generationAfter } = yield* makeCatalogHarness();
        const first = generation();
        yield* generationAfter(
          connectionState({ phase: "backoff", generation: 1, lastFailure, retryAt: 1 }),
        );
        // Re-pairing or editing a route installs a new supervisor, whose counter starts over.
        yield* generationAfter(connectionState({ phase: "available", generation: 0 }));
        expect(
          yield* generationAfter(
            connectionState({ phase: "connected", attempt: 1, generation: 1 }),
            newSession(),
          ),
        ).not.toBe(first);
      }),
    ),
  );
});
