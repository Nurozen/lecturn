import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import * as Connectivity from "../connection/connectivity.ts";
import * as ConnectionDriver from "../connection/driver.ts";
import { type ConnectionTarget, RelayConnectionTarget } from "../connection/model.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Persistence from "../platform/persistence.ts";
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
        }),
        Layer.succeed(Persistence.ConnectionRegistrationStore, {
          register: (registration) =>
            Effect.sync(() => {
              storedTargets.set(registration.target.environmentId, registration.target);
            }),
          remove: (target) =>
            Effect.sync(() => {
              storedTargets.delete(target.environmentId);
            }),
        }),
        Layer.succeed(Persistence.EnvironmentCacheStore, {
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
        }),
        Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, {
          clear: (environmentId) =>
            Effect.sync(() => {
              clearedOwnedData.push(environmentId);
            }),
        }),
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, {
          get: () => Effect.succeed(Option.none()),
          put: () => Effect.void,
          remove: () => Effect.void,
        }),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, {
          get: () => Effect.succeed(Option.none()),
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
          clerkToken: () => Effect.die(new Error("Clerk tokens are not used.")),
        }),
        Layer.succeed(Connectivity.Connectivity, {
          status: Effect.succeed("online" as const),
          changes: Stream.never,
        }),
        Layer.succeed(ConnectionWakeups.ConnectionWakeups, { changes: Stream.never }),
        Layer.succeed(ConnectionDriver.ConnectionDriver, { connect: () => Effect.never }),
      ),
    ),
  );
  return { storedTargets, clearedOwnedData, layer };
}

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
