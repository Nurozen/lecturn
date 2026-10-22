import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@lecturn/contracts";
import { Effect, FileSystem, Layer, Option, Path, Ref, Result } from "effect";

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
import { describeStaveThreadIntent, layer as staveHooksLayer } from "./StaveOrchestrationHooks.ts";
import { StaveReconciliation } from "./StaveOrchestration.ts";
import * as RuntimeFence from "./StaveRuntimeFence.ts";
import * as StaveSpaceLock from "./StaveSpaceLock.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

const NOW = "2026-09-01T00:00:00.000Z";
const PROJECT = ProjectId.make("space-project");
const THREAD = ThreadId.make("space-thread");
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
              threadId === THREAD
                ? ({
                    id: THREAD,
                    projectId: PROJECT,
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

  for (const type of ["thread.pin", "thread.unarchive"] as const)
    it.effect(`resolves ${type} through the thread's project and refuses while transitioning`, () =>
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
