import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AppId,
  AppsSetThreadAppDataInput,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as AppProjectService from "./AppProjectService.ts";
import { AppProjectService as AppProjects } from "./services.ts";
import type { AppSubject } from "./subjects.ts";
import {
  applyThreadAppMetadataCommand,
  THREAD_APP_METADATA_KEYS,
  ThreadAppMetadata,
  threadAppMetadataOf,
  withoutThreadAppMetadata,
} from "./threadAppMetadata.ts";
import { readHistoryRevisions } from "./threadHistoryRevision.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;
const app = AppId.make("dev.rocketwright");
const otherApp = AppId.make("dev.other-app");
const t = (minute: number) => `2026-10-25T12:${String(minute).padStart(2, "0")}:00.000Z`;

const providerInstance = {
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:app-metadata-test" },
  displayName: "Codex app metadata test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("provider sessions are not used by app metadata tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-app-metadata-" });

const TestLayer = AppProjectService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      RuntimeLayer.layer,
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
  Layer.provideMerge(layerConfig),
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
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
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

const seedProject = (projectId: ProjectId, appId: AppId | null) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: t(0),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Project",
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: t(0),
        updatedAt: t(0),
        ...(appId === null ? {} : { appBinding: { appId, workspaceRoot: `/work/${projectId}` } }),
      },
    }),
  );

const embed = (appId: AppId, projectId: ProjectId): AppSubject => ({
  kind: "embed",
  appId,
  projectId,
});

const appFieldsOf = (value: object | null | undefined) =>
  Object.fromEntries(
    Object.entries(value ?? {}).filter(([key]) =>
      (THREAD_APP_METADATA_KEYS as ReadonlyArray<string>).includes(key),
    ),
  );

const continuedIn = {
  environmentId: EnvironmentId.make("environment:user"),
  threadId: ThreadId.make("thread:user-copy"),
  copiedAt: t(9),
};

/** A completed run, the minimum a fork can cut at. */
const writeCompletedRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make(`${threadId}:provider-thread`);
    const runId = RunId.make(`${threadId}:run:1`);
    const messageId = MessageId.make(`${threadId}:message:1`);
    const run: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId,
      userMessageId: messageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      queuePosition: null,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${providerThreadId}:updated`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
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
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`${runId}:message`),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: "fly it",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`${runId}:created`),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: run,
        },
      ],
    });
    return runId;
  });

describe("thread app metadata helpers", () => {
  const thread = {
    title: "T",
    updatedAt: DateTime.makeUnsafe(t(1)),
  };
  const later = DateTime.makeUnsafe(t(2));
  const appDataSet = (
    fields: Partial<Extract<OrchestrationV2InternalCommand, { type: "thread.app-data.set" }>>,
  ) =>
    ({
      type: "thread.app-data.set",
      commandId: CommandId.make("set"),
      threadId: ThreadId.make("thread:helpers"),
      appData: null,
      ...fields,
    }) as const;

  it("copies only present fields, sharing one empty object for non-app threads", () => {
    assert.strictEqual(threadAppMetadataOf({}), threadAppMetadataOf({}));
    assert.deepEqual(threadAppMetadataOf({ appData: "x", appOrigin: "embed" }), {
      appData: "x",
      appOrigin: "embed",
    });
  });

  it("sets, keeps and clears data and subtitle, moving updatedAt only on change", () => {
    const base = thread as never;
    const set = applyThreadAppMetadataCommand(
      base,
      appDataSet({ appData: "a", subtitle: "s" }),
      later,
    );
    assert.deepEqual(appFieldsOf(set), { appData: "a", appSubtitle: "s" });
    assert.deepEqual(set.updatedAt, later);

    // An absent subtitle keeps the old one.
    const dataOnly = applyThreadAppMetadataCommand(set, appDataSet({ appData: "b" }), later);
    assert.deepEqual(appFieldsOf(dataOnly), { appData: "b", appSubtitle: "s" });

    // The same values again change nothing, so the thread is returned as is.
    assert.strictEqual(
      applyThreadAppMetadataCommand(
        dataOnly,
        appDataSet({ appData: "b" }),
        DateTime.makeUnsafe(t(5)),
      ),
      dataOnly,
    );

    const cleared = applyThreadAppMetadataCommand(
      dataOnly,
      appDataSet({ appData: null, subtitle: null }),
      later,
    );
    assert.deepEqual(appFieldsOf(cleared), {});
    assert.notProperty(cleared, "appData");
    assert.notProperty(cleared, "appSubtitle");
  });

  it("strips every app field from a fork child", () => {
    const child = withoutThreadAppMetadata({
      title: "child",
      appData: "a",
      appSubtitle: "s",
      appOrigin: "embed",
      continuedIn,
    });
    assert.deepEqual(child, { title: "child" });
  });

  it("caps appData at 1 KB of UTF-8 on the RPC input and on the stored thread", () => {
    const threadId = ThreadId.make("thread:cap");
    const decodeInput = Schema.decodeUnknownExit(AppsSetThreadAppDataInput);
    const decodeStored = Schema.decodeUnknownExit(ThreadAppMetadata);
    assert.strictEqual(decodeInput({ threadId, appData: "a".repeat(1024) })._tag, "Success");
    assert.strictEqual(decodeInput({ threadId, appData: "a".repeat(1025) })._tag, "Failure");
    // 342 three-byte characters are 1026 bytes though only 342 code units.
    assert.strictEqual(decodeInput({ threadId, appData: "€".repeat(342) })._tag, "Failure");
    assert.strictEqual(decodeStored({ appData: "a".repeat(1024) })._tag, "Success");
    assert.strictEqual(decodeStored({ appData: "a".repeat(1025) })._tag, "Failure");
  });
});

it.layer(TestLayer)("thread app metadata through orchestration", (it) => {
  it.effect("an embed creates its project's thread with appData set atomically", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:create");
      yield* seedProject(projectId, app);

      const { threadId } = yield* service.createEmbedThread(embed(app, projectId), {
        projectId,
        title: "Design review",
        appData: '{"designId":"d-1"}',
      });

      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.strictEqual(shell?.title, "Design review");
      assert.strictEqual(shell?.creationSource, "web");
      assert.deepEqual(appFieldsOf(shell), { appData: '{"designId":"d-1"}', appOrigin: "embed" });
      // One thread.created carries the fields; no follow-up write sets them.
      const created = (yield* orchestrator.getThreadProjection(threadId)).thread;
      assert.deepEqual(appFieldsOf(created), appFieldsOf(shell));
      const [summary] = yield* service.listThreads(projectId);
      assert.strictEqual(summary?.appData, '{"designId":"d-1"}');
      assert.isNull(summary?.subtitle);
    }),
  );

  it.effect("refuses embed creates outside the token's own app project", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const projectId = ProjectId.make("project:create-refusals");
      const otherProjectId = ProjectId.make("project:create-refusals-other");
      const plainProjectId = ProjectId.make("project:create-refusals-plain");
      yield* seedProject(projectId, app);
      yield* seedProject(otherProjectId, otherApp);
      yield* seedProject(plainProjectId, null);

      const codes = yield* Effect.forEach(
        [
          // A token for one project names another.
          [embed(app, projectId), otherProjectId],
          // A token minted for an app that does not own the project.
          [embed(app, otherProjectId), otherProjectId],
          // Not an app project at all.
          [embed(app, plainProjectId), plainProjectId],
          // The app credential itself never creates embed threads.
          [{ kind: "app", appId: app }, projectId],
        ] as const,
        ([subject, target]) =>
          service.createEmbedThread(subject, { projectId: target, appData: "x" }).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
      );
      assert.deepEqual(codes, ["forbidden", "forbidden", "not-found", "forbidden"]);
      const shells = yield* (yield* Orchestrator.OrchestratorV2).getShellSnapshot();
      assert.isFalse(shells.threads.some((shell) => shell.projectId === otherProjectId));
    }),
  );

  it.effect("an embed sets only its own project's default model, which its new threads use", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const settings = yield* ServerSettings.ServerSettingsService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:default-model");
      const otherProjectId = ProjectId.make("project:default-model-other");
      yield* seedProject(projectId, app);
      yield* seedProject(otherProjectId, otherApp);
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { defaultAutoPull: true },
          [otherProjectId]: { defaultModelSelection: modelSelection },
        },
      });
      const overrides = () =>
        settings.getSettings.pipe(Effect.map((current) => current.projectSettingsOverrides));
      const chosen = { instanceId, model: "gpt-5.5" } satisfies ModelSelection;

      yield* service.setEmbedDefaultModel(embed(app, projectId), {
        projectId,
        modelSelection: chosen,
      });
      assert.deepEqual((yield* overrides())[projectId], {
        defaultAutoPull: true,
        defaultModelSelection: chosen,
      });
      const { threadId } = yield* service.createEmbedThread(embed(app, projectId), { projectId });
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.modelSelection, chosen);

      // Back to the environment default: the key goes, the project's other overrides stay.
      yield* service.setEmbedDefaultModel(embed(app, projectId), {
        projectId,
        modelSelection: null,
      });
      assert.deepEqual((yield* overrides())[projectId], { defaultAutoPull: true });

      const codes = yield* Effect.forEach(
        [
          [embed(app, projectId), otherProjectId],
          [embed(app, otherProjectId), otherProjectId],
          [{ kind: "app", appId: app }, projectId],
        ] as const,
        ([subject, target]) =>
          service.setEmbedDefaultModel(subject, { projectId: target, modelSelection: chosen }).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
      );
      assert.deepEqual(codes, ["forbidden", "forbidden", "forbidden"]);
      assert.deepEqual((yield* overrides())[otherProjectId], {
        defaultModelSelection: modelSelection,
      });
    }),
  );

  it.effect("app data and copy marks update the shell without moving historyRevision", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:update");
      yield* seedProject(projectId, app);
      const { threadId } = yield* service.createEmbedThread(embed(app, projectId), { projectId });
      const revision = () =>
        readHistoryRevisions([threadId]).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.map((revisions) => revisions.get(threadId)),
        );
      const before = yield* revision();
      const createdAt = (yield* orchestrator.getThreadShell(threadId))!.updatedAt;

      yield* service.setThreadAppData(app, { threadId, appData: "a", subtitle: "Apogee 412 m" });
      yield* service.setThreadAppData(app, { threadId, appData: "b" });
      yield* service.markThreadsCopied(app, { entries: [{ threadId, continuedIn }] });

      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(appFieldsOf(shell), {
        appData: "b",
        appSubtitle: "Apogee 412 m",
        appOrigin: "embed",
        continuedIn,
      });
      assert.isTrue(DateTime.toEpochMillis(shell!.updatedAt) >= DateTime.toEpochMillis(createdAt));
      assert.strictEqual(yield* revision(), before);
      const [summary] = yield* service.listThreads(projectId);
      assert.deepEqual(
        {
          appData: summary?.appData,
          subtitle: summary?.subtitle,
          continuedIn: summary?.continuedIn,
        },
        { appData: "b", subtitle: "Apogee 412 m", continuedIn },
      );

      yield* service.setThreadAppData(app, { threadId, appData: null, subtitle: null });
      assert.deepEqual(appFieldsOf(yield* orchestrator.getThreadShell(threadId)), {
        appOrigin: "embed",
        continuedIn,
      });
    }),
  );

  it.effect("only the owning app writes a thread's app fields", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:owner");
      const plainProjectId = ProjectId.make("project:owner-plain");
      yield* seedProject(projectId, app);
      yield* seedProject(plainProjectId, null);
      const { threadId } = yield* service.createEmbedThread(embed(app, projectId), { projectId });
      const plainThreadId = ThreadId.make("thread:owner-plain");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("owner-plain:create"),
        threadId: plainThreadId,
        projectId: plainProjectId,
        title: "Plain",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const refusals = yield* Effect.forEach(
        [
          service.setThreadAppData(otherApp, { threadId, appData: "x" }),
          service.setThreadAppData(app, { threadId: plainThreadId, appData: "x" }),
          service.setThreadAppData(app, {
            threadId: ThreadId.make("thread:missing"),
            appData: "x",
          }),
          // One foreign entry refuses the batch before anything is written.
          service.markThreadsCopied(app, {
            entries: [
              { threadId, continuedIn },
              { threadId: plainThreadId, continuedIn },
            ],
          }),
        ],
        (attempt) =>
          attempt.pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
      );
      assert.deepEqual(refusals, ["forbidden", "forbidden", "not-found", "forbidden"]);
      assert.deepEqual(appFieldsOf(yield* orchestrator.getThreadShell(threadId)), {
        appOrigin: "embed",
      });
      assert.deepEqual(appFieldsOf(yield* orchestrator.getThreadShell(plainThreadId)), {});
    }),
  );

  it.effect("a normal client's create with app fields is refused before commit", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:client");
      yield* seedProject(projectId, app);
      const threadId = ThreadId.make("thread:client-create");
      const error = yield* ThreadMessageIntake.dispatchCommand({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("client:create"),
        threadId,
        projectId,
        title: "Forged",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        appData: "forged",
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ThreadAppMetadataRefusedError");
      assert.isNull(yield* orchestrator.getThreadShell(threadId));
    }),
  );

  it.effect("a fork child keeps the app project but not the source's app fields", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("project:fork");
      yield* seedProject(projectId, app);
      const { threadId } = yield* service.createEmbedThread(embed(app, projectId), {
        projectId,
        appData: "source",
      });
      yield* service.setThreadAppData(app, { threadId, appData: "source", subtitle: "Flight 1" });
      yield* service.markThreadsCopied(app, { entries: [{ threadId, continuedIn }] });
      const runId = yield* writeCompletedRun(threadId);

      const childId = ThreadId.make("thread:fork-child");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("fork:app-thread"),
        sourceThreadId: threadId,
        targetThreadId: childId,
        sourcePoint: { type: "run", runId },
      });

      const child = yield* orchestrator.getThreadShell(childId);
      assert.strictEqual(child?.projectId, projectId);
      assert.deepEqual(appFieldsOf(child), {});
      assert.deepEqual(appFieldsOf(yield* orchestrator.getThreadShell(threadId)), {
        appData: "source",
        appSubtitle: "Flight 1",
        appOrigin: "embed",
        continuedIn,
      });
      // The child is still on the app's rail, so the app can set its own data.
      yield* service.setThreadAppData(app, { threadId: childId, appData: "child" });
      assert.deepEqual(appFieldsOf(yield* orchestrator.getThreadShell(childId)), {
        appData: "child",
      });
    }),
  );

  it.effect("imported copies and every app field survive a projection rebuild", () =>
    Effect.gen(function* () {
      const service = yield* AppProjects;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:rebuild");
      yield* seedProject(projectId, app);
      const { threadId } = yield* service.createEmbedThread(embed(app, projectId), {
        projectId,
        appData: "live",
      });
      yield* service.setThreadAppData(app, { threadId, appData: "live", subtitle: "Max-Q" });
      yield* service.markThreadsCopied(app, { entries: [{ threadId, continuedIn }] });

      // A23's import writes a copy as one thread.created carrying copiedFrom.
      const template = (yield* orchestrator.getThreadProjection(threadId)).thread;
      const copyId = ThreadId.make("copy:environment:sidecar:thread:source");
      const copiedFrom = {
        appId: app,
        sourceEnvironmentId: EnvironmentId.make("environment:sidecar"),
        sourceThreadId: ThreadId.make("thread:source"),
        copiedAt: t(3),
        sourceHistoryRevision: 12,
      };
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${copyId}:created`),
            type: "thread.created",
            threadId: copyId,
            occurredAt: DateTime.makeUnsafe(t(3)),
            payload: {
              ...withoutThreadAppMetadata(template),
              id: copyId,
              title: "Copied",
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: copyId },
              historyOrigin: "v1_import",
              settledOverride: "settled",
              copiedFrom,
              appData: "copied",
              appSubtitle: "From sidecar",
            },
          },
        ],
      });

      const plainThreadId = ThreadId.make("thread:rebuild-plain");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("rebuild-plain:create"),
        threadId: plainThreadId,
        projectId,
        title: "Plain",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const read = Effect.gen(function* () {
        const snapshot = yield* orchestrator.getShellSnapshot({ projectId });
        const byId = (id: ThreadId) =>
          appFieldsOf([...snapshot.threads, ...snapshot.archivedThreads].find((s) => s.id === id));
        return {
          live: appFieldsOf(yield* orchestrator.getThreadShell(threadId)),
          liveInSnapshot: byId(threadId),
          copy: appFieldsOf(yield* orchestrator.getThreadShell(copyId)),
          copyInSnapshot: byId(copyId),
          plain: appFieldsOf(yield* orchestrator.getThreadShell(plainThreadId)),
        };
      });
      const expected = {
        live: { appData: "live", appSubtitle: "Max-Q", appOrigin: "embed", continuedIn },
        liveInSnapshot: { appData: "live", appSubtitle: "Max-Q", appOrigin: "embed", continuedIn },
        copy: { copiedFrom, appData: "copied", appSubtitle: "From sidecar" },
        copyInSnapshot: { copiedFrom, appData: "copied", appSubtitle: "From sidecar" },
        plain: {},
      };
      assert.deepEqual(yield* read, expected);

      const verification = yield* maintenance.rebuild;
      assert.isTrue(verification.valid);
      assert.deepEqual(yield* read, expected);

      // Non-app payloads add 0 bytes: no app key in the stored event or the projection row.
      const stored = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS "payload" FROM orchestration_events
        WHERE stream_id = ${plainThreadId}
        UNION ALL
        SELECT payload_json AS "payload" FROM orchestration_v2_projection_threads
        WHERE thread_id = ${plainThreadId}
      `;
      assert.isAtLeast(stored.length, 2);
      for (const { payload } of stored) {
        for (const key of THREAD_APP_METADATA_KEYS) assert.notInclude(payload, `"${key}"`);
      }
    }),
  );
});
