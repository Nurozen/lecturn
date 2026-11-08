/**
 * The reactor, delivery, and timers across modules: the server's switch-on Squire layer over a
 * real orchestrator, with the scripted provider on the home thread and the
 * Squire command allowlist registered.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  RuntimeRequestId,
  NodeId,
  SquireCreateInput,
  type SquireId,
  ThreadId,
  type ThreadPullRequestSnapshot,
} from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as SquireClock from "./SquireClock.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import * as SquireFakeScripts from "./SquireFakeScripts.ts";
import * as SquireLifecycle from "./SquireLifecycle.ts";
import * as SquireReactor from "./SquireReactor.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import {
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { type Phase4Options, type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";

const homeProject = ProjectId.make("project-home");
const tracked = ThreadId.make("thread-tracked");
const decodeCreateInput = Schema.decodeSync(SquireCreateInput);

/** Switch-on services exist only when the switch built them, as at the server's startup. */
const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

type Restart = (
  options?: Phase4Options,
) => <A, E>(effect: Effect.Effect<A, E, Phase4Services | Scope.Scope>) => Effect.Effect<A, E>;

/** A Lecturn home with a Release Squire tracking the home project and one user thread in it. */
const withHome = <A, E>(
  body: (home: {
    readonly squireId: SquireId;
    readonly homeThreadId: ThreadId;
    readonly restart: Restart;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    const restart: Restart =
      (options = {}) =>
      (effect) =>
        effect.pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir, options)), Effect.orDie);
    const squire = yield* restart()(
      Effect.gen(function* () {
        yield* seedProject(homeProject, initRepo(`${root}/home-project`));
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${tracked}:create`),
          threadId: tracked,
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
        const service = yield* need(SquireService.SquireService);
        return yield* service.create(
          decodeCreateInput({
            requestId: "release",
            homeProjectId: homeProject,
            providerInstanceId: scripted,
            modelSelection: scriptedModel,
            name: "Release",
            brief: "Release brief.",
            grants: [{ kind: "project", targetId: homeProject }],
            events: {},
            permissions: {},
            budgets: {},
          }),
        );
      }),
    );
    return yield* body({ squireId: squire.id, homeThreadId: squire.homeThreadId!, restart });
  }).pipe(Effect.scoped);

/** Home-thread turns complete with a short reply. */
const scriptHome = (homeThreadId: ThreadId) =>
  Effect.flatMap(SquireFakeScripts.SquireFakeScripts, (fakes) =>
    fakes.set(homeThreadId, { [SquireFakeScripts.ANY_KIND]: [{ assistantText: "Noted." }] }),
  );

/** Waits until the reactor passed everything committed and delivery went idle. */
const settle = Effect.gen(function* () {
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const reactor = yield* need(SquireReactor.SquireReactor);
  const delivery = yield* need(SquireDelivery.SquireDelivery);
  yield* reactor.drainThrough(yield* events.latestApplicationSequence);
  yield* delivery.drain;
});

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

/** Drives the effect worker until the matching run on the thread ends. */
const runToEnd = (threadId: ThreadId, matches: (run: OrchestrationV2Run) => boolean) =>
  Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const runOf = Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
      projection.runs.find(matches),
    );
    let afterSequence = 0;
    for (;;) {
      yield* worker.drain();
      const run = yield* runOf;
      if (run !== undefined && TERMINAL.has(run.status)) return run;
      const next = yield* orchestrator
        .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
        .pipe(Stream.runHead);
      afterSequence = Option.getOrThrow(next).sequence;
    }
  });

const userTurn = (threadId: ThreadId, key: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${threadId}:turn:${key}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${key}`),
      text: 'Fix the rounding.\n```scripted\n[{"assistantText":"Fixed."}]\n```',
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }),
  );

/** The tracked thread's turn, run to its end. */
const trackedTurn = (key: string) =>
  userTurn(tracked, key).pipe(
    Effect.andThen(runToEnd(tracked, (run) => run.userMessageId === `message:${tracked}:${key}`)),
  );

const squireMessages = (homeThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(homeThreadId);
    return projection.messages.filter((message) => message.id.startsWith("message:squire:"));
  });

const homeRunOf = (homeThreadId: ThreadId, message: OrchestrationV2ConversationMessage) =>
  runToEnd(homeThreadId, (run) => run.userMessageId === message.id);

const rows = (squireId: SquireId) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    return yield* repository.listEventsByStatus({
      squireId,
      statuses: ["pending", "batched", "delivered", "dropped"],
    });
  });

const deferredRows = Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
  repository.listEvents({ statuses: ["deferred"] }),
);

const startServer = ServerRuntimeStartup.startLecturnReactors;

// ── Synthesized events (PR sync and provider requests are not scripted here) ──

let counter = 0;
const eventId = () => EventId.make(`event:squire-phase4:${++counter}`);
const write = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) => sink.write({ events }));

const prEvent = (
  headSha: string,
  checksState: ThreadPullRequestSnapshot["checksState"],
  now: DateTime.Utc,
): OrchestrationV2DomainEvent => ({
  id: eventId(),
  type: "thread.pull-request-link-updated",
  threadId: tracked,
  occurredAt: now,
  payload: {
    host: "github.com",
    repository: "acme/billing-service",
    number: 321,
    url: "https://github.com/acme/billing-service/pull/321",
    source: "created",
    linkedAt: "2026-11-01T10:00:00.000Z",
    snapshot: {
      state: "open",
      title: "Fix invoice rounding",
      headBranch: "fix/rounding",
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-11-01T11:59:00.000Z",
      syncedAt: "2026-11-01T12:00:00.000Z",
      checksState,
      mergeability: "unknown",
      headSha,
    },
    stack: null,
  },
});

/** A provider's approval request on a thread, as its adapter would commit it. */
const pendingApproval = (
  threadId: ThreadId,
  runId: OrchestrationV2Run["id"],
  requestId: string,
  now: DateTime.Utc,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const nodeId = NodeId.make(`node:${requestId}`);
  return [
    {
      id: eventId(),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: `item:${requestId}`,
        threadId,
        runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: counter,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: "Run rm -rf build?",
      } as OrchestrationV2TurnItem,
    },
    {
      id: eventId(),
      type: "runtime-request.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make(requestId),
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    },
  ];
};

/** Resolves once the deferred rows number `count`; a repository change re-checks. */
const awaitDeferred = (count: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      const changes = yield* repository.subscribeChanges;
      if ((yield* deferredRows).length >= count) return;
      yield* changes.pipe(
        Stream.mapEffect(() => deferredRows),
        Stream.filter((found) => found.length >= count),
        Stream.runHead,
      );
    }),
  );

/** Resolves on the next committed message on the thread after `afterSequence`. */
const awaitMessageAfter = (threadId: ThreadId, afterSequence: number) =>
  Effect.flatMap(OrchestrationEventStore.OrchestrationEventStore, (events) =>
    events.streamApplicationEvents({ afterSequence }).pipe(
      Stream.filter(
        (stored) =>
          "event" in stored &&
          stored.event.type === "message.updated" &&
          stored.event.threadId === threadId,
      ),
      Stream.runHead,
    ),
  );

describe("Squire reactor and delivery integration", () => {
  it.effect(
    "the reactor, delivery, and clock exist whatever the switch says, so it flips live",
    () =>
      withHome(({ restart }) =>
        Effect.gen(function* () {
          const present = Effect.gen(function* () {
            return [
              Option.isSome(yield* Effect.serviceOption(SquireReactor.SquireReactor)),
              Option.isSome(yield* Effect.serviceOption(SquireDelivery.SquireDelivery)),
              Option.isSome(yield* Effect.serviceOption(SquireClock.SquireClock)),
            ];
          });
          assert.deepStrictEqual(yield* restart()(present), [true, true, true]);
          assert.deepStrictEqual(yield* restart({ squireEnabled: false })(present), [
            true,
            true,
            true,
          ]);
        }),
      ),
  );

  it.effect("the Squire clock ticks on the runtime's Scheduler and builds none of its own", () =>
    withHome(({ restart }) =>
      Effect.gen(function* () {
        const registered: Array<string> = [];
        const scheduler = Layer.succeed(
          Scheduler.Scheduler,
          Scheduler.Scheduler.of({
            register: (name) => Effect.sync(() => void registered.push(name)),
          }),
        );
        yield* restart({ scheduler })(Effect.serviceOption(SquireClock.SquireClock));
        assert.deepStrictEqual(registered, ["squire"]);
      }),
    ),
  );

  it.effect("(i) a tracked turn is one delivered batch on the home thread and no card", () =>
    withHome(({ squireId, homeThreadId, restart }) =>
      restart()(
        Effect.gen(function* () {
          yield* scriptHome(homeThreadId);
          yield* startServer;
          const turn = yield* trackedTurn("1");
          assert.strictEqual(turn.status, "completed");
          yield* settle;

          const [message, ...rest] = yield* squireMessages(homeThreadId);
          assert.lengthOf(rest, 0);
          assert.strictEqual(message!.createdBy, "agent");
          assert.deepStrictEqual(message!.notification?.source, {
            kind: "squire",
            squireId,
            eventCount: 1,
            eventKinds: ["turn-finished"],
          });
          assert.include(message!.text, "Fix invoice rounding");

          const home = yield* homeRunOf(homeThreadId, message!);
          assert.strictEqual(home.status, "completed");
          yield* settle;
          assert.deepStrictEqual(
            (yield* rows(squireId)).map((row) => `${row.kind}:${row.status}`),
            ["turn-finished:delivered"],
          );
          const repository = yield* SquireRepository.SquireRepository;
          assert.lengthOf(yield* repository.listCards({ squireId }), 0);
          assert.lengthOf(yield* squireMessages(homeThreadId), 1);
        }),
      ),
    ),
  );

  it.effect("(ii) compaction before ingest keeps fail, pass, fail on three heads: 3 rows", () =>
    withHome(({ squireId, restart }) =>
      restart()(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* write([prEvent("sha1", "failing", now)]);
          yield* write([prEvent("sha2", "passing", now)]);
          yield* write([prEvent("sha3", "failing", now)]);
          const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          yield* maintenance.compactEventStore();
          yield* startServer;
          yield* settle;
          const prKey = "github.com/acme/billing-service#321";
          const keys = [...(yield* rows(squireId)), ...(yield* deferredRows)].map(
            (row) => row.state_key,
          );
          assert.sameMembers(keys, [
            `${prKey}:sha1:checks:failed`,
            `${prKey}:sha2:checks:passed`,
            `${prKey}:sha3:checks:failed`,
          ]);
        }),
      ),
    ),
  );

  it.effect("(iii) a turn committed with the switch off is never delivered", () =>
    withHome(({ squireId, homeThreadId, restart }) =>
      Effect.gen(function* () {
        yield* restart({ squireEnabled: false })(
          Effect.gen(function* () {
            yield* startServer;
            yield* trackedTurn("while-off");
          }),
        );
        yield* restart()(
          Effect.gen(function* () {
            yield* startServer;
            yield* settle;
            assert.lengthOf(yield* rows(squireId), 0);
            assert.lengthOf(yield* deferredRows, 0);
            assert.lengthOf(yield* squireMessages(homeThreadId), 0);
          }),
        );
      }),
    ),
  );

  it.effect("(iv) restarts before delivery and mid-batch deliver one home-thread message", () =>
    withHome(({ squireId, homeThreadId, restart }) =>
      Effect.gen(function* () {
        // The summary model never answers, so the row waits on it when the server stops.
        yield* restart({ generateSquireTurnSummary: () => Effect.never })(
          Effect.gen(function* () {
            yield* startServer;
            yield* trackedTurn("1");
            // The reactor is sequential: a row for a later run means the
            // cursor already passed the first run's end.
            yield* trackedTurn("2");
            yield* awaitDeferred(2);
          }),
        );
        const delivered = yield* restart()(
          Effect.gen(function* () {
            yield* startServer;
            yield* settle;
            assert.lengthOf(yield* squireMessages(homeThreadId), 0);
            assert.lengthOf(yield* deferredRows, 2);
            // The summary wait runs out; the clock promotes the rows.
            const events = yield* OrchestrationEventStore.OrchestrationEventStore;
            const head = yield* events.latestApplicationSequence;
            yield* TestClock.adjust("21 seconds");
            yield* awaitMessageAfter(homeThreadId, head);
            yield* settle;
            const messages = yield* squireMessages(homeThreadId);
            assert.lengthOf(messages, 1);
            assert.deepStrictEqual(messages[0]!.notification?.source, {
              kind: "squire",
              squireId,
              eventCount: 2,
              eventKinds: ["turn-finished", "turn-finished"],
            });
            return messages[0]!;
          }),
        );
        const [batched, ...others] = yield* restart()(rows(squireId));
        assert.strictEqual(batched!.status, "batched");
        assert.isTrue(others.every((row) => row.batch_id === batched!.batch_id));
        assert.strictEqual(
          delivered.id,
          SquireDelivery.deliverMessageId("event", batched!.batch_id!),
        );
        // Mid-batch: the batch is re-dispatched under the same command id.
        for (let start = 0; start < 2; start++) {
          yield* restart()(
            Effect.gen(function* () {
              yield* startServer;
              yield* settle;
            }),
          );
        }
        const after = yield* restart()(
          Effect.gen(function* () {
            return { messages: yield* squireMessages(homeThreadId), rows: yield* rows(squireId) };
          }),
        );
        assert.deepStrictEqual(
          after.messages.map((message) => message.id),
          [delivered.id],
        );
        assert.strictEqual(after.rows[0]!.batch_id, batched!.batch_id);
      }),
    ),
  );

  it.effect("(v) delivery, the home run end, and auto-decline all pass the allowlist", () =>
    withHome(({ squireId, homeThreadId, restart }) =>
      restart()(
        Effect.gen(function* () {
          yield* scriptHome(homeThreadId);
          yield* startServer;
          yield* trackedTurn("1");
          yield* settle;
          const [message] = yield* squireMessages(homeThreadId);
          assert.isDefined(message);
          const home = yield* homeRunOf(homeThreadId, message!);
          assert.strictEqual(home.status, "completed");
          yield* settle;
          assert.deepStrictEqual(
            (yield* rows(squireId)).map((row) => row.status),
            ["delivered"],
          );

          // An approval raised on the home thread is declined through the hook.
          yield* write(pendingApproval(homeThreadId, home.id, "req-approve", yield* DateTime.now));
          yield* settle;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const request = yield* projections.getRuntimeRequest(
            homeThreadId,
            RuntimeRequestId.make("req-approve"),
          );
          assert.include(request, { status: "resolved", decision: "decline" });
          const repository = yield* SquireRepository.SquireRepository;
          const decisions = yield* repository.listActionLog({
            squireId,
            kinds: ["decision.recorded"],
            limit: 10,
          });
          assert.lengthOf(decisions, 1);

          // The hook is live: the same delivery outside Squire's origin is refused.
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const refused = yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("server:squire:deliver:forged"),
              threadId: homeThreadId,
              messageId: MessageId.make("message:squire:event:forged"),
              text: "forged",
              attachments: [],
              notification: message!.notification!,
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
            })
            .pipe(Effect.flip);
          assert.strictEqual(refused._tag, "OrchestratorCommandRejectedError");
        }),
      ),
    ),
  );

  it.effect("(vi) a summary model that never answers delivers partial after 20 s", () =>
    withHome(({ squireId, homeThreadId, restart }) =>
      restart({ generateSquireTurnSummary: () => Effect.never })(
        Effect.gen(function* () {
          yield* startServer;
          yield* trackedTurn("1");
          yield* awaitDeferred(1);
          assert.lengthOf(yield* squireMessages(homeThreadId), 0);
          const events = yield* OrchestrationEventStore.OrchestrationEventStore;
          const head = yield* events.latestApplicationSequence;
          yield* TestClock.adjust("21 seconds");
          yield* awaitMessageAfter(homeThreadId, head);
          // Delivery does not wait for the summary call, which is still running.
          yield* (yield* need(SquireDelivery.SquireDelivery)).drain;
          const [message, ...rest] = yield* squireMessages(homeThreadId);
          assert.lengthOf(rest, 0);
          assert.include(message!.text, "partial summary");
          assert.deepStrictEqual(
            (yield* rows(squireId)).map((row) => row.status),
            ["batched"],
          );
        }),
      ),
    ),
  );

  it.effect("a deleted home thread re-homes through the lifecycle the reactor reads", () =>
    withHome(({ squireId, homeThreadId, restart }) =>
      restart()(
        Effect.gen(function* () {
          yield* startServer;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* withSquireDispatchOrigin(
            orchestrator.dispatch({
              type: "thread.delete",
              commandId: CommandId.make("test:delete-home"),
              threadId: homeThreadId,
            }),
          );
          yield* settle;
          const repository = yield* SquireRepository.SquireRepository;
          const row = Option.getOrThrow(yield* repository.getSquire(squireId));
          assert.strictEqual(row.home_generation, 2);
          assert.strictEqual(row.home_thread_id, SquireLifecycle.homeThreadIdFor(squireId, 2));
        }),
      ),
    ),
  );
});
