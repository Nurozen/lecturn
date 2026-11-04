/**
 * "Ask about this" over the server's Squire stack: a real
 * orchestrator with the scripted provider, the command allowlist, the real
 * provider session manager and `McpSessionRegistry`, and the gated `/mcp`.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2StoredEvent,
  ProjectId,
  SquireCardAsk,
  SquireCardId,
  SquireCreateInput,
  type SquireError,
  type SquireId,
  ThreadId,
} from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as SquireFakeScripts from "./SquireFakeScripts.ts";
import { probeForkCommandId, probeThreadIdFor, SquireProbe } from "./SquireProbe.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import * as SquireReactor from "./SquireReactor.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import { type BarServices, barLayer } from "./testkit/barHarness.ts";
import { connectMcp } from "./testkit/boundMcp.ts";
import {
  cursor,
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { phase4Layer, type Phase4Options, type Phase4Services } from "./testkit/phase4Harness.ts";

const project = ProjectId.make("project-probe");
const source = ThreadId.make("thread-probe-source");
const cardId = SquireCardId.make("card:probe:steer");
const decodeCreateInput = Schema.decodeSync(SquireCreateInput);
const decodeAsk = Schema.decodeUnknownSync(Schema.fromJsonString(SquireCardAsk));
const encodeAsk = Schema.encodeSync(Schema.fromJsonString(SquireCardAsk));

const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

const createThread = (threadId: ThreadId, instanceId = scripted) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: project,
      title: "Fix invoice rounding",
      modelSelection: { instanceId, model: "scripted" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

/** Drives the effect worker until a run on the thread reaches a terminal status. */
const runEnds = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    let afterSequence = 0;
    for (;;) {
      yield* worker.drain();
      const next = Option.getOrThrow(
        yield* orchestrator
          .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
          .pipe(Stream.runHead),
      );
      if (next.event.type === "run.updated" && TERMINAL.has(next.event.payload.status)) return;
      afterSequence = next.sequence;
    }
  });

/** The reactor passed everything committed, its forked work settled, and the worker is idle. */
const settle = Effect.gen(function* () {
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const reactor = yield* need(SquireReactor.SquireReactor);
  yield* reactor.drainThrough(yield* events.latestApplicationSequence);
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
});

const threadEvents = (threadId: ThreadId) =>
  Effect.flatMap(OrchestrationEventStore.OrchestrationEventStore, (events) =>
    events.readAgentEvents({ threadId }).pipe(Stream.runCollect),
  ).pipe(Effect.map((all): ReadonlyArray<OrchestrationV2StoredEvent> => [...all]));

const askOf = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const card = Option.getOrThrow(yield* repository.getCard(cardId));
  return card.ask_json === null ? null : decodeAsk(card.ask_json);
});

/** A tracked thread with one finished turn, a Squire, and an open card on that thread. */
const setUp = (sourceInstance = scripted) =>
  Effect.gen(function* () {
    const { root } = yield* tempRoot;
    yield* ServerRuntimeStartup.startLecturnReactors;
    yield* seedProject(project, initRepo(`${root}/project`));
    yield* createThread(source, sourceInstance);
    if (sourceInstance === scripted) {
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${source}:turn`),
        threadId: source,
        messageId: MessageId.make(`message:${source}:turn`),
        text: 'Fix the rounding.\n```scripted\n[{"assistantText":"Fixed."}]\n```',
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* runEnds(source);
    }
    // Past the source's turn before the Squire exists, so its home gets no delivery.
    yield* settle;
    const squire = yield* (yield* need(SquireService.SquireService)).create(
      decodeCreateInput({
        requestId: "release",
        homeProjectId: project,
        providerInstanceId: scripted,
        modelSelection: scriptedModel,
        name: "Release",
        brief: "Release brief.",
        grants: [{ kind: "project", targetId: project }],
        events: {},
        permissions: {},
        budgets: {},
      }),
    );
    const fakes = yield* SquireFakeScripts.SquireFakeScripts;
    yield* fakes.set(squire.homeThreadId!, {
      [SquireFakeScripts.ANY_KIND]: [{ assistantText: "Noted." }],
    });
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* (yield* SquireRepository.SquireRepository).insertCard({
      id: cardId,
      squire_id: squire.id,
      owner_squire_id: squire.id,
      kind: "steer",
      status: "open",
      target_thread_id: source,
      project_id: project,
      title: "Rebase onto main",
      why: "",
      payload_json: "{}",
      evidence_json: "{}",
      trigger_json: "{}",
      intent_json: null,
      origin: "event",
      steer_kind: null,
      routed_task_id: null,
      rule_id: null,
      finding_key: null,
      escalate_at: null,
      opened_at: null,
      executes_at: null,
      attempt: 0,
      command_id: null,
      execution_key: null,
      dedupe_key: null,
      replaced_count: 0,
      ask_json: null,
      resolution: null,
      created_at: now,
      updated_at: now,
    });
    yield* settle;
    return { squireId: squire.id as SquireId, homeThreadId: squire.homeThreadId! };
  });

const ask = (requestId: string, question = "Where does rounding happen?") =>
  Effect.flatMap(need(SquireProbe), (probe) => probe.ask({ requestId, cardId, question }));

const withBar = <A, E>(body: Effect.Effect<A, E, BarServices | Scope.Scope>) =>
  Effect.gen(function* () {
    const { baseDir } = yield* tempRoot;
    return yield* body.pipe(Effect.scoped, Effect.provide(barLayer(baseDir)));
  }).pipe(Effect.scoped, Effect.orDie);

const withPhase4 = <A, E>(
  options: Phase4Options,
  body: Effect.Effect<A, E, Phase4Services | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const { baseDir } = yield* tempRoot;
    return yield* body.pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir, options)));
  }).pipe(Effect.scoped, Effect.orDie);

const refusalOf = <A, R>(effect: Effect.Effect<A, SquireError, R>) => Effect.flip(effect);

describe("SquireProbe", () => {
  it.live(
    "answers from a marked read-only fork with no MCP, then deletes it; source and home untouched",
    () =>
      withBar(
        Effect.gen(function* () {
          const { squireId, homeThreadId } = yield* setUp();
          const requestId = "ask-1";
          const probeId = probeThreadIdFor(cardId, requestId);
          const registry = yield* need(McpSessionRegistry.McpSessionRegistry);
          // A credential that already exists for the probe's id must not survive its session.
          const { config: stale } = yield* registry.issue({
            threadId: probeId,
            providerInstanceId: scripted,
          });
          yield* (yield* SquireFakeScripts.SquireFakeScripts).set(probeId, {
            [SquireFakeScripts.ANY_KIND]: [
              { toolCall: { name: "lecturn_thread_send", arguments: {} }, onError: "continue" },
              { assistantText: "Rounding happens in invoice.ts." },
            ],
          });
          const sourceBefore = (yield* threadEvents(source)).length;
          const homeBefore = (yield* threadEvents(homeThreadId)).length;

          const started = yield* ask(requestId);
          assert.equal(started.ask.status, "running");
          assert.equal(started.ask.requestId, requestId);

          const probe = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(probeId);
          assert.deepEqual(probe.squire, { squireId, role: "probe" });
          assert.equal(probe.runtimeMode, "approval-required");
          assert.equal(probe.interactionMode, "default");
          assert.deepEqual(probe.pullRequests ?? [], []);
          assert.equal(probe.lineage.parentThreadId, source);

          // The marked-thread allowlist: outside Squire modules, the probe takes no lifecycle command.
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const archived = yield* Effect.exit(
            orchestrator.dispatch({
              type: "thread.archive",
              commandId: CommandId.make("client:archive-probe"),
              threadId: probeId,
            }),
          );
          assert.isTrue(Exit.isFailure(archived));

          yield* runEnds(probeId);
          yield* settle;

          const answered = yield* askOf;
          assert.equal(answered?.status, "answered");
          assert.equal(answered?.answer, "Rounding happens in invoice.ts.");

          const probeEvents = yield* threadEvents(probeId);
          assert.isTrue(probeEvents.some((stored) => stored.event.type === "thread.deleted"));
          assert.isFalse(probeEvents.some((stored) => stored.event.type === "thread.archived"));
          const tool = probeEvents.flatMap((stored) =>
            stored.event.type === "turn-item.updated" &&
            stored.event.payload.type === "dynamic_tool"
              ? [stored.event.payload]
              : [],
          );
          assert.deepEqual(
            tool.at(-1) && { name: tool.at(-1)!.toolName, status: tool.at(-1)!.status },
            { name: "lecturn.lecturn_thread_send", status: "failed" },
          );

          // No MCP: the session manager revoked the credential and issued none.
          assert.isUndefined(
            yield* registry.resolve(stale.authorizationHeader.replace(/^Bearer\s+/, "")),
          );
          const client = yield* Effect.promise(() => connectMcp(stale));
          const call = yield* Effect.promise(() =>
            client.callTool("lecturn_thread_send", { threadId: source, message: "hi" }),
          );
          assert.equal(call.status, 401);

          assert.equal((yield* threadEvents(source)).length, sourceBefore);
          assert.equal((yield* threadEvents(homeThreadId)).length, homeBefore);
        }),
      ),
  );

  it.live("a retried ask forks once and returns the same answer", () =>
    withBar(
      Effect.gen(function* () {
        yield* setUp();
        const probeId = probeThreadIdFor(cardId, "ask-retry");
        yield* (yield* SquireFakeScripts.SquireFakeScripts).set(probeId, {
          [SquireFakeScripts.ANY_KIND]: [{ assistantText: "In invoice.ts." }],
        });
        const first = yield* ask("ask-retry");
        const second = yield* ask("ask-retry");
        assert.deepEqual(second.ask, first.ask);
        yield* runEnds(probeId);
        yield* settle;
        const third = yield* ask("ask-retry");
        assert.equal(third.ask.status, "answered");
        assert.equal(third.ask.answer, "In invoice.ts.");
        const created = (yield* threadEvents(probeId)).filter(
          (stored) => stored.event.type === "thread.created",
        );
        assert.equal(created.length, 1);
      }),
    ),
  );

  it.live("startup resumes an ask a crash left between the fork and its message", () =>
    withBar(
      Effect.gen(function* () {
        const { squireId } = yield* setUp();
        const requestId = "ask-crash";
        const probeId = probeThreadIdFor(cardId, requestId);
        yield* (yield* SquireFakeScripts.SquireFakeScripts).set(probeId, {
          [SquireFakeScripts.ANY_KIND]: [{ assistantText: "Still in invoice.ts." }],
        });
        // What `ask` had committed when the server died: the running ask and the fork.
        const repository = yield* SquireRepository.SquireRepository;
        const askedAt = DateTime.formatIso(yield* DateTime.now);
        yield* repository.updateCard({
          id: cardId,
          fromStatuses: ["open"],
          patch: {
            ask_json: encodeAsk({
              requestId,
              question: "Where does rounding happen?",
              status: "running",
              answer: null,
              error: null,
              askedAt,
            }),
          },
          updatedAt: askedAt,
        });
        yield* withSquireDispatchOrigin(
          (yield* Orchestrator.OrchestratorV2).dispatch({
            type: "thread.fork",
            commandId: probeForkCommandId(cardId, requestId),
            sourceThreadId: source,
            targetThreadId: probeId,
            sourcePoint: { type: "latest_stable" },
            title: "Ask about this",
            squireProbe: { squireId },
            createdBy: "system",
            creationSource: "server",
          }),
        );

        yield* (yield* need(SquireProbe)).reconcileStartup;
        yield* runEnds(probeId);
        yield* settle;

        const answered = yield* askOf;
        assert.equal(answered?.status, "answered");
        assert.equal(answered?.answer, "Still in invoice.ts.");
        const probeEvents = yield* threadEvents(probeId);
        assert.equal(
          probeEvents.filter((stored) => stored.event.type === "thread.created").length,
          1,
        );
        assert.isTrue(probeEvents.some((stored) => stored.event.type === "thread.deleted"));
      }),
    ),
  );

  it.live("is refused when thread forking is off", () =>
    withPhase4(
      { threadForkingEnabled: false },
      Effect.gen(function* () {
        yield* setUp();
        const error = yield* refusalOf(ask("ask-off"));
        assert.equal(error?.code, "not_available");
        assert.isNull(yield* askOf);
        assert.deepEqual(yield* threadEvents(probeThreadIdFor(cardId, "ask-off")), []);
      }),
    ),
  );

  it.live("is refused on a driver without probe support", () =>
    withPhase4(
      {},
      Effect.gen(function* () {
        yield* setUp(cursor);
        const error = yield* refusalOf(ask("ask-cursor"));
        assert.equal(error?.code, "provider_unsupported");
        assert.equal(error?.message, "Ask is not available for cursor.");
        assert.isNull(yield* askOf);
        assert.deepEqual(yield* threadEvents(probeThreadIdFor(cardId, "ask-cursor")), []);
      }),
    ),
  );
});
