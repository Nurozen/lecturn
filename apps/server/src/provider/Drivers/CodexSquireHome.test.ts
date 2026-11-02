import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CodexSettings, ProviderInstanceId } from "@lecturn/contracts";
import { tokenizeCliArgs } from "@lecturn/shared/cliArgs";

import {
  CodexSquireHomeError,
  CodexSquireLoginError,
  makeCodexSquireHome,
  materializeCodexSquireHome,
} from "./CodexSquireHome.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const homes = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "lecturn-codex-squire-home-" });
  const sourceHomePath = path.join(root, "source");
  const squireHomePath = path.join(root, "squire");
  yield* fileSystem.makeDirectory(sourceHomePath);
  const materialize = materializeCodexSquireHome({
    fileSystem,
    path,
    sourceHomePath,
    squireHomePath,
  });
  return { fileSystem, path, sourceHomePath, squireHomePath, materialize };
});

describe("materializeCodexSquireHome", () => {
  it.effect("follows the source's login in and out, and links no user context", () =>
    Effect.gen(function* () {
      const { fileSystem, path, sourceHomePath, squireHomePath, materialize } = yield* homes;
      yield* fileSystem.writeFileString(path.join(sourceHomePath, "auth.json"), "{}");
      yield* fileSystem.writeFileString(path.join(sourceHomePath, "AGENTS.md"), "sentinel");
      yield* fileSystem.writeFileString(path.join(sourceHomePath, "hooks.json"), "{}");
      yield* fileSystem.writeFileString(path.join(sourceHomePath, "memories_1.sqlite"), "");
      yield* materialize;
      yield* materialize;
      assert.sameMembers(yield* fileSystem.readDirectory(squireHomePath), [
        "auth.json",
        "sessions",
        "archived_sessions",
        "thread-writer-locks",
        "rollout-migrations",
        "session_index.jsonl",
        "state_5.sqlite",
        "thread_history_1.sqlite",
      ]);

      yield* fileSystem.remove(path.join(sourceHomePath, "auth.json"));
      yield* materialize;
      assert.notInclude(yield* fileSystem.readDirectory(squireHomePath), "auth.json");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces a database Codex created locally once the source has one", () =>
    Effect.gen(function* () {
      const { fileSystem, path, sourceHomePath, squireHomePath, materialize } = yield* homes;
      yield* materialize;
      yield* fileSystem.writeFileString(path.join(squireHomePath, "state_6.sqlite"), "local");
      yield* fileSystem.writeFileString(path.join(squireHomePath, "state_6.sqlite-wal"), "local");
      yield* fileSystem.writeFileString(path.join(sourceHomePath, "state_6.sqlite"), "shared");
      yield* materialize;
      assert.equal(
        yield* fileSystem.readLink(path.join(squireHomePath, "state_6.sqlite")),
        path.join(sourceHomePath, "state_6.sqlite"),
      );
      assert.isFalse(yield* fileSystem.exists(path.join(squireHomePath, "state_6.sqlite-wal")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to replace a local directory or to use the source as the Squire home", () =>
    Effect.gen(function* () {
      const { fileSystem, path, sourceHomePath, squireHomePath } = yield* homes;
      yield* fileSystem.makeDirectory(path.join(squireHomePath, "sessions"), { recursive: true });
      const conflict = yield* materializeCodexSquireHome({
        fileSystem,
        path,
        sourceHomePath,
        squireHomePath,
      }).pipe(Effect.flip);
      assert.instanceOf(conflict, CodexSquireHomeError);
      const same = yield* materializeCodexSquireHome({
        fileSystem,
        path,
        sourceHomePath,
        squireHomePath: `${sourceHomePath}/`,
      }).pipe(Effect.flip);
      assert.instanceOf(same, CodexSquireHomeError);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("makeCodexSquireHome", () => {
  const squireHomeFor = Effect.gen(function* () {
    const { fileSystem, path, sourceHomePath } = yield* homes;
    const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "lecturn-squire-state-" });
    const home = yield* makeCodexSquireHome({
      fileSystem,
      path,
      stateDir,
      instanceId: ProviderInstanceId.make("codex"),
      homeDirectory: "/nonexistent-home",
    });
    const launch = (
      environment: NodeJS.ProcessEnv = {},
      setupMode?: "managed",
      launchArgs?: string,
    ) => ({
      settings: decodeCodexSettings({
        homePath: sourceHomePath,
        ...(setupMode ? { setupMode } : {}),
        ...(launchArgs === undefined ? {} : { launchArgs }),
      }),
      environment,
    });
    return { fileSystem, path, sourceHomePath, stateDir, home, launch };
  });

  it.effect("refuses a login the Squire home cannot reach, in words", () =>
    Effect.gen(function* () {
      const { fileSystem, path, sourceHomePath, home, launch } = yield* squireHomeFor;
      const refused = yield* home.prepare(launch()).pipe(Effect.flip);
      assert.instanceOf(refused, CodexSquireLoginError);
      assert.include(refused.message, sourceHomePath);
      assert.include(refused.message, "keyring");
      assert.include(refused.message, "codex login");
      assert.equal(yield* home.readiness(launch()), refused.message);
      assert.isFalse(yield* fileSystem.exists(home.squireHomePath));

      // Logins that do not live in auth.json pass through the environment.
      assert.isNull(yield* home.readiness(launch({ CODEX_API_KEY: "key" })));
      assert.isNull(yield* home.readiness(launch({}, "managed")));

      yield* fileSystem.writeFileString(path.join(sourceHomePath, "auth.json"), "{}");
      assert.isNull(yield* home.readiness(launch()));
      const prepared = yield* home.prepare(launch({ CODEX_HOME: sourceHomePath }));
      assert.equal(prepared.settings.homePath, home.squireHomePath);
      assert.include(prepared.settings.launchArgs, `cli_auth_credentials_store="file"`);
      assert.isUndefined(prepared.environment.CODEX_HOME);
      assert.equal(
        yield* fileSystem.readLink(path.join(home.squireHomePath, "auth.json")),
        path.join(sourceHomePath, "auth.json"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps an instance's launch args from turning a Squire's tools back on", () =>
    Effect.gen(function* () {
      const { fileSystem, path, sourceHomePath, home, launch } = yield* squireHomeFor;
      yield* fileSystem.writeFileString(path.join(sourceHomePath, "auth.json"), "{}");
      const hostile = [
        "--enable shell_tool",
        "-c features.shell_tool=true",
        "--config=features.unified_exec=true",
        `-c 'mcp_servers.evil.command="evil"'`,
        "-cweb_search=live",
        "--cloud-skills-snapshot /tmp/skills.json",
        "--code-mode-host ws://127.0.0.1:1",
        "--listen ws://0.0.0.0:4500",
        `-c 'model_provider="custom"'`,
        `--config 'model_providers.custom.name="It'"'"'s mine"'`,
      ].join(" ");
      const kept = [
        "-c",
        `model_provider="custom"`,
        "-c",
        `model_providers.custom.name="It's mine"`,
        "-c",
        `cli_auth_credentials_store="file"`,
      ];
      const fromSettings = yield* home.prepare(launch({}, undefined, hostile));
      assert.deepEqual(tokenizeCliArgs(fromSettings.settings.launchArgs), kept);
      const fromEnvironment = yield* home.prepare(
        launch({ LECTURN_CODEX_LAUNCH_ARGS: hostile }, undefined, ""),
      );
      assert.deepEqual(tokenizeCliArgs(fromEnvironment.settings.launchArgs), kept);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("serializes concurrent prepares of one home from separate owners", () =>
    Effect.gen(function* () {
      const { fileSystem, path, sourceHomePath, stateDir, home, launch } = yield* squireHomeFor;
      yield* fileSystem.writeFileString(path.join(sourceHomePath, "auth.json"), "{}");
      // The adapter and the summary writer each build their own handle.
      const second = yield* makeCodexSquireHome({
        fileSystem,
        path,
        stateDir,
        instanceId: ProviderInstanceId.make("codex"),
        homeDirectory: "/nonexistent-home",
      });
      assert.equal(second.squireHomePath, home.squireHomePath);
      yield* Effect.all(
        Array.from({ length: 6 }, (_, index) =>
          (index % 2 === 0 ? home : second).prepare(launch()),
        ),
        { concurrency: "unbounded" },
      );
      assert.include(yield* fileSystem.readDirectory(home.squireHomePath), "auth.json");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
