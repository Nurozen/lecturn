import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as KeyedLock from "@lecturn/shared/KeyedLock";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@lecturn/contracts";
import { Effect, FileSystem, Layer, Option, Path, Ref, Result } from "effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import {
  LecturnOrchestrationHooks,
  layer as hooksRegistryLayer,
} from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import type { ProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { type ProjectRow, ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import {
  StaveAdmission,
  type StaveAdmissionInput,
  StaveSpaceTransitioningError,
} from "./StaveAdmission.ts";
import {
  describeStaveThreadIntent,
  layer as staveHooksLayer,
  STAVE_ADMISSION_WAIT,
} from "./StaveOrchestrationHooks.ts";
import { StaveReconciliation } from "./StaveOrchestration.ts";
import * as RuntimeFence from "./StaveRuntimeFence.ts";
import * as StaveSpaceLock from "./StaveSpaceLock.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

const NOW = "2026-09-01T00:00:00.000Z";
const PROJECT = ProjectId.make("space-project");
const THREAD = ThreadId.make("space-thread");
const SIBLING = ThreadId.make("sibling-thread");
const OTHER_PROJECT = ProjectId.make("other-space-project");
const ELSEWHERE = ThreadId.make("elsewhere-thread");
const THREAD_PROJECTS: ReadonlyMap<ThreadId, ProjectId> = new Map([
  [THREAD, PROJECT],
  [SIBLING, PROJECT],
  [ELSEWHERE, OTHER_PROJECT],
]);
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

const projectRow = (projectId: ProjectId, workspaceRoot: string): ProjectRow => ({
  projectId,
  title: projectId,
  workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

const threadCreate = (worktreePath: string | null): OrchestrationV2ServerCommand => ({
  type: "thread.create",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make("create-thread"),
  threadId: ThreadId.make("new-thread"),
  projectId: PROJECT,
  title: "Thread",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath,
});

const delegatedTaskRequest: OrchestrationV2ServerCommand = {
  type: "delegated_task.request",
  createdBy: "agent",
  creationSource: "mcp",
  commandId: CommandId.make("delegate"),
  parentThreadId: THREAD,
  parentRunId: RunId.make("parent-run"),
  parentNodeId: NodeId.make("parent-node"),
  task: "Investigate",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
};

const delegatedWorktreeTaskRequest: OrchestrationV2ServerCommand = {
  ...delegatedTaskRequest,
  commandId: CommandId.make("delegate-worktree"),
  workspaceStrategy: { type: "worktree", baseRef: "abc123", startFromOrigin: false },
};

const mergeBack: OrchestrationV2ServerCommand = {
  type: "thread.merge_back",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make("merge-back"),
  sourceThreadId: ThreadId.make("fork-child"),
  targetThreadId: THREAD,
  sourcePoint: { type: "latest_stable" },
};

interface Harness {
  readonly rows: Ref.Ref<ReadonlyArray<ProjectRow>>;
  readonly calls: Ref.Ref<ReadonlyArray<StaveAdmissionInput>>;
  readonly transitioning: Ref.Ref<boolean>;
}

const makeLayer = (
  harness: Harness,
  fence: Layer.Layer<RuntimeFence.StaveRuntimeFence> = RuntimeFence.layerNoop,
) =>
  staveHooksLayer.pipe(
    Layer.provideMerge(hooksRegistryLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(StaveAdmission, {
          check: (input) =>
            Ref.update(harness.calls, (all) => [...all, input]).pipe(
              Effect.andThen(Ref.get(harness.transitioning)),
              Effect.flatMap((transitioning) =>
                transitioning
                  ? Effect.fail(
                      new StaveSpaceTransitioningError({
                        projectRoot: input.projectRoot,
                        intent: input.intent,
                        message: "Space is transitioning",
                      }),
                    )
                  : Effect.void,
              ),
            ),
        }),
        StaveSpaceLock.layer,
        fence,
        Layer.mock(StaveWorkspaceReader)({
          load: (workspaceRoot) =>
            Effect.succeed(
              workspaceRoot.startsWith("/spaces/")
                ? Option.some({ spaceId: "space", isSaga: false, repos: [], memories: [] })
                : Option.none(),
            ),
        }),
        Layer.mock(ProjectStoreV2)({
          get: (projectId) =>
            Ref.get(harness.rows).pipe(
              Effect.map((rows) =>
                Option.fromUndefinedOr(rows.find((row) => row.projectId === projectId)),
              ),
            ),
          list: () => Ref.get(harness.rows),
        }),
        Layer.mock(ProjectionStoreV2)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              THREAD_PROJECTS.has(threadId)
                ? ({
                    id: threadId,
                    projectId: THREAD_PROJECTS.get(threadId),
                    worktreePath: null,
                  } as unknown as NonNullable<
                    Effect.Success<ReturnType<ProjectionStoreV2["Service"]["getThreadShell"]>>
                  >)
                : null,
            ),
        }),
      ),
    ),
  );

const withHarness = <A, E>(
  rows: ReadonlyArray<ProjectRow>,
  body: (
    harness: Harness,
    hooks: LecturnOrchestrationHooks["Service"],
  ) => Effect.Effect<A, E, StaveSpaceLock.StaveSpaceLock>,
  fence?: Layer.Layer<RuntimeFence.StaveRuntimeFence>,
) =>
  Effect.gen(function* () {
    const harness: Harness = {
      rows: yield* Ref.make(rows),
      calls: yield* Ref.make<ReadonlyArray<StaveAdmissionInput>>([]),
      transitioning: yield* Ref.make(false),
    };
    return yield* Effect.gen(function* () {
      const hooks = yield* LecturnOrchestrationHooks;
      return yield* body(harness, hooks);
    }).pipe(Effect.provide(makeLayer(harness, fence)));
  });

it.layer(NodeServices.layer)("StaveOrchestrationHooks", (it) => {
  it.effect("rechecks thread admission at commit and maps refusals without committing", () =>
    withHarness([projectRow(PROJECT, "/spaces/lease")], (harness, hooks) =>
      Effect.gen(function* () {
        yield* Ref.set(harness.transitioning, true);
        const committed = yield* Ref.make(false);
        const result = yield* hooks
          .aroundCommand({ scope: "thread", command: threadCreate(null) }, Ref.set(committed, true))
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(result.failure._tag, "LecturnHookRejectedError");
          assert.include(result.failure.message, "Space is transitioning");
        }
        assert.isFalse(yield* Ref.get(committed));
        assert.deepEqual(yield* Ref.get(harness.calls), [
          {
            projectRoot: "/spaces/lease",
            projectId: PROJECT,
            intent: "thread.create",
            worktreePath: null,
            lockHeld: true,
          },
        ]);
      }),
    ),
  );

  it.effect.each(["thread.pin", "thread.unarchive"] as const)(
    "resolves %s through the thread's project and refuses while transitioning",
    (type) =>
      withHarness([projectRow(PROJECT, "/spaces/reactivation")], (harness, hooks) =>
        Effect.gen(function* () {
          const command = { type, commandId: CommandId.make("reactivate"), threadId: THREAD };
          yield* hooks.aroundCommand({ scope: "thread", command }, Effect.void);
          yield* Ref.set(harness.transitioning, true);
          const refused = yield* hooks
            .aroundCommand({ scope: "thread", command }, Effect.void)
            .pipe(Effect.flip);
          assert.include(refused.message, "Space is transitioning");
          assert.deepEqual(
            (yield* Ref.get(harness.calls)).map((call) => [call.projectRoot, call.intent]),
            [
              ["/spaces/reactivation", type],
              ["/spaces/reactivation", type],
            ],
          );
        }),
      ),
  );

  it.effect(
    "admits V2 thread-creating commands (delegated task, merge-back) like create/fork",
    () =>
      withHarness([projectRow(PROJECT, "/spaces/v2")], (harness, hooks) =>
        Effect.gen(function* () {
          const commands: ReadonlyArray<OrchestrationV2ServerCommand> = [
            delegatedTaskRequest,
            mergeBack,
          ];
          for (const command of commands) {
            yield* hooks.aroundCommand({ scope: "thread", command }, Effect.void);
          }
          yield* Ref.set(harness.transitioning, true);
          for (const command of commands) {
            const committed = yield* Ref.make(false);
            const refused = yield* hooks
              .aroundCommand({ scope: "thread", command }, Ref.set(committed, true))
              .pipe(Effect.flip);
            assert.include(refused.message, "Space is transitioning");
            assert.isFalse(yield* Ref.get(committed));
          }
          assert.deepEqual(
            (yield* Ref.get(harness.calls)).map((call) => [
              call.projectRoot,
              call.intent,
              call.worktreePath,
            ]),
            [
              ["/spaces/v2", "thread.create", null],
              ["/spaces/v2", "thread.fork", null],
              ["/spaces/v2", "thread.create", null],
              ["/spaces/v2", "thread.fork", null],
            ],
          );
        }),
      ),
  );

  it.effect("admits a worktree-isolated delegated task as worktree provisioning", () =>
    withHarness([projectRow(PROJECT, "/spaces/delegate")], (harness, hooks) =>
      Effect.gen(function* () {
        yield* hooks.aroundCommand(
          { scope: "thread", command: delegatedWorktreeTaskRequest },
          Effect.void,
        );
        assert.deepEqual(yield* Ref.get(harness.calls), [
          {
            projectRoot: "/spaces/delegate",
            projectId: PROJECT,
            intent: "thread.create",
            worktreePath: null,
            prepareWorktree: true,
            lockHeld: true,
          },
        ]);
      }),
    ),
  );

  it.effect("refuses a thread command while a Stave operation holds the space", () =>
    withHarness([projectRow(PROJECT, "/spaces/busy")], (_harness, hooks) =>
      Effect.gen(function* () {
        const lock = yield* StaveSpaceLock.StaveSpaceLock;
        const refused = yield* lock.withSpaceLock(
          "/spaces/busy",
          hooks
            .aroundCommand({ scope: "thread", command: threadCreate(null) }, Effect.void)
            .pipe(Effect.flip),
        );
        assert.include(refused.message, "A Stave operation is changing this space");
      }),
    ),
  );

  it.effect(
    "fences project imports and retargets through ancestor teardown, including removed manifests",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped();
        const space = path.join(parent, "space");
        const child = path.join(space, "repo");
        yield* fs.makeDirectory(child, { recursive: true });
        const ordinary = ProjectId.make("ordinary");
        const trusted = ProjectId.make("trusted");
        yield* withHarness(
          [projectRow(ordinary, path.join(parent, "ordinary")), projectRow(trusted, space)],
          (_harness, hooks) =>
            Effect.gen(function* () {
              const lock = yield* StaveSpaceLock.StaveSpaceLock;
              const project = (
                command: ProjectCommand,
                commit: Effect.Effect<void> = Effect.void,
              ) => hooks.aroundCommand({ scope: "project", command }, commit);
              yield* lock.withSpaceLock(
                space,
                Effect.gen(function* () {
                  // The space need not be imported, and the CLI may already have removed its
                  // manifest before the project write arrives.
                  yield* fs.remove(space, { recursive: true });
                  const nested = yield* project({
                    type: "project.create",
                    commandId: CommandId.make("create-nested"),
                    projectId: ProjectId.make("nested"),
                    title: "nested",
                    workspaceRoot: child,
                  }).pipe(Effect.flip);
                  assert.include(nested.message, "ancestor");
                  const retarget = yield* project({
                    type: "project.meta.update",
                    commandId: CommandId.make("retarget"),
                    projectId: ordinary,
                    workspaceRoot: child,
                  }).pipe(Effect.flip);
                  assert.include(retarget.message, "ancestor");
                  // Unchanged roots and deletes never wait for Stave.
                  yield* project({
                    type: "project.meta.update",
                    commandId: CommandId.make("same-root"),
                    projectId: ordinary,
                    workspaceRoot: path.join(parent, "ordinary"),
                  });
                  yield* project({
                    type: "project.delete",
                    commandId: CommandId.make("delete"),
                    projectId: ordinary,
                  });
                }),
              );
              // A Stave operation's own writes under the locks it holds pass through.
              const committed = yield* Ref.make(0);
              yield* lock.withSpaceLock(
                child,
                project(
                  {
                    type: "project.create",
                    commandId: CommandId.make("create-trusted"),
                    projectId: ProjectId.make("restored"),
                    title: "restored",
                    workspaceRoot: child,
                  },
                  Ref.update(committed, (count) => count + 1),
                ).pipe(Effect.provideService(StaveReconciliation, true)),
              );
              assert.equal(yield* Ref.get(committed), 1);
              const movedAway = yield* lock.withSpaceLock(
                space,
                project({
                  type: "project.meta.update",
                  commandId: CommandId.make("move-away"),
                  projectId: trusted,
                  workspaceRoot: path.join(parent, "elsewhere"),
                }).pipe(Effect.flip),
              );
              assert.include(movedAway.message, "ancestor");
            }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("keeps provider sessions out of a fenced space and admits others", () =>
    Effect.gen(function* () {
      const fence = yield* RuntimeFence.makeWithOptions();
      yield* withHarness(
        [],
        (_harness, hooks) =>
          Effect.gen(function* () {
            const open = (cwd: string | null) =>
              hooks.aroundProviderSessionOpen(
                {
                  threadId: THREAD,
                  providerSessionId: ProviderSessionId.make("session"),
                  providerInstanceId: modelSelection.instanceId,
                  driverKind: "codex",
                  cwd,
                },
                Effect.succeed("opened"),
              );
            const refused = yield* fence.withFence(
              "/spaces/teardown",
              open("/spaces/teardown/repo").pipe(Effect.flip),
            );
            assert.equal(refused._tag, "LecturnHookRejectedError");
            assert.include(refused.message, "transitioning");
            assert.equal(
              yield* fence.withFence("/spaces/teardown", open("/spaces/other")),
              "opened",
            );
            assert.equal(yield* open(null), "opened");
          }),
        Layer.succeed(RuntimeFence.StaveRuntimeFence, fence),
      );
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ realPath: (path) => Effect.succeed(path) }),
      ),
    ),
  );
});

it.layer(NodeServices.layer)("StaveOrchestrationHooks pre-commit checks", (it) => {
  it.effect("admits a new worktree launch and refuses checkpoint restore in a space", () =>
    withHarness([], (harness, hooks) =>
      Effect.gen(function* () {
        yield* hooks.beforeWorktreeProvision({
          projectId: PROJECT,
          workspaceRoot: "/spaces/one",
          threadId: THREAD,
        });
        const [call] = yield* Ref.get(harness.calls);
        assert.deepEqual(call, {
          projectRoot: "/spaces/one",
          projectId: PROJECT,
          intent: "thread.create",
          worktreePath: null,
          prepareWorktree: true,
        });
        yield* Ref.set(harness.transitioning, true);
        const refusedLaunch = yield* hooks
          .beforeWorktreeProvision({
            projectId: PROJECT,
            workspaceRoot: "/spaces/one",
            threadId: THREAD,
          })
          .pipe(Effect.flip);
        assert.equal(refusedLaunch.hook, "beforeWorktreeProvision");

        const restore = (workspaceRoot: string) =>
          hooks.beforeCheckpointRestore({
            threadId: THREAD,
            projectId: PROJECT,
            workspaceRoot,
            scopeCwd: workspaceRoot,
          });
        const refusedRestore = yield* restore("/spaces/one").pipe(Effect.flip);
        assert.equal(refusedRestore.reason, "Checkpoints are unavailable for Stave spaces.");
        yield* restore("/plain/project");
      }),
    ),
  );
});

it("maps V2 thread commands to the V1 admission intents", () => {
  assert.deepEqual(describeStaveThreadIntent(threadCreate("/spaces/x/wt")), {
    intent: "thread.create",
    projectId: PROJECT,
    worktreePath: "/spaces/x/wt",
  });
  assert.deepEqual(
    describeStaveThreadIntent({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("fork"),
      sourceThreadId: THREAD,
      targetThreadId: ThreadId.make("child"),
      sourcePoint: { type: "latest_stable" },
      workspace: "new-worktree",
    }),
    { intent: "thread.fork", threadId: THREAD, prepareWorktree: true },
  );
  assert.deepEqual(
    describeStaveThreadIntent({
      type: "thread.metadata.update",
      commandId: CommandId.make("meta"),
      threadId: THREAD,
      title: "Renamed",
    }),
    null,
  );
  assert.deepEqual(describeStaveThreadIntent(delegatedTaskRequest), {
    intent: "thread.create",
    threadId: THREAD,
  });
  assert.deepEqual(describeStaveThreadIntent(delegatedWorktreeTaskRequest), {
    intent: "thread.create",
    threadId: THREAD,
    prepareWorktree: true,
  });
  assert.deepEqual(describeStaveThreadIntent(mergeBack), {
    intent: "thread.fork",
    threadId: THREAD,
  });
  assert.deepEqual(
    describeStaveThreadIntent({
      type: "thread.settle",
      commandId: CommandId.make("s"),
      threadId: THREAD,
    }),
    null,
  );
});

const turnStart = (threadId: ThreadId, id: string): OrchestrationV2ServerCommand => ({
  type: "message.dispatch",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make(`turn-${id}`),
  threadId,
  messageId: MessageId.make(`message-${id}`),
  text: id,
  attachments: [],
  dispatchMode: { type: "start_immediately" },
});

/** A gate a test opens to let a held commit or operation finish. */
const gate = (log: Array<string>, name: string) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const open = yield* Deferred.make<void>();
    return {
      entered,
      open: Deferred.succeed(open, undefined),
      body: Effect.sync(() => log.push(name)).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(open)),
      ),
    };
  });

// The orchestrator's composition: aroundThreadLock, the thread lock, then
// aroundCommand around commit. Paths resolve synchronously (no real files), so
// a fiber forked with `startImmediately` is parked on the space when the fork returns.
const withDispatch = <A, E>(
  rows: ReadonlyArray<ProjectRow>,
  body: (
    dispatch: <B, EB>(
      command: OrchestrationV2ServerCommand,
      threadId: ThreadId,
      commit: Effect.Effect<B, EB>,
    ) => Effect.Effect<B, EB | Error>,
    harness: Harness,
  ) => Effect.Effect<A, E, StaveSpaceLock.StaveSpaceLock>,
) =>
  withHarness(rows, (harness, hooks) =>
    Effect.gen(function* () {
      const threadLocks = yield* KeyedLock.make<ThreadId>();
      return yield* body(
        (command, threadId, commit) =>
          hooks.aroundThreadLock(
            command,
            threadLocks.withLock(
              threadId,
              hooks.aroundCommand({ scope: "thread", command }, commit),
            ),
          ),
        harness,
      );
    }),
  ).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ realPath: (path) => Effect.succeed(path) }),
    ),
  );

const fork = Effect.forkChild({ startImmediately: true });

it.layer(NodeServices.layer)("StaveOrchestrationHooks space waits", (it) => {
  it.effect("admits two turn starts in one space together", () =>
    withDispatch([projectRow(PROJECT, "/spaces/shared")], (dispatch, harness) =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const first = yield* gate(log, "first");
        const second = yield* gate(log, "second");
        const a = yield* dispatch(turnStart(THREAD, "a"), THREAD, first.body).pipe(fork);
        const b = yield* dispatch(turnStart(SIBLING, "b"), SIBLING, second.body).pipe(fork);
        yield* Deferred.await(first.entered);
        yield* Deferred.await(second.entered);
        yield* first.open;
        yield* second.open;
        yield* Fiber.join(a);
        yield* Fiber.join(b);
        assert.deepEqual(log, ["first", "second"]);
        assert.lengthOf(yield* Ref.get(harness.calls), 2);
      }),
    ),
  );

  it.effect("holds a turn start while a Stave operation runs, then admits it", () =>
    withDispatch([projectRow(PROJECT, "/spaces/busy")], (dispatch, harness) =>
      Effect.gen(function* () {
        const lock = yield* StaveSpaceLock.StaveSpaceLock;
        const log: Array<string> = [];
        const operation = yield* gate(log, "operation");
        const running = yield* lock.withSpaceLock("/spaces/busy", operation.body).pipe(fork);
        const turn = yield* dispatch(
          turnStart(THREAD, "held"),
          THREAD,
          Effect.sync(() => log.push("turn")),
        ).pipe(fork);
        yield* TestClock.adjust("4 seconds");
        assert.deepEqual(log, ["operation"]);
        assert.lengthOf(yield* Ref.get(harness.calls), 0);
        yield* operation.open;
        yield* Fiber.join(running);
        yield* Fiber.join(turn);
        assert.deepEqual(log, ["operation", "turn"]);
        assert.lengthOf(yield* Ref.get(harness.calls), 1);
      }),
    ),
  );

  it.effect(
    "refuses a turn start with the retry message when the operation outlasts the wait",
    () =>
      withDispatch([projectRow(PROJECT, "/spaces/slow")], (dispatch, harness) =>
        Effect.gen(function* () {
          const lock = yield* StaveSpaceLock.StaveSpaceLock;
          const log: Array<string> = [];
          const operation = yield* gate(log, "operation");
          const running = yield* lock.withSpaceLock("/spaces/slow", operation.body).pipe(fork);
          const turn = yield* dispatch(
            turnStart(THREAD, "refused"),
            THREAD,
            Effect.sync(() => log.push("refused turn")),
          ).pipe(Effect.flip, fork);
          yield* TestClock.adjust(STAVE_ADMISSION_WAIT);
          const refused = yield* Fiber.join(turn);
          assert.equal(
            refused.message,
            "A Stave operation is changing this space. Retry when it finishes.",
          );
          assert.lengthOf(yield* Ref.get(harness.calls), 0);
          yield* operation.open;
          yield* Fiber.join(running);
          yield* dispatch(
            turnStart(THREAD, "retried"),
            THREAD,
            Effect.sync(() => log.push("retried turn")),
          );
          assert.deepEqual(log, ["operation", "retried turn"]);
        }),
      ),
  );

  it.effect("does not let later turn starts starve a waiting Stave operation", () =>
    withDispatch([projectRow(PROJECT, "/spaces/fair")], (dispatch) =>
      Effect.gen(function* () {
        const lock = yield* StaveSpaceLock.StaveSpaceLock;
        const log: Array<string> = [];
        const first = yield* gate(log, "first turn");
        const operation = yield* gate(log, "operation");
        const a = yield* dispatch(turnStart(THREAD, "a"), THREAD, first.body).pipe(fork);
        yield* Deferred.await(first.entered);
        const running = yield* lock.withSpaceLock("/spaces/fair", operation.body).pipe(fork);
        const b = yield* dispatch(
          turnStart(SIBLING, "b"),
          SIBLING,
          Effect.sync(() => log.push("later turn")),
        ).pipe(fork);
        yield* first.open;
        yield* Deferred.await(operation.entered);
        assert.deepEqual(log, ["first turn", "operation"]);
        yield* operation.open;
        yield* Fiber.join(b);
        yield* Fiber.join(a);
        yield* Fiber.join(running);
        assert.deepEqual(log, ["first turn", "operation", "later turn"]);
      }),
    ),
  );

  it.effect("does not hold a turn start in one space for an operation in another", () =>
    withDispatch(
      [projectRow(PROJECT, "/spaces/a"), projectRow(OTHER_PROJECT, "/spaces/b")],
      (dispatch) =>
        Effect.gen(function* () {
          const lock = yield* StaveSpaceLock.StaveSpaceLock;
          const log: Array<string> = [];
          const operation = yield* gate(log, "operation");
          const running = yield* lock.withSpaceLock("/spaces/a", operation.body).pipe(fork);
          yield* dispatch(
            turnStart(ELSEWHERE, "elsewhere"),
            ELSEWHERE,
            Effect.sync(() => log.push("other space turn")),
          );
          assert.deepEqual(log, ["operation", "other space turn"]);
          yield* operation.open;
          yield* Fiber.join(running);
        }),
    ),
  );

  it.effect(
    "waits outside the thread lock, so the operation's own command on that thread runs",
    () =>
      withDispatch([projectRow(PROJECT, "/spaces/reconcile")], (dispatch) =>
        Effect.gen(function* () {
          const lock = yield* StaveSpaceLock.StaveSpaceLock;
          const log: Array<string> = [];
          const reconciled = yield* Deferred.make<void>();
          const running = yield* lock
            .withSpaceLock(
              "/spaces/reconcile",
              Effect.gen(function* () {
                yield* Deferred.await(reconciled);
                yield* dispatch(
                  { type: "thread.pin", commandId: CommandId.make("reconcile"), threadId: THREAD },
                  THREAD,
                  Effect.sync(() => log.push("reconciliation")),
                ).pipe(Effect.provideService(StaveReconciliation, true));
              }),
            )
            .pipe(fork);
          const turn = yield* dispatch(
            turnStart(THREAD, "waiting"),
            THREAD,
            Effect.sync(() => log.push("turn")),
          ).pipe(fork);
          yield* Deferred.succeed(reconciled, undefined);
          yield* Fiber.join(running);
          yield* Fiber.join(turn);
          assert.deepEqual(log, ["reconciliation", "turn"]);
        }),
      ),
  );
});
