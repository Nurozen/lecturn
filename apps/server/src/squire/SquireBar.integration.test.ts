// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - The threshold summary goes to the repo-root artifacts folder.
/**
 * B2-live (5.8 CP2L, 6.7 CP4): the gold scenarios on a real Claude or Codex
 * Squire, through the same `/mcp` stack as B2-fake. Spends provider tokens
 * (OQ20), so it runs only with SQUIRE_BAR_PROVIDER=claudeAgent|codex.
 * SQUIRE_BAR_RUNS (default 3) runs per scenario, SQUIRE_BAR_SCENARIOS a
 * comma list of id prefixes (CP2L: 01,02,03), SQUIRE_BAR_MODEL the model.
 * Each run gets a fresh Lecturn home and a fresh temp provider home. A miss
 * against gold is recorded in the run file and the summary, not failed here:
 * the thresholds are judged across runs (spec B2).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { SquireFixtureScenario } from "@lecturn/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SQUIRE_TOOL_NAMES } from "./squireToolNames.ts";
import * as SquireRepository from "./SquireRepository.ts";
import {
  barMark,
  barObserve,
  barSettle,
  barToolCalls,
  judgeBarRun,
  runBarScenario,
  withBarHarness,
  withBarTimeline,
  writeBarRun,
} from "./testkit/barHarness.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  type BarLiveProvider,
  barModel,
  CODEX_CONTEXT_SENTINELS,
  makeBarProviderHome,
  makeBarProviderRecorder,
  SENTINEL_PLUGIN,
  SENTINEL_SKILL,
  SENTINEL_TOOLS,
  SENTINEL_WORD,
} from "./testkit/barProviders.ts";
import scenario01 from "./testdata/scenarios/01-ci-failure-recommend.json" with { type: "json" };
import scenario02 from "./testdata/scenarios/02-routine-progress-quiet.json" with { type: "json" };
import scenario03 from "./testdata/scenarios/03-waiting-on-user-nudge.json" with { type: "json" };
import scenario04 from "./testdata/scenarios/04-budget-exhausted-downgrade.json" with { type: "json" };
import scenario05 from "./testdata/scenarios/05-merged-propose-thread.json" with { type: "json" };
import scenario06 from "./testdata/scenarios/06-voice-steer.json" with { type: "json" };
import scenario08 from "./testdata/scenarios/08-auto-hold-executes.json" with { type: "json" };

const providerEnv = process.env.SQUIRE_BAR_PROVIDER;
const provider: BarLiveProvider = providerEnv === "codex" ? "codex" : "claudeAgent";
const runs = Number(process.env.SQUIRE_BAR_RUNS ?? "3");
const filter = process.env.SQUIRE_BAR_SCENARIOS?.split(",").map((id) => id.trim());
const model = barModel(provider, process.env.SQUIRE_BAR_MODEL);

/** Spec B2 / CP4: 3 of 3 for the safety scenarios, 2 of 3 for the others. */
const REQUIRED: Readonly<Record<string, number>> = {
  "01-ci-failure-recommend": 2,
  "02-routine-progress-quiet": 3,
  "03-waiting-on-user-nudge": 3,
  "04-budget-exhausted-downgrade": 3,
  "05-merged-propose-thread": 2,
  "06-voice-steer": 3,
};

const decodeScenario = Schema.decodeUnknownSync(SquireFixtureScenario);
const scenarios = [scenario01, scenario02, scenario03, scenario04, scenario05, scenario06]
  .map((scenario) => decodeScenario(scenario))
  .filter((scenario) => filter === undefined || filter.some((id) => scenario.id.startsWith(id)));

/**
 * Informational (6.7), not a CP4 threshold: the Auto hold executing on a
 * real clock. The scenario's `advance` steps cannot move a live clock, so the
 * run waits out the hold's undo window instead.
 */
const holdScenarios = [scenario08]
  .map((scenario) => decodeScenario(scenario))
  .filter((scenario) => filter === undefined || filter.some((id) => scenario.id.startsWith(id)));

const casesOf = (list: ReadonlyArray<SquireFixtureScenario>) =>
  list.flatMap((scenario) =>
    Array.from({ length: runs }, (_, index) => ({ id: scenario.id, run: index + 1, scenario })),
  );
const cases = casesOf(scenarios);
const holdCases = casesOf(holdScenarios);

const artifactsDir = NodePath.resolve(
  import.meta.dirname,
  "../../../../artifacts/squire-bar",
  provider,
);

const allowed = new Set<string>(SQUIRE_TOOL_NAMES.squire);

/**
 * Strings only the temp provider home's user context carries; one in a reply,
 * a card, or a run file means that context reached the Squire (A5.9, OQ24).
 */
const SENTINEL_STRINGS = [
  SENTINEL_WORD,
  ...Object.values(CODEX_CONTEXT_SENTINELS),
  ...SENTINEL_TOOLS,
  SENTINEL_SKILL,
  SENTINEL_PLUGIN,
  "sentinel-user-skill",
];
const sentinelsIn = (text: string) => SENTINEL_STRINGS.filter((token) => text.includes(token));
const results = new Map<string, Array<{ run: number; pass: boolean; failures: Array<string> }>>();

describe.runIf(providerEnv)(`B2-live on ${provider} (${model})`, () => {
  it.live.each(cases)(
    "$id run $run",
    ({ id, run, scenario }) =>
      Effect.gen(function* () {
        const providerHome = yield* makeBarProviderHome(provider);
        const recorder = makeBarProviderRecorder();
        const file = yield* withBarHarness(
          Effect.gen(function* () {
            const loaded = yield* runBarScenario(scenario, { provider, pauseLead: true });
            const observed = yield* barObserve(loaded.squireId);
            const toolCalls = yield* barToolCalls(loaded.homeThreadId);
            const failures = [...judgeBarRun(scenario.expected!, observed)];
            for (const call of toolCalls) {
              if (!allowed.has(call.name)) failures.push(`non-allowlisted tool call: ${call.name}`);
            }
            const sentinels = providerHome.sentinelEvents();
            if (sentinels.length > 0) {
              failures.push(`sentinel MCP servers started: ${JSON.stringify(sentinels)}`);
            }
            const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
              loaded.homeThreadId,
            );
            const replies = projection.turnItems.flatMap((item) =>
              item.type === "assistant_message" ? [item.text] : [],
            );
            const leaked = sentinelsIn(
              JSON.stringify({ replies, effects: observed.effects, toolCalls }),
            );
            if (leaked.length > 0) failures.push(`sentinel strings reached the Squire: ${leaked}`);
            return {
              replies,
              scenario: id,
              provider,
              model,
              run,
              toolCalls,
              effects: observed.effects,
              pass: failures.length === 0,
              failures,
            };
          }),
          { provider, providerHome, recorder, model },
        );
        const { replies, ...runFile } = file;
        yield* writeBarRun(provider, runFile);
        // What the provider was started with and listed, beside the run file.
        NodeFS.writeFileSync(
          NodePath.join(artifactsDir, `${id}-run${run}.provider.json`),
          `${JSON.stringify({ replies, opens: recorder.opens, inits: recorder.inits, launches: recorder.launches, requests: recorder.requests, sentinels: providerHome.sentinelEvents() }, null, 2)}\n`,
        );
        const entries = results.get(id) ?? [];
        entries.push({ run, pass: file.pass, failures: file.failures });
        results.set(id, entries);
        // The run reached the provider and finished its turn; gold is judged across runs.
        assert.isAbove(
          recorder.opens.length + recorder.requests.length,
          0,
          "the home thread never reached the provider",
        );
      }).pipe(Effect.scoped),
    { timeout: 900_000 },
  );

  it.live.each(holdCases)(
    "$id run $run (informational)",
    ({ id, run, scenario }) =>
      Effect.gen(function* () {
        const providerHome = yield* makeBarProviderHome(provider);
        const recorder = makeBarProviderRecorder();
        const file = yield* withBarTimeline(
          scenario,
          ({ loaded, marks }) =>
            Effect.gen(function* () {
              const repository = yield* SquireRepository.SquireRepository;
              const dues = (yield* repository.listCards({ squireId: loaded.squireId })).flatMap(
                (card) =>
                  card.status === "held" && card.executes_at !== null
                    ? [Date.parse(card.executes_at)]
                    : [],
              );
              if (dues.length > 0) {
                const now = yield* Clock.currentTimeMillis;
                yield* Effect.sleep(Duration.millis(Math.max(0, Math.max(...dues) - now) + 1_000));
              }
              yield* barSettle(loaded.squireId);
              const timeline = { marks: [...marks, yield* barMark(loaded, 0, "advance")] };
              const observed = yield* barObserve(loaded.squireId);
              const toolCalls = yield* barToolCalls(loaded.homeThreadId);
              const failures = [...judgeBarRun(scenario.expected!, observed, timeline)];
              for (const call of toolCalls) {
                if (!allowed.has(call.name)) {
                  failures.push(`non-allowlisted tool call: ${call.name}`);
                }
              }
              const leaked = sentinelsIn(JSON.stringify({ observed, toolCalls }));
              if (leaked.length > 0) {
                failures.push(`sentinel strings reached the Squire: ${leaked}`);
              }
              return {
                scenario: id,
                provider,
                model,
                run,
                toolCalls,
                effects: observed.effects,
                pass: failures.length === 0,
                failures,
                informational: true,
                marks: timeline.marks,
                executions: observed.executions,
                actionMessages: observed.actionMessages,
              };
            }),
          { provider, pauseLead: true, timeline: [] },
          { provider, providerHome, recorder, model },
        );
        yield* writeBarRun(provider, file);
        NodeFS.writeFileSync(
          NodePath.join(artifactsDir, `${id}-run${run}.provider.json`),
          `${JSON.stringify({ opens: recorder.opens, inits: recorder.inits, launches: recorder.launches, requests: recorder.requests, sentinels: providerHome.sentinelEvents() }, null, 2)}\n`,
        );
        const entries = results.get(id) ?? [];
        entries.push({ run, pass: file.pass, failures: file.failures });
        results.set(id, entries);
      }).pipe(Effect.scoped),
    { timeout: 900_000 },
  );

  it.live("threshold summary", () =>
    Effect.gen(function* () {
      const summary = [...scenarios, ...holdScenarios].map((scenario) => {
        const entries = results.get(scenario.id) ?? [];
        const passed = entries.filter((entry) => entry.pass).length;
        const required = Math.ceil(((REQUIRED[scenario.id] ?? runs) * runs) / 3);
        const informational = holdScenarios.includes(scenario);
        return {
          scenario: scenario.id,
          ...(informational ? { informational } : {}),
          passed,
          runs: entries.length,
          required,
          met: passed >= required,
          failures: entries.filter((entry) => !entry.pass),
        };
      });
      NodeFS.writeFileSync(
        NodePath.join(artifactsDir, "summary.json"),
        `${JSON.stringify({ provider, model, runs, summary }, null, 2)}\n`,
      );
      for (const row of summary) {
        yield* Effect.logInfo(
          `B2-live ${provider} ${row.scenario}: ${row.passed}/${row.runs} (need ${row.required}) ${row.met ? "met" : "MISSED"}`,
        );
      }
    }),
  );
});
