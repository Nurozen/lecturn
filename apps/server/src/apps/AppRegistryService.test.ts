import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AppRegistration,
  type AppSidecarBootstrap,
  AppsError,
  ProjectId,
} from "@lecturn/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { DeviceToolkit } from "../mcp/toolkits/device/tools.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import { HtmlToolkit } from "../mcp/toolkits/html/tools.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../mcp/toolkits/worktree/tools.ts";
import { AttachmentToolkit } from "../mcp/toolkits/attachment/tools.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AppLeaseServiceLayer from "./AppLeaseService.ts";
import * as AppRegistryServiceLayer from "./AppRegistryService.ts";
import { RESERVED_APP_TOOL_PREFIXES } from "./AppRegistryService.ts";
import {
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  LiveToolClient,
} from "./services.ts";

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const decodeRegistration = Schema.decodeUnknownSync(AppRegistration);
const makeRegistration = (overrides: Record<string, unknown> = {}) =>
  decodeRegistration({
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

const registration = makeRegistration();
const appProject = ProjectId.make("project-app");
const liveDefinitions = [
  new McpSchema.Tool({ name: "window_flash", inputSchema: { type: "object" } }),
];
const headlessDefinitions = [
  new McpSchema.Tool({ name: "design", inputSchema: { type: "object" } }),
];
const liveLease = { url: "http://127.0.0.1:4100/mcp", bearer: "live-bearer", ttlSeconds: 20 };

const makeLayer = (options: { readonly appSidecar?: AppSidecarBootstrap } = {}) => {
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
  const layer = AppRegistryServiceLayer.layer.pipe(
    Layer.provideMerge(AppLeaseServiceLayer.layer),
    Layer.provide(liveClient),
    Layer.provide(projects),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(config),
  );
  return { layer, liveListCalls };
};

const sidecar = (overrides: Record<string, unknown> = {}): AppSidecarBootstrap => ({
  mode: "app-sidecar",
  registration: makeRegistration(overrides),
  appSeedToken: "seed-token",
});

/** Delivers a stream's elements in order, so tests await each one instead of sleeping. */
const streamQueue = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<A>();
    yield* stream.pipe(
      Stream.runForEach((value) => Queue.offer(queue, value)),
      Effect.forkChild({ startImmediately: true }),
    );
    return queue;
  });

const isAppsError = Schema.is(AppsError);

const errorCode = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isFailure(exit)
    ? Option.match(Exit.findErrorOption(exit), {
        onNone: () => "defect",
        onSome: (error) => (isAppsError(error) ? error.code : String(error)),
      })
    : "success";

it.layer(NodeServices.layer)("AppRegistryService", (it) => {
  it.effect("shows a new app's pairing request until it expires", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const events = yield* streamQueue(registry.streamStatus);
      assert.deepEqual(yield* Queue.take(events), { type: "snapshot", apps: [] });

      const created = yield* registry.createPairingRequest(registration);
      const pending = yield* Queue.take(events);
      assert.strictEqual(pending.type === "upsert" && pending.app.state, "pairing-requested");
      assert.strictEqual(
        pending.type === "upsert" && pending.app.pendingRequest?.requestId,
        created.requestId,
      );
      assert.isFalse(yield* registry.isGranted(registration.appId));

      const poll = (pollSecret: string) =>
        registry.pollPairingRequest({ requestId: created.requestId, pollSecret });
      assert.deepEqual(yield* poll(created.pollSecret), { state: "pairing-requested" });
      assert.strictEqual(errorCode(yield* Effect.exit(poll("wrong-secret"))), "not-found");

      yield* TestClock.adjust("10 minutes");
      assert.deepEqual(yield* poll(created.pollSecret), { state: "expired" });
      // Clients drop the prompt from this upsert; they keep no timers of their own.
      const expired = yield* Queue.take(events);
      assert.isTrue(expired.type === "upsert" && expired.app.pendingRequest === null);
    }).pipe(Effect.provide(layer));
  });

  it.effect("supersedes an earlier pairing request from the same app", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const first = yield* registry.createPairingRequest(registration);
      const second = yield* registry.createPairingRequest(registration);

      assert.deepEqual(
        yield* registry.pollPairingRequest({
          requestId: first.requestId,
          pollSecret: first.pollSecret,
        }),
        { state: "expired" },
      );
      assert.strictEqual((yield* registry.list)[0]?.pendingRequest?.requestId, second.requestId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses tool prefixes that Lecturn or another app already uses", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      for (const toolPrefix of ["preview", "lecturn", "apps", "worktree"]) {
        const exit = yield* Effect.exit(
          registry.createPairingRequest(makeRegistration({ toolPrefix })),
        );
        assert.strictEqual(errorCode(exit), "invalid", toolPrefix);
      }

      yield* registry.seedSidecarGrant(sidecar());
      const other = makeRegistration({ appId: "dev.other.app", name: "Other" });
      assert.strictEqual(
        errorCode(yield* Effect.exit(registry.createPairingRequest(other))),
        "conflict",
      );
      assert.strictEqual(
        errorCode(
          yield* Effect.exit(registry.seedSidecarGrant({ ...sidecar(), registration: other })),
        ),
        "conflict",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("grants a sidecar's app and keeps its headless cache only for the same command", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      yield* registry.seedSidecarGrant(sidecar());
      assert.isTrue(yield* registry.isGranted(registration.appId));
      const record = yield* registry.get(registration.appId);
      assert.strictEqual(Option.getOrThrow(record).status.state, "granted");
      assert.isNotNull(Option.getOrThrow(record).status.lastSeenAt);

      assert.isTrue(Option.isNone((yield* registry.cachedTools(registration.appId)).headless));
      yield* registry.setCachedTools(registration.appId, "headless", headlessDefinitions);
      yield* registry.setCachedTools(registration.appId, "live", liveDefinitions);

      yield* registry.seedSidecarGrant(sidecar({ name: "Example 2" }));
      const kept = yield* registry.cachedTools(registration.appId);
      assert.deepEqual(
        Option.map(kept.headless, (tools) => tools.map((tool) => tool.name)),
        Option.some(["design"]),
      );

      yield* registry.seedSidecarGrant(
        sidecar({ headlessTools: { ...registration.headlessTools, args: ["serve"] } }),
      );
      const changed = yield* registry.cachedTools(registration.appId);
      assert.isTrue(Option.isNone(changed.headless));
      assert.isTrue(Option.isSome(changed.live));

      assert.isTrue(
        Option.isNone(yield* registry.get(makeRegistration({ appId: "dev.none.app" }).appId)),
      );
      assert.strictEqual(
        errorCode(
          yield* Effect.exit(
            registry.cachedTools(makeRegistration({ appId: "dev.none.app" }).appId),
          ),
        ),
        "not-found",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("grants the sidecar's own app at startup", () => {
    const { layer } = makeLayer({ appSidecar: sidecar() });
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      assert.isTrue(yield* registry.isGranted(registration.appId));
    }).pipe(Effect.provide(layer));
  });

  it.effect("refreshes live definitions when a lease is established, not on each heartbeat", () => {
    const { layer, liveListCalls } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const leases = yield* AppLeaseService;
      yield* registry.seedSidecarGrant(sidecar());
      const events = yield* streamQueue(registry.streamStatus);
      yield* Queue.take(events);
      const nextLive = Queue.take(events).pipe(
        Effect.map((event) => (event.type === "upsert" ? event.app.live : "removed")),
      );

      yield* leases.set(registration.appId, liveLease);
      assert.isNotNull(yield* nextLive);
      assert.strictEqual(liveListCalls.count, 1);
      const cached = yield* registry.cachedTools(registration.appId);
      assert.deepEqual(
        Option.map(cached.live, (tools) => tools.map((tool) => tool.name)),
        Option.some(["window_flash"]),
      );

      // Changes are handled in order, so the closing upsert proves the renewal before it listed nothing.
      yield* leases.set(registration.appId, liveLease);
      yield* leases.clear(registration.appId);
      assert.isNull(yield* nextLive);
      assert.strictEqual(liveListCalls.count, 1);

      // Re-established after closing: a restarted app may serve new tools.
      yield* leases.set(registration.appId, liveLease);
      assert.isNotNull(yield* nextLive);
      assert.strictEqual(liveListCalls.count, 2);

      yield* TestClock.adjust("20 seconds");
      assert.isNull(yield* nextLive);
    }).pipe(Effect.provide(layer));
  });

  it.effect("streams the embed context of an app project and refuses other projects", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      const registry = yield* AppRegistryService;
      const leases = yield* AppLeaseService;
      yield* registry.seedSidecarGrant(sidecar());

      const contexts = yield* streamQueue(registry.streamEmbedContext(appProject));
      const initial = yield* Queue.take(contexts);
      assert.strictEqual(initial.name, "Example");
      assert.isNull(initial.live);
      yield* leases.set(registration.appId, liveLease);
      assert.isNotNull((yield* Queue.take(contexts)).live);

      const other = yield* Effect.exit(
        Stream.runCollect(registry.streamEmbedContext(ProjectId.make("project-plain"))),
      );
      assert.strictEqual(errorCode(other), "not-found");
    }).pipe(Effect.provide(layer));
  });
});

it("reserves the first segment of every built-in Lecturn tool name", () => {
  const toolkits = [
    AttachmentToolkit,
    DeviceToolkit,
    EnvironmentToolkit,
    HtmlToolkit,
    OrchestratorToolkit,
    PreviewToolkit,
    PreviewControlsToolkit,
    ProjectToolkit,
    PullRequestsToolkit,
    ThreadToolkit,
    WorktreeToolkit,
  ];
  const unreserved = toolkits
    .flatMap((toolkit) => Object.keys(toolkit.tools))
    .filter((name) => !RESERVED_APP_TOOL_PREFIXES.has(name.split("_")[0] ?? name));
  assert.deepEqual(unreserved, []);
});
