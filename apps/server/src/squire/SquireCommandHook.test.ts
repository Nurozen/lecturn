import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2InternalCommand,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SquireCreateInput,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as LecturnOrchestrationHooks from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SquireActions from "./SquireActions.ts";
import * as SquireCommandHook from "./SquireCommandHook.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireTools from "./SquireTools.ts";
import {
  initRepo,
  scripted,
  scriptedModel,
  seedProject as seedLifecycleProject,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";

const squireId = SquireId.make("squire:release");
const homeThread = ThreadId.make("thread:squire-home");
const probeThread = ThreadId.make("thread:squire-probe");
const userThread = ThreadId.make("thread:user");
const instanceId = ProviderInstanceId.make("codex");
const threadModel = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;
const otherModel = { instanceId, model: "gpt-5.5" } satisfies ModelSelection;

// Written out by hand, not from the rule table, so a reclassification shows here.
const ALLOWED_FROM_ANY_CALLER: ReadonlySet<string> = new Set([
  "message.dispatch",
  "run.interrupt",
  "queue.resume",
  "queued-run.start",
  "thread.visit",
  "thread.mark-unread",
  "runtime-request.respond",
  "thread.background-work.settle",
  "notification.delivery.accept",
  "thread.stop",
  // Records that a user's `runtime-request.respond` could not reach the provider.
  "runtime-request.delivery.fail",
  // Records that a user's Stop went unconfirmed by the provider.
  "thread.interrupt.unresponsive",
]);

const CONTRACT_COMMAND_TYPES: ReadonlyArray<string> = [
  ...OrchestrationV2Command.members,
  ...OrchestrationV2InternalCommand.members,
].map((member) => member.fields.type.literal);

/** A command of `type` naming `threadId` in the field(s) that command really carries. */
const commandOf = (type: string, threadId: ThreadId, commandId = `cmd:${type}`) => {
  const names = type.startsWith("delegated_task.")
    ? { parentThreadId: threadId }
    : type === "thread.created.record"
      ? { parentThreadId: threadId, targetThreadId: ThreadId.make("thread:child") }
      : type === "thread.fork" || type === "thread.merge_back"
        ? { sourceThreadId: threadId, targetThreadId: ThreadId.make("thread:fork-target") }
        : { threadId };
  // Only the fields the hook reads; the orchestrator never sees these.
  return {
    type,
    commandId: CommandId.make(commandId),
    ...names,
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(`message:${type}`),
    text: "hello",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  } as unknown as OrchestrationV2ServerCommand;
};

const userMessage = (
  threadId: ThreadId,
  overrides: Partial<Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>> = {},
  commandId = "cmd:message",
): OrchestrationV2ServerCommand => ({
  type: "message.dispatch",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make(commandId),
  threadId,
  messageId: MessageId.make(`message:${commandId}`),
  text: "hello",
  attachments: [],
  dispatchMode: { type: "queue_after_active" },
  ...overrides,
});

// Registry-level: the real registry and hook over thread rows holding one home
// thread (active), one probe (archived), a deleted marked thread, and a plain
// thread. Shells are never built: the hook reads only the marker column.
const deletedHome = ThreadId.make("thread:squire-deleted-home");
const threadRow = (
  threadId: ThreadId,
  payload: object,
  times: { readonly archivedAt?: string; readonly deletedAt?: string } = {},
) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, deleted_at, payload_json)
      VALUES (${threadId}, 'project', 'Thread', 'codex', 'approval-required', 'default',
        '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
        ${times.archivedAt ?? null}, ${times.deletedAt ?? null}, ${JSON.stringify(payload)})`,
  );
const seededThreads = Layer.effectDiscard(
  Effect.all([
    threadRow(homeThread, { squire: { squireId, role: "home" } }),
    threadRow(userThread, { title: "Plain" }),
    threadRow(
      probeThread,
      { squire: { squireId, role: "probe" } },
      { archivedAt: "2026-11-01T00:00:00.000Z" },
    ),
    threadRow(
      deletedHome,
      { squire: { squireId, role: "home" } },
      { deletedAt: "2026-11-01T00:00:00.000Z" },
    ),
  ]),
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const projectionMock = Layer.mock(ProjectionStore.ProjectionStoreV2)({
  getShellSnapshot: () => Effect.die("the hook must not build thread shells"),
  getThread: () => Effect.succeed({ modelSelection: threadModel } as OrchestrationV2AppThread),
});

const registryLayer = (
  squires: Layer.Layer<never> | Layer.Layer<SquireRepository.SquireRepository>,
) =>
  SquireCommandHook.layer.pipe(
    Layer.provideMerge(LecturnOrchestrationHooks.layer),
    Layer.provide(projectionMock),
    Layer.provide(seededThreads),
    Layer.provide(squires),
  );

const squireRepositoryMock = Layer.mock(SquireRepository.SquireRepository)({
  getSquire: () => Effect.succeedSome({ name: "Release" } as SquireRepository.SquireRow),
});

const outcome = (command: OrchestrationV2ServerCommand, origin = false) =>
  Effect.gen(function* () {
    const hooks = yield* LecturnOrchestrationHooks.LecturnOrchestrationHooks;
    const admitted = hooks.aroundCommand(
      { scope: "thread", command },
      Effect.succeed("passed" as string),
    );
    return yield* (origin ? withSquireDispatchOrigin(admitted) : admitted).pipe(
      Effect.catchTags({ LecturnHookRejectedError: (rejected) => Effect.succeed(rejected.reason) }),
    );
  });

describe("SquireCommandHook allowlist", () => {
  it("classifies every contract command type in the rule table", () => {
    assert.sameMembers(Object.keys(SquireCommandHook.SQUIRE_COMMAND_RULES), [
      ...CONTRACT_COMMAND_TYPES,
    ]);
  });

  it.layer(registryLayer(squireRepositoryMock))("on marked threads", (it) => {
    it.effect("refuses every command outside SquireDispatchOrigin unless allow-listed", () =>
      Effect.gen(function* () {
        for (const threadId of [homeThread, probeThread]) {
          for (const type of CONTRACT_COMMAND_TYPES) {
            const result = yield* outcome(commandOf(type, threadId));
            assert.equal(
              result,
              ALLOWED_FROM_ANY_CALLER.has(type) ? "passed" : "Managed by Squire Release",
              `${type} on ${threadId}`,
            );
          }
        }
      }),
    );

    it.effect("passes every command inside SquireDispatchOrigin", () =>
      Effect.gen(function* () {
        for (const threadId of [homeThread, probeThread]) {
          for (const type of CONTRACT_COMMAND_TYPES) {
            if (type === "thread.create" || type === "thread.delete") continue;
            assert.equal(yield* outcome(commandOf(type, threadId), true), "passed", type);
          }
        }
      }),
    );

    it.effect("leaves unmarked threads unchanged", () =>
      Effect.gen(function* () {
        for (const type of CONTRACT_COMMAND_TYPES) {
          assert.equal(yield* outcome(commandOf(type, userThread)), "passed", type);
        }
        assert.equal(yield* outcome(commandOf("thread.teleport", userThread)), "passed");
      }),
    );

    it.effect("refuses a command type the table does not know", () =>
      Effect.gen(function* () {
        assert.equal(
          yield* outcome(commandOf("thread.teleport", homeThread)),
          "Managed by Squire Release",
        );
      }),
    );

    it.effect("allows a user message only in the thread's model and a user dispatch mode", () =>
      Effect.gen(function* () {
        const refused = "Managed by Squire Release";
        assert.equal(yield* outcome(userMessage(homeThread)), "passed");
        assert.equal(
          yield* outcome(userMessage(homeThread, { modelSelection: threadModel })),
          "passed",
        );
        assert.equal(
          yield* outcome(userMessage(homeThread, { dispatchMode: { type: "start_immediately" } })),
          "passed",
        );
        assert.equal(
          yield* outcome(userMessage(homeThread, { modelSelection: otherModel })),
          refused,
        );
        assert.equal(
          yield* outcome(
            userMessage(homeThread, {
              modelSelection: { ...threadModel, options: [{ id: "effort", value: "high" }] },
            }),
          ),
          refused,
        );
        assert.equal(
          yield* outcome(userMessage(homeThread, { dispatchMode: { type: "defer_start" } })),
          refused,
        );
        assert.equal(
          yield* outcome(
            userMessage(homeThread, {
              dispatchMode: { type: "restart_active", targetRunId: "run:1" as never },
            }),
          ),
          refused,
        );
        assert.equal(yield* outcome(userMessage(homeThread, { createdBy: "agent" })), refused);
        assert.equal(
          yield* outcome(
            userMessage(homeThread, { messageId: MessageId.make("message:squire:delivery:1") }),
          ),
          refused,
        );
      }),
    );

    it.effect("refuses provider, worktree, and PR changes whatever the command id", () =>
      Effect.gen(function* () {
        const refused = "Managed by Squire Release";
        const commands: ReadonlyArray<OrchestrationV2ServerCommand> = [
          {
            type: "provider.switch",
            commandId: CommandId.make("server:squire:provider:forged"),
            threadId: homeThread,
            modelSelection: otherModel,
          },
          {
            type: "thread.metadata.update",
            commandId: CommandId.make("cmd:worktree"),
            threadId: homeThread,
            worktreePath: "/Users/someone/repo",
          },
          {
            type: "thread.pull-request.link",
            commandId: CommandId.make("cmd:link"),
            threadId: homeThread,
            host: "github.com",
            repository: "acme/app",
            number: 1,
            url: "https://github.com/acme/app/pull/1",
            source: "manual",
          },
        ];
        for (const command of commands) {
          assert.equal(yield* outcome(command), refused, command.type);
          assert.equal(yield* outcome(command, true), "passed", command.type);
        }
      }),
    );

    it.effect("refuses a fork whose source is a home thread", () =>
      Effect.gen(function* () {
        const fork: OrchestrationV2ServerCommand = {
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("cmd:fork-home"),
          sourceThreadId: homeThread,
          targetThreadId: ThreadId.make("thread:user-fork"),
          sourcePoint: { type: "latest_stable" },
        };
        assert.equal(yield* outcome(fork), "Managed by Squire Release");
      }),
    );

    it.effect("refuses a side chat whose source is a home thread", () =>
      Effect.gen(function* () {
        const sideChat: OrchestrationV2ServerCommand = {
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("cmd:side-chat-home"),
          sourceThreadId: homeThread,
          targetThreadId: ThreadId.make("thread:user-side-chat"),
          sourcePoint: { type: "latest_stable" },
          sideChat: true,
        };
        assert.equal(yield* outcome(sideChat), "Managed by Squire Release");
      }),
    );

    it.effect("tracks threads Squire modules mark and refuses marking from anyone else", () =>
      Effect.gen(function* () {
        const created = ThreadId.make("thread:squire-new-home");
        const create = {
          ...commandOf("thread.create", created, "cmd:create-new-home"),
          squire: { squireId, role: "home" },
        } as OrchestrationV2ServerCommand;
        assert.equal(yield* outcome(create), "Only a Squire can create Squire threads.");
        assert.equal(yield* outcome(commandOf("provider.switch", created)), "passed");

        assert.equal(yield* outcome(create, true), "passed");
        assert.equal(
          yield* outcome(commandOf("provider.switch", created)),
          "Managed by Squire Release",
        );

        const probe = ThreadId.make("thread:squire-new-probe");
        const fork: OrchestrationV2ServerCommand = {
          type: "thread.fork",
          createdBy: "system",
          creationSource: "web",
          commandId: CommandId.make("cmd:probe-fork"),
          sourceThreadId: userThread,
          targetThreadId: probe,
          sourcePoint: { type: "latest_stable" },
          squireProbe: { squireId },
        };
        assert.equal(yield* outcome(fork), "Only a Squire can create Squire threads.");
        assert.equal(yield* outcome(fork, true), "passed");
        assert.equal(
          yield* outcome(commandOf("thread.archive", probe)),
          "Managed by Squire Release",
        );

        assert.equal(yield* outcome(commandOf("thread.delete", created), true), "passed");
        assert.equal(yield* outcome(commandOf("provider.switch", created)), "passed");
      }),
    );
  });

  it.layer(registryLayer(Layer.empty))("without the Squire repository", (it) => {
    it.effect("refuses with the generic reason", () =>
      Effect.gen(function* () {
        assert.equal(yield* outcome(commandOf("provider.switch", homeThread)), "Managed by Squire");
      }),
    );

    it.effect("forgets a deleted thread's marker", () =>
      Effect.gen(function* () {
        assert.equal(yield* outcome(commandOf("provider.switch", deletedHome)), "passed");
      }),
    );
  });

  // Switch off, no Squire ever made: the first ordinary command reads no
  // thread shell (the projection mock dies if asked) and passes.
  it.layer(
    SquireCommandHook.layer.pipe(
      Layer.provideMerge(LecturnOrchestrationHooks.layer),
      Layer.provide(projectionMock),
      Layer.provide(SqlitePersistence.layerMemory),
    ),
  )("with no Squire threads", (it) => {
    it.effect("passes ordinary commands without building thread shells", () =>
      Effect.gen(function* () {
        assert.equal(yield* outcome(commandOf("provider.switch", userThread)), "passed");
        assert.equal(yield* outcome(userMessage(userThread)), "passed");
      }),
    );
  });
});

// Orchestrator-level: the hook registered on the production V2 composition,
// so SquireDispatchOrigin must survive the thread lock to reach it.
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:squire-hook-test" },
  displayName: "Codex Squire hook test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by Squire hook tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
  listExternalSessions: () => Effect.succeed({ sessions: [], truncated: false }),
  importExternalSession: () => Effect.die("imports are not used by Squire hook tests"),
} satisfies ProviderInstance;

const configLayer = (squireEnabled: boolean) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, squireEnabled })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-hook-" })));

const orchestratorLayer = (squireEnabled: boolean) =>
  Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventSink,
    ProjectStore.layer,
    ProjectionStore.layer,
  ).pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(Layer.mock(CheckpointStore.CheckpointStore)({})),
    Layer.provide(configLayer(squireEnabled)),
    Layer.provide(ServerSettings.layerTest()),
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
    Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
    Layer.provideMerge(
      Layer.merge(
        NodeServices.layer,
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => Effect.die("unused"),
        }),
      ),
    ),
  );

const projectId = ProjectId.make("project:squire-hook");
const isLecturnHookRejectedError = Schema.is(LecturnOrchestrationHooks.LecturnHookRejectedError);

const seedProject = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make(`seed:${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: "2026-11-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: process.cwd(),
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    },
  }),
);

const createCommand = (
  threadId: ThreadId,
  squire?: { readonly role: "home" | "probe" },
): OrchestrationV2ServerCommand => ({
  type: "thread.create",
  createdBy: "system",
  creationSource: "web",
  commandId: CommandId.make(`${threadId}:create`),
  threadId,
  projectId,
  title: "Squire · Release",
  modelSelection: threadModel,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  ...(squire === undefined ? {} : { squire: { squireId, role: squire.role } }),
});

/** The Squire hook's refusal reason, "passed" when the hook let it through. */
const dispatchOutcome = (command: OrchestrationV2ServerCommand, origin = false) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const dispatched = orchestrator.dispatch(command);
    return yield* (origin ? withSquireDispatchOrigin(dispatched) : dispatched).pipe(
      Effect.as("passed"),
      Effect.catch((error) =>
        Effect.succeed(
          error._tag === "OrchestratorCommandRejectedError" &&
            isLecturnHookRejectedError(error.cause) &&
            error.cause.contribution === "squire"
            ? error.cause.reason
            : "passed",
        ),
      ),
    );
  });

for (const squireEnabled of [true, false]) {
  it.layer(orchestratorLayer(squireEnabled))(
    `SquireCommandHook on the orchestrator (switch ${squireEnabled ? "on" : "off"})`,
    (it) => {
      it.effect(
        "loads marked threads from thread rows and sees SquireDispatchOrigin through dispatch",
        () =>
          Effect.gen(function* () {
            const home = ThreadId.make(`thread:home:${squireEnabled}`);
            const user = ThreadId.make(`thread:plain:${squireEnabled}`);
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            // Created before the hook registers, so only the startup load can know it.
            yield* orchestrator.dispatch(createCommand(home, { role: "home" }));
            yield* orchestrator.dispatch(createCommand(user));
            yield* Layer.build(SquireCommandHook.layer);

            const refusedOutside: ReadonlyArray<OrchestrationV2ServerCommand> = [
              {
                type: "provider.switch",
                commandId: CommandId.make(`server:squire:provider:${home}`),
                threadId: home,
                modelSelection: otherModel,
              },
              {
                type: "thread.metadata.update",
                commandId: CommandId.make(`${home}:worktree`),
                threadId: home,
                worktreePath: "/tmp/user-repo",
              },
              {
                type: "thread.pull-request.link",
                commandId: CommandId.make(`${home}:link`),
                threadId: home,
                host: "github.com",
                repository: "acme/app",
                number: 1,
                url: "https://github.com/acme/app/pull/1",
                source: "manual",
              },
              userMessage(home, { modelSelection: otherModel }, `${home}:other-model`),
              userMessage(home, { dispatchMode: { type: "defer_start" } }, `${home}:defer`),
              {
                type: "thread.fork",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`${home}:fork`),
                sourceThreadId: home,
                targetThreadId: ThreadId.make(`${home}:fork-target`),
                sourcePoint: { type: "latest_stable" },
              },
            ];
            for (const command of refusedOutside) {
              assert.equal(yield* dispatchOutcome(command), "Managed by Squire", command.type);
            }
            // A refused command records no receipt, so the same id passes from a Squire module.
            for (const command of refusedOutside) {
              assert.equal(yield* dispatchOutcome(command, true), "passed", command.type);
            }
            for (const command of refusedOutside) {
              const onUser = { ...command, commandId: CommandId.make(`${command.commandId}:user`) };
              if ("threadId" in onUser) Object.assign(onUser, { threadId: user });
              if ("sourceThreadId" in onUser) Object.assign(onUser, { sourceThreadId: user });
              assert.equal(yield* dispatchOutcome(onUser), "passed", `${command.type} unmarked`);
            }
          }).pipe(Effect.scoped),
      );

      it.effect("runs a Squire lifecycle with no refused command", () =>
        Effect.gen(function* () {
          yield* seedProject;
          yield* Layer.build(SquireCommandHook.layer);
          const home = ThreadId.make(`thread:lifecycle:${squireEnabled}`);
          const steps: ReadonlyArray<readonly [OrchestrationV2ServerCommand, boolean]> = [
            [createCommand(home, { role: "home" }), true],
            [
              {
                type: "thread.auto-settle.set",
                commandId: CommandId.make(`${home}:auto-settle`),
                threadId: home,
                enabled: false,
              },
              true,
            ],
            [userMessage(home, { modelSelection: threadModel }, `${home}:message`), false],
            [
              {
                type: "thread.stop",
                commandId: CommandId.make(`${home}:stop`),
                threadId: home,
                createdBy: "user",
              },
              false,
            ],
            [
              {
                type: "thread.archive",
                commandId: CommandId.make(`${home}:archive`),
                threadId: home,
              },
              true,
            ],
            [
              {
                type: "thread.delete",
                commandId: CommandId.make(`${home}:delete`),
                threadId: home,
              },
              true,
            ],
          ];
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          for (const [command, origin] of steps) {
            const dispatched = orchestrator.dispatch(command);
            yield* origin ? withSquireDispatchOrigin(dispatched) : dispatched;
          }
          assert.isNull(yield* orchestrator.getThreadShell(home));
        }).pipe(Effect.scoped),
      );
    },
  );
}

const releaseInput = Schema.decodeSync(SquireCreateInput)({
  requestId: "release",
  homeProjectId: ProjectId.make("billing-service"),
  providerInstanceId: scripted,
  modelSelection: scriptedModel,
  name: "Release",
  brief: "",
  grants: [{ kind: "project", targetId: "billing-service" }],
  events: {},
  permissions: {},
  budgets: {},
});

describe("A5.11b trigger re-check for Squire actions", () => {
  const homeProject = ProjectId.make("billing-service");
  const target = ThreadId.make("thr_fix_invoice_rounding");
  // Holds run only when the test calls them, not on the 5 s backstop.
  const noTicks = Layer.succeed(
    Scheduler.Scheduler,
    Scheduler.Scheduler.of({ register: () => Effect.void }),
  );

  const need = <I, S>(tag: Context.Key<I, S>) =>
    Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

  /** A Release Squire with steer Auto and one held steer on its tracked thread. */
  const withHold = <A, E>(
    body: (hold: {
      readonly card: SquireRepository.SquireCardRow;
      readonly execute: OrchestrationV2ServerCommand;
    }) => Effect.Effect<A, E, Phase4Services | Scope.Scope>,
  ) =>
    Effect.gen(function* () {
      const { root, baseDir } = yield* tempRoot;
      return yield* Effect.gen(function* () {
        yield* seedLifecycleProject(homeProject, initRepo(`${root}/billing-service`));
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${target}:create`),
          threadId: target,
          projectId: homeProject,
          title: "Fix invoice rounding",
          modelSelection: scriptedModel,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const squire = yield* (yield* need(SquireService.SquireService)).create(releaseInput);
        const repository = yield* SquireRepository.SquireRepository;
        yield* repository.updateSquire({
          id: squire.id,
          patch: {
            permissions_json: JSON.stringify({
              steer: "auto",
              createThread: "recommend",
              notify: "on",
            }),
          },
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* withSquireDispatchOrigin(
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("test:home:event"),
            threadId: squire.homeThreadId!,
            messageId: MessageId.make("message:squire:event:1"),
            text: "Events.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "server",
          }),
        );
        const tools = yield* need(SquireTools.SquireTools);
        yield* tools.call(
          { squireId: squire.id, role: "squire", threadId: squire.homeThreadId! },
          "squire_send_steer",
          { threadId: target, reason: "api-e2e failed.", steer: "Rerun api-e2e." },
        );
        const [card] = yield* repository.listCards({ squireId: squire.id });
        assert.strictEqual(card!.status, "held");
        const execute: OrchestrationV2ServerCommand = {
          type: "message.dispatch",
          commandId: CommandId.make(card!.command_id!),
          threadId: target,
          messageId: SquireActions.squireActionMessageId(card!.id, card!.attempt),
          text: "Rerun api-e2e.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        };
        return yield* body({ card: card!, execute });
      }).pipe(
        Effect.scoped,
        Effect.provide(phase4Layer(baseDir, { scheduler: noTicks })),
        Effect.orDie,
      );
    }).pipe(Effect.scoped);

  const userTurn = Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("test:user:turn"),
      threadId: target,
      messageId: MessageId.make("message:user:turn"),
      text: "I'll take it from here.",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    }),
  );

  const rejection = (exit: Exit.Exit<unknown, unknown>) => {
    if (Exit.isSuccess(exit)) return undefined;
    const failure = Cause.findErrorOption(exit.cause);
    const cause = Option.isSome(failure) ? (failure.value as { cause?: unknown }).cause : undefined;
    return isLecturnHookRejectedError(cause) ? cause.reason : String(Cause.pretty(exit.cause));
  };

  it.effect("a first dispatch passes while the trigger holds", () =>
    withHold(({ execute }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const exit = yield* withSquireDispatchOrigin(orchestrator.dispatch(execute)).pipe(
          Effect.exit,
        );
        assert.isUndefined(rejection(exit));
      }),
    ),
  );

  it.effect("a first dispatch after a user message is refused under the target's lock", () =>
    withHold(({ execute }) =>
      Effect.gen(function* () {
        yield* userTurn;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const exit = yield* withSquireDispatchOrigin(orchestrator.dispatch(execute)).pipe(
          Effect.exit,
        );
        assert.include(rejection(exit), "the user wrote in the thread");
        const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
        assert.isTrue(
          Option.isNone(yield* receipts.getByCommandId({ commandId: execute.commandId })),
        );
      }),
    ),
  );

  it.effect(
    "a replayed execute command passes the hook even after its own turn moved the thread",
    () =>
      withHold(({ execute }) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const first = yield* withSquireDispatchOrigin(orchestrator.dispatch(execute));
          // A user message since would refuse a first dispatch; the replay's receipt decides.
          yield* userTurn;
          const replay = yield* withSquireDispatchOrigin(orchestrator.dispatch(execute));
          assert.strictEqual(replay.sequence, first.sequence);
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const { messages } = yield* projections.getThreadRecords(target, ["messages"], {
            messageIds: [
              MessageId.make(execute.type === "message.dispatch" ? execute.messageId : ""),
            ],
          });
          assert.lengthOf(messages, 1);
        }),
      ),
  );
});
