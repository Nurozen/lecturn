/**
 * The scripted bar: the gold scenarios on the scripted `squireFake`
 * provider, whose tool calls go through the production `/mcp` route to
 * `SquireTools`, with the held-action executor on. 08-11 run their timeline
 * on the test clock (holds execute through the server's clock, the real
 * thread services, and the command hook against the fixture's real PR
 * link and run); 01-06 keep their recommend-only gold with the executor present.
 * Judged on effects from the Squire's action log. Ungated: CI runs it.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  SquireFakeScript,
  type SquireFixtureScenario,
  SquireFixtureScenario as SquireFixtureScenarioSchema,
  type SquireFixtureTimelineAction,
  type SquireId,
  ThreadId,
} from "@lecturn/contracts";
import { threadPullRequestKeyOf } from "@lecturn/shared/threadPullRequests";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SquireDevFixtures from "./SquireDevFixtures.ts";
import { decodeSquireActionIntent } from "./squireActionIntent.ts";
import * as SquireRepository from "./SquireRepository.ts";
import {
  type BarTimelineRun,
  applyBarTimelineStep,
  barObserve,
  barToolCalls,
  judgeBarRun,
  withBarTimeline,
  writeBarArtifact,
  writeBarRun,
} from "./testkit/barHarness.ts";
import fake01 from "./testdata/fake/01-ci-failure-recommend.json" with { type: "json" };
import fake01auto from "./testdata/fake/01-ci-failure-recommend-auto.json" with { type: "json" };
import fake02 from "./testdata/fake/02-routine-progress-quiet.json" with { type: "json" };
import fake03 from "./testdata/fake/03-waiting-on-user-nudge.json" with { type: "json" };
import fake04 from "./testdata/fake/04-budget-exhausted-downgrade.json" with { type: "json" };
import fake05 from "./testdata/fake/05-merged-propose-thread.json" with { type: "json" };
import fake06 from "./testdata/fake/06-voice-steer.json" with { type: "json" };
import scenario01 from "./testdata/scenarios/01-ci-failure-recommend.json" with { type: "json" };
import scenario02 from "./testdata/scenarios/02-routine-progress-quiet.json" with { type: "json" };
import scenario03 from "./testdata/scenarios/03-waiting-on-user-nudge.json" with { type: "json" };
import scenario04 from "./testdata/scenarios/04-budget-exhausted-downgrade.json" with { type: "json" };
import scenario05 from "./testdata/scenarios/05-merged-propose-thread.json" with { type: "json" };
import scenario06 from "./testdata/scenarios/06-voice-steer.json" with { type: "json" };
import scenario08 from "./testdata/scenarios/08-auto-hold-executes.json" with { type: "json" };
import scenario09 from "./testdata/scenarios/09-auto-hold-undo.json" with { type: "json" };
import scenario10 from "./testdata/scenarios/10-budget-exhausted-after-hold.json" with { type: "json" };
import scenario11 from "./testdata/scenarios/11-overdue-hold.json" with { type: "json" };

const decodeScenario = Schema.decodeUnknownSync(SquireFixtureScenarioSchema);
const decodeFake = Schema.decodeUnknownSync(SquireFakeScript);

/**
 * 04 and 06 grant steer Auto, and the executor is on, so their card proves
 * the downgrade happened for the scenario's own reason (the exhausted budget,
 * the voice origin) and not as a hold or any other refusal.
 */
const DECISION_REASON: Readonly<Record<string, string>> = {
  "04-budget-exhausted-downgrade": "budget",
  "06-voice-steer": "voice",
};

/** Past the longest undo window plus the overdue limit: any hold would have run or lapsed. */
const PAST_EVERY_HOLD = 61 + 60;

const cp2Cases = [
  [scenario01, fake01],
  [scenario02, fake02],
  [scenario03, fake03],
  [scenario04, fake04],
  [scenario05, fake05],
  [scenario06, fake06],
].map(([scenario, fake]) => {
  const decoded = decodeScenario(scenario);
  return { id: decoded.id, scenario: decoded, fake: decodeFake(fake) };
});

const holdFake = decodeFake(fake01auto);
const cp7Cases = [scenario08, scenario09, scenario10, scenario11].map((scenario) => {
  const decoded = decodeScenario(scenario);
  return { id: decoded.id, scenario: decoded };
});

const summary: Record<
  string,
  { readonly pass: boolean; readonly failures: ReadonlyArray<string> }
> = {};
const record = (id: string, failures: ReadonlyArray<string>) =>
  Effect.suspend(() => {
    summary[id] = { pass: failures.length === 0, failures };
    return writeBarArtifact("squireFake", "cp7-summary", { checkpoint: "CP7", scenarios: summary });
  });

const eventPullRequest = (scenario: SquireFixtureScenario) => {
  const event = scenario.events.find(
    (candidate) => "type" in candidate && candidate.type === "pull-request-changed",
  );
  return event !== undefined && "summary" in event ? event.summary.pullRequest : undefined;
};

/**
 * Every hold's intent names the fixture's real PR link (key and
 * head) and the target's real latest run, which the hook re-checks under the
 * target's command lock; every executed hold's dispatch was admitted by the
 * orchestrator (an accepted receipt on its `server:squire:execute:*` id).
 */
const throughTheHook = (squireId: SquireId, scenario: SquireFixtureScenario) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const pullRequest = eventPullRequest(scenario);
    const failures: Array<string> = [];
    const cards = (yield* repository.listCards({ squireId })).filter(
      (card) => card.intent_json !== null,
    );
    if (cards.length === 0) failures.push("hook: no card carries an action intent");
    for (const card of cards) {
      const intent = decodeSquireActionIntent(card.intent_json);
      if (Option.isNone(intent) || intent.value.type !== "steer") {
        failures.push(`hook: card ${card.id} has no steer intent`);
        continue;
      }
      const { threadId, precondition } = intent.value;
      const shell = yield* projections.getThreadShell(threadId);
      const link = (shell?.pullRequests ?? []).find(
        (candidate) => candidate.number === pullRequest?.number,
      );
      if (link === undefined || precondition.prKey !== threadPullRequestKeyOf(link)) {
        failures.push(`hook: precondition prKey ${precondition.prKey} is not the fixture's link`);
      }
      if (precondition.headSha !== pullRequest?.headSha) {
        failures.push(`hook: precondition head ${precondition.headSha} is not the event's head`);
      }
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      if (
        precondition.latestRunId === undefined ||
        !runs.some((run) => run.id === precondition.latestRunId)
      ) {
        failures.push(`hook: precondition run ${precondition.latestRunId} is not the thread's`);
      }
      if (card.status === "executed") {
        const receipt = yield* receipts.getByCommandId(CommandId.make(card.command_id!));
        if (Option.isNone(receipt) || receipt.value.status !== "accepted") {
          failures.push(`hook: executed card ${card.id} has no accepted receipt`);
        }
      }
    }
    return failures;
    // The read side of the receipts the thread service writes; the stack keeps its own private.
  }).pipe(Effect.provide(CommandReceiptStore.layerFromApplicationReceipts));

const judgeTimeline = (id: string, scenario: SquireFixtureScenario, run: BarTimelineRun) =>
  Effect.gen(function* () {
    const observed = yield* barObserve(run.loaded.squireId);
    const toolCalls = yield* barToolCalls(run.loaded.homeThreadId);
    const failures = [
      ...judgeBarRun(scenario.expected!, observed, run),
      ...(yield* throughTheHook(run.loaded.squireId, scenario)),
    ];
    if (toolCalls.length !== 1 || toolCalls[0]!.name !== "squire_send_steer") {
      failures.push(`toolCalls: ${JSON.stringify(toolCalls.map((call) => call.name))}`);
    }
    yield* writeBarRun("squireFake", {
      scenario: id,
      provider: "squireFake",
      run: 1,
      toolCalls,
      effects: observed.effects,
      pass: failures.length === 0,
      failures,
      marks: run.marks,
    });
    return { observed, failures };
  });

describe("scripted bar timelines with the executor", () => {
  it.effect.each(cp7Cases)("$id meets gold", ({ id, scenario }) =>
    withBarTimeline(
      scenario,
      (run) =>
        Effect.gen(function* () {
          const { failures } = yield* judgeTimeline(id, scenario, run);
          yield* record(id, failures);
          assert.deepStrictEqual(failures, []);
        }),
      { fake: holdFake, pauseLead: true },
    ),
  );

  const target = ThreadId.make("thr_fix_invoice_rounding");
  const movedHead = "4b7d0a2";

  /** The control's gold: the hold never sends, its card is outdated, nothing is charged. */
  const refusedHold = (run: BarTimelineRun) =>
    Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      const observed = yield* barObserve(run.loaded.squireId);
      const cards = yield* repository.listCards({ squireId: run.loaded.squireId });
      const original = cards.find((card) => card.intent_json !== null);
      const log = yield* repository.listActionLog({ squireId: run.loaded.squireId, limit: 500 });
      const failures: Array<string> = [];
      if (observed.effects.action_held < 1) failures.push("control: nothing was held");
      if (observed.effects.steer_sent !== 0) {
        failures.push(`control: steer_sent ${observed.effects.steer_sent}`);
      }
      if (observed.actionMessages.length > 0)
        failures.push("control: a message reached the target");
      if (observed.executionBudgetRows.length > 0)
        failures.push("control: an execution was charged");
      if (original?.status !== "outdated") {
        failures.push(`control: the held card is ${original?.status}, not outdated`);
      }
      const cancelled = log.find(
        (row) => row.kind === "action.cancelled" && row.card_id === original?.id,
      );
      if (cancelled === undefined || !cancelled.data_json.includes('"to":"outdated"')) {
        failures.push(`control: no action.cancelled to outdated (${cancelled?.data_json})`);
      }
      return { failures, cancelled: cancelled?.data_json ?? null };
    });

  it.effect("negative control: the PR head moves during 08's hold, so it never sends", () =>
    Effect.gen(function* () {
      const scenario = decodeScenario(scenario08);
      const timeline: ReadonlyArray<SquireFixtureTimelineAction> = [
        { action: "advance", seconds: 3 },
        { action: "moveHead", threadId: target, headSha: movedHead },
        { action: "advance", seconds: 8 },
      ];
      yield* withBarTimeline(
        scenario,
        (run) =>
          Effect.gen(function* () {
            const { failures, cancelled } = yield* refusedHold(run);
            yield* writeBarArtifact("squireFake", "control-moveHead-run1", {
              failures,
              cancelled,
              marks: run.marks,
            });
            yield* record("control-08-moveHead", failures);
            assert.deepStrictEqual(failures, []);
          }),
        { fake: holdFake, pauseLead: true, timeline },
      );
    }),
  );

  it.effect(
    "negative control: the head moves inside the execution's lock, so the A5.11b hook refuses it",
    () =>
      Effect.gen(function* () {
        const scenario = decodeScenario(scenario08);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // Holds the held action's dispatch after re-validation passed, inside the policy lock.
        const wrapThreadManagement = (real: ThreadManagement.ThreadManagementService["Service"]) =>
          Effect.succeed({
            ...real,
            sendToThread: (input: ThreadManagement.ThreadManagementSendInput) =>
              input.commandId.startsWith("server:squire:execute:")
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(real.sendToThread(input)),
                  )
                : real.sendToThread(input),
          });
        yield* withBarTimeline(
          scenario,
          (run) =>
            Effect.gen(function* () {
              const fixtures = Option.getOrThrow(
                yield* Effect.serviceOption(SquireDevFixtures.SquireDevFixtures),
              );
              const executing = yield* Effect.forkChild(
                applyBarTimelineStep(run.loaded, { action: "advance", seconds: 8 }, 1),
              );
              // Entered means re-validation passed under the policy lock: only the hook is left.
              yield* Deferred.await(entered);
              // Not `applyBarTimelineStep`: its settle would wait on the lock the dispatch holds.
              yield* fixtures.timeline({
                action: "moveHead",
                threadId: target,
                headSha: movedHead,
              });
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(executing);
              const { failures, cancelled } = yield* refusedHold(run);
              if (cancelled === null || !cancelled.includes("pull request")) {
                failures.push(`control: refused for ${cancelled}, not the moved head`);
              }
              const repository = yield* SquireRepository.SquireRepository;
              const [held] = yield* repository.listCards({ squireId: run.loaded.squireId });
              const receipt = yield* Effect.flatMap(
                CommandReceiptStore.CommandReceiptStoreV2,
                (store) => store.getByCommandId(CommandId.make(held!.command_id!)),
              ).pipe(Effect.provide(CommandReceiptStore.layerFromApplicationReceipts));
              if (Option.isSome(receipt) && receipt.value.status === "accepted") {
                failures.push("control: the orchestrator admitted the dispatch");
              }
              yield* writeBarArtifact("squireFake", "control-hook-run1", { failures, cancelled });
              yield* record("control-08-hook-under-lock", failures);
              assert.deepStrictEqual(failures, []);
            }),
          { fake: holdFake, pauseLead: true, timeline: [{ action: "advance", seconds: 3 }] },
          { wrapThreadManagement },
        );
      }),
  );
});

describe("scripted bar recommend scenarios with the executor on", () => {
  it.effect.each(cp2Cases)("$id meets gold", ({ id, scenario, fake }) =>
    withBarTimeline(
      scenario,
      (run) =>
        Effect.gen(function* () {
          const observed = yield* barObserve(run.loaded.squireId);
          const toolCalls = yield* barToolCalls(run.loaded.homeThreadId);
          const failures = [...judgeBarRun(scenario.expected!, observed, run)];
          const reason = DECISION_REASON[id];
          if (reason !== undefined) {
            const steers = observed.decisions.filter((decision) =>
              decision.tool.endsWith("_steer"),
            );
            if (steers.length === 0 || !steers.every((decision) => decision.reason === reason)) {
              failures.push(
                `decision.recorded reason: expected ${reason}, got ${JSON.stringify(steers.map((decision) => decision.reason))}`,
              );
            }
          }
          // With the executor on, nothing here may send later either; 06's voice steer above all.
          yield* applyBarTimelineStep(
            run.loaded,
            { action: "advance", seconds: PAST_EVERY_HOLD },
            0,
          );
          const later = yield* barObserve(run.loaded.squireId);
          for (const name of ["action_held", "steer_sent", "thread_created"] as const) {
            if (later.effects[name] !== 0) {
              failures.push(`after ${PAST_EVERY_HOLD} s: ${name} ${later.effects[name]}`);
            }
          }
          if (later.actionMessages.length > 0 || later.executionBudgetRows.length > 0) {
            failures.push(`after ${PAST_EVERY_HOLD} s: an action reached a thread`);
          }
          yield* writeBarRun("squireFake", {
            scenario: id,
            provider: "squireFake",
            run: 1,
            toolCalls,
            effects: observed.effects,
            pass: failures.length === 0,
            failures,
          });
          yield* record(id, failures);
          // The fake's calls reached SquireTools through MCP, so none failed in transport.
          assert.strictEqual(toolCalls.length, fake.steps[0]!.toolCalls?.length ?? 0);
          assert.deepStrictEqual(failures, []);
        }),
      { fake, pauseLead: true, timeline: [] },
    ),
  );
});
