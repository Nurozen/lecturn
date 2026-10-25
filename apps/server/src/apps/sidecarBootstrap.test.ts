import * as NodeServices from "@effect/platform-node/NodeServices";
import { AppRegistration, type AppSidecarBootstrap } from "@lecturn/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { splitServerBootstrap } from "./sidecarBootstrap.ts";

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
