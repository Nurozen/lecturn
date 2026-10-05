import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const VALID_CATALOG =
  '{"schemaVersion":1,"targets":[],"profiles":[],"credentials":[],"remoteDpopTokens":[]}';
const QUARANTINE_PATTERN = /^connection-catalog\.quarantine-\d+\.json$/;

const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
  isEncryptionAvailable: Effect.succeed(true),
  encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
  decryptString: (value) => Effect.succeed(textDecoder.decode(value).slice("encrypted:".length)),
  selectedStorageBackend: Effect.succeed(Option.none()),
} satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

// Each call builds a fresh store, which stands in for a new desktop process.
function makeLayer(baseDir: string) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ LECTURN_HOME: baseDir })),
    ),
  );
  const dependencies = Layer.mergeAll(environmentLayer, safeStorageLayer, NodeServices.layer);
  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(DesktopSavedEnvironments.layer.pipe(Layer.provideMerge(dependencies))),
    Layer.provideMerge(dependencies),
  );
}

const listQuarantined = (fileSystem: FileSystem.FileSystem, stateDir: string) =>
  fileSystem
    .readDirectory(stateDir)
    .pipe(Effect.map((names) => names.filter((name) => QUARANTINE_PATTERN.test(name)).toSorted()));

describe("DesktopConnectionCatalogStore quarantine", () => {
  it.effect("keeps a catalog the renderer cannot decode before a save replaces it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "lecturn-desktop-connection-catalog-test-",
      });
      const stateDir = `${baseDir}/userdata`;
      const catalogPath = `${stateDir}/connection-catalog.json`;
      const writeStore = () =>
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(makeLayer(baseDir)),
        );

      // A well-formed encrypted file whose catalog the runtime schema rejects.
      assert.isTrue(yield* (yield* writeStore()).set('{"schemaVersion":99}'));
      const undecodable = yield* fileSystem.readFileString(catalogPath);

      const store = yield* writeStore();
      assert.deepStrictEqual(yield* store.get, Option.some('{"schemaVersion":99}'));
      assert.equal(yield* fileSystem.readFileString(catalogPath), undecodable);
      assert.deepStrictEqual(yield* listQuarantined(fileSystem, stateDir), []);

      assert.isTrue(yield* store.set(VALID_CATALOG));
      const quarantined = yield* listQuarantined(fileSystem, stateDir);
      assert.equal(quarantined.length, 1);
      assert.equal(yield* fileSystem.readFileString(`${stateDir}/${quarantined[0]}`), undecodable);
      assert.deepStrictEqual(yield* store.get, Option.some(VALID_CATALOG));

      // A readable catalog is replaced without another copy.
      assert.isTrue(yield* (yield* writeStore()).set(VALID_CATALOG));
      assert.equal((yield* listQuarantined(fileSystem, stateDir)).length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps a malformed catalog file and bounds the quarantine copies", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "lecturn-desktop-connection-catalog-test-",
      });
      const stateDir = `${baseDir}/userdata`;
      const catalogPath = `${stateDir}/connection-catalog.json`;
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });

      for (let round = 1; round <= 5; round += 1) {
        yield* TestClock.adjust("1 second");
        yield* fileSystem.writeFileString(catalogPath, `{not-json-${round}`);
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(makeLayer(baseDir)),
        );
        assert.isTrue(yield* store.set(VALID_CATALOG));
      }

      const quarantined = yield* listQuarantined(fileSystem, stateDir);
      assert.deepStrictEqual(quarantined, [
        "connection-catalog.quarantine-3000.json",
        "connection-catalog.quarantine-4000.json",
        "connection-catalog.quarantine-5000.json",
      ]);
      assert.equal(
        yield* fileSystem.readFileString(`${stateDir}/${quarantined[2]}`),
        "{not-json-5",
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
