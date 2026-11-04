// @effect-diagnostics nodeBuiltinImport:off - Fixture repos are inspected with synchronous fs, outside the code under test.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ModelSelection,
  ProjectId,
  SquireCreateInput,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireLifecycle from "./SquireLifecycle.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import {
  deleteProject,
  initRepo,
  isOwnRepository,
  markedThreads,
  scripted,
  scriptedModel,
  seedProject,
  serverLayer,
  tempRoot,
  workspacePath,
} from "./testkit/lifecycleHarness.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const userThread = ThreadId.make("thread-user");
const encodeModel = Schema.encodeSync(Schema.fromJsonString(ModelSelection));

const decodeCreateInput = Schema.decodeSync(SquireCreateInput);
const createInput = (requestId: string) =>
  decodeCreateInput({
    requestId,
    homeProjectId: projectA,
    providerInstanceId: scripted,
    modelSelection: scriptedModel,
    name: "Crash",
    brief: "",
    grants: [{ kind: "thread", targetId: userThread }],
    events: {},
    permissions: {},
    budgets: {},
  });

/** The row `create` inserts before any step runs. */
const creatingRow = (id: SquireId, now: string): SquireRepository.SquireRow => ({
  id,
  role: "squire",
  name: "Crash",
  lifecycle: "creating",
  home_generation: 1,
  home_thread_id: SquireLifecycle.homeThreadIdFor(id, 1),
  home_project_id: projectA,
  provider_instance_id: scripted,
  model_selection_json: encodeModel(scriptedModel),
  summary_model_selection_json: null,
  brief: "",
  status: "active",
  events_json: "{}",
  permissions_json: "{}",
  budgets_json: "{}",
  undo_window_seconds: 10,
  digest_json: null,
  digest_last_date: null,
  onboarded_at: null,
  sweep_json: null,
  user_active_at: null,
  inactivity_prompted_at: null,
  automation_paused_at: null,
  companion_json: "{}",
  revision: 0,
  create_request_id: `crash:${id}`,
  created_at: now,
  updated_at: now,
});

/** A Lecturn home with two Git projects and one user thread in project A. */
const withHome = <A, E, R>(
  body: (home: {
    readonly baseDir: string;
    readonly server: ReturnType<typeof serverLayer>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    const server = () => serverLayer(baseDir);
    yield* Effect.gen(function* () {
      yield* seedProject(projectA, initRepo(NodePath.join(root, "a")));
      yield* seedProject(projectB, initRepo(NodePath.join(root, "b")));
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("thread-user:create"),
        threadId: userThread,
        projectId: projectA,
        title: "Fix the build",
        modelSelection: scriptedModel,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }).pipe(Effect.provide(server()));
    return yield* body({ baseDir, server: server() });
  }).pipe(Effect.scoped);

/** Restart: a fresh server over the same home, then startup reconciliation. */
const restartAndReconcile = <A, E, R>(
  server: ReturnType<typeof serverLayer>,
  check: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* (yield* SquireLifecycle.SquireLifecycle).reconcileAll;
    return yield* check;
  }).pipe(Effect.provide(server));

const expectOneReadyHome = (baseDir: string, squireId: SquireId, generation: number) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const row = Option.getOrThrow(yield* repository.getSquire(squireId));
    assert.equal(row.lifecycle, "ready");
    assert.equal(row.home_generation, generation);
    const homeThreadId = SquireLifecycle.homeThreadIdFor(squireId, generation);
    assert.equal(row.home_thread_id, homeThreadId);
    const threads = yield* markedThreads(squireId);
    assert.deepEqual(
      threads.live.map((shell) => shell.id),
      [homeThreadId],
    );
    assert.lengthOf(threads.archived, generation - 1);
    const shell = (yield* projections.getThreadShell(homeThreadId))!;
    assert.isNotNull(shell.autoSettleDisabledAt ?? null);
    assert.equal(shell.worktreePath, workspacePath(baseDir, squireId));
    assert.isTrue(isOwnRepository(workspacePath(baseDir, squireId)));
    // One workspace: nothing else under this Squire's folder.
    assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(workspacePath(baseDir, squireId))), [
      "workspace",
    ]);
    return row;
  });

/** One case per crash point: after 0..steps.length completed steps. */
const stepCounts = (steps: ReadonlyArray<unknown>) =>
  Array.from({ length: steps.length + 1 }, (_, completed) => ({ completed }));

describe("SquireLifecycle", () => {
  it.live.each(stepCounts(SquireLifecycle.HOME_STEPS))(
    `create resumes after a crash past $completed step(s)`,
    ({ completed }) =>
      withHome(({ baseDir, server }) =>
        Effect.gen(function* () {
          const squireId = SquireId.make(`squire-crash-${completed}`);
          yield* Effect.gen(function* () {
            const repository = yield* SquireRepository.SquireRepository;
            const lifecycle = yield* SquireLifecycle.SquireLifecycle;
            yield* repository.createSquire(
              creatingRow(squireId, DateTime.formatIso(yield* DateTime.now)),
            );
            for (const step of SquireLifecycle.HOME_STEPS.slice(0, completed)) {
              yield* lifecycle.homeStep(squireId, step);
            }
          }).pipe(Effect.provide(server));
          yield* restartAndReconcile(server, expectOneReadyHome(baseDir, squireId, 1));
          // A second start finds nothing to do.
          yield* restartAndReconcile(server, expectOneReadyHome(baseDir, squireId, 1));
        }),
      ),
  );

  it.live.each(stepCounts(SquireLifecycle.DELETE_STEPS))(
    `delete resumes after a crash past $completed step(s) and keeps tracked threads`,
    ({ completed }) =>
      withHome(({ baseDir, server }) =>
        Effect.gen(function* () {
          const squire = yield* Effect.gen(function* () {
            const service = yield* SquireService.SquireService;
            const repository = yield* SquireRepository.SquireRepository;
            const lifecycle = yield* SquireLifecycle.SquireLifecycle;
            const created = yield* service.create(createInput(`delete-${completed}`));
            assert.lengthOf(created.grants, 1);
            yield* repository.updateSquire({
              id: created.id,
              patch: { lifecycle: "deleting" },
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            });
            for (const step of SquireLifecycle.DELETE_STEPS.slice(0, completed)) {
              yield* lifecycle.deleteStep(created.id, step);
            }
            return created;
          }).pipe(Effect.provide(server));

          yield* restartAndReconcile(
            server,
            Effect.gen(function* () {
              const repository = yield* SquireRepository.SquireRepository;
              const projections = yield* ProjectionStore.ProjectionStoreV2;
              assert.isTrue(Option.isNone(yield* repository.getSquire(squire.id)));
              assert.lengthOf(yield* repository.listGrants(squire.id), 0);
              assert.isFalse(NodeFS.existsSync(workspacePath(baseDir, squire.id)));
              const threads = yield* markedThreads(squire.id);
              assert.lengthOf(threads.live, 0);
              assert.deepEqual(
                threads.archived.map((shell) => shell.id),
                [squire.homeThreadId],
              );
              const tracked = (yield* projections.getThreadShell(userThread))!;
              assert.isNull(tracked.archivedAt);
            }),
          );
        }),
      ),
  );

  it.live("re-homes to the most recently active project when the home project goes", () =>
    withHome(({ baseDir, server }) =>
      Effect.gen(function* () {
        const squire = yield* Effect.gen(function* () {
          const service = yield* SquireService.SquireService;
          const lifecycle = yield* SquireLifecycle.SquireLifecycle;
          const created = yield* service.create(createInput("rehome"));
          yield* deleteProject(projectA);
          yield* lifecycle.rehome(created.id);
          return created;
        }).pipe(Effect.provide(server));
        yield* restartAndReconcile(
          server,
          Effect.gen(function* () {
            const row = yield* expectOneReadyHome(baseDir, squire.id, 2);
            assert.equal(row.home_project_id, projectB);
            const threads = yield* markedThreads(squire.id);
            assert.deepEqual(
              threads.archived.map((shell) => shell.id),
              [squire.homeThreadId],
            );
            assert.equal(threads.live[0]!.projectId, projectB);
          }),
        );
      }),
    ),
  );

  it.live("a re-home returns a batch in flight to pending under a new batch id", () =>
    withHome(({ server }) =>
      Effect.gen(function* () {
        const service = yield* SquireService.SquireService;
        const repository = yield* SquireRepository.SquireRepository;
        const lifecycle = yield* SquireLifecycle.SquireLifecycle;
        const created = yield* service.create(createInput("rehome-batch"));
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* repository.insertEvent({
          squire_id: created.id,
          thread_id: userThread,
          kind: "turn-finished",
          state_key: "run-1",
          payload_json: null,
          status: "pending",
          defer_reason: null,
          not_before: now,
          batch_id: null,
          created_at: now,
        });
        const before = Option.getOrThrow(yield* repository.getSquire(created.id));
        const pending = yield* repository.listEventsByStatus({
          squireId: created.id,
          statuses: ["pending"],
        });
        const oldBatch = SquireDelivery.batchIdFor(before, pending);
        yield* repository.markEventsBatched({
          ids: pending.map((row) => row.id),
          batchId: oldBatch,
        });

        yield* deleteProject(projectA);
        yield* lifecycle.rehome(created.id);
        const after = Option.getOrThrow(yield* repository.getSquire(created.id));
        assert.equal(after.home_generation, 2);
        const rows = yield* repository.listEventsByStatus({
          squireId: created.id,
          statuses: ["pending", "batched"],
        });
        assert.deepEqual(
          rows.map((row) => [row.status, row.batch_id]),
          [["pending", null]],
        );
        assert.notEqual(SquireDelivery.batchIdFor(after, rows), oldBatch);
      }).pipe(Effect.provide(server)),
    ),
  );

  it.live.each(stepCounts(SquireLifecycle.HOME_STEPS))(
    `re-home after a deleted home thread resumes past $completed step(s)`,
    ({ completed }) =>
      withHome(({ baseDir, server }) =>
        Effect.gen(function* () {
          const squire = yield* Effect.gen(function* () {
            const service = yield* SquireService.SquireService;
            const repository = yield* SquireRepository.SquireRepository;
            const lifecycle = yield* SquireLifecycle.SquireLifecycle;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const created = yield* service.create(createInput(`rehome-${completed}`));
            yield* withSquireDispatchOrigin(
              orchestrator.dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`test:delete-home:${completed}`),
                threadId: created.homeThreadId!,
              }),
            );
            // What `rehome` writes before it drives the steps.
            yield* repository.updateSquire({
              id: created.id,
              patch: {
                lifecycle: "rehoming",
                home_generation: 2,
                home_thread_id: SquireLifecycle.homeThreadIdFor(created.id, 2),
              },
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            });
            for (const step of SquireLifecycle.HOME_STEPS.slice(0, completed)) {
              yield* lifecycle.homeStep(created.id, step);
            }
            return created;
          }).pipe(Effect.provide(server));
          yield* restartAndReconcile(
            server,
            Effect.gen(function* () {
              const repository = yield* SquireRepository.SquireRepository;
              const row = Option.getOrThrow(yield* repository.getSquire(squire.id));
              assert.equal(row.lifecycle, "ready");
              assert.equal(row.home_generation, 2);
              const threads = yield* markedThreads(squire.id);
              // The deleted generation-1 thread is gone, not archived.
              assert.deepEqual(
                threads.live.map((shell) => shell.id),
                [SquireLifecycle.homeThreadIdFor(squire.id, 2)],
              );
              assert.lengthOf(threads.archived, 0);
              assert.isTrue(isOwnRepository(workspacePath(baseDir, squire.id)));
            }),
          );
        }),
      ),
  );

  it.live("a needs_provider Lead only moves when it re-homes", () =>
    withHome(({ server }) =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const lifecycle = yield* SquireLifecycle.SquireLifecycle;
        const leadId = SquireId.make("squire-waiting-lead");
        yield* repository.createSquire({
          ...creatingRow(leadId, DateTime.formatIso(yield* DateTime.now)),
          role: "lead",
          lifecycle: "needs_provider",
          home_generation: 0,
          home_thread_id: null,
          provider_instance_id: null,
          model_selection_json: null,
        });
        yield* deleteProject(projectA);
        yield* lifecycle.rehome(leadId);
        const row = Option.getOrThrow(yield* repository.getSquire(leadId));
        assert.equal(row.lifecycle, "needs_provider");
        assert.equal(row.home_project_id, projectB);
        assert.deepEqual(yield* markedThreads(leadId), { live: [], archived: [] });
      }).pipe(Effect.provide(server)),
    ),
  );
});
