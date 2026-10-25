import {
  AppRegistration,
  type AppSidecarBootstrap,
  AppsError,
  ProjectId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/ai";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as AppLeaseServiceLayer from "../AppLeaseService.ts";
import * as AppRegistryServiceLayer from "../AppRegistryService.ts";
import { AppProjectService, LiveToolClient } from "../services.ts";

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const decodeRegistration = Schema.decodeUnknownSync(AppRegistration);

export const registrationInput = (overrides: Record<string, unknown> = {}) => ({
  appId: "dev.example.app",
  name: "Example",
  iconDataUrl: PNG_1PX,
  toolPrefix: "ex",
  refPrefixes: ["ex:"],
  headlessTools: {
    command: "/usr/local/bin/example",
    args: ["mcp", "{workspaceRoot}"],
    listArgs: ["mcp", "--list-tools", "{workspaceRoot}"],
    cwd: "{workspaceRoot}",
  },
  liveTools: true,
  gatedTools: ["deploy"],
  ...overrides,
});

export const makeRegistration = (overrides: Record<string, unknown> = {}) =>
  decodeRegistration(registrationInput(overrides));

export const registration = makeRegistration();
export const appProject = ProjectId.make("project-app");
export const liveDefinitions = [
  new McpSchema.Tool({ name: "window_flash", inputSchema: { type: "object" } }),
];

/**
 * The real registry over an in-memory database, with real sessions so issued
 * credentials can be verified. Leases and sessions stay reachable for asserts.
 */
export const makeRegistryLayer = (options: { readonly appSidecar?: AppSidecarBootstrap } = {}) => {
  const liveListCalls = { count: 0 };
  const config = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig.ServerConfig;
      return { ...base, ...options } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-app-registry-" })));
  const liveClient = Layer.succeed(LiveToolClient)({
    listTools: () =>
      Effect.sync(() => {
        liveListCalls.count++;
        return liveDefinitions;
      }),
    call: () => Effect.die("unused"),
    readResource: () => Effect.die("unused"),
  });
  const projects = Layer.succeed(AppProjectService)({
    ensureWorkspace: () => Effect.die("unused"),
    resolveAppForProject: (projectId) =>
      Effect.succeed(
        projectId === appProject
          ? Option.some({ appId: registration.appId, workspaceRoot: "/work/rocket" })
          : Option.none(),
      ),
    listThreads: () => Effect.die("unused"),
    streamThreads: () => Stream.die("unused"),
    setThreadAppData: () => Effect.die("unused"),
    createEmbedThread: () => Effect.die("unused"),
    markThreadsCopied: () => Effect.die("unused"),
  });
  const sessions = SessionStore.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
  );
  const layer = AppRegistryServiceLayer.layer.pipe(
    Layer.provideMerge(AppLeaseServiceLayer.layer),
    Layer.provideMerge(sessions),
    Layer.provide(liveClient),
    Layer.provide(projects),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(config),
  );
  return { layer, liveListCalls };
};

export const sidecar = (overrides: Record<string, unknown> = {}): AppSidecarBootstrap => ({
  mode: "app-sidecar",
  registration: makeRegistration(overrides),
  appSeedToken: "seed-token",
});

/** Delivers a stream's elements in order, so tests await each one instead of sleeping. */
export const streamQueue = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<A>();
    yield* stream.pipe(
      Stream.runForEach((value) => Queue.offer(queue, value)),
      Effect.forkChild({ startImmediately: true }),
    );
    return queue;
  });

const isAppsError = Schema.is(AppsError);

export const errorCode = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isFailure(exit)
    ? Option.match(Exit.findErrorOption(exit), {
        onNone: () => "defect",
        onSome: (error) => (isAppsError(error) ? error.code : String(error)),
      })
    : "success";
