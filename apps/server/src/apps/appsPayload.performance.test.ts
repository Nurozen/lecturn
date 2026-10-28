// @effect-diagnostics nodeBuiltinImport:off
/**
 * A client that is not an app pays at most 2% more shell bytes per
 * update once the fixture app (Embed Host) is registered and its history
 * imported. Both worlds run the same workload on the same non-app threads
 * through the real shell subscription, and every item the client receives is
 * measured as it is encoded for the wire.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AppId,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  ConnectedAppThreadBundleV1,
  EnvironmentId,
  EventId,
  type ModelSelection,
  type OrchestrationV2Command,
  OrchestrationV2RpcSchemas,
  type OrchestrationV2ShellStreamItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { subscribeOrchestrationV2Shell } from "../ws.ts";
import * as AppProjectServiceLayer from "./AppProjectService.ts";
import { filterShellStream } from "./appStreamFilter.ts";
import { AppAuthorization, AppRegistryService, ThreadCopyService } from "./services.ts";
import * as ThreadCopyServiceLayer from "./ThreadCopyService.ts";

const MAX_GROWTH = 0.02;

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;
const fixtureApp = AppId.make("dev.embed-host");
const NOW = "2026-10-25T12:00:00.000Z";

const providerInstance = {
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:apps-payload-test" },
  displayName: "Codex apps payload test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("the workload runs no provider turns"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const makeEnvironmentLayer = (name: string) =>
  ThreadCopyServiceLayer.layer.pipe(
    Layer.provideMerge(AppProjectServiceLayer.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
        RuntimeLayer.layerProjectService,
        RuntimeLayer.layerEventSink,
        ProjectStore.layer,
        ProjectionStore.layer,
        OrchestrationEventStore.layer,
      ),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(Layer.mock(CheckpointStore.CheckpointStore)({})),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provide(
      Layer.succeed(WorkspacePaths.WorkspacePaths, {
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
        resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
          Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
      }),
    ),
    Layer.provide(
      Layer.merge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: () => Effect.succeed(null),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          resolvePath: () => Effect.succeed(null),
        }),
      ),
    ),
    // The registered fixture app, as the copy service looks it up.
    Layer.provide(
      Layer.mock(AppRegistryService)({
        get: () => Effect.succeed(Option.some({ status: { name: "Embed Host" } } as never)),
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(`environment:${name}`)),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: `apps-payload-${name}-` })),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(id === instanceId ? providerInstance : undefined),
        listInstances: Effect.succeed([providerInstance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({
        pruneWorktrees: () => Effect.void,
        createWorktree: () => Effect.succeed({} as never),
      }),
    ),
    Layer.provideMerge(
      Layer.merge(
        NodeServices.layer,
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => Effect.die("unused"),
        }),
      ),
    ),
  );

type EnvironmentServices = Layer.Success<ReturnType<typeof makeEnvironmentLayer>>;

const encodeShellItem = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeShell.output),
);
const shellItemBytes = (item: OrchestrationV2ShellStreamItem) =>
  Buffer.byteLength(JSON.stringify(encodeShellItem(item)), "utf8");
const rowBytes = (row: unknown) => Buffer.byteLength(JSON.stringify(row), "utf8");

const decodeBundleJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ConnectedAppThreadBundleV1),
);
const fixtureBundle = () =>
  decodeBundleJson(
    NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "fixtures", "embed-host.bundle.json"),
      "utf8",
    ),
  );

/** A signed-in Lecturn client, which is not an app. */
const userSession: AuthenticatedSession = {
  sessionId: AuthSessionId.make("session:user"),
  subject: "owner",
  method: "browser-session-cookie",
  scopes: [AuthOrchestrationReadScope],
} as AuthenticatedSession;

const userProjects = [ProjectId.make("project:user-a"), ProjectId.make("project:user-b")];
const userThreads = userProjects.flatMap((projectId, index) =>
  [1, 2].map((n) => ({ projectId, threadId: ThreadId.make(`thread:user-${index}-${n}`) })),
);

const seedUserProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: NOW,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: `Project ${projectId.slice(-1)}`,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );

/**
 * Each step changes one user thread's shell the way a user does: a rename,
 * a pin, a visit. Titles keep one length so both worlds send the same text.
 */
const workload = (step: number): OrchestrationV2Command => {
  const { threadId } = userThreads[step % userThreads.length]!;
  const commandId = CommandId.make(`workload:${step}`);
  switch (step % 3) {
    case 0:
      return {
        type: "thread.metadata.update",
        commandId,
        threadId,
        title: `Renamed ${String(step).padStart(2, "0")}`,
      };
    case 1:
      return { type: "thread.pin", commandId, threadId };
    default:
      return { type: "thread.unpin", commandId, threadId };
  }
};
const WORKLOAD_STEPS = 24;

interface WorldMeasurement {
  readonly appThreadsInSnapshot: number;
  /** Encoded bytes of every user project and thread row in the first snapshot, by id. */
  readonly userRowBytes: ReadonlyMap<string, number>;
  readonly updates: ReadonlyArray<{
    readonly kind: string;
    readonly id: string;
    readonly bytes: number;
  }>;
}

const measureWorld = Effect.fn(function* (withFixtureApp: boolean) {
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(
    makeEnvironmentLayer(withFixtureApp ? "with-app" : "without-app"),
    scope,
  );
  const run = <A, E>(effect: Effect.Effect<A, E, EnvironmentServices | Scope.Scope>) =>
    Effect.provideContext(effect, context).pipe(Effect.scoped);

  const measurement = yield* run(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const projectId of userProjects) yield* seedUserProject(projectId);
      for (const { projectId, threadId } of userThreads) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId,
          title: "User thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
      }
      if (withFixtureApp) {
        const result = yield* Effect.flatMap(ThreadCopyService, (copy) =>
          copy.import(fixtureApp, fixtureBundle()),
        );
        assert.isAbove(result.imported, 0);
      }

      const shell = yield* subscribeOrchestrationV2Shell({}).pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          readShellSnapshot: orchestrator.readShellSnapshot,
          getThreadShell: orchestrator.getThreadShell,
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      );
      const received = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const consumer = yield* filterShellStream(userSession)(shell).pipe(
        Stream.runForEach((item) => Queue.offer(received, item)),
        Effect.provide(Layer.mock(AppAuthorization)({})),
        Effect.forkScoped,
      );

      const first = yield* Queue.take(received);
      assert.strictEqual(first.kind, "snapshot");
      if (first.kind !== "snapshot") throw new Error("unreachable");
      const isUserProject = (id: string) => userProjects.some((projectId) => projectId === id);
      const userRowBytes = new Map<string, number>();
      for (const project of first.snapshot.projects) {
        if (isUserProject(project.id)) userRowBytes.set(project.id, rowBytes(project));
      }
      for (const thread of first.snapshot.threads) {
        if (isUserProject(thread.projectId)) userRowBytes.set(thread.id, rowBytes(thread));
      }
      const appThreadsInSnapshot = first.snapshot.threads.filter(
        (thread) => !isUserProject(thread.projectId),
      ).length;

      // One command at a time, each waited for, so batching never merges two steps.
      const updates: Array<{ kind: string; id: string; bytes: number }> = [];
      for (let step = 0; step < WORKLOAD_STEPS; step += 1) {
        const { threadId } = userThreads[step % userThreads.length]!;
        yield* orchestrator.dispatch(workload(step));
        for (;;) {
          const item = yield* Queue.take(received);
          if (item.kind === "snapshot" || item.kind === "synchronized") continue;
          const id =
            item.kind === "thread.updated"
              ? item.thread.id
              : item.kind === "thread.removed"
                ? item.threadId
                : item.kind === "project.updated"
                  ? item.project.id
                  : item.projectId;
          updates.push({ kind: item.kind, id, bytes: shellItemBytes(item) });
          if (item.kind === "thread.updated" && id === threadId) break;
        }
      }
      yield* Fiber.interrupt(consumer);
      return { appThreadsInSnapshot, userRowBytes, updates } satisfies WorldMeasurement;
    }),
  );
  yield* Scope.close(scope, Exit.void);
  return measurement;
});

const meanBytes = (updates: WorldMeasurement["updates"]) =>
  updates.reduce((sum, update) => sum + update.bytes, 0) / updates.length;

describe("shell payload for a client that is not an app", () => {
  it.live(
    `grows at most ${MAX_GROWTH * 100}% per update with the fixture app registered`,
    () =>
      Effect.gen(function* () {
        const without = yield* measureWorld(false);
        const withApp = yield* measureWorld(true);

        // The fixture really is there: its imported threads reach this client's snapshot.
        assert.strictEqual(without.appThreadsInSnapshot, 0);
        assert.isAtLeast(withApp.appThreadsInSnapshot, 7);

        // An idle app adds no updates: the client hears only about the threads the workload changed.
        const userThreadIds = new Set<string>(userThreads.map(({ threadId }) => threadId));
        for (const world of [without, withApp]) {
          assert.lengthOf(world.updates, WORKLOAD_STEPS);
          for (const update of world.updates) {
            assert.strictEqual(update.kind, "thread.updated");
            assert.isTrue(userThreadIds.has(update.id), `unexpected update for ${update.id}`);
          }
        }

        // App fields are optional keys, omitted on every non-app row.
        assert.deepEqual([...withApp.userRowBytes], [...without.userRowBytes]);

        const before = meanBytes(without.updates);
        const after = meanBytes(withApp.updates);
        const growth = (after - before) / before;
        yield* Effect.logInfo(
          `Shell bytes per update for a non-app client: ${before.toFixed(1)} without the fixture app, ${after.toFixed(1)} with it (${(growth * 100).toFixed(2)}%)`,
        );
        assert.isAtMost(growth, MAX_GROWTH);
      }),
    60_000,
  );
});
