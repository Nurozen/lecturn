/**
 * The fixture seam and fixture mode (4.7, 4.8) over the server's switch-on
 * Squire layer, a real orchestrator, and the scripted provider.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  RunId,
  RuntimeRequestId,
  SQUIRE_LEAD_COMPANION,
  type SquireEvent,
  SquireCompanion,
  SquireCreateInput,
  SquireFakeScript,
  SquireFixtureScenario,
  type SquireId,
  type ThreadId,
} from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as StaveSpaceLock from "../stave/StaveSpaceLock.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireDevFixtures from "./SquireDevFixtures.ts";
import * as SquireFakeScripts from "./SquireFakeScripts.ts";
import { squireCardRowFields } from "./SquireItems.ts";
import * as SquireReactor from "./SquireReactor.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireSummaries from "./SquireSummaries.ts";
import { SquireEventPayloadJson } from "./squireEvents.ts";
import { initRepo, scripted, scriptedModel, tempRoot } from "./testkit/lifecycleHarness.ts";
import { type Phase4Options, type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";
import fake00Json from "./testdata/fake/00-lead-onboarding.json" with { type: "json" };
import fake03Json from "./testdata/fake/03-waiting-on-user-nudge.json" with { type: "json" };
import scenario01Json from "./testdata/scenarios/01-ci-failure-recommend.json" with { type: "json" };
import scenario03Json from "./testdata/scenarios/03-waiting-on-user-nudge.json" with { type: "json" };
import scenario04Json from "./testdata/scenarios/04-budget-exhausted-downgrade.json" with { type: "json" };
import scenario06Json from "./testdata/scenarios/06-voice-steer.json" with { type: "json" };
import scenario07Json from "./testdata/scenarios/07-overlap-risk.json" with { type: "json" };

const decodeScenario = Schema.decodeUnknownSync(SquireFixtureScenario);
const scenario01 = decodeScenario(scenario01Json);
const scenario03 = decodeScenario(scenario03Json);
const scenario04 = decodeScenario(scenario04Json);
const scenario06 = decodeScenario(scenario06Json);
const scenario07 = decodeScenario(scenario07Json);
const decodeCreateInput = Schema.decodeUnknownSync(SquireCreateInput);
const decodeCompanion = Schema.decodeUnknownSync(Schema.fromJsonString(SquireCompanion));
const decodeFakeScript = Schema.decodeUnknownSync(SquireFakeScript);
const fake03 = decodeFakeScript(fake03Json);
const fake00 = decodeFakeScript(fake00Json);
const decodeCompanionValue = Schema.decodeUnknownSync(SquireCompanion);
const decodePayload = Schema.decodeUnknownSync(SquireEventPayloadJson);

const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);
const fixtures = need(SquireDevFixtures.SquireDevFixtures);

/** A fresh Lecturn home with the switch and test providers on. */
const inHome = <A, E>(
  body: Effect.Effect<A, E, Phase4Services | Scope.Scope>,
  options: Phase4Options = {},
  seed?: (root: string) => Effect.Effect<void, never, Phase4Services>,
) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    return yield* Effect.gen(function* () {
      if (seed) yield* seed(root);
      return yield* body;
    }).pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir, options)), Effect.orDie);
  }).pipe(Effect.scoped);

const startServer = ServerRuntimeStartup.startLecturnReactors;

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

/** Drives the effect worker until the matching run on the thread ends. */
const runToEnd = (threadId: ThreadId, matches: (run: OrchestrationV2Run) => boolean) =>
  Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    let afterSequence = 0;
    for (;;) {
      yield* worker.drain();
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs.find(matches);
      if (run !== undefined && TERMINAL.has(run.status)) return run;
      const next = yield* orchestrator
        .streamStoredEventsFrom({ threadId, afterSequence })
        .pipe(Stream.runHead);
      afterSequence = Option.getOrThrow(next).sequence;
    }
  });

/** The reactor passed everything committed and delivery went idle. */
const settle = Effect.gen(function* () {
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  yield* (yield* need(SquireReactor.SquireReactor)).drainThrough(
    yield* events.latestApplicationSequence,
  );
  yield* (yield* need(SquireDelivery.SquireDelivery)).drain;
});

const allRows = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.listEventsByStatus({
      squireId,
      statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
    }),
  );

const threadRows = (threadId: ThreadId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.listEvents({
      threadId,
      statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
    }),
  );

const questionCards = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.listCards({ squireId, kinds: ["question"] }),
  );

const homeMessages = (homeThreadId: ThreadId) =>
  Effect.gen(function* () {
    const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
      homeThreadId,
    );
    return projection.messages.filter((message) => message.id.startsWith("message:squire:"));
  });

/** Home-thread turns complete with a short reply. */
const scriptHome = (homeThreadId: ThreadId | null) =>
  Effect.flatMap(SquireFakeScripts.SquireFakeScripts, (fakes) =>
    fakes.set(homeThreadId!, { [SquireFakeScripts.ANY_KIND]: [{ assistantText: "Noted." }] }),
  );

const waitingEvent = scenario03.events[0]! as Extract<SquireEvent, { type: "waiting-on-user" }>;
const planThread = waitingEvent.summary.threadId;

/** The real request a waiting row names. */
const requestOf = (sequence: number) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const [row] = yield* repository.listEvents({
      ids: [sequence],
      statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
    });
    const payload = decodePayload(row!.payload_json);
    return {
      runId: payload.runId!,
      requestId: RuntimeRequestId.make(payload.pendingRequest!.requestId),
    };
  });

const answer = (threadId: ThreadId, requestId: RuntimeRequestId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`test:answer:${requestId}`),
      threadId,
      requestId,
      answers: { answer: "Offline-only" },
    }),
  );

describe("SquireDevFixtures (4.7, 4.8)", () => {
  it("keys the first step per kind, tolerates refusals, and fills {{event.*}} per event", () => {
    const script = decodeFakeScript({
      steps: [
        {
          onEvent: "waiting-on-user",
          toolCalls: [
            {
              name: "squire_notify",
              args: {
                threadId: "{{event.summary.threadId}}",
                message: "Waiting {{event.waitingMinutes}} min",
              },
            },
          ],
        },
        { onEvent: "*", hold: true },
        { onEvent: "turn-finished", toolCalls: [{ name: "squire_stay_quiet", args: {} }] },
      ],
    });
    const set = SquireDevFixtures.squireFakeScriptSet(script);
    assert.deepStrictEqual(Object.keys(set), ["waiting-on-user", "*"]);
    assert.deepStrictEqual(set["*"], [{ hold: true }]);
    assert.deepStrictEqual(set["waiting-on-user"], [
      {
        toolCall: {
          name: "squire_notify",
          arguments: {
            threadId: "{{event.summary.threadId}}",
            message: "Waiting {{event.waitingMinutes}} min",
          },
        },
        onError: "continue",
      },
    ]);
    assert.deepStrictEqual(
      SquireDevFixtures.fillSquireFakeScript(set["waiting-on-user"]!, waitingEvent),
      [
        {
          toolCall: {
            name: "squire_notify",
            arguments: { threadId: planThread, message: "Waiting 45 min" },
          },
          onError: "continue",
        },
      ],
    );
  });

  it.effect("askUser raises a real user_input request that runtime-request.respond resolves", () =>
    inHome(
      Effect.gen(function* () {
        const service = yield* fixtures;
        yield* service.loadSetup(scenario03.setup);
        const sequence = yield* service.inject(waitingEvent);
        const { runId, requestId } = yield* requestOf(sequence);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const pending = yield* projections.getRuntimeRequest(planThread, requestId);
        assert.include(pending, { kind: "user_input", status: "pending" });
        const { item } = yield* projections.getRuntimeResponseContext(planThread, requestId);
        assert.strictEqual(item?.type, "user_input_request");

        yield* answer(planThread, requestId);
        const run = yield* runToEnd(planThread, (candidate) => candidate.id === runId);
        assert.strictEqual(run.status, "completed");
        const resolved = yield* projections.getRuntimeRequest(planThread, requestId);
        assert.strictEqual(resolved?.status, "resolved");
      }),
    ),
  );

  it.effect("loadSetup is idempotent, never reuses a real project, and never pauses the Lead", () =>
    inHome(
      Effect.gen(function* () {
        const service = yield* fixtures;
        const squires = yield* need(SquireService.SquireService);
        const lead = Option.getOrThrow(yield* squires.ensureLead({ requestId: "user" }));

        const first = yield* service.loadSetup(scenario04.setup);
        const second = yield* service.loadSetup(scenario04.setup);
        assert.strictEqual(second.squireId, first.squireId);
        assert.deepStrictEqual(second.projects, first.projects);

        const repository = yield* SquireRepository.SquireRepository;
        const rows = yield* repository.listSquires;
        assert.deepStrictEqual(rows.map((row) => row.name).toSorted(), ["Lead", "Release"]);
        assert.strictEqual(Option.getOrThrow(yield* repository.getLead).status, "active");
        assert.strictEqual(Option.getOrThrow(yield* repository.getLead).id, lead.id);
        // The seeded usage was replaced, not added to.
        const usage = yield* repository.listBudgetUsage({
          squireId: first.squireId,
          since: "1970-01-01T00:00:00.000Z",
        });
        assert.lengthOf(usage, 10);

        const real = ProjectId.make("project-real-observatory");
        assert.notStrictEqual(first.projects["Observatory"], real);
        const projects = yield* ProjectStore.ProjectStoreV2;
        const fixtureProject = Option.getOrThrow(
          yield* projects.get(first.projects["Observatory"]!),
        );
        const { baseDir } = yield* ServerConfig.ServerConfig;
        assert.isTrue(SquireReactor.isFixtureWorkspaceRoot(baseDir, fixtureProject.workspaceRoot));
        const grants = yield* repository.listGrants(first.squireId);
        assert.sameMembers(
          grants.map((grant) => grant.target_id),
          [first.projects["billing-service"]!, first.projects["Observatory"]!],
        );
        const thread = (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(
          scenario04.setup.threads![0]!.threadId,
        ))!;
        assert.strictEqual(thread.projectId, first.projects["billing-service"]);
        assert.isTrue(yield* SquireReactor.isFixtureOwnedThread(thread.id));
      }),
      {},
      (root) =>
        Effect.flatMap(ProjectService.ProjectService, (projects) =>
          projects.create({
            commandId: CommandId.make("test:real-observatory"),
            projectId: ProjectId.make("project-real-observatory"),
            title: "Observatory",
            workspaceRoot: initRepo(`${root}/real-observatory`),
          }),
        ).pipe(Effect.asVoid, Effect.orDie),
    ),
  );

  it.effect("loadSetup stores 04's and 06's steer Auto straight on the record", () =>
    inHome(
      Effect.gen(function* () {
        const service = yield* fixtures;
        const repository = yield* SquireRepository.SquireRepository;
        for (const scenario of [scenario04, scenario06]) {
          const { squireId } = yield* service.loadSetup(scenario.setup);
          const row = Option.getOrThrow(yield* repository.getSquire(squireId));
          assert.strictEqual(JSON.parse(row.permissions_json).steer, "auto");
          assert.strictEqual(row.create_request_id, "fixture:Release");
        }
      }),
    ),
  );

  it.effect("--set undoWindowSeconds lands on the reused Squire's record, which holds read", () =>
    inHome(
      Effect.gen(function* () {
        const service = yield* fixtures;
        const repository = yield* SquireRepository.SquireRepository;
        const undoWindowOf = (squireId: SquireId) =>
          Effect.map(
            repository.getSquire(squireId),
            (row) => Option.getOrThrow(row).undo_window_seconds,
          );
        const first = yield* service.loadSetup(scenario04.setup);
        assert.strictEqual(yield* undoWindowOf(first.squireId), 10);
        const again = yield* service.loadSetup(scenario04.setup, {
          set: { undoWindowSeconds: 60 },
        });
        assert.strictEqual(again.squireId, first.squireId);
        assert.strictEqual(yield* undoWindowOf(first.squireId), 60);
      }),
    ),
  );

  it.effect.each([
    { reactor: "ahead of", reactorAhead: true },
    { reactor: "behind", reactorAhead: false },
  ])(
    "scenario 03 with the reactor $reactor inject delivers one event and one question card",
    ({ reactorAhead }) =>
      inHome(
        Effect.gen(function* () {
          if (reactorAhead) yield* startServer;
          const service = yield* fixtures;
          const loaded = yield* service.loadSetup(scenario03.setup);
          yield* scriptHome(loaded.homeThreadId);
          const original = yield* service.inject(scenario03.events[0]!);
          const duplicate = yield* service.inject(scenario03.events[1]!);
          assert.strictEqual(duplicate, original);
          if (!reactorAhead) yield* startServer;
          yield* service.drainThrough(duplicate);

          const rows = yield* allRows(loaded.squireId);
          assert.deepStrictEqual(
            rows.map((row) => `${row.kind}:${row.status}`),
            ["waiting-on-user:delivered"],
          );
          assert.lengthOf(yield* questionCards(loaded.squireId), 1);
          const [message, ...rest] = yield* homeMessages(loaded.homeThreadId!);
          assert.lengthOf(rest, 0);
          assert.include(message!.text, "Yale Bright Star API");
          assert.lengthOf(yield* threadRows(planThread), 1);
        }),
      ),
  );

  it.effect("a duplicate inject's drainThrough waits while the original's turn is held", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const open = yield* Deferred.make<void>();
      const gate = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(open)));
      yield* inHome(
        Effect.gen(function* () {
          yield* startServer;
          const service = yield* fixtures;
          const loaded = yield* service.loadSetup(scenario03.setup);
          yield* scriptHome(loaded.homeThreadId);
          const original = yield* service.inject(scenario03.events[0]!);
          const duplicate = yield* service.inject(scenario03.events[1]!);
          assert.strictEqual(duplicate, original);
          const draining = yield* service.drainThrough(duplicate).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          // The batch is out and its turn is held: the row cannot settle before the gate opens.
          assert.isUndefined(draining.pollUnsafe());
          assert.deepStrictEqual(
            (yield* allRows(loaded.squireId)).map((row) => row.status),
            ["batched"],
          );
          yield* Deferred.succeed(open, undefined);
          yield* Fiber.join(draining);
          assert.deepStrictEqual(
            (yield* allRows(loaded.squireId)).map((row) => row.status),
            ["delivered"],
          );
        }),
        { deliveryGate: gate },
      );
    }),
  );

  it.effect("each batch fills {{event.*}} from its own events; a refused call ends nothing", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const open = yield* Deferred.make<void>();
      const gate = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(open)));
      const prFake = decodeFakeScript({
        schemaVersion: 2,
        steps: [
          {
            onEvent: "pull-request-changed",
            toolCalls: [
              {
                name: "squire_recommend_steer",
                args: { pr: "{{event.summary.pullRequest.number}}" },
              },
            ],
          },
        ],
      });
      yield* inHome(
        Effect.gen(function* () {
          yield* startServer;
          const service = yield* fixtures;
          const loaded = yield* service.loadSetup(scenario01.setup, { fake: prFake });
          const first = scenario01.events[0]! as Extract<
            SquireEvent,
            { type: "pull-request-changed" }
          >;
          const second = {
            ...first,
            summary: {
              ...first.summary,
              turnId: RunId.make("t_44"),
              pullRequest: { ...first.summary.pullRequest!, number: 319, headSha: "4b7d0a2" },
            },
          };
          const one = yield* service.inject(first);
          // Batch 318 is out; 319 arrives before its turn reads its script.
          yield* (yield* need(SquireDelivery.SquireDelivery)).drain;
          const two = yield* service.inject(second);
          const draining = yield* service.drainThrough(one).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Deferred.succeed(open, undefined);
          yield* Fiber.join(draining);
          yield* service.drainThrough(two);

          const home = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
            loaded.homeThreadId!,
          );
          assert.deepStrictEqual(
            home.turnItems.flatMap((item) =>
              item.type === "dynamic_tool" ? [[item.input, item.status]] : [],
            ),
            [
              [{ pr: 318 }, "failed"],
              [{ pr: 319 }, "failed"],
            ],
          );
          assert.deepStrictEqual(
            home.runs.map((run) => run.status),
            ["completed", "completed"],
          );
        }),
        { deliveryGate: gate },
      );
    }),
  );

  it.effect("an injected PR event leaves a real fixture link and a completed run", () =>
    inHome(
      Effect.gen(function* () {
        yield* startServer;
        const service = yield* fixtures;
        const loaded = yield* service.loadSetup(scenario01.setup);
        yield* scriptHome(loaded.homeThreadId);
        const event = scenario01.events[0]! as Extract<
          SquireEvent,
          { type: "pull-request-changed" }
        >;
        const threadId = event.summary.threadId;
        const sequence = yield* service.inject(event);
        yield* service.drainThrough(sequence);

        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const [linked] = yield* projections.getThreadsWithPullRequests(threadId);
        const link = linked!.pullRequests!.find((entry) => entry.number === 318)!;
        assert.strictEqual(link.host, "fixture.invalid");
        assert.include(link.snapshot, {
          headSha: "9f2c4e1",
          state: "open",
          checksState: "failing",
          reviewDecision: "approved",
        });

        const [row] = yield* threadRows(threadId);
        assert.strictEqual(
          row!.state_key,
          "fixture.invalid/billing-service#318:9f2c4e1:checks:failed",
        );
        const runId = decodePayload(row!.payload_json).runId!;
        const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
        assert.strictEqual(runs.find((run) => run.id === runId)?.status, "completed");

        // The summary is stored complete with no payer, keyed by the real run.
        const repository = yield* SquireRepository.SquireRepository;
        const summary = Option.getOrThrow(
          yield* repository.getSummary({ thread_id: threadId, run_id: runId, stage: "terminal" }),
        );
        assert.strictEqual(summary.status, "complete");
        assert.isNull(summary.payer_squire_id);
        assert.include(JSON.parse(summary.summary_json), {
          goal: event.summary.goal,
          turnId: runId,
        });

        // A turn event on the same thread gets its own completed run.
        const turn = yield* service.inject({
          type: "turn-finished",
          summary: { ...event.summary, turnId: RunId.make("t_44") },
        });
        yield* service.drainThrough(turn);
        const turnRow = (yield* threadRows(threadId)).find((entry) => entry.id === turn)!;
        const { runs: after } = yield* projections.getThreadRecords(threadId, ["runs"]);
        assert.strictEqual(after.find((run) => run.id === turnRow.state_key)?.status, "completed");
        assert.strictEqual(turnRow.status, "delivered");
      }),
    ),
  );

  it.effect(
    "answering a fixture request lets its run finish with no provider call and no row",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        yield* inHome(
          Effect.gen(function* () {
            yield* startServer;
            const service = yield* fixtures;
            const loaded = yield* service.loadSetup(scenario03.setup);
            yield* scriptHome(loaded.homeThreadId);
            const sequence = yield* service.inject(waitingEvent);
            yield* service.drainThrough(sequence);
            const { runId, requestId } = yield* requestOf(sequence);
            yield* answer(planThread, requestId);
            const run = yield* runToEnd(planThread, (candidate) => candidate.id === runId);
            assert.strictEqual(run.status, "completed");
            yield* settle;
            assert.lengthOf(yield* threadRows(planThread), 1);
            assert.strictEqual(yield* Ref.get(calls), 0);
            const repository = yield* SquireRepository.SquireRepository;
            assert.isTrue(
              Option.isNone(
                yield* repository.getSummary({
                  thread_id: planThread,
                  run_id: runId,
                  stage: "terminal",
                }),
              ),
            );
          }),
          {
            generateSquireTurnSummary: () =>
              Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(Effect.never)),
          },
        );
      }),
  );

  it.effect(
    "summary stages: the question card keeps its provisional summary; turn-finished renders the terminal one",
    () =>
      inHome(
        Effect.gen(function* () {
          yield* startServer;
          const service = yield* fixtures;
          const loaded = yield* service.loadSetup(scenario03.setup, { fake: fake03 });
          // The harness home has no MCP session: the fake's call is recorded as refused and the turn goes on.
          const sequence = yield* service.inject(waitingEvent);
          yield* service.drainThrough(sequence);
          const { runId, requestId } = yield* requestOf(sequence);
          const [card] = yield* questionCards(loaded.squireId);
          const trigger = JSON.parse(card!.trigger_json) as { runId: string; requestId: string };
          assert.deepStrictEqual(trigger, { runId, requestId });
          // "waiting <age>" counts from the ask (backdated by the fixture), not from the card.
          const { requestedAt } = squireCardRowFields(card!) as { requestedAt?: string };
          assert.isDefined(requestedAt);
          assert.approximately(
            Date.parse(card!.created_at) - Date.parse(requestedAt!),
            waitingEvent.waitingMinutes * 60_000,
            60_000,
          );

          yield* answer(planThread, requestId);
          yield* runToEnd(planThread, (candidate) => candidate.id === runId);
          yield* settle;
          const repository = yield* SquireRepository.SquireRepository;
          assert.strictEqual(
            Option.getOrThrow(yield* repository.getCard(card!.id)).status,
            "resolved",
          );
          const summaries = yield* need(SquireSummaries.SquireSummaries);
          const provisional = Option.getOrThrow(
            yield* summaries.read({
              threadId: planThread,
              runId: RunId.make(trigger.runId),
              stage: `request:${trigger.requestId}`,
            }),
          );
          assert.strictEqual(provisional.status, "complete");
          assert.deepStrictEqual(provisional.summary, { ...waitingEvent.summary, turnId: runId });

          const finished = yield* service.inject({
            type: "turn-finished",
            summary: {
              ...waitingEvent.summary,
              outcome: "finished",
              completed: ["Chose the offline-only catalog"],
              pendingQuestion: null,
            },
          });
          yield* service.drainThrough(finished);
          const messages = yield* homeMessages(loaded.homeThreadId!);
          assert.lengthOf(messages, 2);
          assert.include(messages[0]!.text, "Yale Bright Star API");
          assert.notInclude(messages[0]!.text, "Chose the offline-only catalog");
          assert.include(messages[1]!.text, "Chose the offline-only catalog");
          // Same run: the terminal summary sits beside the provisional one.
          const [, terminalRow] = yield* threadRows(planThread);
          assert.strictEqual(terminalRow!.state_key, runId);
        }),
      ),
  );
  it.effect("a fixture reuses the user's Squire of its name, changing only what it names", () =>
    inHome(
      Effect.gen(function* () {
        const service = yield* fixtures;
        const squires = yield* need(SquireService.SquireService);
        const repository = yield* SquireRepository.SquireRepository;
        const realProject = ProjectId.make("project-real-research");
        const user = yield* squires.create(
          decodeCreateInput({
            requestId: "user:research",
            homeProjectId: realProject,
            providerInstanceId: scripted,
            modelSelection: scriptedModel,
            name: "Research",
            brief: "Mine.",
            grants: [{ kind: "project", targetId: realProject }],
            events: {},
            permissions: { steer: "auto" },
            budgets: {},
            companion: { equipment: "grimoire", palette: "cobalt" },
          }),
        );

        const loaded = yield* service.loadSetup(scenario07.setup);
        assert.strictEqual(loaded.squires["Research"], user.id);
        const rows = yield* repository.listSquires;
        assert.deepStrictEqual(rows.map((row) => row.name).toSorted(), ["Release", "Research"]);
        const row = Option.getOrThrow(yield* repository.getSquire(user.id));
        assert.notStrictEqual(row.create_request_id, "fixture:Research");
        assert.strictEqual(row.brief, "Mine.");
        // The fixture's companion and permissions sections apply; its scope does not.
        const fixtureResearch = scenario07.setup.squires![0]!;
        assert.deepStrictEqual(decodeCompanion(row.companion_json), fixtureResearch.companion);
        assert.strictEqual(JSON.parse(row.permissions_json).steer, "recommend");
        assert.deepStrictEqual(
          (yield* repository.listGrants(user.id)).map((grant) => grant.target_id),
          [realProject],
        );

        yield* service.loadSetup(scenario07.setup, { set: { "squires.0.brief": "From --set." } });
        assert.strictEqual(
          Option.getOrThrow(yield* repository.getSquire(user.id)).brief,
          "From --set.",
        );
        assert.lengthOf(
          (yield* repository.listSquires).filter((entry) => entry.name === "Research"),
          1,
        );
      }),
      {},
      (root) =>
        Effect.flatMap(ProjectService.ProjectService, (projects) =>
          projects.create({
            commandId: CommandId.make("test:real-research"),
            projectId: ProjectId.make("project-real-research"),
            title: "Research home",
            workspaceRoot: initRepo(`${root}/real-research`),
          }),
        ).pipe(Effect.asVoid, Effect.orDie),
    ),
  );

  it.effect(
    "the Lead, Release, Research, and Steward differ in appearance, hood, and equipment",
    () =>
      inHome(
        Effect.gen(function* () {
          const service = yield* fixtures;
          const squires = yield* need(SquireService.SquireService);
          const repository = yield* SquireRepository.SquireRepository;
          // B1 order: Release from the step 1-4 fixtures, then Research from 07.
          const release = (yield* service.loadSetup(scenario01.setup)).squireId;
          const lead = Option.getOrThrow(yield* squires.ensureLead({ requestId: "lead" }));
          const research = (yield* service.loadSetup(scenario07.setup)).squires["Research"]!;
          const companionOf = (id: SquireId) =>
            Effect.map(repository.getSquire(id), (row) =>
              decodeCompanion(Option.getOrThrow(row).companion_json),
            );
          const records = {
            Lead: yield* companionOf(lead.id),
            Release: yield* companionOf(release),
            Research: yield* companionOf(research),
          };
          // The Lead's onboarding proposals, as the fake script names them.
          const proposed = Object.fromEntries(
            (fake00.steps[0]!.toolCalls ?? []).map((call) => {
              const args = call.args as { name: string; companion: unknown };
              return [args.name, decodeCompanionValue(args.companion)];
            }),
          );
          const look = (companion: SquireCompanion) => `${companion.appearance}/${companion.hood}`;
          const four = [records.Lead, records.Release, records.Research, proposed["Steward"]!];
          const looks = four.map(look);
          assert.strictEqual(new Set(looks).size, 4, looks.join(", "));
          const equipment = four.map((companion) => companion.equipment);
          assert.strictEqual(new Set(equipment).size, 4, equipment.join(", "));
          assert.strictEqual(records.Lead.equipment, SQUIRE_LEAD_COMPANION.equipment);
          // A proposal accepted from onboarding looks like the fixture's Squire of that name.
          assert.strictEqual(look(proposed["Release"]!), look(records.Release));
          assert.strictEqual(look(proposed["Research"]!), look(records.Research));
          assert.strictEqual(proposed["Release"]!.equipment, records.Release.equipment);
          assert.strictEqual(proposed["Research"]!.equipment, records.Research.equipment);
          for (const companion of [records.Release, records.Research, ...Object.values(proposed)]) {
            assert.notInclude(["gold", "brass"], companion.palette);
            assert.notStrictEqual(companion.equipment, records.Lead.equipment);
            assert.strictEqual(companion.presence, "figure");
          }
        }),
      ),
  );

  it.effect("a fixture that names no companion leaves the Squire's as it is", () =>
    inHome(
      Effect.gen(function* () {
        const service = yield* fixtures;
        const squires = yield* need(SquireService.SquireService);
        const repository = yield* SquireRepository.SquireRepository;
        assert.isUndefined(scenario04.setup.companion);
        const { squireId } = yield* service.loadSetup(scenario04.setup);
        const before = Option.getOrThrow(yield* repository.getSquire(squireId));
        const chosen = { ...decodeCompanion(before.companion_json), equipment: "lance" as const };
        yield* squires.update({
          requestId: "user:companion",
          squireId,
          expectedRevision: before.revision,
          companion: chosen,
        });

        yield* service.loadSetup(scenario04.setup);
        const companionOf = Effect.map(repository.getSquire(squireId), (row) =>
          decodeCompanion(Option.getOrThrow(row).companion_json),
        );
        assert.deepStrictEqual(yield* companionOf, chosen);
        // `--set companion.*` changes only the field it names.
        yield* service.loadSetup(scenario04.setup, { set: { "companion.hood": "up" } });
        assert.deepStrictEqual(yield* companionOf, { ...chosen, hood: "up" });
      }),
    ),
  );

  it.effect("03 re-runs on a reset home: a settled request's turn gets fresh ids", () =>
    inHome(
      Effect.gen(function* () {
        yield* startServer;
        const service = yield* fixtures;
        const first = yield* service.loadSetup(scenario03.setup);
        yield* scriptHome(first.homeThreadId);
        const before = yield* requestOf(yield* service.inject(waitingEvent));
        yield* answer(planThread, before.requestId);
        yield* runToEnd(planThread, (run) => run.id === before.runId);
        yield* service.reset(scenario03.setup.squire!.name);

        const again = yield* service.loadSetup(scenario03.setup);
        yield* scriptHome(again.homeThreadId);
        const sequence = yield* service.inject(waitingEvent);
        const after = yield* requestOf(sequence);
        assert.notStrictEqual(after.runId, before.runId);
        assert.notStrictEqual(after.requestId, before.requestId);
        const request = yield* (yield* ProjectionStore.ProjectionStoreV2).getRuntimeRequest(
          planThread,
          after.requestId,
        );
        assert.strictEqual(request?.status, "pending");
        // A duplicate inject in the same load still finds this turn.
        assert.strictEqual(yield* service.inject(scenario03.events[1]!), sequence);
      }),
    ),
  );

  it.effect("inject waits out a short Stave operation in its project", () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      const refused = yield* Deferred.make<void>();
      yield* inHome(
        Effect.gen(function* () {
          const service = yield* fixtures;
          const locks = yield* StaveSpaceLock.StaveSpaceLock;
          const projects = yield* ProjectStore.ProjectStoreV2;
          const loaded = yield* service.loadSetup(scenario07.setup);
          const event = scenario07.events[1]! as Extract<SquireEvent, { type: "turn-finished" }>;
          const project = Option.getOrThrow(
            yield* projects.get(ProjectId.make(loaded.projects["billing-service"]!)),
          );
          const release = yield* Deferred.make<void>();
          const holding = yield* Deferred.make<void>();
          yield* locks
            .withSpaceLock(
              project.workspaceRoot,
              Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(holding);
          const injecting = yield* service.inject(event).pipe(Effect.forkChild);
          yield* Deferred.await(waiting);
          yield* Deferred.succeed(release, undefined);
          const sequence = yield* Fiber.join(injecting);

          assert.isFalse(yield* Deferred.isDone(refused));
          const [row] = yield* threadRows(event.summary.threadId);
          assert.strictEqual(row!.id, sequence);
          const { runs } = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
            event.summary.threadId,
            ["runs"],
          );
          assert.deepStrictEqual(
            runs.map((run) => run.status),
            ["completed"],
          );
        }),
        {
          staveSpaceLock: {
            onWaiting: Deferred.succeed(waiting, undefined).pipe(Effect.asVoid),
            onRefused: Deferred.succeed(refused, undefined).pipe(Effect.asVoid),
          },
        },
      );
    }),
  );

  it.effect("inject waits out a finished turn whose checkpoint another worker holds", () =>
    inHome(
      Effect.gen(function* () {
        const service = yield* fixtures;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        // The harness keeps its outbox private; this one shares its database rows.
        const outbox = yield* Effect.provide(
          Effect.service(EffectOutbox.EffectOutboxV2),
          EffectOutbox.layer,
        );
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* service.loadSetup(scenario07.setup);
        const event = scenario07.events[1]! as Extract<SquireEvent, { type: "turn-finished" }>;
        const { threadId, turnId } = event.summary;
        const runOf = Effect.map(projections.getThreadRecords(threadId, ["runs"]), ({ runs }) =>
          runs.find((run) => run.userMessageId === `message:fixture:${threadId}:${turnId}`),
        );
        // The turn the fixture would start, finished up to its checkpoint capture.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`test:turn:${turnId}`),
          threadId,
          messageId: MessageId.make(`message:fixture:${threadId}:${turnId}`),
          text: `${event.summary.goal}.\n\`\`\`scripted\n[{"assistantText":"Formatters refactored."}]\n\`\`\``,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "system",
          creationSource: "server",
        });
        let afterSequence = 0;
        const nextEvent = Effect.gen(function* () {
          const next = yield* orchestrator
            .streamStoredEventsFrom({ threadId, afterSequence })
            .pipe(Stream.runHead);
          afterSequence = Option.getOrThrow(next).sequence;
        });
        // Effects run only until the provider turn is under way, so none of
        // them can be the capture its end enqueues.
        while ((yield* runOf)?.status !== "running") {
          if ((yield* worker.drain(1)) === 0) yield* nextEvent;
        }
        while ((yield* runOf)?.status !== "waiting") yield* nextEvent;
        const runId = (yield* runOf)!.id;
        // The live effect daemon holds the capture, so the fixture's own drain finds nothing.
        const held = Option.getOrThrow(
          yield* outbox.claimNext({ workerId: "daemon", leaseDurationMs: 3_600_000 }),
        );
        assert.strictEqual(held.id, `effect:checkpoint.capture:${runId}`);

        const injecting = yield* service.inject(event).pipe(Effect.forkChild);
        yield* outbox.defer({ effectId: held.id, workerId: "daemon", reason: "test", delayMs: 0 });
        yield* worker.drain();
        const sequence = yield* Fiber.join(injecting);

        const run = (yield* runOf)!;
        assert.strictEqual(run.status, "completed");
        assert.isNotNull(run.checkpointId);
        const [row] = yield* threadRows(threadId);
        assert.strictEqual(row!.id, sequence);
        assert.strictEqual(row!.state_key, runId);
      }),
    ),
  );
});
