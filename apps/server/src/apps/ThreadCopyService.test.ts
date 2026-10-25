// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AppId,
  type ChatAttachment,
  CommandId,
  ConnectedAppThreadBundleV1,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  NodeId,
  RunId,
  type ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import { mcpAppFromToolItem } from "@lecturn/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  resolveAttachmentPath,
  resolveAttachmentPathById,
  createAttachmentId,
} from "../attachmentStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as AppProjectServiceLayer from "./AppProjectService.ts";
import { AppProjectService, AppRegistryService, ThreadCopyService } from "./services.ts";
import { copyThreadId, recopyThreadId } from "./threadCopyHistory.ts";
import * as ThreadCopyServiceLayer from "./ThreadCopyService.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;
const app = AppId.make("dev.embed-host");
const APP_NAME = "Embed Host";
const CARD_HTML =
  "<!doctype html><html><head><title>Counter</title></head><body><main>3</main></body></html>";
const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const providerInstance = {
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:thread-copy-test" },
  displayName: "Codex thread copy test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("provider sessions are not used by thread copy tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

/** Holds the import at the first file promoted into a given copy thread, as a kill would. */
interface PromotionGate {
  segment: string | null;
  readonly reached: Deferred.Deferred<void>;
}

const gatedFileSystem = (gate: PromotionGate) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => ({
      ...fs,
      rename: (from: string, to: string) =>
        fs
          .rename(from, to)
          .pipe(
            Effect.tap(() =>
              gate.segment !== null && NodePath.basename(to).startsWith(gate.segment)
                ? Deferred.succeed(gate.reached, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
            ),
          ),
    })),
  );

const makeEnvironmentLayer = (name: string, gate?: PromotionGate) =>
  Layer.mergeAll(
    gate === undefined
      ? ThreadCopyServiceLayer.layer
      : ThreadCopyServiceLayer.layer.pipe(Layer.provide(gatedFileSystem(gate))),
  ).pipe(
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
    Layer.provide(
      Layer.mock(AppRegistryService)({
        get: () => Effect.succeed(Option.some({ status: { name: APP_NAME } } as never)),
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(`environment:${name}`)),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: `thread-copy-${name}-` })),
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

/** One Lecturn environment with its own database and home; `stop` shuts it down and removes its home. */
const startEnvironment = Effect.fn(function* (name: string, gate?: PromotionGate) {
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(makeEnvironmentLayer(name, gate), scope);
  return {
    environmentId: EnvironmentId.make(`environment:${name}`),
    run: <A, E>(effect: Effect.Effect<A, E, EnvironmentServices>) =>
      Effect.provideContext(effect, context),
    stop: Scope.close(scope, Exit.void),
  };
});

const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 25, 12, 0, second));

const createSourceThread = (workspaceRoot: string, title: string) =>
  Effect.gen(function* () {
    const apps = yield* AppProjectService;
    const { projectId } = yield* apps.ensureWorkspace(app, { workspaceRoot, title: workspaceRoot });
    const { threadId } = yield* apps.createEmbedThread(
      { kind: "embed", appId: app, projectId },
      { projectId, title },
    );
    return { projectId, threadId };
  });

const writeFile = (relativePath: string, bytes: Uint8Array | string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, relativePath), bytes);
  });

/**
 * One finished turn, as an adapter records it: the user's message (with an
 * uploaded image on request), the reply and, on request, an app card.
 */
const writeTurn = (
  threadId: ThreadId,
  turn: number,
  options: { readonly image?: boolean; readonly card?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const runId = RunId.make(`${threadId}:run:${turn}`);
    const time = at(turn * 10);
    const attachments: Array<ChatAttachment> = [];
    if (options.image === true) {
      const attachment: ChatAttachment = {
        type: "image",
        id: createAttachmentId(threadId)!,
        name: "plot.png",
        mimeType: "image/png",
        sizeBytes: IMAGE_BYTES.byteLength,
      };
      const config = yield* ServerConfig.ServerConfig;
      NodeFS.writeFileSync(
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
        IMAGE_BYTES,
      );
      attachments.push(attachment);
    }
    const cardId = options.card === true ? createAttachmentId(threadId, "html")! : null;
    if (cardId !== null) yield* writeFile(`${cardId}.html`, CARD_HTML);
    const base = (suffix: string, ordinal: number) => ({
      id: TurnItemId.make(`${threadId}:t${turn}:${suffix}`),
      threadId,
      runId,
      nodeId: NodeId.make(`${threadId}:node:${turn}`),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: turn * 10 + ordinal,
      status: "completed" as const,
      title: null,
      startedAt: time,
      completedAt: time,
      updatedAt: time,
    });
    const message = (role: "user" | "assistant", text: string) => ({
      createdBy: role === "user" ? ("user" as const) : ("agent" as const),
      creationSource: "web" as const,
      id: MessageId.make(`${threadId}:t${turn}:${role}`),
      threadId,
      runId,
      nodeId: null,
      role,
      text,
      attachments: role === "user" ? attachments : [],
      streaming: false,
      createdAt: time,
      updatedAt: time,
    });
    const user = message("user", `question ${turn}`);
    const assistant = message("assistant", `answer ${turn}`);
    const events: Array<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make(`${user.id}:event`),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: time,
        payload: user,
      },
      {
        id: EventId.make(`${threadId}:t${turn}:user-item`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: time,
        payload: {
          ...base("user", 1),
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: user.id,
          inputIntent: "turn_start",
          text: user.text,
          attachments,
        },
      },
      ...(cardId === null
        ? []
        : [
            {
              id: EventId.make(`${threadId}:t${turn}:card-item`),
              type: "turn-item.updated" as const,
              threadId,
              runId,
              occurredAt: time,
              payload: {
                ...base("card", 2),
                type: "dynamic_tool" as const,
                toolName: "mcp__lecturn__ex_counter_increment",
                input: {},
                output: {
                  lecturnMcpApp: {
                    attachmentId: cardId,
                    server: "lecturn",
                    tool: "ex_counter_increment",
                    resourceUri: "ui://embed-host/counter",
                  },
                  result: { content: [{ type: "text", text: "3" }] },
                },
              },
            },
          ]),
      {
        id: EventId.make(`${assistant.id}:event`),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: time,
        payload: assistant,
      },
      {
        id: EventId.make(`${threadId}:t${turn}:assistant-item`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: time,
        payload: {
          ...base("assistant", 3),
          type: "assistant_message",
          messageId: assistant.id,
          text: assistant.text,
          streaming: false,
        },
      },
    ];
    yield* sink.write({ events });
  });

/** A provider turn's state on its own, as ProviderEventIngestor records it apart from items. */
const writeProviderTurn = (threadId: ThreadId, status: "running" | "completed") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const providerThreadId = ProviderThreadId.make(`${threadId}:provider-thread`);
    const time = at(50);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`${threadId}:provider-thread:${status}`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: time,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: `${threadId}:native`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: time,
            updatedAt: time,
          },
        },
        {
          id: EventId.make(`${threadId}:provider-turn:${status}`),
          type: "provider-turn.updated",
          threadId,
          occurredAt: time,
          payload: {
            id: ProviderTurnId.make(`${threadId}:provider-turn`),
            providerThreadId,
            nodeId: NodeId.make(`${threadId}:provider-node`),
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status,
            startedAt: time,
            completedAt: status === "completed" ? time : null,
          },
        },
      ],
    });
  });

const decodeBundleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ConnectedAppThreadBundleV1),
);
const encodeBundle = Schema.encodeSync(ConnectedAppThreadBundleV1);

/** The bundle as it crosses the wire between two servers. */
const overTheWire = (bundle: ConnectedAppThreadBundleV1) =>
  decodeBundleJson(JSON.stringify(encodeBundle(bundle)));

const exportAll = Effect.flatMap(ThreadCopyService, (copy) => copy.export(app, undefined)).pipe(
  Effect.flatMap(overTheWire),
);

const importBundle = (bundle: ConnectedAppThreadBundleV1) =>
  Effect.flatMap(ThreadCopyService, (copy) => copy.import(app, bundle));

const transcript = (projection: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems">) =>
  projection.visibleTurnItems.flatMap((row) =>
    row.item.type === "user_message" || row.item.type === "assistant_message"
      ? [row.item.text]
      : [],
  );

const projectionOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  );

const listCopies = (projectId: ProjectId) =>
  Effect.flatMap(AppProjectService, (apps) => apps.listThreads(projectId));

const appProjectFor = (workspaceRoot: string) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.findActiveByAppWorkspace(app, workspaceRoot),
  ).pipe(Effect.map((row) => Option.getOrThrow(row).projectId));

const latestSequence = Effect.flatMap(
  OrchestrationEventStore.OrchestrationEventStore,
  (events) => events.latestApplicationSequence,
);

const attachmentFiles = Effect.map(ServerConfig.ServerConfig, (config) =>
  NodeFS.readdirSync(config.attachmentsDir).toSorted(),
);

const stagingEntries = Effect.map(ServerConfig.ServerConfig, (config) => {
  const root = NodePath.join(config.stateDir, "thread-copy-staging");
  return NodeFS.existsSync(root) ? NodeFS.readdirSync(root) : [];
});

const sendMessage = (threadId: ThreadId, text: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${threadId}:send:${text}`),
      threadId,
      messageId: MessageId.make(`${threadId}:send:${text}`),
      text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }),
  );

describe("ThreadCopyService", () => {
  it.effect(
    "copies threads, cards and uploads into another environment that outlives the source",
    () =>
      Effect.gen(function* () {
        const sidecar = yield* startEnvironment("sidecar");
        const user = yield* startEnvironment("user");
        const source = yield* sidecar.run(
          Effect.gen(function* () {
            const thread = yield* createSourceThread("/work/rocket", "Max-Q study");
            yield* writeTurn(thread.threadId, 1, { image: true, card: true });
            yield* writeTurn(thread.threadId, 2);
            yield* Effect.flatMap(AppProjectService, (apps) =>
              apps.setThreadAppData(app, {
                threadId: thread.threadId,
                appData: '{"design":"d1"}',
                subtitle: "Apogee 1.2 km",
              }),
            );
            return thread;
          }),
        );
        const bundle = yield* sidecar.run(exportAll);
        assert.strictEqual(bundle.sourceEnvironmentId, sidecar.environmentId);
        assert.lengthOf(bundle.assets, 2);
        yield* sidecar.stop;

        const result = yield* user.run(importBundle(bundle));
        assert.deepEqual(result, { imported: 1, skipped: 0 });

        yield* user.run(
          Effect.gen(function* () {
            const projectId = yield* appProjectFor("/work/rocket");
            const [summary] = yield* listCopies(projectId);
            const threadId = copyThreadId(sidecar.environmentId, source.threadId);
            assert.strictEqual(summary?.threadId, threadId);
            assert.strictEqual(summary?.title, "Max-Q study");
            assert.strictEqual(summary?.subtitle, "Apogee 1.2 km");
            assert.strictEqual(summary?.appData, '{"design":"d1"}');
            assert.deepInclude(summary?.copiedFrom, {
              appId: app,
              sourceEnvironmentId: sidecar.environmentId,
              sourceThreadId: source.threadId,
              sourceHistoryRevision: bundle.projects[0]!.threads[0]!.historyRevision,
            });

            const projection = yield* projectionOf(threadId);
            assert.strictEqual(projection.thread.historyOrigin, "v1_import");
            assert.strictEqual(projection.thread.settledOverride, "settled");
            assert.isUndefined(projection.thread.importedFrom);
            assert.lengthOf(projection.runs, 0);
            assert.lengthOf(projection.providerThreads, 0);
            assert.deepEqual(transcript(projection), [
              "question 1",
              "answer 1",
              "question 2",
              "answer 2",
            ]);
            for (const row of projection.visibleTurnItems) assert.isNull(row.item.runId);

            // The source is gone: the card and the upload are served from the copy's own files.
            const config = yield* ServerConfig.ServerConfig;
            const card = projection.visibleTurnItems.find(
              (row) => row.item.type === "dynamic_tool",
            );
            const cardRef = mcpAppFromToolItem(card!.item as never);
            assert.isDefined(cardRef);
            const cardPath = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: cardRef!.attachmentId,
            });
            assert.strictEqual(NodeFS.readFileSync(cardPath!, "utf8"), CARD_HTML);
            const [image] = projection.messages.find(
              (message) => message.role === "user",
            )!.attachments;
            const imagePath = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: image!.id,
            });
            assert.deepEqual(new Uint8Array(NodeFS.readFileSync(imagePath!)), IMAGE_BYTES);
            // Thread deletion finds both through the copy's own ids.
            const owned = yield* Effect.flatMap(ProjectionStore.ProjectionStoreV2, (store) =>
              store.getThreadAttachmentIds(threadId),
            );
            assert.sameMembers([...owned], [cardRef!.attachmentId, image!.id]);
            assert.deepEqual(yield* stagingEntries, []);
          }),
        );
      }),
  );

  it.effect("a second import of the same bundle changes nothing", () =>
    Effect.gen(function* () {
      const sidecar = yield* startEnvironment("sidecar");
      const user = yield* startEnvironment("user");
      yield* sidecar.run(
        Effect.gen(function* () {
          const thread = yield* createSourceThread("/work/rocket", "Thread");
          yield* writeTurn(thread.threadId, 1, { card: true });
        }),
      );
      const bundle = yield* sidecar.run(exportAll);
      yield* user.run(importBundle(bundle));
      const before = yield* user.run(Effect.all([latestSequence, attachmentFiles]));
      assert.deepEqual(yield* user.run(importBundle(bundle)), { imported: 0, skipped: 1 });
      // A fresh export of unchanged history is the same story.
      assert.deepEqual(yield* user.run(importBundle(yield* sidecar.run(exportAll))), {
        imported: 0,
        skipped: 1,
      });
      assert.deepEqual(yield* user.run(Effect.all([latestSequence, attachmentFiles])), before);
    }),
  );

  it.effect("re-copies a source that finished a turn after the copy exactly once, in place", () =>
    Effect.gen(function* () {
      const sidecar = yield* startEnvironment("sidecar");
      const user = yield* startEnvironment("user");
      const source = yield* sidecar.run(createSourceThread("/work/rocket", "Thread"));
      yield* sidecar.run(writeTurn(source.threadId, 1));
      yield* user.run(importBundle(yield* sidecar.run(exportAll)));

      yield* sidecar.run(writeTurn(source.threadId, 2, { card: true }));
      const newer = yield* sidecar.run(exportAll);
      assert.deepEqual(yield* user.run(importBundle(newer)), { imported: 1, skipped: 0 });
      assert.deepEqual(yield* user.run(importBundle(newer)), { imported: 0, skipped: 1 });

      yield* user.run(
        Effect.gen(function* () {
          const [only, ...rest] = yield* listCopies(yield* appProjectFor("/work/rocket"));
          assert.lengthOf(rest, 0);
          assert.strictEqual(only?.threadId, copyThreadId(sidecar.environmentId, source.threadId));
          assert.strictEqual(
            only?.copiedFrom?.sourceHistoryRevision,
            newer.projects[0]!.threads[0]!.historyRevision,
          );
          const projection = yield* projectionOf(only!.threadId);
          assert.deepEqual(transcript(projection), [
            "question 1",
            "answer 1",
            "question 2",
            "answer 2",
          ]);
          assert.lengthOf(yield* attachmentFiles, 1);
        }),
      );
    }),
  );

  it.effect(
    "a turn that ends with only a terminal provider event still moves historyRevision",
    () =>
      Effect.gen(function* () {
        const sidecar = yield* startEnvironment("sidecar");
        const user = yield* startEnvironment("user");
        const source = yield* sidecar.run(createSourceThread("/work/rocket", "Thread"));
        yield* sidecar.run(writeTurn(source.threadId, 1));
        // The turn was running when the copy was taken.
        yield* sidecar.run(writeProviderTurn(source.threadId, "running"));
        const first = yield* sidecar.run(exportAll);
        yield* user.run(importBundle(first));

        yield* sidecar.run(writeProviderTurn(source.threadId, "completed"));
        const second = yield* sidecar.run(exportAll);
        assert.isAbove(
          second.projects[0]!.threads[0]!.historyRevision,
          first.projects[0]!.threads[0]!.historyRevision,
        );
        assert.deepEqual(yield* user.run(importBundle(second)), { imported: 1, skipped: 0 });
        assert.deepEqual(yield* user.run(importBundle(second)), { imported: 0, skipped: 1 });
      }),
  );

  it.effect(
    "subtitle and continued-in writes after the copy re-copy nothing, though updatedAt moved",
    () =>
      Effect.gen(function* () {
        const sidecar = yield* startEnvironment("sidecar");
        const user = yield* startEnvironment("user");
        const source = yield* sidecar.run(createSourceThread("/work/rocket", "Thread"));
        yield* sidecar.run(writeTurn(source.threadId, 1));
        const first = yield* sidecar.run(exportAll);
        yield* user.run(importBundle(first));

        yield* TestClock.adjust("1 hour");
        yield* sidecar.run(
          Effect.gen(function* () {
            const apps = yield* AppProjectService;
            yield* apps.setThreadAppData(app, {
              threadId: source.threadId,
              appData: "later",
              subtitle: "Later",
            });
            yield* apps.markThreadsCopied(app, {
              entries: [
                {
                  threadId: source.threadId,
                  continuedIn: {
                    environmentId: user.environmentId,
                    threadId: copyThreadId(sidecar.environmentId, source.threadId),
                    copiedAt: DateTime.formatIso(yield* DateTime.now),
                  },
                },
              ],
            });
          }),
        );
        const second = yield* sidecar.run(exportAll);
        const [before, after] = [first, second].map((bundle) => bundle.projects[0]!.threads[0]!);
        assert.notStrictEqual(after!.updatedAt, before!.updatedAt);
        assert.strictEqual(after!.historyRevision, before!.historyRevision);
        const sequence = yield* user.run(latestSequence);
        assert.deepEqual(yield* user.run(importBundle(second)), { imported: 0, skipped: 1 });
        assert.strictEqual(yield* user.run(latestSequence), sequence);
      }),
  );

  it.effect(
    "never overwrites a copy with Lecturn-side turns; newer history becomes a new thread",
    () =>
      Effect.gen(function* () {
        const sidecar = yield* startEnvironment("sidecar");
        const user = yield* startEnvironment("user");
        const source = yield* sidecar.run(createSourceThread("/work/rocket", "Max-Q study"));
        yield* sidecar.run(writeTurn(source.threadId, 1));
        yield* user.run(importBundle(yield* sidecar.run(exportAll)));
        const copyId = copyThreadId(sidecar.environmentId, source.threadId);
        yield* user.run(sendMessage(copyId, "continue here"));
        const continued = yield* user.run(projectionOf(copyId));

        yield* sidecar.run(writeTurn(source.threadId, 2));
        const newer = yield* sidecar.run(exportAll);
        const revision = newer.projects[0]!.threads[0]!.historyRevision;
        assert.deepEqual(yield* user.run(importBundle(newer)), { imported: 1, skipped: 0 });
        // The next attach finds the new thread and copies nothing more.
        assert.deepEqual(yield* user.run(importBundle(newer)), { imported: 0, skipped: 1 });

        yield* user.run(
          Effect.gen(function* () {
            const untouched = yield* projectionOf(copyId);
            assert.deepEqual(transcript(untouched), transcript(continued));
            assert.deepEqual(untouched.thread.copiedFrom, continued.thread.copiedFrom);

            const recopyId = recopyThreadId(sidecar.environmentId, source.threadId, revision);
            const recopy = yield* projectionOf(recopyId);
            assert.strictEqual(recopy.thread.title, `Max-Q study (from ${APP_NAME})`);
            assert.strictEqual(recopy.thread.copiedFrom?.sourceHistoryRevision, revision);
            assert.deepEqual(transcript(recopy), [
              "question 1",
              "answer 1",
              "question 2",
              "answer 2",
            ]);
            const rail = yield* listCopies(yield* appProjectFor("/work/rocket"));
            assert.sameMembers(
              rail.map((summary) => summary.threadId),
              [copyId, recopyId],
            );
          }),
        );
      }),
  );

  it.effect("continuing a copy opens a fresh provider session handed the copied history", () =>
    Effect.gen(function* () {
      const sidecar = yield* startEnvironment("sidecar");
      const user = yield* startEnvironment("user");
      const source = yield* sidecar.run(createSourceThread("/work/rocket", "Thread"));
      yield* sidecar.run(writeTurn(source.threadId, 1));
      yield* user.run(importBundle(yield* sidecar.run(exportAll)));
      const copyId = copyThreadId(sidecar.environmentId, source.threadId);

      yield* user.run(sendMessage(copyId, "go on"));
      const projection = yield* user.run(projectionOf(copyId));
      assert.lengthOf(projection.providerThreads, 1);
      assert.isNull(projection.providerThreads[0]!.nativeThreadRef);
      assert.lengthOf(projection.contextHandoffs, 1);
      assert.include(projection.contextHandoffs[0]!.summaryText ?? "", "answer 1");
    }),
  );

  it.effect("a fork of a copy shows the copied history", () =>
    Effect.gen(function* () {
      const sidecar = yield* startEnvironment("sidecar");
      const user = yield* startEnvironment("user");
      const source = yield* sidecar.run(createSourceThread("/work/rocket", "Thread"));
      yield* sidecar.run(writeTurn(source.threadId, 1));
      yield* user.run(importBundle(yield* sidecar.run(exportAll)));
      const copyId = copyThreadId(sidecar.environmentId, source.threadId);

      yield* user.run(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const childId = `${copyId}:fork` as ThreadId;
          yield* orchestrator.dispatch({
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("fork:copy"),
            sourceThreadId: copyId,
            targetThreadId: childId,
            sourcePoint: { type: "latest_stable" },
          });
          const child = yield* projectionOf(childId);
          assert.deepEqual(transcript(child), ["question 1", "answer 1"]);
          assert.isUndefined(child.thread.copiedFrom);
        }),
      );
    }),
  );

  it.effect("an import killed mid-way completes on rerun with no duplicate or orphaned asset", () =>
    Effect.gen(function* () {
      const gate: PromotionGate = { segment: null, reached: yield* Deferred.make<void>() };
      const sidecar = yield* startEnvironment("sidecar");
      const user = yield* startEnvironment("user", gate);
      const first = yield* sidecar.run(createSourceThread("/work/rocket", "First"));
      const second = yield* sidecar.run(createSourceThread("/work/rocket", "Second"));
      yield* sidecar.run(writeTurn(first.threadId, 1, { card: true }));
      yield* sidecar.run(writeTurn(second.threadId, 1, { card: true, image: true }));
      const bundle = yield* sidecar.run(exportAll);

      // The bundle lists threads newest first; whichever comes last dies after its files land.
      const lastSource = bundle.projects[0]!.threads.at(-1)!.sourceThreadId;
      const lastCopy = copyThreadId(sidecar.environmentId, lastSource);
      gate.segment = lastCopy
        .replace(/[^a-z0-9_-]+/gi, "-")
        .toLowerCase()
        .slice(0, 40);
      const fiber = yield* user.run(importBundle(bundle)).pipe(Effect.forkChild);
      yield* Deferred.await(gate.reached);
      yield* Fiber.interrupt(fiber);
      gate.segment = null;

      yield* user.run(
        Effect.gen(function* () {
          const projectId = yield* appProjectFor("/work/rocket");
          assert.lengthOf(yield* listCopies(projectId), 1);
          assert.lengthOf(yield* stagingEntries, 1);

          assert.deepEqual(yield* importBundle(bundle), { imported: 1, skipped: 1 });
          const copies = yield* listCopies(projectId);
          assert.lengthOf(copies, 2);
          assert.deepEqual(yield* stagingEntries, []);
          // Exactly the files the two copies reference: three assets, one each.
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const referenced = yield* Effect.forEach(copies, (copy) =>
            store.getThreadAttachmentIds(copy.threadId),
          );
          const files = yield* attachmentFiles;
          assert.lengthOf(files, 3);
          assert.sameMembers(
            files.map((file) => file.replace(/\.[^.]*$/, "")),
            referenced.flat(),
          );
        }),
      );
    }),
  );

  it.effect("sweeps an abandoned staging area and its unreferenced files after 24 hours", () =>
    Effect.gen(function* () {
      const gate: PromotionGate = { segment: null, reached: yield* Deferred.make<void>() };
      const sidecar = yield* startEnvironment("sidecar");
      const user = yield* startEnvironment("user", gate);
      const source = yield* sidecar.run(createSourceThread("/work/rocket", "Thread"));
      yield* sidecar.run(writeTurn(source.threadId, 1, { card: true }));
      const bundle = yield* sidecar.run(exportAll);
      gate.segment = "copy-environment-sidecar";
      const fiber = yield* user.run(importBundle(bundle)).pipe(Effect.forkChild);
      yield* Deferred.await(gate.reached);
      yield* Fiber.interrupt(fiber);
      gate.segment = null;
      assert.lengthOf(yield* user.run(attachmentFiles), 1);
      assert.lengthOf(yield* user.run(stagingEntries), 1);

      // Within the day the abandoned import is kept for a rerun.
      yield* TestClock.adjust("23 hours");
      const empty = { ...bundle, projects: [], assets: [] };
      yield* user.run(importBundle(empty));
      assert.lengthOf(yield* user.run(attachmentFiles), 1);
      assert.lengthOf(yield* user.run(stagingEntries), 1);

      yield* TestClock.adjust("2 hours");
      yield* user.run(importBundle(empty));
      assert.deepEqual(yield* user.run(attachmentFiles), []);
      assert.deepEqual(yield* user.run(stagingEntries), []);
    }),
  );

  it.effect("refuses a bundle of another app and a corrupt asset", () =>
    Effect.gen(function* () {
      const sidecar = yield* startEnvironment("sidecar");
      const user = yield* startEnvironment("user");
      const source = yield* sidecar.run(createSourceThread("/work/rocket", "Thread"));
      yield* sidecar.run(writeTurn(source.threadId, 1, { card: true }));
      const bundle = yield* sidecar.run(exportAll);
      const copy = yield* user.run(ThreadCopyService);

      const otherApp = yield* user.run(
        Effect.flip(copy.import(AppId.make("dev.other-app"), bundle)),
      );
      assert.strictEqual(otherApp._tag === "AppsError" ? otherApp.code : null, "forbidden");

      const corrupt = {
        ...bundle,
        assets: bundle.assets.map((asset) => ({ ...asset, dataBase64: btoa("tampered") })),
      };
      const refused = yield* user.run(Effect.flip(copy.import(app, corrupt)));
      assert.strictEqual(refused._tag === "AppsError" ? refused.code : null, "invalid");
      assert.deepEqual(yield* user.run(attachmentFiles), []);
    }),
  );
});

describe("embed-host fixture bundle", () => {
  it.effect("imports two workspaces with every section state and a card that renders", () =>
    Effect.gen(function* () {
      const fixture = NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "fixtures", "embed-host.bundle.json"),
        "utf8",
      );
      const bundle = yield* decodeBundleJson(fixture);
      assert.strictEqual(bundle.appId, "dev.embed-host");
      assert.lengthOf(bundle.projects, 2);
      const sections = new Set(
        bundle.projects.flatMap((project) =>
          project.threads.map((thread) => JSON.parse(thread.appData ?? "{}").section as string),
        ),
      );
      assert.sameMembers([...sections], ["pinned", "active", "working", "snoozed", "settled"]);

      const user = yield* startEnvironment("user");
      const total = bundle.projects.reduce((sum, project) => sum + project.threads.length, 0);
      assert.deepEqual(yield* user.run(importBundle(bundle)), { imported: total, skipped: 0 });
      yield* user.run(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          let cards = 0;
          for (const project of bundle.projects) {
            const projectId = yield* appProjectFor(project.workspaceRoot);
            const copies = yield* listCopies(projectId);
            assert.lengthOf(copies, project.threads.length);
            for (const copy of copies) {
              const shell = yield* orchestrator.getThreadShell(copy.threadId);
              const pinned = project.threads.find(
                (thread) => thread.sourceThreadId === copy.copiedFrom?.sourceThreadId,
              )!.pinned;
              assert.strictEqual(shell?.pinnedAt != null, pinned);
              assert.strictEqual(shell?.settledOverride, pinned ? "active" : "settled");
              for (const row of (yield* projectionOf(copy.threadId)).visibleTurnItems) {
                const card = mcpAppFromToolItem(row.item as never);
                if (card === undefined) continue;
                const file = resolveAttachmentPathById({
                  attachmentsDir: config.attachmentsDir,
                  attachmentId: card.attachmentId,
                });
                assert.include(NodeFS.readFileSync(file!, "utf8"), "<html");
                cards += 1;
              }
            }
          }
          assert.isAtLeast(cards, 1);
        }),
      );
    }),
  );
});
