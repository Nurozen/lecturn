/**
 * Held execution and accept under the durable action protocol on the
 * server's switch-on Squire layer over a real orchestrator, with the real
 * `ThreadManagementService`, `ThreadLaunchService`, and the command hook's
 * trigger precondition. A crash is the layer's scope closing; a restart builds it again over
 * the same Lecturn home.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  SquireCreateInput,
  SquireFakeScript,
  SquireFixtureScenario,
  type SquireCardId,
  type SquireId,
  SquireRuleId,
  ThreadId,
} from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SquireActions from "./SquireActions.ts";
import { decodeSquireActionIntent, isRoomOpenIntent } from "./squireActionIntent.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import * as SquireLaunchAction from "./SquireLaunchAction.ts";
import { isFixtureWorkspaceRoot } from "./SquireReactor.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRooms from "./SquireRooms.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import * as SquireRules from "./SquireRules.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireTools from "./SquireTools.ts";
import {
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { runBarScenario, withBarHarness } from "./testkit/barHarness.ts";
import { type Phase4Options, type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";
import {
  callTool as roomCallTool,
  currencyThread,
  deliver,
  invoiceThread,
  userTurn,
  withRoomCast,
} from "./testkit/roomHarness.ts";
import fake05 from "./testdata/fake/05-merged-propose-thread.json" with { type: "json" };
import scenario05 from "./testdata/scenarios/05-merged-propose-thread.json" with { type: "json" };

const homeProject = ProjectId.make("billing-service");
const tracked = ThreadId.make("thr_fix_invoice_rounding");
const second = ThreadId.make("thr_tax_rounding");
const decodeCreateInput = Schema.decodeSync(SquireCreateInput);

const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

interface Home {
  readonly squireId: SquireId;
  readonly homeThreadId: ThreadId;
}

type Body<A, E> = Effect.Effect<A, E, Phase4Services | Scope.Scope>;

// The server's 5 s backstop would run holds on its own as the test clock moves.
const noTicks = Layer.succeed(
  Scheduler.Scheduler,
  Scheduler.Scheduler.of({ register: () => Effect.void }),
);

/** One server lifetime over `baseDir`; its scope closing is a crash. */
const lifetime = <A, E>(baseDir: string, body: Body<A, E>, options: Phase4Options = {}) =>
  body.pipe(
    Effect.scoped,
    Effect.provide(phase4Layer(baseDir, { scheduler: noTicks, ...options })),
    Effect.orDie,
  );

const seed = (root: string) =>
  Effect.gen(function* () {
    yield* seedProject(homeProject, initRepo(`${root}/billing-service`));
    const threads = yield* ThreadManagement.ThreadManagementService;
    for (const [threadId, title] of [
      [tracked, "Fix invoice rounding"],
      [second, "Fix tax rounding"],
    ] as const) {
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: homeProject,
        title,
        modelSelection: scriptedModel,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    const squire = yield* (yield* need(SquireService.SquireService)).create(
      decodeCreateInput({
        requestId: "release",
        homeProjectId: homeProject,
        providerInstanceId: scripted,
        modelSelection: scriptedModel,
        name: "Release",
        brief: "",
        grants: [{ kind: "project", targetId: homeProject }],
        events: {},
        permissions: {},
        budgets: {},
      }),
    );
    const home = { squireId: squire.id, homeThreadId: squire.homeThreadId! } satisfies Home;
    yield* setPermissions(home.squireId, { steer: "auto", createThread: "auto" });
    yield* homeRun(home.homeThreadId);
    return home;
  });

/** Seeds a Squire with steer and create Auto, then runs `body` in the same lifetime. */
const withSquire = <A, E>(body: (home: Home) => Body<A, E>, options: Phase4Options = {}) =>
  Effect.gen(function* () {
    const { root, baseDir } = yield* tempRoot;
    return yield* lifetime(baseDir, Effect.flatMap(seed(root), body), options);
  }).pipe(Effect.scoped);

let runCounter = 0;
/** An event-origin run on the home thread, so tool calls read as event turns. */
const homeRun = (homeThreadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const key = `event-${++runCounter}`;
    yield* withSquireDispatchOrigin(
      threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`test:home:${key}`),
        threadId: homeThreadId,
        messageId: MessageId.make(`message:squire:event:${key}`),
        text: "Events.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
      }),
    );
  });

const setPermissions = (
  squireId: SquireId,
  permissions: { steer?: string; createThread?: string; notify?: string },
) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    yield* repository.updateSquire({
      id: squireId,
      patch: {
        permissions_json: JSON.stringify({
          steer: "recommend",
          createThread: "recommend",
          notify: "on",
          ...permissions,
        }),
      },
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

const seedUsage = (squireId: SquireId, count: number) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const now = yield* DateTime.now;
    for (let i = 0; i < count; i++) {
      yield* repository.insertBudgetUsage({
        squire_id: squireId,
        thread_id: tracked,
        kind: "steer",
        room_id: null,
        executed_at: DateTime.formatIso(DateTime.subtract(now, { hours: 3 })),
        execution_key: null,
      });
    }
  });

let steerCounter = 0;
const sendSteer = (home: Home, steer?: string, extra: Record<string, unknown> = {}) =>
  Effect.flatMap(need(SquireTools.SquireTools), (tools) =>
    tools.call(
      { squireId: home.squireId, role: "squire", threadId: home.homeThreadId },
      "squire_send_steer",
      {
        threadId: tracked,
        reason: "api-e2e failed on the rounding change.",
        steer: steer ?? `Rerun api-e2e and fix the rounding assertion (${++steerCounter}).`,
        ...extra,
      },
    ),
  );

const actions = need(SquireActions.SquireActions);
const executeDue = Effect.flatMap(actions, (service) => service.executeDue);
const reconcileStartup = Effect.flatMap(actions, (service) => service.reconcileStartup);
const act = (input: SquireActions.SquireActionsActInput) =>
  Effect.flatMap(actions, (service) => service.act(input));

const cardsOf = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.listCards({ squireId }),
  );
const cardOf = (cardId: SquireCardId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.getCard(cardId).pipe(Effect.map(Option.getOrThrow)),
  );
const onlyCard = (squireId: SquireId) =>
  Effect.map(cardsOf(squireId), (cards) => {
    assert.lengthOf(cards, 1);
    return cards[0]!;
  });

const logOf = (squireId: SquireId) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const rows = yield* repository.listActionLog({ squireId, limit: 500 });
    return rows.map((row) => ({ ...row, data: JSON.parse(row.data_json) as Record<string, any> }));
  });
const count = (log: ReadonlyArray<{ readonly kind: string }>, kind: string) =>
  log.filter((row) => row.kind === kind).length;

const budgetRows = (squireId: SquireId) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    repository.listBudgetUsage({ squireId, since: "1969-01-01T00:00:00.000Z" }),
  );

/** Messages Squire actions sent into the tracked threads. */
const actionMessages = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sent = [];
  for (const threadId of [tracked, second]) {
    const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
    });
    sent.push(...messages.filter((message) => message.id.startsWith("message:squire-action:")));
  }
  return sent;
});

const advance = (seconds: number) => TestClock.adjust(`${seconds} seconds`);

/** Holds `sendToThread` for Squire actions until `release`; `entered` once it is inside. */
const gatedSend = (entered: Deferred.Deferred<void>, release: Deferred.Deferred<void>) => ({
  wrapThreadManagement: (real: ThreadManagement.ThreadManagementService["Service"]) =>
    Effect.succeed({
      ...real,
      sendToThread: (input: ThreadManagement.ThreadManagementSendInput) =>
        input.commandId.startsWith("server:squire:")
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(real.sendToThread(input)),
            )
          : real.sendToThread(input),
    }),
});

/** A held card as a crash after `executing` was written leaves it, optionally after its dispatch. */
const crashMidExecution = (card: SquireRepository.SquireCardRow, dispatched: boolean) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    yield* repository.updateCard({
      id: card.id,
      fromStatuses: ["held"],
      patch: { status: "executing" },
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    });
    if (!dispatched) return;
    const intent = Option.getOrThrow(decodeSquireActionIntent(card.intent_json));
    assert.strictEqual(intent.type, "steer");
    if (intent.type !== "steer") return;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* withSquireDispatchOrigin(
      threads.sendToThread({
        projectId: homeProject,
        commandId: CommandId.make(card.command_id!),
        threadId: tracked,
        messageId: SquireActions.squireActionMessageId(card.id, card.attempt),
        text: intent.text,
        attachments: [],
        mode: intent.dispatchMode,
        createdBy: "agent",
        creationSource: "server",
      }),
    );
  });

describe("SquireActions held execution", () => {
  it.effect("a hold executes once after the undo window, charged on execution only (08)", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        const held = yield* sendSteer(home);
        assert.isFalse(held.isError);
        assert.include(held.text, "Held");
        const card = yield* onlyCard(home.squireId);
        assert.strictEqual(card.status, "held");
        assert.strictEqual(card.attempt, 1);
        assert.strictEqual(card.command_id, `server:squire:execute:${card.id}:1`);
        let log = yield* logOf(home.squireId);
        assert.strictEqual(count(log, "action.held"), 1);
        assert.strictEqual(count(log, "card.created"), 0);
        assert.strictEqual(count(log, "notification.pushed"), 0);

        yield* advance(9);
        yield* executeDue;
        assert.lengthOf(yield* actionMessages, 0);
        assert.lengthOf(yield* budgetRows(home.squireId), 0);

        yield* advance(2);
        yield* executeDue;
        yield* executeDue;
        const [sent, ...more] = yield* actionMessages;
        assert.lengthOf(more, 0);
        assert.strictEqual(sent!.createdBy, "agent");
        assert.strictEqual(sent!.senderThreadId, home.homeThreadId);
        const done = yield* cardOf(card.id);
        assert.strictEqual(done.status, "executed");
        assert.strictEqual(done.execution_key, card.command_id);
        const usage = yield* budgetRows(home.squireId);
        assert.deepStrictEqual(
          usage.map((row) => [row.kind, row.thread_id, row.execution_key]),
          [["steer", tracked, card.command_id]],
        );
        log = yield* logOf(home.squireId);
        const executed = log.filter((row) => row.kind === "action.executed");
        assert.lengthOf(executed, 1);
        assert.strictEqual(executed[0]!.data.action, "steer");
        assert.strictEqual(executed[0]!.execution_key, card.command_id);
        assert.strictEqual(count(log, "card.created"), 0);
      }),
    ),
  );

  it.effect("no interrupt-restart on a provider without active steering: the steer queues", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* sendSteer(home);
        const card = yield* onlyCard(home.squireId);
        const intent = Option.getOrThrow(decodeSquireActionIntent(card.intent_json));
        assert.strictEqual(intent.type === "steer" ? intent.dispatchMode : null, "queue");
        yield* advance(11);
        yield* executeDue;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const { runs } = yield* projections.getThreadRecords(tracked, ["runs"]);
        assert.isFalse(runs.some((run) => run.status === "interrupted"));
        const [sent] = yield* actionMessages;
        assert.isTrue(runs.some((run) => run.userMessageId === sent!.id));
      }),
    ),
  );

  it.effect(
    "a hold more than 60 s overdue becomes an open card that pushes, never a steer (11)",
    () =>
      withSquire((home) =>
        Effect.gen(function* () {
          yield* sendSteer(home);
          yield* advance(78);
          yield* executeDue;
          const card = yield* onlyCard(home.squireId);
          assert.strictEqual(card.status, "open");
          assert.isNull(card.executes_at);
          assert.lengthOf(yield* actionMessages, 0);
          assert.lengthOf(yield* budgetRows(home.squireId), 0);
          const log = yield* logOf(home.squireId);
          assert.strictEqual(count(log, "card.created"), 1);
          assert.strictEqual(count(log, "notification.pushed"), 1);
          assert.strictEqual(count(log, "action.executed"), 0);
        }),
      ),
  );

  it.effect("Undo turns the hold into an open card: no charge, no push, nothing later (09)", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* sendSteer(home, undefined, { steerKind: "rerun-checks" });
        const card = yield* onlyCard(home.squireId);
        yield* advance(3);
        const undone = yield* act({ requestId: "undo-1", cardIds: [card.id], action: "undo" });
        assert.strictEqual(undone.results[0]!.status, "open");
        assert.isNull(undone.results[0]!.error);
        // The matching ask-first rule is offered after an Undo.
        assert.strictEqual(undone.results[0]!.ruleOffer?.effect, "ask-first");
        yield* advance(20);
        yield* executeDue;
        assert.strictEqual((yield* cardOf(card.id)).status, "open");
        assert.lengthOf(yield* actionMessages, 0);
        assert.lengthOf(yield* budgetRows(home.squireId), 0);
        const log = yield* logOf(home.squireId);
        assert.strictEqual(count(log, "action.undone"), 1);
        assert.strictEqual(count(log, "card.created"), 1);
        assert.strictEqual(count(log, "notification.pushed"), 0);
        const again = yield* act({ requestId: "undo-2", cardIds: [card.id], action: "undo" });
        assert.isNotNull(again.results[0]!.error);
      }),
    ),
  );

  it.effect(
    "Undo with an open card for the same thread replaces it; a retried Undo writes nothing",
    () =>
      withSquire((home) =>
        Effect.gen(function* () {
          yield* setPermissions(home.squireId, { steer: "recommend" });
          yield* sendSteer(home, "Recheck the rounding fixture.");
          const older = yield* onlyCard(home.squireId);
          assert.strictEqual(older.status, "open");
          yield* setPermissions(home.squireId, { steer: "auto" });
          yield* sendSteer(home, "Rerun api-e2e only.");
          const held = (yield* cardsOf(home.squireId)).find((card) => card.id !== older.id)!;
          // A hold is not an item, so it leaves the open card alone.
          assert.strictEqual(held.status, "held");
          assert.strictEqual((yield* cardOf(older.id)).status, "open");

          const undone = yield* act({ requestId: "undo-1", cardIds: [held.id], action: "undo" });
          assert.strictEqual(undone.results[0]!.status, "open");
          assert.isNull(undone.results[0]!.error);
          const open = (yield* cardsOf(home.squireId)).filter((card) => card.status === "open");
          assert.deepStrictEqual(
            open.map((card) => card.id),
            [held.id],
          );
          assert.include(open[0]!.payload_json, "Rerun api-e2e only.");
          const replaced = yield* cardOf(older.id);
          assert.strictEqual(replaced.status, "outdated");
          assert.strictEqual(replaced.resolution, "superseded");

          const cards = yield* cardsOf(home.squireId);
          const log = yield* logOf(home.squireId);
          for (const requestId of ["undo-1", "undo-2"]) {
            const again = yield* act({ requestId, cardIds: [held.id], action: "undo" });
            assert.strictEqual(again.results[0]!.status, "open");
          }
          assert.deepStrictEqual(yield* cardsOf(home.squireId), cards);
          assert.lengthOf(yield* logOf(home.squireId), log.length);
          yield* advance(20);
          yield* executeDue;
          assert.lengthOf(yield* actionMessages, 0);
        }),
      ),
  );

  it.effect("two holds on the last budget slot: one steer and one card with the caption", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* seedUsage(home.squireId, 9);
        // Two threads: a steer starts a turn, which obsoletes a hold on the same thread.
        yield* sendSteer(home);
        yield* sendSteer(home, undefined, { threadId: second });
        const holds = yield* cardsOf(home.squireId);
        assert.deepStrictEqual(
          holds.map((card) => card.status),
          ["held", "held"],
        );
        yield* advance(11);
        yield* executeDue;
        assert.lengthOf(yield* actionMessages, 1);
        const after = yield* cardsOf(home.squireId);
        assert.deepStrictEqual(after.map((card) => card.status).toSorted(), ["executed", "open"]);
        assert.lengthOf(yield* budgetRows(home.squireId), 10);
        const created = (yield* logOf(home.squireId)).filter((row) => row.kind === "card.created");
        assert.lengthOf(created, 1);
        assert.match(created[0]!.data.caption, /^budget reached, recommending only/);
      }),
    ),
  );

  it.effect(
    "hold A dispatched and crashed before finalize, then hold B with one slot: A charged first, B a card",
    () =>
      withSquire((home) =>
        Effect.gen(function* () {
          yield* seedUsage(home.squireId, 9);
          yield* sendSteer(home);
          yield* sendSteer(home, undefined, { threadId: second });
          const [a, b] = yield* cardsOf(home.squireId);
          yield* crashMidExecution(a!, true);
          // Only B is due, so A is settled by B's admission, not its own timer.
          const repository = yield* SquireRepository.SquireRepository;
          yield* repository.updateCard({
            id: a!.id,
            fromStatuses: ["executing"],
            patch: { executes_at: "2100-01-01T00:00:00.000Z" },
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          });
          yield* advance(11);
          yield* executeDue;
          assert.strictEqual((yield* cardOf(a!.id)).status, "executed");
          assert.strictEqual((yield* cardOf(b!.id)).status, "open");
          const usage = yield* budgetRows(home.squireId);
          assert.lengthOf(usage, 10);
          assert.isTrue(usage.some((row) => row.execution_key === a!.command_id));
          assert.lengthOf(yield* actionMessages, 1);
        }),
      ),
  );

  it.effect(
    "crash after dispatch, target archived meanwhile: finalized once on restart, no downgrade",
    () =>
      Effect.gen(function* () {
        const { root, baseDir } = yield* tempRoot;
        const { home, card } = yield* lifetime(
          baseDir,
          Effect.gen(function* () {
            const home = yield* seed(root);
            yield* sendSteer(home);
            const card = yield* onlyCard(home.squireId);
            yield* advance(11);
            yield* crashMidExecution(card, true);
            const threads = yield* ThreadManagement.ThreadManagementService;
            yield* threads.dispatch({
              type: "thread.archive",
              commandId: CommandId.make("test:archive"),
              threadId: tracked,
            });
            return { home, card };
          }),
        );
        yield* lifetime(
          baseDir,
          Effect.gen(function* () {
            yield* reconcileStartup;
            yield* executeDue;
            const done = yield* cardOf(card.id);
            assert.strictEqual(done.status, "executed");
            assert.lengthOf(yield* budgetRows(home.squireId), 1);
            const log = yield* logOf(home.squireId);
            assert.strictEqual(count(log, "action.executed"), 1);
            assert.strictEqual(count(log, "card.created"), 0);
            assert.lengthOf(yield* actionMessages, 1);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("crash before dispatch: one steer after restart", () =>
    Effect.gen(function* () {
      const { root, baseDir } = yield* tempRoot;
      const { home, card } = yield* lifetime(
        baseDir,
        Effect.gen(function* () {
          const home = yield* seed(root);
          yield* sendSteer(home);
          const card = yield* onlyCard(home.squireId);
          yield* advance(11);
          yield* crashMidExecution(card, false);
          return { home, card };
        }),
      );
      yield* lifetime(
        baseDir,
        Effect.gen(function* () {
          yield* reconcileStartup;
          assert.strictEqual((yield* cardOf(card.id)).status, "executing");
          yield* executeDue;
          yield* executeDue;
          assert.strictEqual((yield* cardOf(card.id)).status, "executed");
          assert.lengthOf(yield* actionMessages, 1);
          assert.lengthOf(yield* budgetRows(home.squireId), 1);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("sendToThread failing after its dispatch committed: finalized from the receipt", () =>
    withSquire(
      (home) =>
        Effect.gen(function* () {
          yield* sendSteer(home);
          yield* advance(11);
          yield* executeDue;
          const card = yield* onlyCard(home.squireId);
          assert.strictEqual(card.status, "executed");
          assert.lengthOf(yield* budgetRows(home.squireId), 1);
          assert.strictEqual(count(yield* logOf(home.squireId), "card.created"), 0);
        }),
      {
        wrapThreadManagement: (real) =>
          Effect.succeed({
            ...real,
            sendToThread: (input) =>
              real.sendToThread(input).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ThreadManagement.ThreadManagementDurableRunProjectionError({
                      threadId: input.threadId,
                      messageId: input.messageId,
                    }),
                  ),
                ),
              ),
          }),
      },
    ),
  );

  it.effect(
    "a user message between re-validation and dispatch: refused under the lock, card outdated",
    () =>
      withSquire(
        (home) =>
          Effect.gen(function* () {
            yield* sendSteer(home);
            yield* advance(11);
            yield* executeDue;
            const card = yield* onlyCard(home.squireId);
            assert.strictEqual(card.status, "outdated");
            assert.lengthOf(yield* actionMessages, 0);
            assert.lengthOf(yield* budgetRows(home.squireId), 0);
            const cancelled = (yield* logOf(home.squireId)).find(
              (row) => row.kind === "action.cancelled",
            );
            assert.include(cancelled!.data.reason, "user wrote");
          }),
        {
          wrapThreadManagement: (real) =>
            Effect.succeed({
              ...real,
              sendToThread: (input) =>
                (input.commandId.startsWith("server:squire:execute:")
                  ? real.dispatch({
                      type: "message.dispatch",
                      commandId: CommandId.make("test:user:between"),
                      threadId: input.threadId,
                      messageId: MessageId.make("message:user:between"),
                      text: "Hold on, I am changing the rounding mode.",
                      attachments: [],
                      dispatchMode: { type: "queue_after_active" },
                      createdBy: "user",
                      creationSource: "web",
                    })
                  : Effect.void
                ).pipe(Effect.andThen(real.sendToThread(input))),
            }),
        },
      ),
  );

  it.effect(
    "a rerun-checks hold is outdated, not sent, once its check passes on the same head",
    () =>
      withSquire((home) =>
        Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const repository = yield* SquireRepository.SquireRepository;
          const key = { host: "github.com", repository: "acme/billing-service", number: 321 };
          const syncChecks = (checksState: "failing" | "passing") =>
            Effect.gen(function* () {
              yield* threads.dispatch({
                type: "thread.pull-request-link.sync",
                commandId: CommandId.make(`${tracked}:sync:${checksState}`),
                threadId: tracked,
                ...key,
                snapshot: {
                  state: "open",
                  title: "Fix invoice rounding",
                  headBranch: "fix/rounding",
                  baseBranch: "main",
                  isDraft: false,
                  updatedAt: null,
                  syncedAt: DateTime.formatIso(yield* DateTime.now),
                  checksState,
                  headSha: "sha1",
                },
                stack: null,
              });
            });
          yield* threads.dispatch({
            type: "thread.pull-request.link",
            commandId: CommandId.make(`${tracked}:link`),
            threadId: tracked,
            ...key,
            url: "https://github.com/acme/billing-service/pull/321",
            source: "manual",
          });
          yield* syncChecks("failing");
          yield* sendSteer(home, undefined, { steerKind: "rerun-checks" });
          const card = yield* onlyCard(home.squireId);
          assert.strictEqual(card.status, "held");
          // What the tool stores from the batch that woke the Squire on the failing check.
          yield* repository.updateCard({
            id: card.id,
            fromStatuses: ["held"],
            patch: {
              trigger_json: JSON.stringify({
                prKey: "github.com/acme/billing-service#321",
                headSha: "sha1",
                transition: "checks:failed",
              }),
            },
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          });

          // The rerun went green on the same commit, so the head check alone still holds.
          yield* syncChecks("passing");
          yield* advance(11);
          yield* executeDue;
          assert.strictEqual((yield* cardOf(card.id)).status, "outdated");
          assert.lengthOf(yield* actionMessages, 0);
          assert.lengthOf(yield* budgetRows(home.squireId), 0);
        }),
      ),
  );

  describe("the policy lock from re-validation through finalize", () => {
    const changes = {
      pause: (home: Home) =>
        Effect.flatMap(need(SquireService.SquireService), (service) =>
          service.setStatus({ requestId: "pause", squireId: home.squireId, status: "paused" }),
        ),
      untrack: (home: Home) =>
        Effect.flatMap(need(SquireService.SquireService), (service) =>
          service.untrack({
            requestId: "untrack",
            squireId: home.squireId,
            grant: { kind: "thread", targetId: tracked },
          }),
        ),
      permission: (home: Home) =>
        Effect.gen(function* () {
          const service = yield* need(SquireService.SquireService);
          const row = Option.getOrThrow(yield* service.get(home.squireId));
          yield* service.update({
            requestId: "recommend",
            squireId: home.squireId,
            expectedRevision: row.revision,
            permissions: { steer: "recommend", createThread: "auto", notify: "on" },
          });
        }),
    } as const;

    it.effect.each(Object.keys(changes) as Array<keyof typeof changes>)(
      "a %s during the dispatch completes only after it commits",
      (name) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* withSquire(
            (home) =>
              Effect.gen(function* () {
                yield* sendSteer(home);
                yield* advance(11);
                const execution = yield* Effect.forkChild(executeDue);
                yield* Deferred.await(entered);
                const change = yield* Effect.forkChild(changes[name](home));
                for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
                assert.isUndefined(change.pollUnsafe());
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(execution);
                yield* Fiber.join(change);
                const card = yield* onlyCard(home.squireId);
                assert.strictEqual(card.status, "executed");
                assert.lengthOf(yield* actionMessages, 1);
                assert.lengthOf(yield* budgetRows(home.squireId), 1);
              }),
            gatedSend(entered, release),
          );
        }),
    );

    it.effect.each(Object.keys(changes) as Array<keyof typeof changes>)(
      "a %s committed before re-validation refuses the execution",
      (name) =>
        withSquire((home) =>
          Effect.gen(function* () {
            yield* sendSteer(home);
            yield* changes[name](home);
            yield* advance(11);
            yield* executeDue;
            const card = yield* onlyCard(home.squireId);
            // Pausing opens a paused Squire's holds itself and an untrack outdates the
            // thread's cards; a permission change reopens the hold at execution.
            assert.strictEqual(card.status, name === "untrack" ? "outdated" : "open");
            assert.lengthOf(yield* actionMessages, 0);
            assert.lengthOf(yield* budgetRows(home.squireId), 0);
          }),
        ),
    );
  });

  it.effect("removing the allow rule during a hold turns it into a card at execution", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* setPermissions(home.squireId, { steer: "recommend" });
        const repository = yield* SquireRepository.SquireRepository;
        const ruleId = SquireRuleId.make("rule-rerun");
        yield* repository.insertRule({
          id: ruleId,
          squire_id: home.squireId,
          effect: "allow",
          action_class: "steer",
          target_kind: "thread",
          target_id: tracked,
          steer_kind: "rerun-checks",
          status: "active",
          match_count: 0,
          last_matched_at: null,
          created_at: DateTime.formatIso(yield* DateTime.now),
        });
        yield* sendSteer(home, undefined, { steerKind: "rerun-checks" });
        const card = yield* onlyCard(home.squireId);
        assert.strictEqual(card.status, "held");
        assert.strictEqual(card.rule_id, ruleId);
        yield* (yield* need(SquireRules.SquireRules)).remove({ requestId: "remove", ruleId });
        yield* advance(11);
        yield* executeDue;
        assert.strictEqual((yield* cardOf(card.id)).status, "open");
        assert.lengthOf(yield* actionMessages, 0);
        assert.lengthOf(yield* budgetRows(home.squireId), 0);
      }),
    ),
  );
});

/**
 * The first attempt's command is rejected by the orchestrator before the
 * accept dispatches it, as a refusing target would.
 */
const rejectFirstAttempt = {
  wrapThreadManagement: (real: ThreadManagement.ThreadManagementService["Service"]) =>
    Effect.succeed({
      ...real,
      sendToThread: (input: ThreadManagement.ThreadManagementSendInput) =>
        (input.commandId.endsWith(":1")
          ? real
              .dispatch({
                type: "message.dispatch",
                commandId: input.commandId,
                threadId: input.threadId,
                messageId: input.messageId,
                text: input.text,
                attachments: [],
                dispatchMode: { type: "steer_active", targetRunId: RunId.make("run:gone") },
                createdBy: "user",
                creationSource: "server",
              })
              .pipe(Effect.ignore)
          : Effect.void
        ).pipe(Effect.andThen(real.sendToThread(input))),
    }),
} satisfies Phase4Options;

describe("squire.items.act", () => {
  /** A Recommend steer card, opened by a send at Recommend. */
  const openCard = (home: Home, steer?: string) =>
    Effect.gen(function* () {
      yield* setPermissions(home.squireId, { steer: "recommend", createThread: "recommend" });
      yield* sendSteer(home, steer);
      const card = yield* onlyCard(home.squireId);
      assert.strictEqual(card.status, "open");
      return card;
    });

  it.effect("the same requestId twice is one dispatch, charged once, with the user as author", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        const card = yield* openCard(home);
        const input = { requestId: "accept-1", cardIds: [card.id], action: "accept" } as const;
        const first = yield* act({ ...input, text: "Rerun api-e2e only." });
        const again = yield* act({ ...input, text: "Rerun api-e2e only." });
        assert.strictEqual(first.results[0]!.status, "resolved");
        assert.isNull(first.results[0]!.error);
        assert.strictEqual(again.results[0]!.status, "resolved");
        const [sent, ...more] = yield* actionMessages;
        assert.lengthOf(more, 0);
        assert.strictEqual(sent!.text, "Rerun api-e2e only.");
        assert.strictEqual(sent!.createdBy, "user");
        assert.lengthOf(yield* budgetRows(home.squireId), 1);
        assert.strictEqual(
          (yield* cardOf(card.id)).command_id,
          `server:squire:accept:${card.id}:1`,
        );
      }),
    ),
  );

  it.effect("accept on an outdated card does nothing", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        const card = yield* openCard(home);
        const repository = yield* SquireRepository.SquireRepository;
        yield* repository.updateCard({
          id: card.id,
          fromStatuses: ["open"],
          patch: { status: "outdated", resolution: "outdated" },
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        const result = yield* act({ requestId: "late", cardIds: [card.id], action: "accept" });
        assert.strictEqual(result.results[0]!.error?.code, "outdated");
        assert.lengthOf(yield* actionMessages, 0);
        assert.lengthOf(yield* budgetRows(home.squireId), 0);
      }),
    ),
  );

  it.effect(
    "an accept the target rejects reopens the card; accepting again is attempt 2 and one dispatch",
    () =>
      withSquire(
        (home) =>
          Effect.gen(function* () {
            const card = yield* openCard(home);
            const rejected = yield* act({ requestId: "a", cardIds: [card.id], action: "accept" });
            assert.isNotNull(rejected.results[0]!.error);
            const reopened = yield* cardOf(card.id);
            assert.strictEqual(reopened.status, "open");
            assert.strictEqual(reopened.attempt, 1);
            assert.lengthOf(yield* actionMessages, 0);

            const accepted = yield* act({ requestId: "b", cardIds: [card.id], action: "accept" });
            assert.strictEqual(accepted.results[0]!.status, "resolved");
            const done = yield* cardOf(card.id);
            assert.strictEqual(done.command_id, `server:squire:accept:${card.id}:2`);
            assert.lengthOf(yield* actionMessages, 1);
            assert.lengthOf(yield* budgetRows(home.squireId), 1);
          }),
        rejectFirstAttempt,
      ),
  );

  it.effect("the same requestId after a rejection replays it and never sends new content", () =>
    withSquire(
      (home) =>
        Effect.gen(function* () {
          const card = yield* openCard(home);
          const input = { requestId: "a", cardIds: [card.id], action: "accept" } as const;
          const rejected = yield* act(input);
          assert.isNotNull(rejected.results[0]!.error);
          assert.strictEqual((yield* cardOf(card.id)).status, "open");

          const retried = yield* act({ ...input, text: "Something else entirely." });
          assert.deepStrictEqual(retried.results, rejected.results);
          assert.strictEqual((yield* cardOf(card.id)).attempt, 1);
          assert.lengthOf(yield* actionMessages, 0);
        }),
      rejectFirstAttempt,
    ),
  );

  it.effect("a paused Squire's accept still honors Steer Off", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        const card = yield* openCard(home);
        const service = yield* need(SquireService.SquireService);
        yield* service.setStatus({ requestId: "pause", squireId: home.squireId, status: "paused" });
        yield* setPermissions(home.squireId, { steer: "off" });
        const refused = yield* act({ requestId: "accept", cardIds: [card.id], action: "accept" });
        assert.isNotNull(refused.results[0]!.error);
        assert.strictEqual((yield* cardOf(card.id)).status, "open");
        assert.lengthOf(yield* actionMessages, 0);
        assert.lengthOf(yield* budgetRows(home.squireId), 0);
      }),
    ),
  );

  it.effect("the edited text survives a restart between accept and dispatch", () =>
    Effect.gen(function* () {
      const { root, baseDir } = yield* tempRoot;
      const entered = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      const { home, cardId } = yield* lifetime(
        baseDir,
        Effect.gen(function* () {
          const home = yield* seed(root);
          const card = yield* openCard(home);
          yield* Effect.forkChild(
            act({
              requestId: "accept",
              cardIds: [card.id],
              action: "accept",
              text: "Rerun api-e2e, then stop.",
            }),
          );
          yield* Deferred.await(entered);
          assert.strictEqual((yield* cardOf(card.id)).status, "accepting");
          return { home, cardId: card.id };
        }),
        gatedSend(entered, never),
      );
      yield* lifetime(
        baseDir,
        Effect.gen(function* () {
          yield* reconcileStartup;
          assert.strictEqual((yield* cardOf(cardId)).status, "resolved");
          const [sent, ...more] = yield* actionMessages;
          assert.lengthOf(more, 0);
          assert.strictEqual(sent!.text, "Rerun api-e2e, then stop.");
          assert.lengthOf(yield* budgetRows(home.squireId), 1);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("dismiss closes an open card; accept-all resolves each card", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        const card = yield* openCard(home);
        const dismissed = yield* act({ requestId: "d", cardIds: [card.id], action: "dismiss" });
        assert.strictEqual(dismissed.results[0]!.status, "dismissed");
        const late = yield* act({ requestId: "x", cardIds: [card.id], action: "accept" });
        assert.isNotNull(late.results[0]!.error);
        assert.lengthOf(yield* actionMessages, 0);
      }),
    ),
  );
});

describe("thread create", () => {
  const propose = (home: Home) =>
    Effect.flatMap(need(SquireTools.SquireTools), (tools) =>
      tools.call(
        { squireId: home.squireId, role: "squire", threadId: home.homeThreadId },
        "squire_create_thread",
        {
          project: "billing-service",
          provider: "scripted",
          firstPrompt: "Add a CHANGELOG entry for #318.",
          reason: "PR #318 merged.",
        },
      ),
    );

  const launchIntentOf = (card: SquireRepository.SquireCardRow) => {
    const intent = Option.getOrThrow(decodeSquireActionIntent(card.intent_json));
    if (intent.type !== "thread-create") throw new Error("expected a thread-create intent");
    return intent.launch;
  };

  const createOnly = (intent: SquireLaunchAction.SquireLaunchIntent) =>
    Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
      threads.dispatch({
        type: "thread.create",
        commandId: intent.commandId,
        threadId: intent.threadId,
        projectId: intent.projectId,
        title: intent.title,
        modelSelection: intent.modelSelection,
        runtimeMode: intent.runtimeMode,
        interactionMode: intent.interactionMode,
        branch: null,
        worktreePath: null,
        createdBy: intent.createdBy,
        creationSource: "server",
      }),
    );

  const grantsOf = (squireId: SquireId) =>
    Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
      repository.listGrants(squireId),
    );

  const disableScripted = Effect.flatMap(ServerSettings.ServerSettingsService, (settings) =>
    settings.updateSettings({
      projectSettingsOverrides: {
        [homeProject]: { providerInstances: { [scripted]: { enabled: false } } },
      },
    }),
  );

  it.effect("a held create launches once, charges a thread, and grants origin created", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* propose(home);
        const card = yield* onlyCard(home.squireId);
        assert.strictEqual(card.status, "held");
        yield* advance(11);
        yield* executeDue;
        yield* executeDue;
        const intent = launchIntentOf(card);
        assert.strictEqual((yield* cardOf(card.id)).status, "executed");
        const threads = yield* ThreadManagement.ThreadManagementService;
        assert.strictEqual(yield* threads.getMessageCount(intent.threadId), 1);
        const usage = yield* budgetRows(home.squireId);
        assert.deepStrictEqual(
          usage.map((row) => row.kind),
          ["thread"],
        );
        const grant = (yield* grantsOf(home.squireId)).find(
          (row) => row.target_id === intent.threadId,
        );
        assert.strictEqual(grant?.origin, "created");
        const executed = (yield* logOf(home.squireId)).filter(
          (row) => row.kind === "action.executed",
        );
        assert.deepStrictEqual(
          executed.map((row) => row.data.action),
          ["create_thread"],
        );
      }),
    ),
  );

  it.effect(
    "a crash after the create receipt only: one thread with its message, finalized once",
    () =>
      Effect.gen(function* () {
        const { root, baseDir } = yield* tempRoot;
        const { home, card } = yield* lifetime(
          baseDir,
          Effect.gen(function* () {
            const home = yield* seed(root);
            yield* propose(home);
            const card = yield* onlyCard(home.squireId);
            yield* advance(11);
            yield* crashMidExecutionCreate(card);
            yield* createOnly(launchIntentOf(card));
            return { home, card };
          }),
        );
        yield* lifetime(
          baseDir,
          Effect.gen(function* () {
            yield* reconcileStartup;
            yield* executeDue;
            const intent = launchIntentOf(card);
            assert.strictEqual((yield* cardOf(card.id)).status, "executed");
            const threads = yield* ThreadManagement.ThreadManagementService;
            assert.strictEqual(yield* threads.getMessageCount(intent.threadId), 1);
            const projection = yield* threads.getThreadProjection(intent.threadId);
            assert.lengthOf(projection.runs, 1);
            assert.lengthOf(yield* budgetRows(home.squireId), 1);
            assert.strictEqual(count(yield* logOf(home.squireId), "action.executed"), 1);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a crash after both receipts, then the provider disabled: finalized and charged, no relaunch",
    () =>
      Effect.gen(function* () {
        const { root, baseDir } = yield* tempRoot;
        const { home, card } = yield* lifetime(
          baseDir,
          Effect.gen(function* () {
            const home = yield* seed(root);
            yield* propose(home);
            const card = yield* onlyCard(home.squireId);
            yield* advance(11);
            yield* crashMidExecutionCreate(card);
            const launcher = yield* need(SquireLaunchAction.SquireLaunchAction);
            yield* launcher.launch(launchIntentOf(card));
            return { home, card };
          }),
        );
        yield* lifetime(
          baseDir,
          Effect.gen(function* () {
            yield* disableScripted;
            yield* reconcileStartup;
            assert.strictEqual((yield* cardOf(card.id)).status, "executed");
            assert.lengthOf(yield* budgetRows(home.squireId), 1);
            const threads = yield* ThreadManagement.ThreadManagementService;
            assert.strictEqual(yield* threads.getMessageCount(launchIntentOf(card).threadId), 1);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a crash after the create receipt only, then the provider disabled: archived, reopened, uncharged",
    () =>
      Effect.gen(function* () {
        const { root, baseDir } = yield* tempRoot;
        const { home, card } = yield* lifetime(
          baseDir,
          Effect.gen(function* () {
            const home = yield* seed(root);
            yield* propose(home);
            const card = yield* onlyCard(home.squireId);
            yield* advance(11);
            yield* crashMidExecutionCreate(card);
            yield* createOnly(launchIntentOf(card));
            return { home, card };
          }),
        );
        yield* lifetime(
          baseDir,
          Effect.gen(function* () {
            yield* disableScripted;
            yield* reconcileStartup;
            const reopened = yield* cardOf(card.id);
            assert.strictEqual(reopened.status, "open");
            assert.lengthOf(yield* budgetRows(home.squireId), 0);
            const threads = yield* ThreadManagement.ThreadManagementService;
            const shell = yield* threads.getThreadShell(launchIntentOf(card).threadId);
            assert.isNotNull(shell?.archivedAt ?? null);
            assert.strictEqual(yield* threads.getMessageCount(launchIntentOf(card).threadId), 0);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("a launch retry is one thread", () =>
    withSquire((home) =>
      Effect.gen(function* () {
        yield* setPermissions(home.squireId, { createThread: "recommend" });
        yield* propose(home);
        const card = yield* onlyCard(home.squireId);
        assert.strictEqual(card.status, "open");
        const input = { requestId: "create", cardIds: [card.id], action: "accept" } as const;
        assert.strictEqual((yield* act(input)).results[0]!.status, "resolved");
        assert.strictEqual((yield* act(input)).results[0]!.status, "resolved");
        const threads = yield* ThreadManagement.ThreadManagementService;
        const snapshot = yield* threads.getShellSnapshot();
        const created = snapshot.threads.filter((thread) =>
          thread.id.startsWith("thread:squire-create:"),
        );
        assert.lengthOf(created, 1);
        assert.lengthOf(yield* budgetRows(home.squireId), 1);
      }),
    ),
  );
});

/** A held create as a crash after `executing` was written leaves it. */
const crashMidExecutionCreate = (card: SquireRepository.SquireCardRow) =>
  Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
    Effect.flatMap(DateTime.now, (now) =>
      repository.updateCard({
        id: card.id,
        fromStatuses: ["held"],
        patch: { status: "executing" },
        updatedAt: DateTime.formatIso(now),
      }),
    ),
  );

const scenario05Decoded = Schema.decodeUnknownSync(SquireFixtureScenario)(scenario05);
const fake05Decoded = Schema.decodeUnknownSync(SquireFakeScript)(fake05);

describe("fixture proposals", () => {
  it.effect("accepting fake 05's proposal launches a fixture thread on the scripted instance", () =>
    withBarHarness(
      Effect.gen(function* () {
        const loaded = yield* runBarScenario(scenario05Decoded, {
          fake: fake05Decoded,
          pauseLead: true,
        });
        const [card, ...more] = (yield* cardsOf(loaded.squireId)).filter(
          (row) => row.kind === "proposal",
        );
        assert.lengthOf(more, 0);
        // The card still shows the proposed provider.
        assert.include(card!.payload_json, '"provider":"claudeAgent"');
        const result = yield* act({
          requestId: "accept-05",
          cardIds: [card!.id],
          action: "accept",
        });
        assert.strictEqual(result.results[0]!.status, "resolved");
        const intent = Option.getOrThrow(
          decodeSquireActionIntent((yield* cardOf(card!.id)).intent_json),
        );
        if (intent.type !== "thread-create") return assert.fail("expected a thread-create intent");
        const threads = yield* ThreadManagement.ThreadManagementService;
        const shell = yield* threads.getThreadShell(intent.launch.threadId);
        assert.strictEqual(shell?.modelSelection.instanceId, scripted);
        // In the fixture's project, so the thread is fixture-owned.
        assert.strictEqual(shell?.projectId, card!.project_id);
        const project = yield* (yield* need(ProjectStore.ProjectStoreV2)).get(card!.project_id!);
        const config = yield* ServerConfig.ServerConfig;
        assert.isTrue(
          isFixtureWorkspaceRoot(config.baseDir, Option.getOrThrow(project).workspaceRoot),
        );
        assert.strictEqual(yield* threads.getMessageCount(intent.launch.threadId), 1);
      }),
    ),
  );
});

describe("Lead room open", () => {
  it.effect("the locked open re-reads Manage Squires, so a hold stops once it is Off", () =>
    withRoomCast(
      (cast) =>
        Effect.gen(function* () {
          const repository = yield* SquireRepository.SquireRepository;
          yield* deliver(cast.lead.squireId);
          yield* userTurn(cast.lead);
          const opened = yield* roomCallTool(cast.lead, "lead", "squire_open_room", {
            members: [cast.release.squireId, cast.research.squireId],
            topic: "Currency rounding",
            about: [
              { kind: "thread", threadId: invoiceThread },
              { kind: "thread", threadId: currencyThread },
            ],
            reason: "Both threads touch rounding.",
          });
          assert.isFalse(opened.isError, opened.text);
          const [held] = yield* repository.listCards({
            squireId: cast.lead.squireId,
            statuses: ["held"],
          });
          const intent = Option.getOrThrow(decodeSquireActionIntent(held!.intent_json));
          if (!isRoomOpenIntent(intent)) return assert.fail("expected a room open");

          const lead = Option.getOrThrow(yield* repository.getSquire(cast.lead.squireId));
          yield* repository.updateSquire({
            id: lead.id,
            patch: {
              permissions_json: JSON.stringify({
                ...JSON.parse(lead.permissions_json),
                manageSquires: "off",
              }),
            },
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          });
          const rooms = yield* need(SquireRooms.SquireRooms);
          const applied = yield* rooms.applyOpen(intent, {
            executionKey: held!.command_id!,
            now: DateTime.formatIso(yield* DateTime.now),
            verb: "execute",
          });
          assert.deepStrictEqual(applied, {
            ok: false,
            to: "open",
            reason: "Manage Squires is no longer Auto",
          });
          const store = yield* need(SquireRoomStore.SquireRoomStore);
          assert.lengthOf(yield* store.listRooms({ status: "open" }), 0);
        }),
      { scheduler: noTicks, leadManageSquires: "auto" },
    ),
  );
});
