// @effect-diagnostics nodeBuiltinImport:off -- the parent pipe test spawns a real peer process.
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AppRegistration, type AppSidecarBootstrap } from "@lecturn/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  type AppSidecarParentProbe,
  awaitAppSidecarParentExit,
  exitWithAppSidecarParent,
  splitServerBootstrap,
} from "./sidecarBootstrap.ts";

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const appSidecar: AppSidecarBootstrap = {
  mode: "app-sidecar",
  registration: Schema.decodeSync(AppRegistration)({
    appId: "dev.example.app",
    name: "Example",
    iconDataUrl: PNG_1PX,
    toolPrefix: "ex",
    refPrefixes: ["ex:"],
    liveTools: false,
    gatedTools: [],
  }),
  appSeedToken: "sidecar-seed-token",
};

const layerAuth = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return { ...config, ...overrides } satisfies ServerConfig.ServerConfig["Service"];
        }),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-sidecar-" }))),
    ),
  );

const metadata = { deviceType: "desktop" as const, os: "macOS" };

it("routes an app-sidecar envelope away from the desktop fields", () => {
  assert.deepEqual(splitServerBootstrap(Option.some(appSidecar)), {
    desktop: undefined,
    appSidecar,
  });
  assert.deepEqual(splitServerBootstrap(Option.none()), {
    desktop: undefined,
    appSidecar: undefined,
  });
});

it.layer(NodeServices.layer)("sidecar seed grant", (it) => {
  it.effect("exchanges the seed for an app session that holds only apps:host", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      const first = yield* auth.exchangeBootstrapCredentialForAccessToken(
        appSidecar.appSeedToken,
        undefined,
        metadata,
      );
      const session = yield* sessions.verify(first.access_token);
      assert.strictEqual(session.subject, "app:dev.example.app");
      assert.deepEqual(session.scopes, ["apps:host"]);

      // The helper re-exchanges after a restart; its earlier session is replaced, not kept.
      const second = yield* auth.exchangeBootstrapCredentialForAccessToken(
        appSidecar.appSeedToken,
        undefined,
        metadata,
      );
      assert.strictEqual(
        (yield* sessions.verify(second.access_token)).subject,
        "app:dev.example.app",
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(sessions.verify(first.access_token))));

      const widened = yield* Effect.exit(
        auth.exchangeBootstrapCredentialForAccessToken(
          appSidecar.appSeedToken,
          ["orchestration:read"],
          metadata,
        ),
      );
      assert.isTrue(Exit.isFailure(widened));
    }).pipe(Effect.provide(layerAuth({ appSidecar }))),
  );

  it.effect("seeds nothing on a server that is not a sidecar", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const exit = yield* Effect.exit(
        auth.exchangeBootstrapCredentialForAccessToken(
          appSidecar.appSeedToken,
          undefined,
          metadata,
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(layerAuth({}))),
  );
});

const fakeParent = (initial = 4242) => {
  const state = { ppid: initial, alive: true };
  const probe: AppSidecarParentProbe = {
    parentPid: () => state.ppid,
    isAlive: () => state.alive,
    openPipe: () => {
      throw new Error("no pipe in this test");
    },
  };
  return { state, probe };
};

describe("sidecar parent watch", () => {
  it.effect("ends when the sidecar is re-parented after the app dies", () =>
    Effect.gen(function* () {
      const { state, probe } = fakeParent();
      const watch = yield* Effect.forkChild(awaitAppSidecarParentExit(appSidecar, { probe }));
      yield* TestClock.adjust(Duration.seconds(3));
      assert.isUndefined(watch.pollUnsafe());

      state.ppid = 1;
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(watch)));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("ends when the parent pid is gone without a re-parent, as on Windows", () =>
    Effect.gen(function* () {
      const { state, probe } = fakeParent();
      const watch = yield* Effect.forkChild(
        awaitAppSidecarParentExit(
          { ...appSidecar, parentPipeFd: 9 },
          { probe, pollInterval: Duration.millis(250) },
        ),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isUndefined(watch.pollUnsafe());

      state.alive = false;
      yield* TestClock.adjust(Duration.millis(250));
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(watch)));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("ends at the end of the parent pipe without waiting for a poll", () =>
    Effect.gen(function* () {
      const { probe } = fakeParent();
      const pipe = new NodeStream.PassThrough();
      const opened: Array<number> = [];
      const watch = yield* Effect.forkChild(
        awaitAppSidecarParentExit(
          { ...appSidecar, parentPipeFd: 4 },
          {
            probe: {
              ...probe,
              openPipe: (fd) => {
                opened.push(fd);
                return pipe;
              },
            },
          },
        ),
      );
      yield* Effect.yieldNow;
      assert.deepEqual(opened, [4]);
      assert.isUndefined(watch.pollUnsafe());

      pipe.end();
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(watch)));
      assert.isTrue(pipe.destroyed);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  // The peer is another process, as in production, so its death is what closes the pipe.
  it.live("ends when the process holding the other end of the pipe dies", () =>
    Effect.gen(function* () {
      const peer = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "ignore", "ignore", "pipe"],
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.kill("SIGKILL")));
      const pipe = peer.stdio[3] as NodeStream.Duplex;
      const { parentPid, isAlive } = fakeParent().probe;
      const watch = yield* Effect.forkChild(
        awaitAppSidecarParentExit(
          { ...appSidecar, parentPipeFd: 4 },
          { probe: { parentPid, isAlive, openPipe: () => pipe } },
        ).pipe(Effect.timeout(Duration.seconds(10))),
      );
      yield* Effect.sleep(Duration.millis(300));
      assert.isUndefined(watch.pollUnsafe());

      peer.kill("SIGKILL");
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(watch)));
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the poll in charge when the pipe cannot be opened", () =>
    Effect.gen(function* () {
      const { state, probe } = fakeParent();
      // Not a descriptor this process has, so the real opener refuses it.
      const watch = yield* Effect.forkChild(
        awaitAppSidecarParentExit(
          { ...appSidecar, parentPipeFd: 987_654 },
          { probe: { parentPid: probe.parentPid, isAlive: probe.isAlive } },
        ),
      );
      yield* TestClock.adjust(Duration.seconds(2));
      assert.isUndefined(watch.pollUnsafe());

      state.ppid = 1;
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(watch)));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("stops the server, finalizers included, and fails so the CLI exits", () =>
    Effect.gen(function* () {
      const { state, probe } = fakeParent();
      let finalized = false;
      const server = Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized = true;
        }),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);

      const run = yield* Effect.forkChild(
        server.pipe(exitWithAppSidecarParent({ appSidecar }, { probe })),
      );
      yield* TestClock.adjust(Duration.seconds(2));
      assert.isFalse(finalized);

      state.ppid = 1;
      yield* TestClock.adjust(Duration.seconds(1));
      const exit = yield* Fiber.await(run);
      assert.isTrue(finalized);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(
        Option.getOrUndefined(Exit.findErrorOption(exit))?._tag,
        "AppSidecarParentExitedError",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it("leaves a server that is not a sidecar untouched", () => {
    const server = Effect.never;
    assert.strictEqual(exitWithAppSidecarParent({ appSidecar: undefined })(server), server);
  });
});
