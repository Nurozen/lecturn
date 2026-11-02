import { assert, describe, it } from "@effect/vitest";
import {
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

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireScope from "./SquireScope.ts";
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
