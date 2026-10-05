import { setDeviceRelayConflict } from "./DeviceRelayReservation.ts";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID, RELAY_ENVIRONMENT_CREDENTIAL_SECRET } from "./config.ts";
import { applyCloudRelayConfig, unlinkCloudRelayConfig } from "./http.ts";
import type { CloudManagedEndpointRuntime } from "./ManagedEndpointRuntime.ts";

const publicKey = NodeCrypto.generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();
const payload = (cloudUserId: string) => ({
  relayUrl: "https://relay.example.test",
  cloudUserId,
  environmentCredential: `credential-${cloudUserId}`,
  cloudMintPublicKey: publicKey,
  endpointRuntime: null,
});

function makeStore() {
  const values = new Map<string, Uint8Array>();
  const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    create: () => Effect.die("unused create"),
    getOrCreateRandom: () => Effect.die("unused getOrCreateRandom"),
  };
  return { secrets, values };
}

const blockedRuntime = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let calls = 0;
  const endpointRuntime: CloudManagedEndpointRuntime["Service"] = {
    applyConfig: () =>
      Effect.gen(function* () {
        calls++;
        if (calls === 1) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        return { status: "disabled" };
      }),
  };
  return { endpointRuntime, entered, release, calls: () => calls };
});

it.effect("rejects a competing account after an in-flight publish installs its owner", () =>
  Effect.gen(function* () {
    const store = makeStore();
    const runtime = yield* blockedRuntime;
    const dependencies = { ...store, endpointRuntime: runtime.endpointRuntime };
    const first = yield* applyCloudRelayConfig(dependencies, payload("account-a")).pipe(
      Effect.forkChild,
    );
    yield* Deferred.await(runtime.entered);
    const second = yield* applyCloudRelayConfig(dependencies, payload("account-b")).pipe(
      Effect.result,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* Deferred.succeed(runtime.release, undefined);
    yield* Fiber.join(first);
    const result = yield* Fiber.join(second);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("EnvironmentHttpConflictError");
    expect(new TextDecoder().decode(store.values.get(CLOUD_LINKED_USER_ID))).toBe("account-a");
    expect(new TextDecoder().decode(store.values.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET))).toBe(
      "credential-account-a",
    );
    expect(runtime.calls()).toBe(1);
  }),
);

it.effect("an unlink waits for a pending publish then clears its credentials and connector", () =>
  Effect.gen(function* () {
    const store = makeStore();
    const runtime = yield* blockedRuntime;
    const dependencies = { ...store, endpointRuntime: runtime.endpointRuntime };
    const first = yield* applyCloudRelayConfig(dependencies, payload("account-a")).pipe(
      Effect.forkChild,
    );
    yield* Deferred.await(runtime.entered);
    const unlink = yield* unlinkCloudRelayConfig(dependencies).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, store.secrets),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* Deferred.succeed(runtime.release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(unlink);
    expect(store.values.size).toBe(0);
    expect(runtime.calls()).toBe(2);
    yield* applyCloudRelayConfig(dependencies, payload("account-b"));
    expect(new TextDecoder().decode(store.values.get(CLOUD_LINKED_USER_ID))).toBe("account-b");
  }),
);

for (const alreadyLinked of [false, true]) {
  it.effect(
    `rolls back a failed credential write (${alreadyLinked ? "existing" : "new"} publication)`,
    () =>
      Effect.gen(function* () {
        const store = makeStore();
        let failWrite = false;
        const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
          ...store.secrets,
          set: (name, value) =>
            Effect.suspend(() => {
              if (failWrite && name === RELAY_ENVIRONMENT_CREDENTIAL_SECRET) {
                failWrite = false;
                return Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: "test credential",
                    cause: new Error("disk full"),
                  }),
                );
              }
              return store.secrets.set(name, value);
            }),
        };
        const published: boolean[] = [];
        const endpointRuntime: CloudManagedEndpointRuntime["Service"] = {
          applyConfig: (_, options) =>
            Effect.sync(() => {
              published.push(options?.published ?? false);
              return { status: "disabled" };
            }),
        };
        const dependencies = { secrets, endpointRuntime };
        if (alreadyLinked) yield* applyCloudRelayConfig(dependencies, payload("account-a"));
        const before = new Map(store.values);
        failWrite = true;
        const result = yield* Effect.result(
          applyCloudRelayConfig(dependencies, {
            ...payload("account-a"),
            environmentCredential: "replacement",
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(store.values).toEqual(before);
        expect(published.at(-1)).toBe(alreadyLinked);
      }),
  );
}

it.effect("a losing same-home installation cannot clear the owner's stored credentials", () =>
  Effect.gen(function* () {
    const store = makeStore();
    store.values.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("owner"));
    setDeviceRelayConflict(store.secrets, "Other installation owns this device");
    const result = yield* Effect.result(
      unlinkCloudRelayConfig({
        secrets: store.secrets,
        endpointRuntime: { applyConfig: () => Effect.die("must not stop owner") },
      }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, store.secrets)),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(new TextDecoder().decode(store.values.get(CLOUD_LINKED_USER_ID))).toBe("owner");
  }),
);
