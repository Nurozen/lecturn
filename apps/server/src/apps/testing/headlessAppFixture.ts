// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  AppId,
  type AppRegistration,
  type AppRuntimeCeiling,
  type AppStatus,
  type AppStatusStreamEvent,
  ProjectId,
} from "@lecturn/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { McpSchema } from "effect/ai";

import {
  AppProjectService,
  AppRegistryService,
  type AppCachedTools,
  type AppToolTier,
} from "../services.ts";

const FIXTURE_SERVER = NodeURL.fileURLToPath(
  new URL("./HeadlessMcpServer.fixture.mjs", import.meta.url),
);

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const fixtureAppId = AppId.make("dev.lecturn.counter");
export const fixtureProjectId = ProjectId.make("project-counter");

export interface FixtureLogEvent {
  readonly pid: number;
  readonly event: "start" | "exit" | "call" | "read" | "stdin-closed" | "sigterm";
  readonly mode?: "list" | "serve";
  readonly cwd?: string;
  readonly argv?: ReadonlyArray<string>;
  readonly pinned?: string | null;
  readonly electronRunAsNode?: string | null;
  readonly name?: string;
  readonly inFlight?: number;
  readonly uri?: string;
}

/** A real workspace folder (cwd must exist) and the fixture's event log inside it. */
export const makeWorkspace = () => {
  const workspaceRoot = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lecturn-headless-")),
  );
  const logPath = NodePath.join(workspaceRoot, "fixture.log");
  return {
    workspaceRoot,
    logPath,
    events: (): ReadonlyArray<FixtureLogEvent> =>
      NodeFS.existsSync(logPath)
        ? NodeFS.readFileSync(logPath, "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as FixtureLogEvent)
        : [],
    remove: () => NodeFS.rmSync(workspaceRoot, { recursive: true, force: true }),
  };
};

export const fixtureRegistration = (
  logPath: string,
  options: { readonly listArgs: boolean },
): AppRegistration => ({
  appId: fixtureAppId,
  name: "Counter",
  iconDataUrl: PNG_1PX,
  toolPrefix: "ex",
  refPrefixes: ["ex:"],
  liveTools: false,
  gatedTools: ["gated_job"],
  headlessTools: {
    command: process.execPath,
    args: [FIXTURE_SERVER, "--project", "{workspaceRoot}"],
    ...(options.listArgs
      ? { listArgs: [FIXTURE_SERVER, "--list-tools", "--project", "{workspaceRoot}"] }
      : {}),
    env: { FIXTURE_LOG: logPath, FIXTURE_PIN: "{workspaceRoot}" },
    cwd: "{workspaceRoot}",
  },
});

export const statusOf = (
  registration: AppRegistration,
  state: AppStatus["state"] = "granted",
): AppStatus => ({
  appId: registration.appId,
  name: registration.name,
  iconDataUrl: registration.iconDataUrl,
  toolPrefix: registration.toolPrefix,
  refPrefixes: registration.refPrefixes,
  openUrlTemplate: null,
  state,
  live: null,
  lastSeenAt: null,
  runtimeCeiling: null,
  headlessTools: registration.headlessTools ?? null,
  gatedTools: registration.gatedTools,
  embedOrigins: [],
  pendingRequest: null,
});

/**
 * An in-memory registry with one app. Each published status event resolves
 * its Deferred once the subscriber has handled it and asked for the next.
 */
export const makeFakeApps = (input: {
  readonly registration: AppRegistration;
  readonly workspaceRoot: string;
  readonly cachedHeadless?: ReadonlyArray<McpSchema.Tool>;
  readonly cachedLive?: ReadonlyArray<McpSchema.Tool>;
}) =>
  Effect.gen(function* () {
    const state = yield* Ref.make<AppStatus["state"]>("granted");
    const ceiling = yield* Ref.make<AppRuntimeCeiling>(null);
    const cache = yield* Ref.make<AppCachedTools>({
      headless: Option.fromNullishOr(input.cachedHeadless),
      live: Option.fromNullishOr(input.cachedLive),
    });
    const cacheWrites: Array<{
      readonly tier: AppToolTier;
      readonly names: ReadonlyArray<string>;
    }> = [];
    const statusEvents = yield* Queue.unbounded<{
      readonly event: AppStatusStreamEvent;
      readonly handled: Deferred.Deferred<void>;
    }>();

    const registry = Layer.mock(AppRegistryService)({
      get: (appId) =>
        Effect.all([Ref.get(state), Ref.get(ceiling)]).pipe(
          Effect.map(([current, runtimeCeiling]) =>
            appId === input.registration.appId
              ? Option.some({
                  status: { ...statusOf(input.registration, current), runtimeCeiling },
                  registration: input.registration,
                })
              : Option.none(),
          ),
        ),
      cachedTools: () => Ref.get(cache),
      setCachedTools: (_appId, tier, definitions) =>
        Effect.sync(() =>
          cacheWrites.push({ tier, names: definitions.map((tool) => tool.name) }),
        ).pipe(
          Effect.andThen(
            Ref.update(cache, (current) => ({ ...current, [tier]: Option.some(definitions) })),
          ),
        ),
      streamStatus: Stream.fromQueue(statusEvents).pipe(
        Stream.flatMap(({ event, handled }) =>
          Stream.concat(
            Stream.make(event),
            Stream.fromEffect(Deferred.succeed(handled, undefined)).pipe(Stream.drain),
          ),
        ),
      ),
    });

    const projects = Layer.mock(AppProjectService)({
      resolveAppForProject: (projectId) =>
        Effect.succeed(
          projectId === fixtureProjectId
            ? Option.some({ appId: input.registration.appId, workspaceRoot: input.workspaceRoot })
            : Option.none(),
        ),
    });

    const publishStatus = (next: AppStatus["state"]) =>
      Effect.gen(function* () {
        yield* Ref.set(state, next);
        const handled = yield* Deferred.make<void>();
        yield* Queue.offer(statusEvents, {
          event: { type: "upsert", app: statusOf(input.registration, next) },
          handled,
        });
        yield* Deferred.await(handled);
      });

    return {
      layer: Layer.merge(registry, projects),
      cacheWrites,
      cache,
      state,
      ceiling,
      publishStatus,
    };
  });
