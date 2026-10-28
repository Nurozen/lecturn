import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { signPayload, timingSafeEqualBase64Url } from "./utils.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerRemoveFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRemoveFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRemoveFailureFileSystem),
  );

const layerConcurrentReadMissFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

// Each `make` keeps its own in-process state, so two of them over one secrets
// directory stand in for two server processes.
const makeSecretStores = (count: number) =>
  Effect.all(Array.from({ length: count }, () => ServerSecretStore.make));

const layerConcurrentCreateContext = () =>
  Layer.merge(layerServerConfig(), layerConcurrentReadMissFileSystem);

// Real pauses, so concurrent callers actually overlap on the filesystem.
const realDelay = (ms: number) => TestClock.withLive(Effect.sleep(Duration.millis(ms)));

// Widens the window between a secret file appearing and its bytes landing, which
// is where a reader used to see an empty key.
const layerSlowSecretWriteFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      open: (path, options) => fileSystem.open(path, options).pipe(Effect.tap(() => realDelay(15))),
      writeFile: (path, data, options) =>
        realDelay(15).pipe(Effect.andThen(fileSystem.writeFile(path, data, options))),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerSlowWriteContext = () =>
  Layer.merge(layerServerConfig(), layerSlowSecretWriteFileSystem);

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("returns Option.none when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const [storeA, storeB] = yield* makeSecretStores(2);

      const [first, second] = yield* Effect.all(
        [
          storeA!.getOrCreateRandom("session-signing-key", 32),
          storeB!.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* storeA!.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(layerConcurrentCreateContext())),
  );

  it.effect("gives every concurrent first caller one complete key across processes", () =>
    Effect.gen(function* () {
      const stores = yield* makeSecretStores(3);
      const callers = 24;

      const keys = yield* Effect.forEach(
        Array.from({ length: callers }, (_, index) => index),
        (index) =>
          realDelay(index % 8).pipe(
            Effect.andThen(
              stores[index % stores.length]!.getOrCreateRandom("asset-signing-key", 32),
            ),
          ),
        { concurrency: "unbounded" },
      );
      const persisted = Option.getOrThrow(yield* stores[0]!.get("asset-signing-key"));

      assert.strictEqual(persisted.length, 32);
      for (const key of keys) {
        assert.deepEqual(Array.from(key), Array.from(persisted));
      }
      const payload = "asset-claims";
      for (const [index, signer] of keys.entries()) {
        const verifier = keys[(index + 1) % keys.length]!;
        assert.isTrue(
          timingSafeEqualBase64Url(signPayload(payload, signer), signPayload(payload, verifier)),
        );
      }
      const later = yield* makeSecretStores(1);
      const reloaded = yield* later[0]!.getOrCreateRandom("asset-signing-key", 32);
      assert.isTrue(
        timingSafeEqualBase64Url(signPayload(payload, keys[0]!), signPayload(payload, reloaded)),
      );
    }).pipe(Effect.provide(layerSlowWriteContext())),
  );

  it.effect("shares one in-flight creation between concurrent callers in a process", () => {
    let reads = 0;
    const layerCountingFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;

        return {
          ...fileSystem,
          readFile: (path) =>
            /[\\/]shared-key\.bin$/.test(String(path))
              ? Effect.suspend(() => {
                  reads += 1;
                  return fileSystem.readFile(path);
                })
              : fileSystem.readFile(path),
        } satisfies FileSystem.FileSystem;
      }),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const [store] = yield* makeSecretStores(1);

      const keys = yield* Effect.all(
        Array.from({ length: 8 }, () => store!.getOrCreateRandom("shared-key", 32)),
        { concurrency: "unbounded" },
      );

      assert.strictEqual(reads, 1);
      for (const key of keys) {
        assert.deepEqual(Array.from(key), Array.from(keys[0]!));
      }
      const afterwards = yield* store!.getOrCreateRandom("shared-key", 32);
      assert.deepEqual(Array.from(afterwards), Array.from(keys[0]!));
      assert.strictEqual(reads, 2);
    }).pipe(Effect.provide(Layer.merge(layerServerConfig(), layerCountingFileSystem)));
  });

  it.effect("create still refuses to replace an existing secret", () =>
    Effect.gen(function* () {
      const [store] = yield* makeSecretStores(1);

      yield* store!.create("replay-marker", Uint8Array.from([1]));
      const error = yield* Effect.flip(store!.create("replay-marker", Uint8Array.from([2])));

      assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(error));
      assert.deepEqual(Array.from(Option.getOrThrow(yield* store!.get("replay-marker"))), [1]);
      const fileSystem = yield* FileSystem.FileSystem;
      const leftovers = (yield* fileSystem.readDirectory(store!.directory!)).filter((name) =>
        name.endsWith(".tmp"),
      );
      assert.deepEqual(leftovers, []);
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("uses restrictive permissions for the secret directory and files", () =>
    Effect.gen(function* () {
      const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = [];
      const layerRecordingFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          return {
            ...fileSystem,
            makeDirectory: () => Effect.void,
            writeFile: () => Effect.void,
            rename: () => Effect.void,
            chmod: (path, mode) =>
              Effect.sync(() => {
                chmodCalls.push({ path: String(path), mode });
              }),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      const secretStore = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(layerServerConfig()),
            Layer.provideMerge(layerRecordingFileSystem),
          ),
        ),
      );

      yield* secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3]));

      assert.isTrue(
        chmodCalls.some((call) => call.mode === 0o700 && /[\\/]secrets$/.test(call.path)),
      );
      assert.isAtLeast(chmodCalls.filter((call) => call.mode === 0o600).length, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      assert.instanceOf(error, ServerSecretStore.SecretStoreRemoveError);
      assert.include(error.message, "Failed to remove secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRemoveFailureSecretStore())),
  );
});
