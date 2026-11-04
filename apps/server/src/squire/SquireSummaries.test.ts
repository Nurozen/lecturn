import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  SquireId,
  type ModelSelection,
  type SquireSummaryModelOutput,
  type SquireTurnSummary,
  TextGenerationError,
} from "@lecturn/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerSettingsService, layerTest as settingsLayer } from "../serverSettings.ts";
import {
  TextGeneration,
  type SquireTurnSummaryGenerationInput,
} from "../textGeneration/TextGeneration.ts";
import * as SquireRepository from "./SquireRepository.ts";
import {
  SquireRunSource,
  SquireSummaries,
  chooseSquireSummaryPayer,
  make,
  type SquireSummaryTracker,
} from "./SquireSummaries.ts";
import { squireSummaryInputFromRun, type SquireRunSnapshot } from "./SquireSummaryInput.ts";
import {
  assistantMessage,
  command,
  runSnapshot,
  summaryRunId,
  summaryThreadId,
  userMessage,
} from "./testkit/summaryRun.ts";

const model = (instance: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instance),
  model: `${instance}-small`,
});
const threadModel = model("claude");
const settingsModel = model("codex");

const tracker = (overrides: Partial<SquireSummaryTracker> = {}): SquireSummaryTracker => ({
  squireId: SquireId.make("squire-release"),
  createdAt: "2026-10-01T00:00:00.000Z",
  active: true,
  turnFinishedOn: true,
  summaryModelSelection: null,
  ...overrides,
});

const modelReply = (goal: string): SquireSummaryModelOutput => ({
  goal,
  completed: [`${goal}: done`],
  remaining: [],
  blocked: [],
  pendingQuestion: null,
  suggestedNextStep: null,
});

type Generate = (
  input: SquireTurnSummaryGenerationInput,
) => Effect.Effect<SquireSummaryModelOutput, TextGenerationError>;

/** The summary service over an in-memory store, a mutable run, and a scripted model. */
const harness = (
  generate: Generate,
  options: { readonly threadModel?: ModelSelection | null } = {},
) =>
  Effect.gen(function* () {
    const calls: Array<SquireTurnSummaryGenerationInput> = [];
    let run: SquireRunSnapshot = runSnapshot();
    const generator = {
      generateCommitMessage: () => Effect.die("unused"),
      generatePrContent: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
      generateThreadTitle: () => Effect.die("unused"),
      generateWorkflowSummary: () => Effect.die("unused"),
      generateReviewGuide: () => Effect.die("unused"),
      generateSquireTurnSummary: (input: SquireTurnSummaryGenerationInput) => {
        calls.push(input);
        return generate(input);
      },
    } satisfies TextGeneration["Service"];
    const configured = yield* Effect.service(ServerSettingsService).pipe(
      Effect.provide(settingsLayer()),
    );
    const service = yield* make.pipe(
      Effect.provideService(TextGeneration, generator),
      Effect.provideService(SquireRunSource, {
        load: () =>
          Effect.succeed({
            input: squireSummaryInputFromRun(run),
            threadModel: options.threadModel === undefined ? threadModel : options.threadModel,
          }),
      }),
      Effect.provideService(ServerSettingsService, {
        ...configured,
        getSettings: configured.getSettings.pipe(
          Effect.map((value) => ({ ...value, textGenerationModelSelection: settingsModel })),
        ),
      }),
    );
    return {
      service: SquireSummaries.of(service),
      calls,
      setRun: (next: Partial<SquireRunSnapshot>) => {
        run = { ...run, ...next };
      },
    };
  });

const key = { threadId: summaryThreadId, runId: summaryRunId } as const;
const files = (summary: SquireTurnSummary) => summary.files.entries.map((entry) => entry.path);
const commands = (summary: SquireTurnSummary) => summary.commands.map((entry) => entry.command);

it.layer(Layer.provideMerge(SquireRepository.layer, SqlitePersistence.layerMemory))(
  "SquireSummaries",
  (it) => {
    it.effect(
      "keeps the work up to a wait in the provisional row and adds later work at run end",
      () =>
        Effect.gen(function* () {
          const { service, calls, setRun } = yield* harness((input) =>
            Effect.succeed(modelReply(`stage with ${input.summaryInput.toolCalls.length} calls`)),
          );
          const beforeWait = [
            userMessage("Fix the rounding."),
            command("vp test run src/invoice", 0),
          ];
          setRun({
            status: "waiting",
            pendingRequest: { kind: "user_input", requestId: "req-1", question: "Which currency?" },
            turnItems: beforeWait,
            files: [{ path: "src/invoice/InvoiceTotals.ts", change: "modified" }],
          });
          const provisional = yield* service.ensure({
            ...key,
            stage: "request:req-1",
            trackers: [tracker()],
          });
          assert.strictEqual(provisional.status, "complete");
          assert.strictEqual(provisional.summary.outcome, "waiting-on-input");
          assert.strictEqual(provisional.summary.pendingQuestion, "Which currency?");

          // Answering resumes the same run, which does more work and completes.
          setRun({
            status: "completed",
            pendingRequest: null,
            turnItems: [
              ...beforeWait,
              command("vp run typecheck --filter billing", 0),
              assistantMessage("Done with EUR."),
            ],
            files: [
              { path: "src/invoice/InvoiceTotals.ts", change: "modified" },
              { path: "src/invoice/roundHalfEven.ts", change: "added" },
            ],
          });
          const terminal = yield* service.ensure({
            ...key,
            stage: "terminal",
            trackers: [tracker()],
          });
          assert.strictEqual(terminal.summary.outcome, "finished");
          assert.deepStrictEqual(files(terminal.summary), [
            "src/invoice/InvoiceTotals.ts",
            "src/invoice/roundHalfEven.ts",
          ]);
          assert.deepStrictEqual(commands(terminal.summary), [
            "vp test run src/invoice",
            "vp run typecheck --filter billing",
          ]);

          // Both rows are immutable: repeating either stage calls no model.
          const again = yield* service.ensure({ ...key, stage: "request:req-1", trackers: [] });
          assert.deepStrictEqual(files(again.summary), ["src/invoice/InvoiceTotals.ts"]);
          assert.deepStrictEqual(commands(again.summary), ["vp test run src/invoice"]);
          yield* service.ensure({ ...key, stage: "terminal", trackers: [] });
          assert.strictEqual(calls.length, 2);
          assert.strictEqual(calls[0]!.summaryInput.toolCalls.length, 1);
          assert.strictEqual(calls[1]!.summaryInput.toolCalls.length, 2);
          // No Squire setting: the thread's own provider pays, and no payer is recorded.
          assert.deepStrictEqual(calls[0]!.modelSelection, threadModel);
          assert.strictEqual(terminal.payerSquireId, null);
        }),
    );

    it.effect("reads the terminal summary, else the latest provisional one", () =>
      Effect.gen(function* () {
        const { service, setRun } = yield* harness(() => Effect.succeed(modelReply("read")));
        const runKey = { ...key, runId: "run-read" as typeof summaryRunId };
        assert.isTrue(Option.isNone(yield* service.read(runKey)));
        setRun({
          status: "waiting",
          pendingRequest: { kind: "command", requestId: "a", question: null },
        });
        yield* service.ensure({ ...runKey, stage: "request:a", trackers: [] });
        yield* service.ensure({ ...runKey, stage: "request:b", trackers: [] });
        const latest = yield* service.read(runKey);
        assert.strictEqual(Option.getOrThrow(latest).summary.outcome, "waiting-on-approval");
        setRun({ status: "failed", pendingRequest: null });
        yield* service.ensure({ ...runKey, stage: "terminal", trackers: [] });
        assert.strictEqual(Option.getOrThrow(yield* service.read(runKey)).summary.outcome, "error");
        const own = yield* service.read({ ...runKey, stage: "request:a" });
        assert.strictEqual(Option.getOrThrow(own).summary.outcome, "waiting-on-approval");
      }),
    );

    it.effect("charges the earliest active Squire's summary setting and records it", () =>
      Effect.gen(function* () {
        const { service, calls } = yield* harness(() => Effect.succeed(modelReply("paid")));
        const chosen = model("claude-squire-setting");
        const stored = yield* service.ensure({
          ...key,
          runId: "run-payer" as typeof summaryRunId,
          stage: "terminal",
          trackers: [
            tracker({
              squireId: SquireId.make("later"),
              createdAt: "2026-10-03T00:00:00.000Z",
              summaryModelSelection: model("later-setting"),
            }),
            tracker({
              squireId: SquireId.make("earliest"),
              createdAt: "2026-10-02T00:00:00.000Z",
              summaryModelSelection: chosen,
            }),
            tracker({
              squireId: SquireId.make("paused"),
              createdAt: "2026-09-01T00:00:00.000Z",
              active: false,
              summaryModelSelection: model("paused-setting"),
            }),
          ],
        });
        assert.deepStrictEqual(calls[0]!.modelSelection, chosen);
        assert.strictEqual(stored.payerSquireId, SquireId.make("earliest"));
      }),
    );

    it.effect("stores deterministic fields only when the model fails or runs past 20 s", () =>
      Effect.gen(function* () {
        const failing = yield* harness(() => Effect.die("provider exploded"));
        failing.setRun({ turnItems: [command("vp test run", 1)] });
        const failed = yield* failing.service.ensure({
          ...key,
          runId: "run-fail" as typeof summaryRunId,
          stage: "terminal",
          trackers: [],
        });
        assert.strictEqual(failed.status, "partial");
        assert.strictEqual(failed.summary.summaryStatus, "partial");
        assert.strictEqual(failed.summary.goal, "");
        assert.deepStrictEqual(failed.summary.commands, [
          { command: "vp test run", exitCode: 1, pass: false },
        ]);

        const slow = yield* harness(() => Effect.never);
        const fiber = yield* slow.service
          .ensure({
            ...key,
            runId: "run-slow" as typeof summaryRunId,
            stage: "terminal",
            trackers: [],
          })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("21 seconds");
        const timedOut = yield* Fiber.join(fiber);
        assert.strictEqual(timedOut.status, "partial");
      }),
    );

    it.effect("logs the reason a provider gives for a partial summary", () =>
      Effect.gen(function* () {
        const reason = "A Squire can use only a Codex sign-in saved as a file.";
        const { service } = yield* harness(() =>
          Effect.fail(
            new TextGenerationError({ operation: "generateSquireTurnSummary", detail: reason }),
          ),
        );
        const logged: Array<unknown> = [];
        const logger = Logger.make(({ message }) => {
          logged.push(message);
        });
        const stored = yield* service
          .ensure({
            ...key,
            runId: "run-login" as typeof summaryRunId,
            stage: "terminal",
            trackers: [],
          })
          .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
        assert.strictEqual(stored.status, "partial");
        assert.include(JSON.stringify(logged), reason);
      }),
    );

    it.effect(
      "is partial with no payer anywhere, and never calls a provider for a fixture thread",
      () =>
        Effect.gen(function* () {
          const unpaid = yield* harness(() => Effect.succeed(modelReply("x")), {
            threadModel: null,
          });
          // The settings model is the last link in the chain.
          yield* unpaid.service.ensure({
            ...key,
            runId: "run-settings" as typeof summaryRunId,
            stage: "terminal",
            trackers: [],
          });
          assert.deepStrictEqual(unpaid.calls[0]!.modelSelection, settingsModel);
          assert.isNull(chooseSquireSummaryPayer([tracker()], null, null));

          const fixtureSummary = (yield* unpaid.service.ensure({
            ...key,
            runId: "run-settings" as typeof summaryRunId,
            stage: "terminal",
            trackers: [],
          })).summary;
          const { service, calls } = yield* harness(() => Effect.succeed(modelReply("never")));
          const fromFixture = yield* service.ensure({
            ...key,
            runId: "run-fixture" as typeof summaryRunId,
            stage: "terminal",
            trackers: [tracker({ summaryModelSelection: model("paid") })],
            fixture: { summary: fixtureSummary },
          });
          assert.strictEqual(fromFixture.status, "complete");
          assert.strictEqual(fromFixture.summary.goal, "x");
          const bare = yield* service.ensure({
            ...key,
            runId: "run-fixture-bare" as typeof summaryRunId,
            stage: "terminal",
            trackers: [],
            fixture: { summary: null },
          });
          assert.strictEqual(bare.status, "partial");
          assert.strictEqual(calls.length, 0);
        }),
    );

    it.effect("shares one model call between concurrent requests for a stage", () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const { service, calls } = yield* harness(() =>
          Deferred.await(release).pipe(Effect.as(modelReply("shared"))),
        );
        const request = {
          ...key,
          runId: "run-shared" as typeof summaryRunId,
          stage: "terminal",
          trackers: [],
        } as const;
        const first = yield* service.ensure(request).pipe(Effect.forkChild);
        const second = yield* service.ensure(request).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)];
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(a, b);
      }),
    );

    it.effect("settles summaries a restart left generating as partial", () =>
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const { service } = yield* harness(() => Effect.succeed(modelReply("unused")));
        const partial = yield* service.ensure({
          ...key,
          runId: "run-crash-template" as typeof summaryRunId,
          stage: "terminal",
          trackers: [],
          fixture: { summary: null },
        });
        const runKey = { ...key, runId: "run-crash" as typeof summaryRunId };
        yield* repository.insertSummary({
          thread_id: runKey.threadId,
          run_id: runKey.runId,
          stage: "terminal",
          status: "generating",
          summary_json: JSON.stringify(partial.summary),
          payer_squire_id: null,
          created_at: "2026-10-01T00:00:00.000Z",
          updated_at: "2026-10-01T00:00:00.000Z",
        });
        assert.isAtLeast(yield* service.settleInterrupted, 1);
        const settled = Option.getOrThrow(yield* service.read(runKey));
        assert.strictEqual(settled.status, "partial");
        assert.strictEqual(settled.summary.summaryStatus, "partial");
      }),
    );
  },
);
