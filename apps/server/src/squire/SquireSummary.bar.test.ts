// The summary gold. The stub half runs in CI: the model is replaced
// by the gold's own model-written fields, so everything else the pipeline
// produces must match gold exactly. The live half runs only with
// SQUIRE_BAR_PROVIDER set (claudeAgent or codex) and writes artifacts for
// the critics; it spends provider tokens.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  SQUIRE_SUMMARY_MAX_CHARS,
  SquireSummaryGoldFixture,
  SquireSummaryStressFixture,
  renderSquireTurnSummary,
  squireOutcome,
  type SquireSummaryModelOutput,
  type SquireTurnSummary,
} from "@lecturn/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerSettingsService, layerTest as settingsLayer } from "../serverSettings.ts";
import { makeClaudeTextGeneration } from "../textGeneration/ClaudeTextGeneration.ts";
import { makeCodexTextGeneration } from "../textGeneration/CodexTextGeneration.ts";
import { resolveInferenceModel } from "../textGeneration/inferenceModel.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as SquireRepository from "./SquireRepository.ts";
import { SquireRunSource, SquireSummaries, make } from "./SquireSummaries.ts";
import { squireDeterministicSummary, squireSummaryWithModel } from "./SquireSummaryInput.ts";
import goldJson from "./testdata/scenarios/summary-gold.json" with { type: "json" };
import stressJson from "./testdata/scenarios/summary-stress.json" with { type: "json" };

const goldFixture = Schema.decodeUnknownSync(SquireSummaryGoldFixture)(goldJson);
const stress = Schema.decodeUnknownSync(SquireSummaryStressFixture)(stressJson).summary;

/** Writes `artifacts/squire-bar/<file>` at the repo root (gitignored). */
const writeBarArtifact = (file: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const here = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
    const target = path.resolve(here, "../../../../artifacts/squire-bar", file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, content);
  });
const { fixture, gold } = goldFixture;

const goldModelFields: SquireSummaryModelOutput = {
  goal: gold.goal,
  completed: gold.completed,
  remaining: gold.remaining,
  blocked: gold.blocked,
  pendingQuestion: gold.pendingQuestion,
  suggestedNextStep: gold.suggestedNextStep,
};

const exactFields = (summary: SquireTurnSummary) =>
  Object.fromEntries(
    goldFixture.exactMatch.map((key) => [key, summary[key as keyof SquireTurnSummary]]),
  );

/** Every path and command line the render shows, which must be stored verbatim. */
const shownEntries = (text: string) => ({
  paths: [...text.matchAll(/^ {2}[AMD] (.+)$/gm)].map((match) => match[1]!),
  commands: [...text.matchAll(/^ {2}(?:pass|fail \(exit -?\d+\)) (.+)$/gm)].map(
    (match) => match[1]!,
  ),
});

it.layer(
  Layer.mergeAll(
    Layer.provideMerge(SquireRepository.layer, SqlitePersistence.layerMemory),
    NodeServices.layer,
  ),
)("B3 summary gold (stub)", (it) => {
  it.effect("builds the gold summary through the pipeline and renders it under the cap", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const configured = yield* Effect.service(ServerSettingsService).pipe(
        Effect.provide(settingsLayer()),
      );
      const service = SquireSummaries.of(
        yield* make.pipe(
          Effect.provideService(TextGeneration, {
            generateCommitMessage: () => Effect.die("unused"),
            generatePrContent: () => Effect.die("unused"),
            generateBranchName: () => Effect.die("unused"),
            generateThreadTitle: () => Effect.die("unused"),
            generateWorkflowSummary: () => Effect.die("unused"),
            generateReviewGuide: () => Effect.die("unused"),
            generateSquireTurnSummary: (input) => {
              calls.push(input);
              return Effect.succeed(goldModelFields);
            },
          }),
          Effect.provideService(SquireRunSource, {
            load: () =>
              Effect.succeed({
                input: fixture,
                threadModel: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: "stub",
                },
              }),
          }),
          Effect.provideService(ServerSettingsService, configured),
        ),
      );
      const stored = yield* service.ensure({
        threadId: fixture.thread.threadId,
        runId: fixture.turnId,
        stage: "terminal",
        trackers: [],
      });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(stored.status, "complete");
      assert.deepStrictEqual(exactFields(stored.summary), exactFields(gold));
      assert.deepStrictEqual(stored.summary, gold);
      const reread = Option.getOrThrow(
        yield* service.read({ threadId: fixture.thread.threadId, runId: fixture.turnId }),
      );
      assert.deepStrictEqual(reread.summary, gold);

      const rendered = renderSquireTurnSummary(stored.summary);
      assert.isAtMost(rendered.length, SQUIRE_SUMMARY_MAX_CHARS);
      // failIf, mechanically: no PR line without a PR, no PDF path, nothing elided.
      assert.notMatch(rendered, /^PR /m);
      assert.notMatch(rendered, /pdf/i);
      assert.notMatch(rendered, / more (files|commands)$/m);
      assert.deepStrictEqual(shownEntries(rendered), {
        paths: gold.files.entries.map((entry) => entry.path),
        commands: gold.commands.map((entry) => entry.command),
      });

      const stressRendered = renderSquireTurnSummary(stress);
      assert.isAtMost(stressRendered.length, SQUIRE_SUMMARY_MAX_CHARS);
      assert.match(stressRendered, /^ {2}\+\d+ more files$/m);
      const stressShown = shownEntries(stressRendered);
      assert.isAbove(stressShown.paths.length, 0);
      for (const path of stressShown.paths) {
        assert.include(
          stress.files.entries.map((entry) => entry.path),
          path,
        );
      }
      for (const command of stressShown.commands) {
        assert.include(
          stress.commands.map((entry) => entry.command),
          command,
        );
      }

      yield* writeBarArtifact(
        "b3/stub-render.txt",
        [
          `# summary-gold (stub model fields), ${rendered.length} chars, cap ${SQUIRE_SUMMARY_MAX_CHARS}`,
          rendered,
          "",
          `# summary-stress (schema maxima), ${stressRendered.length} chars, cap ${SQUIRE_SUMMARY_MAX_CHARS}`,
          stressRendered,
          "",
        ].join("\n"),
      );
    }),
  );
});

const liveProvider = process.env.SQUIRE_BAR_PROVIDER;
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const liveRuns = Number(process.env.SQUIRE_BAR_RUNS ?? "3");

describe.runIf(liveProvider)("B3 summary gold (live)", () => {
  const driverKind = ProviderDriverKind.make(liveProvider ?? "claudeAgent");
  const preferred = driverKind === "codex" ? "gpt-5.6-luna" : "claude-sonnet-5";
  const modelSelection = resolveInferenceModel(
    { instanceId: ProviderInstanceId.make(driverKind), model: preferred },
    driverKind,
    [{ slug: preferred }],
  );
  const layer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "lecturn-squire-b3-live-",
  }).pipe(Layer.provideMerge(NodeServices.layer));

  // Live clock: durationMs is wall time, and the provider timeouts can fire.
  // oxlint-disable-next-line lecturn/no-test-timeout-or-unreasoned-skip -- a live provider run behind an env gate, on real model latency, not a hidden wait.
  it.layer(layer, { timeout: 600_000, excludeTestServices: true })(`${driverKind}`, (it) => {
    // oxlint-disable-next-line lecturn/no-test-timeout-or-unreasoned-skip -- a live provider run behind an env gate, on real model latency, not a hidden wait.
    it.effect(
      `writes ${liveRuns} runs of the gold summary for the critics`,
      () =>
        Effect.gen(function* () {
          const generation =
            driverKind === "codex"
              ? yield* makeCodexTextGeneration(
                  yield* decodeCodexSettings({}),
                  process.env,
                  undefined,
                  undefined,
                  ProviderInstanceId.make("codex"),
                )
              : yield* makeClaudeTextGeneration(yield* decodeClaudeSettings({}), process.env);
          const generate = generation.generateSquireTurnSummary;
          assert.isDefined(generate);
          const outcome = squireOutcome(fixture.session);
          assert.strictEqual(outcome, "finished");
          const deterministic = squireDeterministicSummary(fixture, outcome!);
          for (let run = 1; run <= liveRuns; run++) {
            const started = yield* Clock.currentTimeMillis;
            const model = yield* generate!({
              cwd: process.cwd(),
              summaryInput: fixture,
              outcome: outcome!,
              modelSelection,
            });
            const durationMs = (yield* Clock.currentTimeMillis) - started;
            const summary = squireSummaryWithModel(deterministic, model);
            const rendered = renderSquireTurnSummary(summary);
            yield* writeBarArtifact(
              `${driverKind}/summary-gold-run${run}.json`,
              `${JSON.stringify({ summary, rendered, renderedLength: rendered.length, durationMs, modelSelection }, null, 2)}\n`,
            );
            assert.deepStrictEqual(exactFields(summary), exactFields(gold));
            assert.isAtMost(rendered.length, SQUIRE_SUMMARY_MAX_CHARS);
          }
        }).pipe(Effect.scoped),
      600_000,
    );
  });
});
