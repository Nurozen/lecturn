import { EnvironmentId } from "@lecturn/contracts";
import type { RelayClientEnvironmentRecord } from "@lecturn/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ManagedRelay from "./managedRelay.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Connectivity from "../connection/connectivity.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import * as ConnectionDriver from "../connection/driver.ts";
import { RelayConnectionTarget } from "../connection/model.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RelayEnvironmentDiscovery from "./discovery.ts";

const ACCOUNT_ID = "account-a";

function record(id: string): RelayClientEnvironmentRecord {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    endpoint: {
      httpBaseUrl: `https://${id}.example.test`,
      wsBaseUrl: `wss://${id}.example.test`,
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-06-01T00:00:00.000Z",
  };
}

const FIRST = record("environment-1");
const SECOND = record("environment-2");
const TARGETS = [
  new RelayConnectionTarget({
    environmentId: FIRST.environmentId,
    label: FIRST.label,
    accountId: ACCOUNT_ID,
  }),
  // Stored by a build from before relay entries named their account.
  new RelayConnectionTarget({ environmentId: SECOND.environmentId, label: SECOND.label }),
];

function accountToken(accountId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "none" })}.${encode({ sub: accountId })}.signature`;
}

const makeHarness = Effect.fn("TestDiscoveryRegistry.makeHarness")(function* () {
  const listing = yield* Ref.make<ReadonlyArray<RelayClientEnvironmentRecord>>([]);
  const storedTargets = yield* Ref.make(
    new Map(TARGETS.map((target) => [target.environmentId, target])),
  );
  // Every hook that deletes something an environment owns reports here.
  const deletions = yield* Ref.make<ReadonlyArray<string>>([]);
  const deleted = (hook: string) => Ref.update(deletions, (current) => [...current, hook]);

  const unused = (name: string) => Effect.die(new Error(`${name} is not used.`));
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      ManagedRelay.ManagedRelayClient,
      ManagedRelay.ManagedRelayClient.of({
        listEnvironments: () => Ref.get(listing),
        getEnvironmentStatus: ({ environmentId }: { readonly environmentId: string }) =>
          Ref.get(listing).pipe(
            Effect.map((environments) => {
              const environment = environments.find(
                (candidate) => candidate.environmentId === environmentId,
              )!;
              return {
                environmentId: environment.environmentId,
                endpoint: environment.endpoint,
                status: "online" as const,
                checkedAt: "2026-06-01T00:00:00.000Z",
              };
            }),
          ),
      } as unknown as ManagedRelay.ManagedRelayClient["Service"]),
    ),
    Layer.succeed(
      ClientCapabilities.CloudSession,
      ClientCapabilities.CloudSession.of({
        accountIds: Effect.succeed([ACCOUNT_ID]),
        clerkToken: (accountId) => Effect.succeed(accountToken(accountId)),
      }),
    ),
    Layer.succeed(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({ status: Effect.succeed("online"), changes: Stream.never }),
    ),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
    ),
    Layer.succeed(
      Persistence.ConnectionTargetStore,
      Persistence.ConnectionTargetStore.of({
        list: Ref.get(storedTargets).pipe(Effect.map((targets) => [...targets.values()])),
      }),
    ),
    Layer.succeed(
      Persistence.ConnectionRegistrationStore,
      Persistence.ConnectionRegistrationStore.of({
        register: (registration) =>
          Ref.update(storedTargets, (current) =>
            registration.target._tag === "RelayConnectionTarget"
              ? new Map(current).set(registration.target.environmentId, registration.target)
              : current,
          ),
        remove: () => deleted("registration"),
      }),
    ),
    Layer.succeed(Persistence.EnvironmentCacheStore, {
      clear: () => deleted("cache"),
    } as unknown as Persistence.EnvironmentCacheStore["Service"]),
    Layer.succeed(
      Persistence.EnvironmentOwnedDataCleanup,
      Persistence.EnvironmentOwnedDataCleanup.of({ clear: () => deleted("owned data") }),
    ),
    Layer.succeed(
      ConnectionProfileStore.ConnectionProfileStore,
      ConnectionProfileStore.ConnectionProfileStore.of({
        get: () => Effect.succeed(Option.none()),
        put: () => unused("Profile storage"),
        remove: () => deleted("profile"),
      }),
    ),
    Layer.succeed(
      ConnectionCredentialStore.ConnectionCredentialStore,
      ConnectionCredentialStore.ConnectionCredentialStore.of({
        get: () => Effect.succeed(Option.none()),
        put: () => unused("Credential storage"),
        remove: () => deleted("credential"),
      }),
    ),
    Layer.succeed(
      ConnectionDriver.ConnectionDriver,
      ConnectionDriver.ConnectionDriver.of({ connect: () => unused("The connection driver") }),
    ),
    Layer.succeed(
      ClientCapabilities.SshEnvironmentGateway,
      ClientCapabilities.SshEnvironmentGateway.of({
        provision: () => unused("SSH provisioning"),
        prepare: () => unused("SSH preparation"),
        disconnect: () => unused("SSH disconnect"),
      }),
    ),
  );
  const registry = EnvironmentRegistry.layer.pipe(Layer.provide(dependencies));
  const layer = Layer.merge(
    registry,
    RelayEnvironmentDiscovery.layer.pipe(Layer.provide(Layer.merge(registry, dependencies))),
  );

  return { layer, listing, storedTargets, deletions };
});

describe("RelayEnvironmentDiscovery with the real EnvironmentRegistry", () => {
  it.effect("never deletes what a single account's empty or partial listing leaves out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const unlisted = SubscriptionRef.get(registry.unlistedRelayEnvironmentIds).pipe(
          Effect.map((ids) => [...ids]),
        );
        const catalogIds = SubscriptionRef.get(registry.entries).pipe(
          Effect.map((entries) => [...entries.keys()]),
        );

        // A 200 with no environments, as a relay incident or another relay
        // stage would answer.
        yield* discovery.refresh;
        expect(Option.isNone((yield* SubscriptionRef.get(discovery.state)).error)).toBe(true);
        expect(yield* catalogIds).toEqual([FIRST.environmentId, SECOND.environmentId]);
        expect(yield* unlisted).toEqual([FIRST.environmentId, SECOND.environmentId]);

        yield* Ref.set(harness.listing, [FIRST]);
        yield* discovery.refresh;
        expect(yield* catalogIds).toEqual([FIRST.environmentId, SECOND.environmentId]);
        expect(yield* unlisted).toEqual([SECOND.environmentId]);

        yield* Ref.set(harness.listing, [FIRST, SECOND]);
        yield* discovery.refresh;
        expect(yield* unlisted).toEqual([]);
        expect(
          [...(yield* Ref.get(harness.storedTargets)).values()].map((target) => target.accountId),
        ).toEqual([ACCOUNT_ID, ACCOUNT_ID]);

        expect(yield* Ref.get(harness.deletions)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
