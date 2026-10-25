import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AppId,
  CommandId,
  type ConnectedAppThreadsStreamEvent,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LecturnOrchestrationHooks from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import Migration0080 from "../persistence/Migrations/080_ProjectionProjectsAppBinding.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as AppProjectService from "./AppProjectService.ts";
import * as AppsOrchestrationHooks from "./AppsOrchestrationHooks.ts";
import { AppProjectService as AppProjects } from "./services.ts";

const layerWorkspacePaths = Layer.succeed(WorkspacePaths.WorkspacePaths, {
  normalizeWorkspaceRoot: (workspaceRoot) =>
    workspaceRoot.includes("missing")
      ? Effect.fail(
          new WorkspacePaths.WorkspaceRootNotExistsError({
            workspaceRoot,
            normalizedWorkspaceRoot: workspaceRoot,
          }),
        )
      : Effect.succeed(workspaceRoot.replace(/\/$/, "")),
  resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
    Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
});

const layerMetadata = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: () => Effect.succeed(null),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: () => Effect.succeed(null),
  }),
);

// Migration 80 is registered by A12's Migrations.ts entry; it is idempotent,
// so applying it here as well is harmless once that lands.
const layerSqlite = Layer.effectDiscard(Migration0080).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const layerTest = Layer.mergeAll(
  AppProjectService.layer,
  AppsOrchestrationHooks.layer.pipe(Layer.provide(LecturnOrchestrationHooks.layer)),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      RuntimeLayer.layerProjectService,
      RuntimeLayer.layerEventSink,
      RuntimeLayer.layerEventInfrastructure,
      ProjectStore.layer,
      ProjectionStore.layer,
    ),
  ),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(layerWorkspacePaths),
  Layer.provideMerge(layerMetadata),
  Layer.provideMerge(layerSqlite),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "app-project-service-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const app = AppId.make("dev.rocketwright");
const otherApp = AppId.make("dev.other-app");
const at = (seconds: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 25, 12, 0, seconds));
const providerInstanceId = ProviderInstanceId.make("codex");

const threadRecord = (
  threadId: ThreadId,
  projectId: ProjectId,
  seconds: number,
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: `Thread ${threadId}`,
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at(seconds),
  updatedAt: at(seconds),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

let eventCounter = 0;
const commitEvents = (threadId: ThreadId, events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    eventCounter += 1;
    yield* sink.commitCommand({
      commandId: CommandId.make(`test:command:${eventCounter}`),
      threadId,
      commandType: "test.commit",
      acceptedAt: at(0),
      events,
      effects: [],
    });
  });

const createThread = (threadId: ThreadId, projectId: ProjectId, seconds: number) =>
  commitEvents(threadId, [
    {
      id: EventId.make(`event:${threadId}:created`),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: at(seconds),
      payload: threadRecord(threadId, projectId, seconds),
    },
  ]);

const postMessage = (threadId: ThreadId, key: string, seconds: number) =>
  commitEvents(threadId, [
    {
      id: EventId.make(`event:${threadId}:${key}`),
      type: "message.updated",
      threadId,
      occurredAt: at(seconds),
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: MessageId.make(`message:${threadId}:${key}`),
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: key,
        attachments: [],
        streaming: false,
        createdAt: at(seconds),
        updatedAt: at(seconds),
      },
    },
  ]);

const providerTurn = (threadId: ThreadId, status: "running" | "completed", seconds: number) =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    eventCounter += 1;
    yield* store.appendAgentEvents({
      events: [
        {
          id: EventId.make(`event:${threadId}:turn:${eventCounter}`),
          type: "provider-turn.updated",
          threadId,
          occurredAt: at(seconds),
          payload: {
            id: ProviderTurnId.make(`turn:${threadId}`),
            providerThreadId: ProviderThreadId.make(`provider-thread:${threadId}`),
            nodeId: NodeId.make(`node:${threadId}`),
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status,
            startedAt: at(seconds),
            completedAt: status === "completed" ? at(seconds) : null,
          },
        },
      ],
    });
  });

const createNormalProject = (projectId: ProjectId, workspaceRoot: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    return yield* projects.create({
      commandId: CommandId.make(`test:create:${projectId}`),
      projectId,
      title: "Normal",
      workspaceRoot,
    });
  });

it.layer(layerTest)("AppProjectService", (it) => {
  it.effect("ensures one app project per root, idempotently, beside a normal project", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const store = yield* ProjectStore.ProjectStoreV2;
      const normal = yield* createNormalProject(ProjectId.make("normal:shared"), "/work/shared");

      const [first, concurrent] = yield* Effect.all(
        [
          service.ensureWorkspace(app, { workspaceRoot: "/work/shared/", title: "Shared" }),
          service.ensureWorkspace(app, { workspaceRoot: "/work/shared/", title: "Shared" }),
        ],
        { concurrency: "unbounded" },
      );
      const again = yield* service.ensureWorkspace(app, {
        workspaceRoot: "/work/shared/",
        title: "Renamed by the app",
      });
      assert.strictEqual(concurrent.projectId, first.projectId);
      assert.strictEqual(again.projectId, first.projectId);
      assert.notStrictEqual(first.projectId, normal.id);

      const row = Option.getOrThrow(yield* store.get(first.projectId));
      assert.strictEqual(row.workspaceRoot, "/work/shared");
      assert.deepStrictEqual(row.appBinding, { appId: app, workspaceRoot: "/work/shared/" });
      assert.deepStrictEqual(
        Option.getOrThrow(yield* service.resolveAppForProject(first.projectId)),
        { appId: app, workspaceRoot: "/work/shared/" },
      );
      assert.isTrue(Option.isNone(yield* service.resolveAppForProject(normal.id)));

      // Another app, and the same folder spelled differently, are separate projects.
      const other = yield* service.ensureWorkspace(otherApp, {
        workspaceRoot: "/work/shared/",
        title: "Other",
      });
      const respelled = yield* service.ensureWorkspace(app, {
        workspaceRoot: "/work/shared",
        title: "Shared",
      });
      assert.notStrictEqual(other.projectId, first.projectId);
      assert.notStrictEqual(respelled.projectId, first.projectId);

      const owner = Option.getOrThrow(yield* store.findActiveByWorkspaceRoot("/work/shared"));
      assert.strictEqual(owner.projectId, normal.id);
    }),
  );

  it.effect("refuses a root that is not a folder", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const error = yield* service
        .ensureWorkspace(app, { workspaceRoot: "/work/missing", title: "Missing" })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "AppsError");
      assert.strictEqual(error._tag === "AppsError" ? error.code : null, "invalid");
    }),
  );

  it.effect("refuses moving an app project's folder but not renaming it", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const projects = yield* ProjectService.ProjectService;
      const { projectId } = yield* service.ensureWorkspace(app, {
        workspaceRoot: "/work/locked",
        title: "Locked",
      });

      const moved = yield* projects
        .update({
          commandId: CommandId.make("test:move-app-project"),
          projectId,
          workspaceRoot: "/work/elsewhere",
        })
        .pipe(Effect.flip);
      assert.strictEqual(moved._tag, "ProjectOperationError");
      assert.strictEqual(
        moved._tag === "ProjectOperationError"
          ? (moved.cause as { readonly _tag?: string })._tag
          : null,
        "LecturnHookRejectedError",
      );

      const renamed = yield* projects.update({
        commandId: CommandId.make("test:rename-app-project"),
        projectId,
        title: "Still locked",
      });
      assert.strictEqual(renamed.title, "Still locked");
      assert.strictEqual(renamed.workspaceRoot, "/work/locked");
      assert.deepStrictEqual(Option.getOrThrow(yield* service.resolveAppForProject(projectId)), {
        appId: app,
        workspaceRoot: "/work/locked",
      });

      const normal = yield* createNormalProject(ProjectId.make("normal:movable"), "/work/movable");
      const normalMoved = yield* projects.update({
        commandId: CommandId.make("test:move-normal-project"),
        projectId: normal.id,
        workspaceRoot: "/work/moved",
      });
      assert.strictEqual(normalMoved.workspaceRoot, "/work/moved");
    }),
  );

  it.effect("lists the app project's threads with history revisions", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const { projectId } = yield* service.ensureWorkspace(app, {
        workspaceRoot: "/work/rail/",
        title: "Rail",
      });
      const normal = yield* createNormalProject(ProjectId.make("normal:rail"), "/work/rail");
      const older = ThreadId.make("thread:rail:older");
      const newer = ThreadId.make("thread:rail:newer");
      yield* createThread(older, projectId, 1);
      yield* createThread(newer, projectId, 2);
      yield* createThread(ThreadId.make("thread:rail:normal"), normal.id, 3);
      yield* postMessage(older, "hello", 4);

      const listed = yield* service.listThreads(projectId);
      assert.deepStrictEqual(
        listed.map((thread) => thread.threadId),
        [older, newer],
      );
      const [first, second] = listed;
      assert.strictEqual(first?.workspaceRoot, "/work/rail/");
      assert.strictEqual(first?.state, "idle");
      assert.isNull(first?.appData);
      assert.isNull(first?.subtitle);
      assert.isAbove(first?.historyRevision ?? 0, 0);
      assert.strictEqual(second?.historyRevision, 0);

      const revisionOf = (threadId: ThreadId) =>
        service
          .listThreads(projectId)
          .pipe(
            Effect.map(
              (threads) => threads.find((thread) => thread.threadId === threadId)?.historyRevision,
            ),
          );
      const before = yield* revisionOf(newer);
      yield* providerTurn(newer, "running", 5);
      assert.strictEqual(yield* revisionOf(newer), before);
      yield* providerTurn(newer, "completed", 6);
      const afterTurn = yield* revisionOf(newer);
      assert.isAbove(afterTurn ?? 0, before ?? 0);
      yield* commitEvents(newer, [
        {
          id: EventId.make("event:rail:newer:pinned"),
          type: "thread.pinned",
          threadId: newer,
          providerInstanceId,
          occurredAt: at(7),
          payload: { ...threadRecord(newer, projectId, 2), pinnedAt: at(7), updatedAt: at(7) },
        },
      ]);
      assert.strictEqual(yield* revisionOf(newer), afterTurn);

      const notApp = yield* service.listThreads(normal.id).pipe(Effect.flip);
      assert.strictEqual(notApp._tag === "AppsError" ? notApp.code : null, "not-found");
    }),
  );

  // The stream batches on a 50 ms window, so it runs on the live clock.
  it.effect("streams a snapshot, then only this project's thread changes", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const { projectId } = yield* service.ensureWorkspace(app, {
        workspaceRoot: "/work/stream",
        title: "Stream",
      });
      const elsewhere = yield* service.ensureWorkspace(otherApp, {
        workspaceRoot: "/work/stream",
        title: "Elsewhere",
      });
      const existing = ThreadId.make("thread:stream:existing");
      const added = ThreadId.make("thread:stream:added");
      yield* createThread(existing, projectId, 1);

      const subscribed = yield* Deferred.make<void>();
      // A batch may carry both changes, in either order.
      const awaited = new Set<string>();
      const fiber = yield* service.streamThreads(projectId).pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.takeUntil((item) => {
          if (item.type === "remove" && item.threadId === existing) awaited.add("archived");
          if (item.type === "upsert" && item.thread.historyRevision > 0) awaited.add("message");
          return awaited.size === 2;
        }),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* createThread(ThreadId.make("thread:stream:elsewhere"), elsewhere.projectId, 2);
      yield* createThread(added, projectId, 3);
      yield* postMessage(added, "first", 4);
      yield* commitEvents(existing, [
        {
          id: EventId.make("event:stream:existing:archived"),
          type: "thread.archived",
          threadId: existing,
          providerInstanceId,
          occurredAt: at(5),
          payload: { ...threadRecord(existing, projectId, 1), archivedAt: at(5), updatedAt: at(5) },
        },
      ]);

      const items: ReadonlyArray<ConnectedAppThreadsStreamEvent> = Array.from(
        yield* Fiber.join(fiber),
      );
      const [snapshot, ...updates] = items;
      assert.deepStrictEqual(
        snapshot?.type === "snapshot" ? snapshot.threads.map((thread) => thread.threadId) : null,
        [existing],
      );
      const upserts = updates.flatMap((item) =>
        item.type === "upsert" ? [item.thread.threadId] : [],
      );
      assert.isTrue(upserts.length > 0 && upserts.every((threadId) => threadId === added));
      assert.deepStrictEqual(
        updates.filter((item) => item.type === "remove"),
        [{ type: "remove", threadId: existing }],
      );
    }).pipe(TestClock.withLive),
  );
});
