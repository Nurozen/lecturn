import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  EventId,
  type OrchestrationEvent,
  type ServerSettings,
  type StaveLifecycleSettings,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig, layerTest as configLayerTest } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { StaveLifecycleRepositoryLive } from "../../persistence/Layers/StaveLifecycleRepository.ts";
import {
  StaveLifecycleRepository,
  type StaveLifecyclePatch,
} from "../../persistence/Services/StaveLifecycleRepository.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { StaveBinary, StaveBinaryNotFound } from "../../stave/StaveBinary.ts";
import { StaveCli } from "../../stave/StaveCli.ts";
import { StaveOperations } from "../../stave/StaveOperations.ts";
import { StaveSpaceLock } from "../../stave/StaveSpaceLock.ts";
import { StaveWorkspaceReader } from "../../stave/StaveWorkspaceReader.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadLifecycleAnchor,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { make } from "./StaveLifecycleService.ts";

const NOW = "2026-09-01T00:00:00.000Z";
const OLD = "2026-08-01T00:00:00.000Z";
const ID = ProjectId.make("lifecycle-project");
const PROJECT: OrchestrationProjectShell = {
  id: ID,
  title: "Space",
  workspaceRoot: "/space",
  defaultModelSelection: null,
  scripts: [],
  createdAt: OLD,
  updatedAt: OLD,
  stave: {
    spaceId: "space",
    createdAt: OLD,
    isSaga: false,
    state: "live",
    repos: [],
    memories: [],
  },
};
const ANCHOR: ProjectionThreadLifecycleAnchor = {
  threadId: ThreadId.make("thread"),
  createdAt: OLD,
  updatedAt: OLD,
  settledAt: OLD,
  unsettledAt: null,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
};
const persistence = StaveLifecycleRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const harness = Effect.fn(function* (
  options: {
    serverEnabled?: boolean;
    enabled?: boolean;
    binaryAvailable?: boolean;
    deleted?: boolean;
    saga?: boolean;
    policy?: Partial<StaveLifecycleSettings>;
  } = {},
) {
  yield* TestClock.setTime(Date.parse(NOW));
  const config = yield* ServerConfig.pipe(
    Effect.provide(
      configLayerTest("/space", { prefix: "t3-lifecycle-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  const repo = yield* StaveLifecycleRepository;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Ref.make<ServerSettings>({
    ...DEFAULT_SERVER_SETTINGS,
    stave: {
      ...DEFAULT_SERVER_SETTINGS.stave,
      enabled: options.enabled ?? true,
      lifecycle: {
        ...DEFAULT_SERVER_SETTINGS.stave.lifecycle,
        onAllThreadsSettled: "archive-after-grace",
        archiveGraceDays: 7,
        ...options.policy,
      },
    },
  });
  const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const activation = yield* Deferred.make<void>();
  const reads = yield* Queue.unbounded<void>();
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);
  const anchors = yield* Ref.make<ReadonlyArray<ProjectionThreadLifecycleAnchor>>([ANCHOR]);
  const projects = yield* Ref.make<ReadonlyArray<OrchestrationProjectShell>>(
    options.deleted
      ? []
      : [options.saga ? { ...PROJECT, stave: { ...PROJECT.stave!, isSaga: true } } : PROJECT],
  );
  const beforeValidate = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const onDrain = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const stamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at) VALUES (${ID}, 'Space', '/space', '[]', ${OLD}, ${OLD}, ${options.deleted ? NOW : null})`;
  yield* repo.ensure({
    projectId: ID,
    workspaceRoot: "/space",
    spaceId: "space",
    manifestCreatedAt: OLD,
    now: NOW,
  });
  const patch = (value: StaveLifecyclePatch) =>
    Effect.gen(function* () {
      const row = Option.getOrThrow(yield* repo.getByProjectId(ID));
      const now = yield* stamp;
      const held = Option.getOrThrow(
        yield* repo.acquireLease({
          projectId: ID,
          expectedEpoch: row.leaseEpoch,
          ownerToken: "test",
          now,
          leaseUntil: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 })),
        }),
      );
      const lease = { projectId: ID, leaseEpoch: held.leaseEpoch, ownerToken: "test", now };
      yield* repo.updateDisposition({ ...lease, patch: value });
      yield* repo.releaseLease(lease);
    });
  if (options.deleted)
    yield* patch({
      disposition: "pending_evaluation",
      deleteIntentSequence: 42,
      sagaRemoveConfirmed: true,
    });
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfig, { ...config, staveEnabled: options.serverEnabled ?? true }),
    Layer.succeed(StaveLifecycleRepository, repo),
    Layer.mock(ServerSettingsService)({
      getSettings: Ref.get(settings),
      subscribeChanges: PubSub.subscribe(settingsChanges).pipe(Effect.map(Stream.fromSubscription)),
    }),
    Layer.mock(StaveCli)({
      spaceStatus: () =>
        Effect.succeed({
          spaceId: "space",
          spacePath: "/space",
          repos: [],
          memories: [],
          manifest: {
            id: "space",
            createdAt: OLD,
            repos: [],
            memories: [],
            saga: { members: [{ id: "member", after: [], createdAt: OLD, prs: [] }] },
          },
        }),
    }),
    Layer.mock(StaveBinary)({
      resolve: Ref.update(calls, (all) => [...all, "resolve"]).pipe(
        Effect.andThen(
          options.binaryAvailable === false
            ? Effect.fail(new StaveBinaryNotFound({ candidates: ["/configured/missing"] }))
            : Effect.succeed({
                path: "/stave",
                source: "settings" as const,
                version: "0.4.0",
                commit: null,
              }),
        ),
      ),
    }),
    Layer.mock(StaveWorkspaceReader)({
      invalidate: () => Effect.void,
      load: () =>
        Ref.update(calls, (all) => [...all, "manifest"]).pipe(
          Effect.as(Option.some(PROJECT.stave!)),
        ),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Ref.get(projects).pipe(
          Effect.tap(() => Queue.offer(reads, undefined)),
          Effect.map((value) => ({
            snapshotSequence: 42,
            updatedAt: NOW,
            projects: value,
            threads: [],
          })),
        ),
      getProjectShellById: (id) =>
        Ref.get(projects).pipe(
          Effect.map((value) => Option.fromNullishOr(value.find((project) => project.id === id))),
        ),
      listThreadLifecycleAnchorsByProjectId: () => Ref.get(anchors),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: () => Effect.succeed({ sequence: 43 }),
      streamDomainEvents: Stream.fromPubSub(events),
    }),
    Layer.mock(ThreadDeletionReactor)({
      drainThrough: (seq) =>
        Ref.update(calls, (all) => [...all, `drain:${seq}`]).pipe(
          Effect.andThen(Ref.get(onDrain)),
          Effect.flatten,
        ),
    }),
    Layer.mock(StaveOperations)({
      executeLifecycle: (operation, validate, validateParticipant) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (all) => [...all, "operation"]);
          yield* yield* Ref.get(beforeValidate);
          yield* validate ?? Effect.die("Missing under-lease validation");
          if (options.saga && validateParticipant)
            for (const project of yield* Ref.get(projects)) yield* validateParticipant(project.id);
          yield* Ref.update(calls, (all) => [
            ...all,
            `disk:${operation.target}:${operation.force}:${operation.sagaRemoveConfirmed}`,
          ]);
          yield* patch({
            disposition: operation.target === "destroy" ? "destroyed" : "archived",
            deleteIntentSequence: null,
          }).pipe(Effect.orDie);
          yield* Ref.set(projects, []);
        }),
    }),
    Layer.succeed(StaveSpaceLock, { withSpaceLock: (_root, effect) => effect }),
    FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
  );
  const service = yield* make.pipe(Effect.provide(dependencies));
  return {
    repo,
    service,
    projects,
    calls,
    anchors,
    beforeValidate,
    onDrain,
    patch,
    reads,
    activation,
    events,
    freshService: make.pipe(Effect.provide(dependencies)),
    row: repo.getByProjectId(ID).pipe(Effect.map(Option.getOrThrow)),
    updateSettings: (enabled: boolean, policy: Partial<StaveLifecycleSettings> = {}) =>
      Ref.updateAndGet(settings, (current) => ({
        ...current,
        stave: { ...current.stave, enabled, lifecycle: { ...current.stave.lifecycle, ...policy } },
      })).pipe(Effect.tap((value) => PubSub.publish(settingsChanges, value))),
  };
});

const test = <E>(
  name: string,
  body: Effect.Effect<
    void,
    E,
    StaveLifecycleRepository | SqlClient.SqlClient | import("effect/Scope").Scope
  >,
) => it.effect(name, () => body.pipe(Effect.provide(persistence), Effect.scoped));

describe("StaveLifecycleService", () => {
  for (const options of [{ serverEnabled: false }, { enabled: false }, { binaryAvailable: false }])
    test(
      `is inert for ${JSON.stringify(options)}`,
      Effect.gen(function* () {
        const h = yield* harness({ ...options, deleted: true });
        const before = yield* h.row;
        yield* h.service.sweep;
        assert.deepEqual(yield* h.row, before);
        assert.deepEqual(
          yield* Ref.get(h.calls),
          options.binaryAvailable === false ? ["resolve"] : [],
        );
      }),
    );
  test(
    "recovers a durable delete intent after reprovision and drains deleted threads before cleanup",
    Effect.gen(function* () {
      const h = yield* harness({ deleted: true });
      const restarted = yield* h.freshService;
      yield* restarted.sweep;
      const calls = yield* Ref.get(h.calls);
      assert.isBelow(calls.indexOf("drain:42"), calls.indexOf("operation"));
      assert.include(calls, "disk:destroy:false:true");
      assert.equal((yield* h.row).disposition, "destroyed");
      yield* restarted.sweep;
      assert.equal((yield* Ref.get(h.calls)).filter((call) => call.startsWith("disk:")).length, 1);
    }),
  );
  test(
    "starts old settlements at a fresh grace period and preserves the deadline across restart",
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.sweep;
      const first = yield* h.row;
      assert.equal(first.scheduledAt, NOW);
      assert.equal(first.archiveDeadlineAt, "2026-09-08T00:00:00.000Z");
      yield* TestClock.adjust("1 day");
      const restarted = yield* h.freshService;
      yield* restarted.sweep;
      assert.equal((yield* h.row).archiveDeadlineAt, first.archiveDeadlineAt);
      assert.isFalse((yield* Ref.get(h.calls)).some((call) => call.startsWith("disk:")));
    }),
  );
  for (const anchors of [[], [{ ...ANCHOR, settledOverride: "active" as const }]])
    test(
      `cancels pending archives for ${anchors.length === 0 ? "no threads" : "active threads"}`,
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.service.sweep;
        yield* Ref.set(h.anchors, anchors);
        yield* h.service.sweep;
        const row = yield* h.row;
        assert.equal(row.disposition, "live");
        assert.equal(row.scheduledAt, null);
        assert.equal(row.archiveDeadlineAt, null);
      }),
    );
  test(
    "suggests without automatic disk work even at zero grace",
    Effect.gen(function* () {
      const h = yield* harness({ policy: { onAllThreadsSettled: "suggest", archiveGraceDays: 0 } });
      yield* h.service.sweep;
      assert.equal((yield* h.row).disposition, "pending_archive");
      assert.equal((yield* h.row).archiveDeadlineAt, null);
      assert.isFalse((yield* Ref.get(h.calls)).includes("operation"));
    }),
  );
  test(
    "archive mode acts immediately without Force",
    Effect.gen(function* () {
      const h = yield* harness({ policy: { onAllThreadsSettled: "archive" } });
      yield* h.service.sweep;
      assert.include(yield* Ref.get(h.calls), "disk:archive:false:false");
    }),
  );
  test(
    "Keep suppresses the current episode until its activity anchor moves",
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.sweep;
      yield* h.patch({ disposition: "kept" });
      yield* TestClock.adjust("8 days");
      yield* h.service.sweep;
      assert.equal((yield* h.row).disposition, "kept");
      yield* Ref.set(h.anchors, [{ ...ANCHOR, updatedAt: "2026-09-09T00:00:00.000Z" }]);
      yield* h.service.sweep;
      assert.equal((yield* h.row).disposition, "pending_archive");
      assert.equal((yield* h.row).scheduledAt, "2026-09-09T00:00:00.000Z");
    }),
  );
  test(
    "revalidates activity under the operation lease before touching disk",
    Effect.gen(function* () {
      const h = yield* harness({ policy: { onAllThreadsSettled: "archive" } });
      yield* Ref.set(h.beforeValidate, Ref.set(h.anchors, [{ ...ANCHOR, unsettledAt: NOW }]));
      yield* h.service.sweep;
      assert.include(yield* Ref.get(h.calls), "operation");
      assert.isFalse((yield* Ref.get(h.calls)).some((call) => call.startsWith("disk:")));
      assert.equal((yield* h.row).refusalCode, "space_transitioning");
    }),
  );
  test(
    "periodic sweeps run after activation and settings re-enable starts a fresh countdown",
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.start();
      assert.equal((yield* h.row).scheduledAt, null);
      yield* Deferred.succeed(h.activation, undefined);
      yield* Queue.take(h.reads);
      yield* h.service.drain;
      assert.equal((yield* h.row).scheduledAt, NOW);
      yield* h.updateSettings(false);
      yield* TestClock.adjust("1 minute");
      yield* h.service.drain;
      yield* h.updateSettings(true);
      yield* Queue.take(h.reads);
      yield* h.service.drain;
      assert.equal((yield* h.row).scheduledAt, "2026-09-01T00:01:00.000Z");
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(h.reads);
      yield* h.service.drain;
      assert.equal((yield* h.row).archiveDeadlineAt, "2026-09-08T00:01:00.000Z");
    }),
  );
  test(
    "does not resurrect cleanup when Keep wins during deleted-thread draining",
    Effect.gen(function* () {
      const h = yield* harness({ deleted: true });
      yield* Ref.set(
        h.onDrain,
        h.patch({ disposition: "kept", deleteIntentSequence: null }).pipe(Effect.orDie),
      );
      yield* h.service.sweep;
      assert.equal((yield* h.row).disposition, "kept");
      assert.isFalse((yield* Ref.get(h.calls)).some((call) => call.startsWith("disk:")));
    }),
  );
  test(
    "domain activity wakes the worker and cancels the schedule before the timer",
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.start();
      yield* Deferred.succeed(h.activation, undefined);
      yield* Queue.take(h.reads);
      yield* h.service.drain;
      yield* Ref.set(h.anchors, [{ ...ANCHOR, unsettledAt: NOW }]);
      yield* PubSub.publish(h.events, {
        type: "thread.unsettled",
        sequence: 43,
        eventId: EventId.make("activity"),
        aggregateKind: "thread",
        aggregateId: ANCHOR.threadId,
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId: ANCHOR.threadId, reason: "activity", updatedAt: NOW },
      });
      yield* Queue.take(h.reads);
      yield* h.service.drain;
      assert.equal((yield* h.row).scheduledAt, null);
    }),
  );
  test(
    "re-enable retains its reset for a leased project until the lease expires",
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.start();
      yield* Deferred.succeed(h.activation, undefined);
      yield* Queue.take(h.reads);
      yield* h.service.drain;
      const row = yield* h.row;
      yield* h.repo.acquireLease({
        projectId: ID,
        expectedEpoch: row.leaseEpoch,
        ownerToken: "other-operation",
        now: NOW,
        leaseUntil: "2026-09-01T00:03:00.000Z",
      });
      yield* h.updateSettings(false);
      yield* TestClock.adjust("1 minute");
      yield* h.service.drain;
      yield* h.updateSettings(true);
      yield* Queue.take(h.reads);
      yield* h.service.drain;
      assert.equal((yield* h.row).scheduledAt, NOW);
      yield* TestClock.adjust("2 minutes");
      yield* h.service.drain;
      yield* h.service.sweep;
      assert.equal((yield* h.row).scheduledAt, "2026-09-01T00:03:00.000Z");
    }),
  );
  test(
    "switching suggestions to automatic cleanup starts a fresh grace window",
    Effect.gen(function* () {
      const h = yield* harness({ policy: { onAllThreadsSettled: "suggest" } });
      yield* h.service.start();
      yield* Deferred.succeed(h.activation, undefined);
      yield* Queue.take(h.reads);
      yield* h.service.drain;
      yield* TestClock.adjust("8 days");
      yield* h.service.drain;
      yield* h.updateSettings(true, { onAllThreadsSettled: "archive-after-grace" });
      yield* Queue.take(h.reads);
      yield* h.service.drain;
      assert.equal((yield* h.row).scheduledAt, "2026-09-09T00:00:00.000Z");
      assert.equal((yield* h.row).archiveDeadlineAt, "2026-09-16T00:00:00.000Z");
      assert.isFalse((yield* Ref.get(h.calls)).some((call) => call.startsWith("disk:")));
    }),
  );
});

test(
  "automatic saga archive waits for each member schedule, Keep, and grace",
  Effect.gen(function* () {
    const h = yield* harness({ saga: true });
    const memberId = ProjectId.make("member");
    yield* Ref.update(h.projects, (projects) => [
      ...projects,
      {
        ...PROJECT,
        id: memberId,
        workspaceRoot: "/member",
        stave: { ...PROJECT.stave!, spaceId: "member" },
      },
    ]);
    yield* h.repo.ensure({
      projectId: memberId,
      workspaceRoot: "/member",
      spaceId: "member",
      manifestCreatedAt: OLD,
      now: NOW,
    });
    yield* h.service.sweep;
    yield* TestClock.adjust("7 days");
    let row = Option.getOrThrow(yield* h.repo.getByProjectId(memberId));
    const now = DateTime.formatIso(yield* DateTime.now);
    const lease = Option.getOrThrow(
      yield* h.repo.acquireLease({
        projectId: memberId,
        expectedEpoch: row.leaseEpoch,
        ownerToken: "member-keep",
        now,
        leaseUntil: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 })),
      }),
    );
    yield* h.repo.updateDisposition({
      projectId: memberId,
      leaseEpoch: lease.leaseEpoch,
      ownerToken: "member-keep",
      now,
      patch: { disposition: "kept" },
    });
    yield* h.repo.releaseLease({
      projectId: memberId,
      leaseEpoch: lease.leaseEpoch,
      ownerToken: "member-keep",
      now,
    });
    yield* h.service.sweep;
    assert.equal((yield* h.row).disposition, "pending_archive");
    assert.isFalse((yield* Ref.get(h.calls)).includes("operation"));
    row = Option.getOrThrow(yield* h.repo.getByProjectId(memberId));
    const nextLease = Option.getOrThrow(
      yield* h.repo.acquireLease({
        projectId: memberId,
        expectedEpoch: row.leaseEpoch,
        ownerToken: "member-reset",
        now,
        leaseUntil: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 })),
      }),
    );
    yield* h.repo.resetScheduleEpisode({
      projectId: memberId,
      leaseEpoch: nextLease.leaseEpoch,
      ownerToken: "member-reset",
      now,
      disposition: "pending_archive",
      anchorAt: OLD,
      scheduledAt: now,
      archiveDeadlineAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { days: 7 })),
    });
    yield* h.repo.releaseLease({
      projectId: memberId,
      leaseEpoch: nextLease.leaseEpoch,
      ownerToken: "member-reset",
      now,
    });
    yield* h.service.sweep;
    assert.equal((yield* h.row).disposition, "pending_archive");
    assert.isFalse((yield* Ref.get(h.calls)).includes("operation"));
  }),
);
