import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationProjectShell,
  ProjectId,
  SquireId,
  type StaveProjectInfo,
  ThreadId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireScope from "./SquireScope.ts";
import * as SquireSwitch from "./SquireSwitch.ts";
import { handOverOrDropQueuedEvents, retireOutOfScope } from "./squireScopeCascade.ts";
import {
  createThread,
  dispatchThread,
  grantRow,
  orchestratorLayer,
  squireRow,
} from "./testkit/scopeHarness.ts";

const projectA = ProjectId.make("project:a");
const projectB = ProjectId.make("project:b");
const projectUnknown = ProjectId.make("project:unknown");
const release = SquireId.make("squire:release");
const billing = SquireId.make("squire:billing");
const saga = SquireId.make("squire:saga");

const containers = SquireContainers.layerTest({
  spaces: [
    { spaceId: "space-a", sagaId: "saga-1", projectIds: [projectA] },
    { spaceId: "space-b", sagaId: "saga-1", projectIds: [projectB] },
  ],
  unknownProjectIds: [projectUnknown],
});

// A fresh database per test, so Squires from one test never track another's threads.
const withScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      SquireScope.layer.pipe(
        Layer.provideMerge(SquireRepository.layer),
        Layer.provideMerge(containers),
        Layer.provideMerge(orchestratorLayer),
      ),
    ),
  );

const seed = (
  squires: ReadonlyArray<SquireRepository.SquireRow>,
  grants: ReadonlyArray<SquireRepository.SquireGrantRow>,
) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    for (const squire of squires) yield* repository.createSquire(squire);
    for (const grant of grants) yield* repository.insertGrant(grant);
  });

describe("SquireScope", () => {
  it.effect("queued thread events go to the next owner at a pause, an exclusion, or a delete", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        const repository = yield* SquireRepository.SquireRepository;
        const off = SquireId.make("squire:toggled-off");
        yield* seed(
          [
            squireRow(release, { created_at: "2026-11-01T00:00:00.000Z" }),
            squireRow(off, {
              created_at: "2026-11-02T00:00:00.000Z",
              events_json: '{"turnFinished":false}',
            }),
            squireRow(billing, { created_at: "2026-11-03T00:00:00.000Z" }),
          ],
          [
            grantRow(release, "project", projectA),
            grantRow(off, "project", projectA),
            grantRow(billing, "project", projectA),
          ],
        );
        const threadId = ThreadId.make("thread:handover");
        yield* createThread(threadId, projectA);
        const event = (
          stateKey: string,
          kind: string,
          thread: ThreadId | null = threadId,
        ): Omit<SquireRepository.SquireEventRow, "id"> => ({
          squire_id: release,
          thread_id: thread,
          kind,
          state_key: stateKey,
          payload_json: null,
          status: "pending",
          defer_reason: null,
          not_before: "2026-11-01T00:00:00.000Z",
          batch_id: null,
          created_at: "2026-11-01T00:00:00.000Z",
        });
        yield* repository.insertEvent(event("run-1", "turn-finished"));
        yield* repository.insertEvent(event("voice-1", "voice-note", null));
        yield* handOverOrDropQueuedEvents(repository, scope, release);
        const queued = yield* repository.listEvents({
          statuses: ["pending", "dropped"],
        });
        assert.deepStrictEqual(
          queued.map((row) => [row.state_key, row.squire_id, row.status]).toSorted(),
          [
            ["run-1", billing, "pending"],
            ["voice-1", release, "dropped"],
          ],
        );

        // An exclusion hands over; a duplicate at the new owner is dropped.
        yield* repository.insertEvent(event("run-2", "turn-finished"));
        yield* repository.insertEvent(event("run-3", "turn-finished"));
        yield* repository.insertEvent({ ...event("run-3", "turn-finished"), squire_id: billing });
        yield* repository.insertGrant(grantRow(release, "exclusion", threadId));
        yield* retireOutOfScope(repository, scope, {
          squireId: release,
          now: "2026-11-01T00:00:00.000Z",
        });
        const after = yield* repository.listEvents({ statuses: ["pending", "dropped"] });
        assert.deepStrictEqual(
          after
            .filter((row) => row.state_key === "run-2" || row.state_key === "run-3")
            .map((row) => [row.state_key, row.squire_id, row.status])
            .toSorted(),
          [
            ["run-2", billing, "pending"],
            ["run-3", billing, "pending"],
            ["run-3", release, "dropped"],
          ],
        );
      }),
    ),
  );

  it.effect("tracks threads created in a granted project after the grant", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        yield* seed([squireRow(release)], [grantRow(release, "project", projectA)]);
        const inA = ThreadId.make("thread:a-new");
        const inB = ThreadId.make("thread:b-new");
        assert.deepStrictEqual(yield* scope.trackersOf(inA), []);

        yield* createThread(inA, projectA);
        yield* createThread(inB, projectB);
        assert.deepStrictEqual(yield* scope.trackersOf(inA), [release]);
        assert.isTrue(yield* scope.isTracked(release, inA));
        assert.deepStrictEqual(yield* scope.trackersOf(inB), []);
        assert.isFalse(yield* scope.isTracked(release, inB));
      }),
    ),
  );

  it.effect("covers threads through Stave space and saga grants, never when unknown", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        yield* seed(
          [squireRow(release), squireRow(saga), squireRow(billing)],
          [
            grantRow(release, "staveSpace", "space-a"),
            grantRow(saga, "staveSaga", "saga-1"),
            grantRow(billing, "project", projectUnknown),
          ],
        );
        const inA = ThreadId.make("thread:space-a");
        const inB = ThreadId.make("thread:space-b");
        const inUnknown = ThreadId.make("thread:unknown");
        yield* createThread(inA, projectA);
        yield* createThread(inB, projectB);
        yield* createThread(inUnknown, projectUnknown);

        assert.deepStrictEqual(yield* scope.trackersOf(inA), [release, saga]);
        assert.deepStrictEqual(yield* scope.trackersOf(inB), [saga]);
        // Unknown membership is outside every space and saga; the project grant still holds.
        assert.deepStrictEqual(yield* scope.trackersOf(inUnknown), [billing]);
        assert.deepStrictEqual(Option.getOrThrow(yield* scope.targetOf(inA)), {
          threadId: inA,
          projectId: projectA,
          staveSpaceId: "space-a",
          staveSagaId: "saga-1",
        });
        assert.isNull(Option.getOrThrow(yield* scope.targetOf(inUnknown)).staveSagaId);
      }),
    ),
  );

  it.effect("covers a project through project, Stave space, and saga grants (P19.3c)", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        const thread = SquireId.make("squire:thread");
        yield* seed(
          [squireRow(release), squireRow(saga), squireRow(billing), squireRow(thread)],
          [
            grantRow(release, "staveSpace", "space-a"),
            grantRow(saga, "staveSaga", "saga-1"),
            grantRow(billing, "project", projectB),
            // A thread grant names one thread, never its whole project.
            grantRow(thread, "thread", "thread:in-a"),
          ],
        );
        assert.deepStrictEqual(yield* scope.projectCoverersOf(projectA), [release, saga]);
        assert.deepStrictEqual(yield* scope.projectCoverersOf(projectB), [saga, billing]);
        assert.deepStrictEqual(yield* scope.projectCoverersOf(projectUnknown), []);
      }),
    ),
  );

  it.effect("lets an exclusion beat project, space, and thread grants", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        const excluded = ThreadId.make("thread:excluded");
        const kept = ThreadId.make("thread:kept");
        yield* seed(
          [squireRow(release)],
          [
            grantRow(release, "project", projectA),
            grantRow(release, "staveSpace", "space-a"),
            grantRow(release, "thread", excluded),
            grantRow(release, "exclusion", excluded),
          ],
        );
        yield* createThread(excluded, projectA);
        yield* createThread(kept, projectA);

        assert.isFalse(yield* scope.isTracked(release, excluded));
        assert.deepStrictEqual(yield* scope.trackersOf(excluded), []);
        assert.isTrue(yield* scope.isTracked(release, kept));
      }),
    ),
  );

  it.effect("drops a settled thread from project and thread grants until it is unsettled", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const settled = ThreadId.make("thread:settled");
        yield* seed(
          [squireRow(release), squireRow(billing)],
          [grantRow(release, "project", projectA), grantRow(billing, "thread", settled)],
        );
        yield* createThread(settled, projectA);
        assert.deepStrictEqual(yield* scope.trackersOf(settled), [release, billing]);

        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle"),
          threadId: settled,
        });
        assert.deepStrictEqual(yield* scope.trackersOf(settled), []);
        assert.isFalse(yield* scope.isTracked(billing, settled));
        assert.isTrue(Option.isNone(yield* scope.targetOf(settled)));

        yield* orchestrator.dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make("unsettle"),
          threadId: settled,
          reason: "user",
        });
        assert.deepStrictEqual(yield* scope.trackersOf(settled), [release, billing]);
      }),
    ),
  );

  it.effect("never tracks a Squire thread, an archived thread, or a deleted one", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        const marked = ThreadId.make("thread:billing-home");
        const archived = ThreadId.make("thread:archived");
        const deleted = ThreadId.make("thread:deleted");
        yield* seed(
          [squireRow(release), squireRow(billing)],
          [grantRow(release, "project", projectA), grantRow(release, "thread", marked)],
        );
        yield* createThread(marked, projectA, billing);
        yield* createThread(archived, projectA);
        yield* createThread(deleted, projectA);
        assert.isTrue(yield* scope.isTracked(release, archived));
        // The marked thread exists, so only its marker keeps it untracked.
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.equal((yield* projections.getThreadShell(marked))?.squire?.squireId, billing);

        yield* dispatchThread("thread.archive", archived);
        yield* dispatchThread("thread.delete", deleted);
        for (const threadId of [marked, archived, deleted]) {
          assert.deepStrictEqual(yield* scope.trackersOf(threadId), [], threadId);
          assert.isFalse(yield* scope.isTracked(release, threadId), threadId);
          assert.isTrue(Option.isNone(yield* scope.targetOf(threadId)), threadId);
        }
        assert.isFalse(
          yield* scope.ruleTargetInScope({
            squireId: release,
            targetKind: "thread",
            targetId: marked,
          }),
        );
      }),
    ),
  );

  it.effect("orders trackers by creation and sees grant changes at once", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        const repository = yield* SquireRepository.SquireRepository;
        const lead = SquireId.make("squire:lead");
        const threadId = ThreadId.make("thread:shared");
        // Inserted newest first, so the order comes from created_at, not insertion.
        yield* seed(
          [
            squireRow(billing, { created_at: "2026-11-03T00:00:00.000Z" }),
            squireRow(release, { created_at: "2026-11-02T00:00:00.000Z" }),
            squireRow(lead, { role: "lead", created_at: "2026-11-01T00:00:00.000Z" }),
          ],
          [
            grantRow(billing, "project", projectA),
            grantRow(release, "project", projectA),
            grantRow(lead, "project", projectA),
          ],
        );
        yield* createThread(threadId, projectA);
        assert.deepStrictEqual(yield* scope.trackersOf(threadId), [release, billing]);

        yield* repository.deleteGrant({ squireId: release, kind: "project", targetId: projectA });
        assert.deepStrictEqual(yield* scope.trackersOf(threadId), [billing]);
        yield* repository.insertGrant(grantRow(release, "thread", threadId));
        assert.deepStrictEqual(yield* scope.trackersOf(threadId), [release, billing]);
        yield* repository.insertGrant(grantRow(billing, "exclusion", threadId));
        assert.deepStrictEqual(yield* scope.trackersOf(threadId), [release]);
      }),
    ),
  );

  it.effect("owns a thread by grant rank: thread, saga, space, then project", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        const repository = yield* SquireRepository.SquireRepository;
        const space = SquireId.make("squire:space");
        const threadId = ThreadId.make("thread:ranked");
        yield* seed(
          [
            squireRow(billing, { created_at: "2026-11-01T00:00:00.000Z" }),
            squireRow(space, { created_at: "2026-11-02T00:00:00.000Z" }),
            squireRow(saga, { created_at: "2026-11-03T00:00:00.000Z" }),
            squireRow(release, { created_at: "2026-11-04T00:00:00.000Z" }),
          ],
          [
            grantRow(billing, "project", projectA),
            grantRow(space, "staveSpace", "space-a"),
            grantRow(saga, "staveSaga", "saga-1"),
          ],
        );
        yield* createThread(threadId, projectA);
        assert.deepStrictEqual(yield* scope.ownerOf(threadId), Option.some(saga));
        yield* repository.insertGrant(grantRow(release, "thread", threadId));
        assert.deepStrictEqual(yield* scope.ownerOf(threadId), Option.some(release));
        yield* repository.deleteGrant({ squireId: release, kind: "thread", targetId: threadId });
        yield* repository.deleteGrant({ squireId: saga, kind: "staveSaga", targetId: "saga-1" });
        assert.deepStrictEqual(yield* scope.ownerOf(threadId), Option.some(space));
        yield* repository.deleteGrant({
          squireId: space,
          kind: "staveSpace",
          targetId: "space-a",
        });
        assert.deepStrictEqual(yield* scope.ownerOf(threadId), Option.some(billing));
      }),
    ),
  );

  it.effect("breaks an ownership tie by age and skips paused, deleting, and excluded Squires", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        const repository = yield* SquireRepository.SquireRepository;
        const newest = SquireId.make("squire:newest");
        const threadId = ThreadId.make("thread:tied");
        // Inserted newest first, so the winner comes from created_at, not insertion.
        yield* seed(
          [
            squireRow(newest, { created_at: "2026-11-04T00:00:00.000Z" }),
            squireRow(billing, { created_at: "2026-11-03T00:00:00.000Z" }),
            squireRow(release, { created_at: "2026-11-02T00:00:00.000Z" }),
          ],
          [
            grantRow(newest, "project", projectA),
            grantRow(billing, "project", projectA),
            grantRow(release, "project", projectA),
          ],
        );
        yield* createThread(threadId, projectA);
        assert.deepStrictEqual(yield* scope.ownerOf(threadId), Option.some(release));

        const patch = (id: SquireId, fields: Partial<SquireRepository.SquireRow>) =>
          repository.updateSquire({ id, patch: fields, updatedAt: "2026-11-05T00:00:00.000Z" });
        yield* patch(release, { status: "paused" });
        assert.deepStrictEqual(yield* scope.ownerOf(threadId), Option.some(billing));
        yield* patch(billing, { lifecycle: "deleting" });
        assert.deepStrictEqual(yield* scope.ownerOf(threadId), Option.some(newest));
        yield* repository.insertGrant(grantRow(newest, "exclusion", threadId));
        assert.deepStrictEqual(yield* scope.ownerOf(threadId), Option.none());
        // A paused tracker still tracks; it only stops being woken.
        assert.isTrue(yield* scope.isTracked(release, threadId));
      }),
    ),
  );

  it.effect("checks rule targets against uncommitted grant writes", () =>
    withScope(
      Effect.gen(function* () {
        const scope = yield* SquireScope.SquireScope;
        const repository = yield* SquireRepository.SquireRepository;
        const threadId = ThreadId.make("thread:rule-target");
        yield* seed([squireRow(release)], [grantRow(release, "project", projectA)]);
        yield* createThread(threadId, projectA);
        const projectTarget = {
          squireId: release,
          targetKind: "project",
          targetId: projectA,
        } as const;
        const threadTarget = {
          squireId: release,
          targetKind: "thread",
          targetId: threadId,
        } as const;
        assert.isTrue(yield* scope.ruleTargetInScope(projectTarget));
        assert.isTrue(yield* scope.ruleTargetInScope(threadTarget));
        // A container rule names a granted container, not one that merely holds the thread.
        assert.isFalse(
          yield* scope.ruleTargetInScope({
            ...projectTarget,
            targetKind: "staveSpace",
            targetId: "space-a",
          }),
        );

        yield* repository.transaction(
          Effect.gen(function* () {
            yield* repository.deleteGrant({
              squireId: release,
              kind: "project",
              targetId: projectA,
            });
            assert.isFalse(yield* scope.ruleTargetInScope(projectTarget));
            assert.isFalse(yield* scope.ruleTargetInScope(threadTarget));
          }),
        );
      }),
    ),
  );
});

describe("SquireContainers live layer", () => {
  const stave = (info: Partial<StaveProjectInfo>): StaveProjectInfo => ({
    spaceId: "space",
    isSaga: false,
    repos: [],
    memories: [],
    state: "live",
    ...info,
  });
  const shells: Record<string, StaveProjectInfo | null> = {
    [projectA]: stave({ spaceId: "space-a", memberOf: "saga-1" }),
    [projectB]: stave({ spaceId: "saga-1", isSaga: true }),
    "project:plain": null,
  };
  const live = SquireContainers.layer.pipe(
    Layer.provide(SquireSwitch.layerTest(true)),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getShell: (projectId) =>
          projectId === projectUnknown
            ? Effect.fail(
                new ProjectService.ProjectOperationError({
                  operation: "read-project",
                  projectId,
                  cause: new Error("stave read failed"),
                }),
              )
            : Effect.succeed(
                projectId in shells
                  ? Option.some({
                      id: projectId,
                      stave: shells[projectId],
                    } as OrchestrationProjectShell)
                  : Option.none(),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
        latestApplicationSequence: Effect.succeed(0),
        streamApplicationEvents: () => Stream.never,
      }),
    ),
  );

  it.effect("reads spaces and sagas from project shells and reports read failures as unknown", () =>
    Effect.gen(function* () {
      const containers = yield* SquireContainers.SquireContainers;
      assert.deepStrictEqual(yield* containers.ofProject(projectA), {
        status: "known",
        spaceId: "space-a",
        sagaId: "saga-1",
      });
      // A saga's own coordinating space is inside the saga.
      assert.deepStrictEqual(yield* containers.ofProject(projectB), {
        status: "known",
        spaceId: "saga-1",
        sagaId: "saga-1",
      });
      for (const projectId of ["project:plain", "project:missing"]) {
        assert.deepStrictEqual(yield* containers.ofProject(ProjectId.make(projectId)), {
          status: "known",
          spaceId: null,
          sagaId: null,
        });
      }
      assert.deepStrictEqual(yield* containers.ofProject(projectUnknown), { status: "unknown" });
    }).pipe(Effect.provide(live)),
  );
});
